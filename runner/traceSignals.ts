// Per-run trace SIGNALS — a compact, filtered summary extracted from a run's Playwright trace zip AT CAPTURE
// TIME (the runner already holds the zip; no 18 MB re-download). Persisted to runs.trace_signals (0040) so
// trace-diff (baseline↔failure) + console-error trending read JSON, not zips.
//
// ★ This is a FAITHFUL PORT of the API's Infrastructure/TraceExtractor.cs (itself a port of
//   docs/proposals/prototype/extract_trace.py, proven on real run 844486) — SAME signals, SAME thresholds,
//   SAME console filter + extension denylist, SAME caps, SAME camelCase wire shape. The persisted JSON MUST
//   match what GetTraceSignals returns so trace-diff + ai-insights agree on one schema. Do NOT diverge here;
//   change both sides together. Pure + non-fatal: a missing entry / unparseable line yields an empty section.
import AdmZip from 'adm-zip';
import { type Redactor, IDENTITY_REDACTOR } from './redact.js';

// ── output shape (camelCase — matches TraceSignalsDto serialized with JsonSerializerDefaults.Web) ──────────
export interface TraceRequest {
  url: string;
  status: number;
  resourceType: string;
  timeMs: number;
  waitMs: number;
  size: number;
  wire: number;
  encoding: string;
  thirdParty: boolean;
}
export interface ThirdParty {
  host: string;
  count: number;
  kb: number;
}
// A MUTATING request (POST/PUT/PATCH/DELETE) + the status the site returned — "the action under test". Mirrors
// the API's MutationDto (Dtos/TraceSignalsDto.cs): field order method/url/status, camelCase on the wire.
export interface Mutation {
  method: string;
  url: string;
  status: number;
}
export interface NetworkSummary {
  totalRequests: number;
  wireKb: number;
  thirdPartyCount: number;
  failed: TraceRequest[];
  slowest: TraceRequest[];
  largest: TraceRequest[];
  uncompressed: TraceRequest[];
  topThirdParties: ThirdParty[];
  mutations: Mutation[];
}
export interface ConsoleMessage {
  level: string;
  origin: string;
  text: string;
}
export interface ConsoleSummary {
  messages: ConsoleMessage[];
  droppedInfoLog: number;
  droppedExtensionNoise: number;
}
export interface TraceSignals {
  targetHost: string | null;
  network: NetworkSummary;
  console: ConsoleSummary;
}

const EMPTY_NETWORK: NetworkSummary = {
  totalRequests: 0,
  wireKb: 0,
  thirdPartyCount: 0,
  failed: [],
  slowest: [],
  largest: [],
  uncompressed: [],
  topThirdParties: [],
  mutations: [],
};
const EMPTY_CONSOLE: ConsoleSummary = { messages: [], droppedInfoLog: 0, droppedExtensionNoise: 0 };

// ★ Browser-EXTENSION console noise — a trace captured/opened with extensions is NOT the monitored site.
// Matched against the message text AND its source url. THE load-bearing correctness filter; ported VERBATIM.
const EXTENSION_NOISE =
  /grammarly|recorder\.contentScripts|contentscript|message port closed|DEFAULT root logger|AAA-init|chrome-extension:\/\/|moz-extension:\/\//i;

// Assets where missing compression is a real concern (a big image isn't "uncompressed", just large).
const TEXT_TYPES = new Set(['script', 'stylesheet', 'document', 'fetch', 'xhr']);

// ★ Methods whose request mutates state — "the action under test" for cart/auth/submit monitors. Matched
// case-insensitively (uppercased before the lookup), matching C# MutatingMethods (StringComparer.OrdinalIgnoreCase).
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MUTATION_CAP = 12;

const TOP_N = 5;
const FAILED_CAP = 8;
const THIRD_PARTY_CAP = 6;
const UNCOMPRESSED_MIN_BYTES = 30_000;
// ★ Hard cap on console messages so a pathological trace can't blow the downstream AOAI token budget.
const MAX_CONSOLE_MESSAGES = 40;

/**
 * Open the trace zip + extract both sections. Non-fatal: a bad/locked zip → null (so trace_signals stays
 * null). A valid zip with no notable signals → a well-shaped, mostly-empty object (0 errors IS a signal).
 * Only reads the two small NDJSON entries (trace.network, trace.trace) — NOT the multi-MB resources/.
 */
