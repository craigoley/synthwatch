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
  "observed": [up to 5 short strings — FACTS taken directly from the error message, HTTP status, failed step, funnel, screenshot, or run history. Only what the evidence literally shows.],
  "inferred": [up to 4 short strings — HYPOTHESES that follow from the observed facts; each is a reasoning step, NOT a fact.],
  "summary": "one or two plain-English sentences for the on-call engineer."
}

Classification definitions:
- real-outage: the target itself is genuinely down/erroring (5xx, connection refused, the page/endpoint truly broken).
- flaky-transient: intermittent, likely self-resolving (a one-off timeout/blip); run history is mostly passing.
- selector-drift: (browser/multistep) the PAGE changed so the check's selector/assertion is now stale — the MONITOR needs updating, not the target. Signals: an element/locator not found while the page otherwise rendered; a screenshot showing a working page with a moved/renamed/removed element.
- environment-regional: an infra/network/regional blip — especially if only SOME locations are failing.
- perf-regression: slow, not broken — a latency/timeout/budget issue rather than a hard error.

HONESTY (critical): clearly separate OBSERVED facts from INFERRED hypotheses. LLMs tend to generate plausible-sounding but incorrect explanations — do NOT. If the evidence is thin or ambiguous, return LOW confidence and put MULTIPLE candidate causes in "inferred" rather than inventing one confident cause. Never state as observed anything the evidence does not literally show. An honest low-confidence answer beats a confident wrong one.`;

interface StepRow {
  step_index: number;
  name: string;
  status: string;
  error_message: string | null;
}

/** Gather the rich signal: run facets, funnel, recent history, screenshots. */
async function gatherContext(
  check: Check,
  run: RunRecord,
  verdict: { failing: number; total: number },
): Promise<{ text: string; failureB64: string | null; baselineB64: string | null }> {
  // Run facets not on RunRecord.
  const runRow = (
    await pool.query<{ http_status: number | null; duration_ms: number | null; screenshot_url: string | null }>(
      `SELECT http_status, duration_ms, screenshot_url FROM runs WHERE id = $1`,
      [run.id],
    )
  ).rows[0];

  // The funnel (browser/multistep): which step failed.
  const steps = (
    await pool.query<StepRow>(
      `SELECT step_index, name, status, error_message FROM run_steps WHERE run_id = $1 ORDER BY step_index`,
      [run.id],
    )
  ).rows;
  const funnel = steps.length
    ? steps
        .map((s) => `  step ${s.step_index} "${s.name}" [${s.status}]${s.error_message ? `: ${s.error_message.slice(0, 120)}` : ''}`)
        .join('\n')
    : '  (none — not a stepped check)';

  // Recent history: NEW vs RECURRING (a long pass streak that broke vs chronically flaky).
  const recent = (
    await pool.query<{ status: string }>(
      `SELECT status FROM runs WHERE check_id = $1 AND id <> $2 AND status <> 'running'
        ORDER BY started_at DESC LIMIT 15`,
      [check.id, run.id],
    )
  ).rows.map((r) => r.status);

  // Most-recent-passing screenshot as the visual-diff baseline. The runner stores it
  // per check (checks.baseline_screenshot_url), overwritten on each passing browser
  // run (see executeBrowser/runOne) — so a browser check that has passed since the
  // feature shipped has a baseline to compare the failure against. NULL otherwise.
  const failureB64 = await downloadBlobBase64(runRow?.screenshot_url ?? null);
  const baselineB64 = await downloadBlobBase64(check.baseline_screenshot_url);

  const text = [
    `Check: "${check.name}" (kind=${check.kind}, target=${check.target_url})`,
    `Run status: ${run.status}   HTTP status: ${runRow?.http_status ?? 'n/a'}   duration: ${runRow?.duration_ms ?? 'n/a'}ms`,
    `Failed step: ${run.failed_step ?? 'n/a'}`,
    `Error message: ${run.error_message ?? 'n/a'}`,
    `Funnel (run_steps):\n${funnel}`,
    `Recent run history (newest first): ${recent.length ? recent.join(', ') : '(none)'}`,
    `Multi-location: failing from ${verdict.failing} of ${verdict.total} location(s).`,
    `Failure screenshot: ${failureB64 ? 'attached' : 'not available'}`,
    `Last passing (baseline) screenshot: ${baselineB64 ? 'attached for visual diff' : 'not available'}`,
  ].join('\n');

  return { text, failureB64, baselineB64 };
}

let credential: TokenCredential | null = null;
async function getAadToken(): Promise<string> {
  credential ??= new DefaultAzureCredential();
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
    if (!content) {
      const hint = finishReason === 'length' ? ' (TRUNCATED — raise RCA_MAX_TOKENS)' : '';
      console.warn(`[rca] empty model content (finish_reason=${finishReason})${hint} — no RCA`);
      return null;
    }
    const result = parseResult(content, signature);
    if (result) console.log(`[rca] parsed OK: ${result.classification} (${result.confidence})`);
    return result;
  } catch (err) {
    console.warn('[rca] failed (non-fatal):', err instanceof Error ? err.message : err);
    return null;
  }
}
