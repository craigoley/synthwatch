// AI root-cause analysis — when a failure OPENS an incident, an Azure-hosted model
// CLASSIFIES + explains it into the incident. Opt-in, non-fatal, cost-smart.
//
// AZURE, MANAGED IDENTITY, NO KEYS: the OpenAI-compatible chat-completions API
// against an Azure OpenAI / Foundry deployment, authenticated with an AAD bearer
// token from DefaultAzureCredential (the runner's managed identity in ACA; az-CLI
// creds locally). A fork (e.g. Wegmans) points AZURE_OPENAI_ENDPOINT +
// AZURE_OPENAI_DEPLOYMENT at THEIR tenant's deployment + grants THEIR MI the
// "Cognitive Services OpenAI User" role — zero code change.
//
// OPT-IN: absent AZURE_OPENAI_ENDPOINT/DEPLOYMENT => RCA fully off, zero overhead.
// NON-FATAL: any failure (token, network, 401, timeout, bad output) is swallowed —
// the incident records WITHOUT rca; RCA never blocks incident-open or changes a
// verdict.
import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';
import { pool, type Check, type RunRecord } from './db.js';
import { downloadBlobBase64 } from './artifacts.js';
import type { TraceSignals, ConsoleMessage, TraceRequest } from './traceSignals.js';

const ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT; // e.g. https://my-aoai.openai.azure.com
const DEPLOYMENT = process.env.RCA_MODEL_DEPLOYMENT ?? process.env.AZURE_OPENAI_DEPLOYMENT;
// GA chat-completions version (learn.microsoft.com); override if a fork needs newer.
const API_VERSION = process.env.AZURE_OPENAI_API_VERSION ?? '2024-10-21';
// `Number(env) || default` (not `?? default`): a malformed value (e.g. "30s") makes
// Number() return NaN; NaN is falsy so we fall back to the default rather than
// propagating NaN into a setTimeout / the API request (which would 400).
const TIMEOUT_MS = Number(process.env.RCA_TIMEOUT_MS) || 30000;
// Completion budget. gpt-5-mini is a REASONING model: hidden reasoning tokens count
// against this BEFORE the visible JSON is emitted (commonly 1000-2000), so a tight
// budget truncates the output (finish_reason='length' -> empty content). Default
// 4000 leaves ample room for reasoning + the small classification JSON.
const MAX_TOKENS = Number(process.env.RCA_MAX_TOKENS) || 4000;
// OPT-IN reasoning_effort (minimal|low|medium|high) to cap reasoning spend. Sent
// ONLY when set: api-version 2024-10-21 predates GPT-5 and may 400 on this param, so
// it stays off by default; a fork on a newer api-version / the v1 API can enable it.
const REASONING_EFFORT = process.env.RCA_REASONING_EFFORT;
// Reuse an RCA for an identical failure signature opened within this window.
const CACHE_TTL = process.env.RCA_CACHE_TTL ?? '24 hours';
// AAD scope for Azure AI / Cognitive Services data-plane.
const SCOPE = 'https://cognitiveservices.azure.com/.default';

// ★ Fact-pack caps — the trace can carry hundreds of console errors; cap + RANK (first-party first) so the
// signal a Wegmans monitor cares about isn't drowned by tracker noise, and the pack stays inside RCA_MAX_TOKENS.
const FIRST_PARTY_CONSOLE_CAP = 10;
const NET_FAILED_CAP = 8;

const CLASSIFICATIONS = [
  'real-outage',
  'flaky-transient',
  'selector-drift',
  'environment-regional',
  'perf-regression',
] as const;
type Classification = (typeof CLASSIFICATIONS)[number];
const CONFIDENCES = ['high', 'medium', 'low'] as const;
type Confidence = (typeof CONFIDENCES)[number];

export interface RcaResult {
  classification: Classification;
  confidence: Confidence;
  observed: string[];
  inferred: string[];
  summary: string;
  signature: string; // check_id|error|failed_step — the cache key
  model: string | null;
  cached: boolean;
  generated_at: string;
}

export function rcaEnabled(): boolean {
  return Boolean(ENDPOINT && DEPLOYMENT);
}