export function extractTraceSignals(
  zipPath: string,
  targetUrl: string | null,
  redact: Redactor = IDENTITY_REDACTOR,
): TraceSignals | null {
  const targetHost = hostOf(targetUrl ?? '') || null;
  try {
    const zip = new AdmZip(zipPath);
    const networkNdjson = entryText(zip, 'trace.network');
    const traceNdjson = entryText(zip, 'trace.trace');
    if (networkNdjson === null && traceNdjson === null) return null; // not a Playwright trace
    return {
      targetHost,
      network: networkNdjson !== null ? extractNetwork(networkNdjson, targetHost) : EMPTY_NETWORK,
      console: traceNdjson !== null ? extractConsole(traceNdjson, targetHost, redact) : EMPTY_CONSOLE,
    };
  } catch {
    return null; // bad zip / read error — non-fatal
  }
}

function entryText(zip: AdmZip, name: string): string | null {
  const e = zip.getEntry(name);
  return e ? e.getData().toString('utf8') : null;
}

// ── network ───────────────────────────────────────────────────────────────────────────────────────────────
interface Req {
  url: string;
  status: number;
  rtype: string;
  time: number;
  wait: number;
  size: number;
  wire: number;
  enc: string;
  third: boolean;
  method: string;
}

export function extractNetwork(
  networkNdjson: string,
  targetHost: string | null,
): NetworkSummary {
  const reqs: Req[] = [];
  for (const line of lines(networkNdjson)) {
    const root = tryParse(line);
    if (!root || root.type !== 'resource-snapshot' || !isObj(root.snapshot)) continue;
    const s = root.snapshot;
    const req = isObj(s.request) ? s.request : {};
    const resp = isObj(s.response) ? s.response : {};
    const content = isObj(resp.content) ? resp.content : {};
    const url = str(req.url);
    reqs.push({
      url,
      status: int(resp.status),
      rtype: str(s._resourceType),
      time: roundHalfEven(dbl(s.time)),
      wait: roundHalfEven(isObj(s.timings) ? dbl(s.timings.wait) : 0),
      size: int(content.size),
      wire: int(resp._transferSize),
      enc: header(resp, 'content-encoding'),
      third: !isSite(hostOf(url), targetHost),
      method: str(req.method),
    });
  }

  // Store the url RAW — byte-matching C# (TraceRequestDto Slim stores r.Url; FromZip has no redactor). Network
  // urls are NEVER redacted, completing the raw-URL parity #171 started for mutation urls: a divergence here (as
  // the runner did before) only shows on a sensitive input, which the golden guard can't see. Redaction on the
  // persist path is now scoped to console TEXT only (extractConsole below), not network urls.
  const slim = (r: Req): TraceRequest => ({
    url: r.url,
    status: r.status,
    resourceType: r.rtype,
    timeMs: r.time,
    waitMs: r.wait,
    size: r.size,
    wire: r.wire,
    encoding: r.enc,
    thirdParty: r.third,
  });

  // third-party grouping by real origin (host-less blob:/data: excluded), top by wire KB.
  const byHost = new Map<string, { count: number; wire: number }>();
  for (const r of reqs) {
    if (!r.third) continue;
    const h = hostOf(r.url);
    if (h.length === 0) continue;
    const cur = byHost.get(h) ?? { count: 0, wire: 0 };
    cur.count += 1;
    cur.wire += r.wire;
    byHost.set(h, cur);
  }
  const topThirdParties: ThirdParty[] = [...byHost.entries()]
    .map(([host, v]) => ({ host, count: v.count, kb: Math.trunc(v.wire / 1024) }))
    .sort((a, b) => b.kb - a.kb)
    .slice(0, THIRD_PARTY_CAP);

  // OrderByDescending is stable (V8 Array.sort is stable) → first-seen order preserved within ties, matching C#.
  const byDesc = (key: (r: Req) => number) => [...reqs].sort((a, b) => key(b) - key(a));

  return {
    totalRequests: reqs.length,
    wireKb: Math.trunc(reqs.reduce((acc, r) => acc + r.wire, 0) / 1024),
    thirdPartyCount: reqs.filter((r) => r.third).length,
    failed: reqs
      .filter((r) => r.status >= 400)
      .slice(0, FAILED_CAP)
      .map(slim),
    slowest: byDesc((r) => r.time)
      .slice(0, TOP_N)
      .map(slim),
    largest: byDesc((r) => r.size)
      .slice(0, TOP_N)
      .map(slim),
    uncompressed: reqs
      .filter((r) => TEXT_TYPES.has(r.rtype) && r.enc.length === 0 && r.size > UNCOMPRESSED_MIN_BYTES)
      .sort((a, b) => b.size - a.size)
      .slice(0, TOP_N)
      .map(slim),
    topThirdParties,
    // ★ The action(s) under test: every mutating request + the status the site returned, in first-seen order,
    // capped at 12 — mirrors C# TraceExtractor.ExtractNetwork's Mutations (Where(MutatingMethods).Take(12)).
    // ★ The url is stored RAW — NOT redacted — to byte-match C# (MutationDto(r.Method, r.Url, r.Status): FromZip
    // has no redactor, so it stores the raw url). This is a faithful-port parity requirement: redacting here
    // (as #169 did) diverges from C# on a sensitive input — the exact drift the golden guard exists to prevent.
    mutations: reqs
      .filter((r) => MUTATING_METHODS.has(r.method.toUpperCase()))
      .slice(0, MUTATION_CAP)
      .map((r) => ({ method: r.method, url: r.url, status: r.status })),
  };
}