/** check_id|error|failed_step — the cache signature (bounded, stable per failure mode). */
function signatureOf(checkId: number, errorMessage: string | null, failedStep: string | null): string {
  return `${checkId}|${(errorMessage ?? '').slice(0, 300)}|${failedStep ?? ''}`;
}

const SYSTEM_PROMPT = `You are a site-reliability failure classifier for a synthetic monitoring tool. A monitored check just FAILED and opened an incident. Classify the failure and explain it for an on-call engineer.

Return ONLY a JSON object with EXACTLY this shape:
{
  "classification": one of ["real-outage","flaky-transient","selector-drift","environment-regional","perf-regression"],
  "confidence": one of ["high","medium","low"],
  "observed": [up to 5 short strings — FACTS the evidence literally shows. ★ EACH observed item MUST END WITH a citation "[cite: TOKEN]" naming the artifact it comes from, where TOKEN is one of the CITE TOKENS listed in the evidence block. A claim with no cite, or a cite that is not in that list, is DISCARDED and your whole answer is thrown away.],
  "inferred": [up to 4 short strings — HYPOTHESES that follow from the observed facts; each is a reasoning step, NOT a fact. Do NOT cite here — inferred items are your reasoning, not artifacts.],
  "summary": "one or two plain-English sentences for the on-call engineer."
}

Classification definitions:
- real-outage: the target itself is genuinely down/erroring (5xx, connection refused, the page/endpoint truly broken).
- flaky-transient: intermittent, likely self-resolving (a one-off timeout/blip); run history is mostly passing.
- selector-drift: (browser/multistep) the PAGE changed so the check's selector/assertion is now stale — the MONITOR needs updating, not the target. Signals: an element/locator not found while the page otherwise rendered; a screenshot showing a working page with a moved/renamed/removed element.
- environment-regional: an infra/network/regional blip — especially if only SOME locations are failing.
- perf-regression: slow, not broken — a latency/timeout/budget issue rather than a hard error.

HONESTY (critical): clearly separate OBSERVED facts from INFERRED hypotheses. LLMs tend to generate plausible-sounding but incorrect explanations — do NOT. If the evidence is thin or ambiguous, return LOW confidence and put MULTIPLE candidate causes in "inferred" rather than inventing one confident cause. Never state as observed anything the evidence does not literally show. An honest low-confidence answer beats a confident wrong one.

★ THE ERROR MESSAGE CAN MISLEAD: the "Error message" often NAMES a suspected cause (e.g. "affordance not found (NET-NEW selector)") that the OTHER evidence CONTRADICTS. Do NOT take it at face value — reconcile it against the funnel, the console errors, and the network failures before classifying.

★ WEIGH SIBLING STEPS: the funnel shows every step and its status. If the SAME mechanism succeeded on an EARLIER step in THIS SAME run (e.g. an "add to cart" action passed for one product seconds before it "failed" for another), then a selector/mechanism REGRESSION is REFUTED — the selector is fine; look for a transient or product-specific cause (an API error, a slow render) instead.

★ CONSOLE ERRORS HAVE NO TIMESTAMP: the console/network signals are captured for the WHOLE run, not stamped to a step. So you CANNOT prove a captured error struck DURING the failed step. State the captured error as an OBSERVED fact (it was captured), but any causal link between it and the failure is a HYPOTHESIS — put it in "inferred", and let confidence reflect that it is a correlation, not proof (medium at most when the only link is co-occurrence within the run).`;

interface StepRow {
  step_index: number;
  name: string;
  status: string;
  error_message: string | null;
}

interface ConsoleFact {
  origin: string; // 'site' (first-party) | 'third-party'
  level: string;
  sourceHost: string;
  text: string; // omitted (empty) for sensitive monitors — host+level only
}
interface NetFailFact {
  host: string;
  status: number;
}

/**
 * The RCA fact pack — everything the classifier reasons over, assembled ONCE (DB) then rendered purely so
 * the render + cite-validation + fallback are all unit-testable without a DB or a model. `citeIndex` (built
 * from the SAME facts) is the closed set of artifacts an "observed" claim may cite — the ground truth the
 * resolve-or-discard guard checks against.
 */