// ── console (the filter) ────────────────────────────────────────────────────────────────────────────────────
export function extractConsole(
  traceNdjson: string,
  targetHost: string | null,
  redact: Redactor = IDENTITY_REDACTOR,
): ConsoleSummary {
  const kept: ConsoleMessage[] = [];
  const seen = new Set<string>();
  let droppedLevel = 0;
  let droppedExt = 0;

  for (const line of lines(traceNdjson)) {
    const root = tryParse(line);
    if (!root || root.type !== 'console') continue;
    const level = str(root.messageType) || 'log';
    // Redact BEFORE dedup/slice so a session token the site logs is scrubbed uniformly (no-op for
    // non-sensitive monitors). The location url is only host-derived for `origin`, never stored.
    const text = redact(str(root.text).trim());
    const loc = isObj(root.location) ? str(root.location.url) : '';

    if (level !== 'error' && level !== 'warning') {
      droppedLevel++; // info/log chatter
      continue;
    }
    if (EXTENSION_NOISE.test(text) || EXTENSION_NOISE.test(loc)) {
      droppedExt++;
      continue;
    }
    const key = level + '|' + text.slice(0, 80);
    if (seen.has(key)) continue; // dedupe repeats
    seen.add(key);

    kept.push({
      level,
      origin: isSite(hostOf(loc), targetHost) ? 'site' : 'third-party',
      text: text.slice(0, 200),
    });
  }

  // Bound the list, keeping the most relevant: the site's own errors first, then warnings/third-party.
  // Composite score (error is the high bit, site the low bit) reproduces OrderByDesc(error).ThenByDesc(site);
  // V8 sort is stable, so first-seen order is preserved within each tier.
  const score = (m: ConsoleMessage) => (m.level === 'error' ? 2 : 0) + (m.origin === 'site' ? 1 : 0);
  const messages = [...kept].sort((a, b) => score(b) - score(a)).slice(0, MAX_CONSOLE_MESSAGES);
  return { messages, droppedInfoLog: droppedLevel, droppedExtensionNoise: droppedExt };
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────
function* lines(s: string): Generator<string> {
  for (const line of s.split('\n')) if (line.length > 0) yield line;
}

function tryParse(line: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(line);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Host (no port) for real http(s) urls only — blob:/data:/about: have no host (→ third-party), matching the
// prototype. Mirrors C# Uri.Host (hostname, port excluded).
function hostOf(url: string): string {
  if (!url.startsWith('http://') && !url.startsWith('https://')) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function isSite(host: string, target: string | null): boolean {
  if (!target || host.length === 0) return false;
  const h = host.toLowerCase();
  const t = target.toLowerCase();
  return h === t || h.endsWith('.' + t);
}

function header(resp: Record<string, unknown>, name: string): string {
  const hs = resp.headers;
  if (!Array.isArray(hs)) return '';
  for (const h of hs) {
    if (isObj(h) && str(h.name).toLowerCase() === name.toLowerCase()) return str(h.value);
  }
  return '';
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function int(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0;
}
function dbl(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
// C# (int)Math.Round(x) — banker's rounding (half-to-even), matching Python round(); timings are ≥ 0.
function roundHalfEven(x: number): number {
  if (Math.abs(x - Math.trunc(x)) === 0.5) {
    const f = Math.floor(x);
    return f % 2 === 0 ? f : f + 1;
  }
  return Math.round(x);
}