export interface RcaFacts {
  checkName: string;
  kind: string;
  targetUrl: string;
  sensitive: boolean;
  runStatus: string;
  httpStatus: number | null;
  durationMs: number | null;
  failedStep: string | null;
  errorMessage: string | null;
  steps: { index: number; name: string; status: string; error: string | null }[];
  recent: string[];
  verdict: { failing: number; total: number };
  // ★ Trace signals (was ABSENT — the whole gap). First-party FIRST (the monitored site's own errors are the
  // signal; third-party is tracker noise that would drown it, exactly as in the error-diff panel).
  firstPartyConsole: ConsoleFact[]; // capped, error-class, first-party
  thirdPartyConsoleErrorCount: number; // just the count — noise, not dumped
  netFailed: NetFailFact[]; // capped
}

function hostOfUrl(url: string): string {
  if (!/^https?:\/\//i.test(url)) return url.split(/[/?#]/)[0] ?? url;
  try {
    return new URL(url).hostname;
  } catch {
    return url.replace(/^https?:\/\//i, '').split(/[/?#]/)[0] ?? url;
  }
}

/** Pull the console + network signal out of trace_signals, first-party ranked + capped. */
export function extractTraceFacts(
  ts: TraceSignals | null,
  sensitive: boolean,
): { firstPartyConsole: ConsoleFact[]; thirdPartyConsoleErrorCount: number; netFailed: NetFailFact[] } {
  const msgs: ConsoleMessage[] = ts?.console?.messages ?? [];
  const isErr = (m: ConsoleMessage) => m.level === 'error' || m.level === 'pageerror';
  const firstPartyConsole = msgs
    .filter((m) => m.origin === 'site' && isErr(m))
    .slice(0, FIRST_PARTY_CONSOLE_CAP)
    .map((m) => ({
      origin: m.origin,
      level: m.level,
      sourceHost: m.sourceHost,
      // B10: for a sensitive monitor forward host+level ONLY (trace_signals is scrubbed at capture, but the
      // funnel applies the same defense-in-depth — never forward console TEXT for a sensitive check).
      text: sensitive ? '' : m.text.slice(0, 160),
    }));
  const thirdPartyConsoleErrorCount = msgs.filter((m) => m.origin === 'third-party' && isErr(m)).length;
  const failed: TraceRequest[] = ts?.network?.failed ?? [];
  const netFailed = failed.slice(0, NET_FAILED_CAP).map((f) => ({ host: hostOfUrl(f.url), status: f.status }));
  return { firstPartyConsole, thirdPartyConsoleErrorCount, netFailed };
}

/** Gather the rich signal from the DB into a pure RcaFacts (rendering + validation happen on the facts). */
async function gatherFacts(
  check: Check,
  run: RunRecord,
  verdict: { failing: number; total: number },
): Promise<{ facts: RcaFacts; screenshotUrl: string | null }> {
  const runRow = (
    await pool.query<{
      http_status: number | null;
      duration_ms: number | null;
      screenshot_url: string | null;
      trace_signals: TraceSignals | null;
    }>(`SELECT http_status, duration_ms, screenshot_url, trace_signals FROM runs WHERE id = $1`, [run.id])
  ).rows[0];

  const steps = (
    await pool.query<StepRow>(
      `SELECT step_index, name, status, error_message FROM run_steps WHERE run_id = $1 ORDER BY step_index`,
      [run.id],
    )
  ).rows.map((s) => ({ index: s.step_index, name: s.name, status: s.status, error: s.error_message }));

  const recent = (
    await pool.query<{ status: string }>(
      `SELECT status FROM runs WHERE check_id = $1 AND id <> $2 AND status <> 'running'
        ORDER BY started_at DESC LIMIT 15`,
      [check.id, run.id],
    )
  ).rows.map((r) => r.status);

  const trace = extractTraceFacts(runRow?.trace_signals ?? null, check.sensitive);
  const facts: RcaFacts = {
    checkName: check.name,
    kind: check.kind,
    targetUrl: check.target_url,
    sensitive: check.sensitive,
    runStatus: run.status,
    httpStatus: runRow?.http_status ?? null,
    durationMs: runRow?.duration_ms ?? null,
    failedStep: run.failed_step,
    errorMessage: run.error_message,
    steps,
    recent,
    verdict,
    ...trace,
  };
  return { facts, screenshotUrl: runRow?.screenshot_url ?? null };
}

/**
 * Render the fact pack to the model prompt text AND the closed cite-token set. The tokens are the ground
 * truth for resolve-or-discard: an "observed [cite: X]" is valid iff X ∈ citeIndex.
 */
export function renderFactPack(facts: RcaFacts): { text: string; citeIndex: Set<string> } {
  const cite = new Set<string>();
  cite.add('locations');
  if (facts.errorMessage) cite.add('error_message');
  if (facts.failedStep) cite.add('failed_step');
  if (facts.httpStatus != null) cite.add('http_status');
  if (facts.durationMs != null) cite.add('duration');
  if (facts.recent.length) cite.add('history');
  if (facts.steps.length) cite.add('run_steps');
  for (const s of facts.steps) cite.add(`step:${s.name}`);
  for (const c of facts.firstPartyConsole) if (c.sourceHost) cite.add(`console:${c.sourceHost}`);
  for (const n of facts.netFailed) if (n.host) cite.add(`network:${n.host}`);

  const funnel = facts.steps.length
    ? facts.steps
        .map(
          (s) =>
            `  step ${s.index} "${s.name}" [${s.status}]` +
            (!facts.sensitive && s.error ? `: ${s.error.slice(0, 120)}` : ''),
        )
        .join('\n')
    : '  (none — not a stepped check)';

  const consoleBlock = facts.firstPartyConsole.length
    ? facts.firstPartyConsole
        .map((c) => `  - [${c.origin}/${c.level} @${c.sourceHost || '?'}]${c.text ? ' ' + c.text : ''}`)
        .join('\n')
    : '  (none captured)';
  const netBlock = facts.netFailed.length
    ? facts.netFailed.map((n) => `  - ${n.host} → status ${n.status}`).join('\n')
    : '  (none captured)';

  const text = [
    `Check: "${facts.checkName}" (kind=${facts.kind}, target=${facts.targetUrl})`,
    `Run status: ${facts.runStatus}   HTTP status: ${facts.httpStatus ?? 'n/a'}   duration: ${facts.durationMs ?? 'n/a'}ms`,
    `Failed step: ${facts.failedStep ?? 'n/a'}`,
    `Error message: ${facts.errorMessage ?? 'n/a'}`,
    `Funnel (run_steps):\n${funnel}`,
    `Trace signals — first-party console errors (the monitored site's OWN errors — the signal):\n${consoleBlock}` +
      (facts.thirdPartyConsoleErrorCount
        ? `\n  (+ ${facts.thirdPartyConsoleErrorCount} third-party/tracker console errors omitted as noise)`
        : ''),
    `Trace signals — failed network requests:\n${netBlock}`,
    `Recent run history (newest first): ${facts.recent.length ? facts.recent.join(', ') : '(none)'}`,
    `Multi-location: failing from ${facts.verdict.failing} of ${facts.verdict.total} location(s).`,
    `CITE TOKENS — every "observed" item MUST end with [cite: TOKEN] from THIS list (anything else is discarded):\n  ${[...cite].join(', ')}`,
  ].join('\n');

  return { text, citeIndex: cite };
}

/**
 * Resolve-or-discard (extends narrative.ts's missingFigures). Every observed item must carry at least one
 * [cite: TOKEN] and every cited TOKEN must be in the fact pack's citeIndex. Returns the list of violations;
 * a non-empty list means the whole generation is discarded (a cited artifact that isn't in the evidence is a
 * fabrication) and the caller falls back to a facts-only deterministic result.
 */
export function validateCites(observed: string[], citeIndex: Set<string>): string[] {
  const violations: string[] = [];
  for (const item of observed) {
    const cites = [...item.matchAll(/\[cite:\s*([^\]]+)\]/gi)].map((m) => m[1].trim());
    if (cites.length === 0) {
      violations.push(`no-cite: ${item.slice(0, 60)}`);
      continue;
    }
    for (const c of cites) if (!citeIndex.has(c)) violations.push(`unresolved-cite: ${c}`);
  }
  return violations;
}

/**
 * Is the evidence too thin to attribute a cause? True when there's no artifact a cause could rest on — no
 * failed step, no first-party console error, no failed network request, no HTTP status. error_message alone
 * does NOT lift this (for a browser check it can NAME a false cause — the whole trap) — except for non-browser
 * checks where the message is a direct network-level observation (ECONNREFUSED / TLS / timeout).
 */
export function evidenceThin(facts: RcaFacts): boolean {
  const stepFailed = facts.steps.some((s) => s.status === 'fail' || s.status === 'error');
  const msgIsDirect =
    facts.errorMessage != null && facts.kind !== 'browser' && facts.kind !== 'multistep';
  const hasCorroboration =
    stepFailed ||
    facts.firstPartyConsole.length > 0 ||
    facts.netFailed.length > 0 ||
    facts.httpStatus != null ||
    msgIsDirect;
  return !hasCorroboration;
}

/**
 * The deterministic result used when the model output is discarded (cite-miss / model failure) or the
 * evidence is thin (abstain). Facts-only: observed carries ONLY cited facts, inferred is ALWAYS empty (no
 * cause is asserted), confidence is low. `abstain` swaps the summary for the explicit insufficient-evidence line.
 */
export function deterministicResult(facts: RcaFacts, signature: string, abstain: boolean): RcaResult {
  const observed: string[] = [];
  if (facts.failedStep) observed.push(`Failed at step "${facts.failedStep}" [cite: failed_step]`);
  const passed = facts.steps.filter((s) => s.status === 'pass').map((s) => s.name);
  if (passed.length) observed.push(`Earlier steps passed: ${passed.join(', ')} [cite: run_steps]`);
  if (facts.errorMessage) observed.push(`Error message: "${facts.errorMessage.slice(0, 140)}" [cite: error_message]`);
  if (facts.httpStatus != null) observed.push(`HTTP status ${facts.httpStatus} [cite: http_status]`);
  if (facts.firstPartyConsole.length) {
    const h = facts.firstPartyConsole[0].sourceHost || '?';
    observed.push(
      `${facts.firstPartyConsole.length} first-party console error(s) captured, incl. @${h} [cite: console:${h}]`,
    );
  }
  if (facts.netFailed.length) {
    const h = facts.netFailed[0].host;
    observed.push(`${facts.netFailed.length} failed network request(s), incl. ${h} [cite: network:${h}]`);
  }

  const classification: Classification =
    facts.httpStatus != null && facts.httpStatus >= 500 ? 'real-outage' : 'flaky-transient';
  const summary = abstain
    ? 'insufficient evidence to attribute a cause'
    : `Failed${facts.failedStep ? ` at ${facts.failedStep}` : ''}${
        passed.length ? `; ${passed.length} earlier step(s) passed` : ''
      }. No cause inferred from the available evidence — see the error message and captured signals.`;

  return {
    classification,
    confidence: 'low',
    observed,
    inferred: [], // ★ facts-only / abstain: NEVER an inferred cause on discarded or thin evidence.
    summary,
    signature,
    model: null,
    cached: false,
    generated_at: new Date().toISOString(),
  };
}

/** Gather facts + screenshots + render the prompt. Screenshots stay separate (multimodal user content). */
async function gatherContext(
  check: Check,
  run: RunRecord,
  verdict: { failing: number; total: number },
): Promise<{
  facts: RcaFacts;
  text: string;
  citeIndex: Set<string>;
  failureB64: string | null;
  baselineB64: string | null;
}> {
  const { facts, screenshotUrl } = await gatherFacts(check, run, verdict);
  // ★ B10: a SENSITIVE monitor's RCA is TEXT-ONLY — never send screenshots to the (3rd-party) AI: a
  // rendered cart/auth page shows cart contents / logged-in name·email·address. The runner already stores no
  // screenshots for sensitive monitors, so these are normally null anyway; this is the explicit guard.
  const failureB64 = check.sensitive ? null : await downloadBlobBase64(screenshotUrl);
  const baselineB64 = check.sensitive ? null : await downloadBlobBase64(check.baseline_screenshot_url);
  const { text, citeIndex } = renderFactPack(facts);
  const withShots = [
    text,
    `Failure screenshot: ${failureB64 ? 'attached' : 'not available'}`,
    `Last passing (baseline) screenshot: ${baselineB64 ? 'attached for visual diff' : 'not available'}`,
  ].join('\n');
  return { facts, text: withShots, citeIndex, failureB64, baselineB64 };
}

/**
 * Managed-identity options for DefaultAzureCredential. The runner runs under a
 * USER-ASSIGNED-only MI (no system-assigned), and a bare DefaultAzureCredential can't
 * resolve WHICH identity to use in that case -> "ChainedTokenCredential authentication
 * failed" -> RCA token acquisition fails (the intermittent-RCA root cause, masked by the
 * 24h cache). Pin the user-assigned MI's client id from AZURE_CLIENT_ID. Unset (local /
 * system-assigned envs) -> bare DefaultAzureCredential, unchanged. Exported so a test can
 * assert the pinning decision without a live token.
 */
export function credentialOptions(): { managedIdentityClientId: string } | undefined {
  const clientId = process.env.AZURE_CLIENT_ID;
  return clientId ? { managedIdentityClientId: clientId } : undefined;
}

let credential: TokenCredential | null = null;
async function getAadToken(): Promise<string> {
  if (!credential) {
    const opts = credentialOptions();
    credential = opts ? new DefaultAzureCredential(opts) : new DefaultAzureCredential();
  }
  const token = await credential.getToken(SCOPE);
  if (!token?.token) throw new Error('no AAD token for cognitive-services scope');
  return token.token;
}

/** Look up a recent RCA for the same failure signature on this check (cost + consistency). */
async function cacheLookup(checkId: number, signature: string): Promise<RcaResult | null> {
  const { rows } = await pool.query<{ rca: RcaResult }>(
    `SELECT rca FROM incidents
      WHERE check_id = $1 AND rca IS NOT NULL AND rca->>'signature' = $2
        AND opened_at > now() - $3::interval
      ORDER BY opened_at DESC LIMIT 1`,
    [checkId, signature, CACHE_TTL],
  );
  return rows[0]?.rca ?? null;
}

/** Pull the JSON object out of a model response — tolerant of markdown fences or
 *  leading/trailing prose (response_format json_object should prevent these, but be
 *  robust). Returns the outermost {...} slice. */
function extractJson(content: string): string {
  let s = content.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  return s;
}

function parseResult(content: string, signature: string): RcaResult | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(extractJson(content)) as Record<string, unknown>;
  } catch (err) {
    console.warn(`[rca] parse failed: JSON.parse error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  const classification = obj.classification as Classification;
  const confidence = obj.confidence as Confidence;
  if (!CLASSIFICATIONS.includes(classification)) {
    console.warn(`[rca] parse failed: off-taxonomy classification ${JSON.stringify(obj.classification)}`);
    return null;
  }
  if (!CONFIDENCES.includes(confidence)) {
    console.warn(`[rca] parse failed: invalid confidence ${JSON.stringify(obj.confidence)}`);
    return null;
  }
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 6) : [];
  return {
    classification,
    confidence,
    observed: arr(obj.observed),
    inferred: arr(obj.inferred),
    summary: typeof obj.summary === 'string' ? obj.summary.slice(0, 1000) : '',
    signature,
    model: DEPLOYMENT ?? null,
    cached: false,
    generated_at: new Date().toISOString(),
  };
}

/**
 * Run AI root-cause analysis for an incident-opening failure. Returns the structured
 * result, or null if RCA is off / cached-miss errored / the model failed. NEVER throws.
 */
export async function runRca(
  check: Check,
  run: RunRecord,
  verdict: { failing: number; total: number },
): Promise<RcaResult | null> {
  if (!rcaEnabled()) return null;
  const signature = signatureOf(check.id, run.error_message, run.failed_step);

  try {
    // Pattern-cache: identical (check_id + error + failed_step) RCA'd recently? Reuse it.
    const cached = await cacheLookup(check.id, signature);
    if (cached) return { ...cached, cached: true, generated_at: new Date().toISOString() };

    const ctx = await gatherContext(check, run, verdict);

    // ★ ABSTAIN (the one genuinely new state): no artifact a cause could rest on — an infra_error with empty
    // trace, a bare "browser context closed" with no steps/console/network. Do NOT ask the model to guess;
    // return the explicit insufficient-evidence result (confidence low, EMPTY inferred). Cheap and safe — the
    // model can't confabulate a cause it was never asked for.
    if (evidenceThin(ctx.facts)) {
      console.log('[rca] evidence thin — abstaining (insufficient evidence to attribute a cause)');
      return deterministicResult(ctx.facts, signature, true);
    }

    const token = await getAadToken();

    // Multimodal user content: the structured facts + the screenshot(s).
    const userContent: unknown[] = [{ type: 'text', text: ctx.text }];
    if (ctx.failureB64) {
      userContent.push({ type: 'text', text: 'Failure screenshot:' });
      userContent.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${ctx.failureB64}` } });
    }
    if (ctx.baselineB64) {
      userContent.push({ type: 'text', text: 'Last passing (baseline) screenshot for visual diff:' });
      userContent.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${ctx.baselineB64}` } });
    }

    const url = `${ENDPOINT!.replace(/\/$/, '')}/openai/deployments/${DEPLOYMENT}/chat/completions?api-version=${API_VERSION}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const body: Record<string, unknown> = {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      max_completion_tokens: MAX_TOKENS,
      response_format: { type: 'json_object' },
    };
    if (REASONING_EFFORT) body.reasoning_effort = REASONING_EFFORT;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    // Funnel telemetry — make every exit path observable from logs alone.
    console.log(`[rca] model HTTP ${res.status}`);
    if (!res.ok) {
      console.warn(`[rca] model returned ${res.status} ${res.statusText} (non-fatal); incident records without RCA`);
      return null;
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: unknown;
    };
    const choice = json.choices?.[0];
    const content = choice?.message?.content;
    const finishReason = choice?.finish_reason ?? 'unknown';
    // usage carries completion/reasoning token counts (no prompt content, non-sensitive).
    console.log(
      `[rca] finish_reason=${finishReason} content_len=${content?.length ?? 0} usage=${JSON.stringify(json.usage ?? {})}`,
    );
    // Truncation surfaces two ways on a reasoning model: empty content (all budget
    // spent on hidden reasoning) OR a non-empty PARTIAL that then fails to parse.
    // Emit the actionable hint whenever finish_reason='length', not only when empty,
    // so a truncated-but-non-empty response isn't diagnosed as a generic parse error.
    if (finishReason === 'length') {
      console.warn(
        `[rca] finish_reason=length — output TRUNCATED, raise RCA_MAX_TOKENS (content_len=${content?.length ?? 0})`,
      );
    }
    if (!content) {
      console.warn(`[rca] empty model content (finish_reason=${finishReason}) — no RCA`);
      return null;
    }
    const result = parseResult(content, signature);
    if (!result) return null; // off-shape / parse failure — a model failure, non-fatal (incident records without RCA).

    // ★ RESOLVE-OR-DISCARD (extends narrative.ts's missingFigures): every observed claim must cite an artifact
    // that is actually in the fact pack. A fabricated cite (a host / step / fingerprint the run never captured)
    // invalidates the WHOLE generation → fall back to a facts-only deterministic summary (no inferred cause) —
    // the same discard-on-miss the narrative already uses for invented $ / unsupported deploy-sha.
    const violations = validateCites(result.observed, ctx.citeIndex);
    if (violations.length) {
      console.warn(`[rca] DISCARDED — unresolved/absent citations: ${violations.join('; ')} — facts-only fallback`);
      return deterministicResult(ctx.facts, signature, false);
    }
    console.log(`[rca] parsed OK: ${result.classification} (${result.confidence})`);
    return result;
  } catch (err) {
    console.warn('[rca] failed (non-fatal):', err instanceof Error ? err.message : err);
    return null;
  }
}
