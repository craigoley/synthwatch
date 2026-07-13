// Per-run trace SIGNALS — a compact, filtered summary extracted from a run's Playwright trace zip AT CAPTURE
// TIME (the runner already holds the zip; no 18 MB re-download). Persisted to runs.trace_signals (0040) so
// trace-diff (baseline↔failure) + console-error trending read JSON, not zips.
//
// ★ This is a FAITHFUL PORT of the API's Infrastructure/TraceExtractor.cs (itself a port of
//   docs/proposals/prototype/extract_trace.py, proven on real run 844486) — SAME signals, SAME thresholds,
//   SAME console filter + extension denylist, SAME caps, SAME camelCase wire shape. The persisted JSON MUST
//   match what GetTraceSignals returns so trace-diff + ai-insights agree on one schema. Do NOT diverge here;
//   change both sides together. Pure + non-fatal: a missing entry / unparseable line yields an empty section.
import yauzl from 'yauzl';
import { type Redactor, IDENTITY_REDACTOR } from './redact.js';
import { isFirstParty } from './firstPartyHosts.js';

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
  // ★ Error-diff P1: the host of the RESOURCE this error is about — parsed from the first URL in the error
  // text, else the logging frame's host. Drives `origin` (via the first-party allowlist) and is a component
  // of the per-error diff fingerprint (synthwatch-api TraceSignalsDiff). '' when no host is derivable.
  sourceHost: string;
  text: string;
}
export interface ConsoleSummary {
  messages: ConsoleMessage[];
  droppedInfoLog: number;
  droppedExtensionNoise: number;
  // ★ Error-class messages (error/warning/pageerror) dropped by the MAX_CONSOLE_MESSAGES cap. info/log
  // chatter is already excluded up front (droppedInfoLog) so an error is NEVER dropped in favour of an
  // info log; this makes the REMAINING truncation (errors beyond the cap) HONEST instead of silent — a
  // diff over a silently-truncated error set would be unreliable. 0 = nothing preserved was dropped.
  droppedError: number;
  // ★ droppedError SPLIT BY first-party-ness (droppedThirdParty + droppedFirstParty === droppedError). The
  // drop-policy ranks first-party ABOVE third-party (see the score below), so at the cap third-party is
  // dropped FIRST — droppedFirstParty is > 0 ONLY once ALL third-party is gone AND first-party alone still
  // overflows the cap (a genuine first-party flood). This lets the panel be HONEST *and* INFORMATIVE: a
  // truncation that lost only tracker noise ("N third-party dropped — first-party complete") is very
  // different from one that lost first-party signal (stay LOUD). Both default 0 (older rows read as 0).
  droppedThirdParty: number;
  droppedFirstParty: number;
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
const EMPTY_CONSOLE: ConsoleSummary = {
  messages: [],
  droppedInfoLog: 0,
  droppedExtensionNoise: 0,
  droppedError: 0,
  droppedThirdParty: 0,
  droppedFirstParty: 0,
};

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
// Sized from the real distribution of check 355 (wegmans-full-shop-flow, the worst offender): first-party
// (error+warning) peaks at 37/run and all error-class at 33/run, so 80 keeps EVERY first-party message with
// >2× headroom (a first-party truncation would need an unprecedented 80+ first-party fingerprints) while
// still capturing a healthy slice of third-party context. Row cost is trivial — ~245 B/message, so +40
// messages is ~10 KB uncompressed (single-digit KB in the TOASTed jsonb the diff reads 5× per request).
// Because the drop-policy ranks first-party first, the cap governs how much THIRD-PARTY is kept, not whether
// first-party survives.
const MAX_CONSOLE_MESSAGES = 80;

// The only two entries we read; everything else in the zip (the screencast resources/*.jpeg bulk) is skipped.
const TRACE_NETWORK = 'trace.network';
const TRACE_TRACE = 'trace.trace';

/**
 * Open the trace zip + extract both sections. Returns null when the zip is a VALID zip that simply isn't a
 * Playwright trace (neither NDJSON entry present) — a legitimate, quiet outcome. A valid zip with no notable
 * signals → a well-shaped, mostly-empty object (0 errors IS a signal).
 *
 * ★ STREAMING (was in-memory AdmZip): a long browser flow's trace is large, and `new AdmZip(zipPath)`
 * `readFileSync`s the ENTIRE zip — screencast jpegs included — into a Buffer before reading a single entry.
 * That was the peak, and it ran on EVERY traced run (before the streamed redacted-zip rebuild), stranding
 * run #936920 (exit 137) once check 355's 5-min shop flow produced a ~124MB trace. This mirrors
 * buildRedactedTraceZip (yauzl, #253): the zip is walked one entry at a time (lazyEntries); the two small
 * NDJSON entries are the ONLY ones ever opened + decompressed, and each is turned into its compact summary
 * and DROPPED the instant its stream ends — so peak memory is bounded to the LARGER of the two text entries,
 * NOT the whole trace / the screencast bulk. Everything else is skipped WITHOUT a read stream (never
 * decompressed). The extracted signals are BYTE-IDENTICAL to the AdmZip path (same Buffer→utf8 of the same
 * two entries, same extractNetwork/extractConsole) — the golden-parity test is the byte contract.
 *
 * ★ FAIL LOUD, never silently empty: a corrupt / truncated / unreadable zip REJECTS with a clear error (the
 * caller logs it, non-fatal, and trace_signals stays null) rather than resolving an all-zeros summary that
 * would look like a successful empty extraction. Only a cleanly-read zip missing both entries resolves null.
 */
export function extractTraceSignals(
  zipPath: string,
  targetUrl: string | null,
  redact: Redactor = IDENTITY_REDACTOR,
): Promise<TraceSignals | null> {
  const targetHost = hostOf(targetUrl ?? '') || null;
  return new Promise<TraceSignals | null>((resolve, reject) => {
    let settled = false;
    const fail = (err: Error, zip?: yauzl.ZipFile): void => {
      if (settled) return;
      settled = true;
      try {
        zip?.close();
      } catch {
        /* ignore */
      }
      reject(err); // LOUD: corrupt/unreadable zip — the caller warns + leaves trace_signals null.
    };

    // Compact summaries, built + retained; the raw NDJSON text of each entry is dropped as soon as its
    // extractor runs (below), so we never hold both raw texts — peak stays bounded to one entry.
    let network: NetworkSummary | null = null;
    let consoleSummary: ConsoleSummary | null = null;

    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (openErr, zip) => {
      if (openErr || !zip) return fail(openErr ?? new Error(`trace zip unreadable: ${zipPath}`));

      zip.on('error', (err: Error) => fail(err, zip));
      zip.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName;
        if (name !== TRACE_NETWORK && name !== TRACE_TRACE) {
          zip.readEntry(); // skip WITHOUT opening a read stream — the jpeg bulk is never decompressed.
          return;
        }
        zip.openReadStream(entry, (streamErr, rs) => {
          if (streamErr || !rs) return fail(streamErr ?? new Error(`cannot read ${name} in ${zipPath}`), zip);
          const chunks: Buffer[] = [];
          rs.on('error', (err: Error) => fail(err, zip));
          rs.on('data', (c: Buffer) => chunks.push(c));
          rs.on('end', () => {
            if (settled) return;
            // Whole-entry decode (identical bytes to AdmZip getData().toString('utf8')), then run the
            // extractor NOW and let the raw text + chunks go out of scope — only the compact summary survives.
            const text = Buffer.concat(chunks).toString('utf8');
            if (name === TRACE_NETWORK) network = extractNetwork(text, targetHost);
            else consoleSummary = extractConsole(text, targetHost, redact);
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => {
        if (settled) return;
        settled = true;
        if (network === null && consoleSummary === null) {
          resolve(null); // valid zip, neither entry — not a Playwright trace (quiet, legitimate).
          return;
        }
        resolve({ targetHost, network: network ?? EMPTY_NETWORK, console: consoleSummary ?? EMPTY_CONSOLE });
      });

      zip.readEntry(); // kick off the lazy walk
    });
  });
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
      third: !isFirstParty(hostOf(url), targetHost),
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
    // ★ FAILED = HTTP errors (status >= 400) AND ABORTS (status <= 0). Playwright records an
    // aborted/blocked/interrupted request (requestfailed — connection killed, CSP-blocked, cancelled
    // mid-flight) as a resource-snapshot whose response.status is -1 (or 0 when there's no response at
    // all). Those were previously DROPPED (>= 400 only), yet an abort is often MORE diagnostic than a
    // 4xx — something got killed. The status itself distinguishes them for a consumer: <= 0 = abort,
    // >= 400 = HTTP error. First-seen order, capped at FAILED_CAP (both classes share the cap).
    failed: reqs
      .filter((r) => r.status >= 400 || r.status <= 0)
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
    if (!root) continue;

    // Two event shapes carry an error signal, BOTH in trace.trace (already in-hand — no extra parse):
    //   • {type:'console', messageType, text, location:{url}} — a console error/warning.
    //   • {type:'event', method:'pageError', params:{error:{error:{message,…}}, location:{url}}} — an
    //     UNCAUGHT page exception. Previously invisible unless the site ALSO console-logged it, so a
    //     browser monitor was blind to real uncaught exceptions. Captured as level='pageerror' (a distinct
    //     category in the SAME messages array — no wire-shape change).
    let level: string;
    let text: string;
    let loc: string;
    if (root.type === 'console') {
      level = str(root.messageType) || 'log';
      // Redact BEFORE dedup/slice so a session token the site logs is scrubbed uniformly (no-op for
      // non-sensitive monitors). The location url is only host-derived for `origin`, never stored.
      text = redact(str(root.text).trim());
      loc = isObj(root.location) ? str(root.location.url) : '';
      if (level !== 'error' && level !== 'warning') {
        droppedLevel++; // info/log chatter — dropped up front, so it can NEVER push out an error below.
        continue;
      }
    } else if (root.type === 'event' && root.method === 'pageError') {
      const params = isObj(root.params) ? root.params : {};
      const errWrap = isObj(params.error) ? params.error : {};
      const err = isObj(errWrap.error) ? errWrap.error : {};
      level = 'pageerror';
      text = redact(str(err.message).trim());
      loc = isObj(params.location) ? str(params.location.url) : '';
      if (text.length === 0) continue; // a pageError with no message carries no signal
    } else {
      continue;
    }

    if (EXTENSION_NOISE.test(text) || EXTENSION_NOISE.test(loc)) {
      droppedExt++;
      continue;
    }
    const key = level + '|' + text.slice(0, 80);
    if (seen.has(key)) continue; // dedupe repeats
    seen.add(key);

    // ★ Error-diff P1: classify by the RESOURCE the error is ABOUT, not the frame that logged it. Prefer the
    // host of the first URL in the error text (a CSP refusal / failed load / websocket names its resource);
    // fall back to the logging frame's host when the text carries none. Keying off the frame alone mislabelled
    // a third-party resource refused by the site frame as origin:'site'.
    const sourceHost = resourceHostFromText(text) || hostOf(loc);
    kept.push({
      level,
      origin: isFirstParty(sourceHost, targetHost) ? 'site' : 'third-party',
      sourceHost,
      text: text.slice(0, 200),
    });
  }

  // Bound the list, ranking by FIRST-PARTY-NESS FIRST, then by severity — so the cap is spent on the errors
  // a Wegmans monitor actually cares about, and tracker noise (doubleclick/emplifi/rlcdn) is dropped BEFORE a
  // wegmans.com / *.wegmans.cloud message. ★ The high bit is `site` (first-party), the low bit is
  // error/pageerror, giving the strict order:
  //     first-party error/pageerror (3) > first-party warning (2) > third-party error/pageerror (1) > third-party warning (0)
  // CSP violations are level 'error' classified by the REFUSED resource's host (P1), so a third-party CSP
  // (rlcdn/doubleclick) folds into tier 1 and a first-party CSP into tier 3 — both correctly ranked by owner.
  // info/log was already excluded up front (droppedInfoLog), so it never competes. V8 sort is stable → first-
  // seen order is preserved within a tier. Previously the bits were reversed (severity high, site low), which
  // kept THIRD-PARTY errors above FIRST-PARTY warnings — evicting real wegmans.com warnings to store tracker
  // errors. First-party errors were already safe (they scored top either way), but first-party warnings were not.
  const score = (m: ConsoleMessage) =>
    (m.origin === 'site' ? 2 : 0) + (m.level === 'error' || m.level === 'pageerror' ? 1 : 0);
  const ranked = [...kept].sort((a, b) => score(b) - score(a));
  const messages = ranked.slice(0, MAX_CONSOLE_MESSAGES);
  const dropped = ranked.slice(MAX_CONSOLE_MESSAGES); // the truncated tail — the LOWEST-ranked (third-party first)
  const droppedError = dropped.length;
  // Split the truncation by owner so the panel can distinguish "we dropped only noise" from "we dropped your
  // signal". Because third-party ranks below all first-party, droppedFirstParty > 0 ⟹ every third-party was
  // ALSO dropped AND first-party alone overflowed the cap — the only case that actually threatens the diff.
  const droppedThirdParty = dropped.reduce((n, m) => n + (m.origin === 'third-party' ? 1 : 0), 0);
  const droppedFirstParty = droppedError - droppedThirdParty;
  return {
    messages,
    droppedInfoLog: droppedLevel,
    droppedExtensionNoise: droppedExt,
    droppedError,
    droppedThirdParty,
    droppedFirstParty,
  };
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

// ★ Error-diff P1: the host of the first URL embedded in an error's text (the resource the error is ABOUT).
// Matches http(s)/ws(s) and captures the authority up to the first path/query/fragment/quote/space; then
// strips userinfo + port. '' when the text carries no URL. FAITHFUL-PORTED — keep byte-identical to the C#
// TraceExtractor.ResourceHostFromText (same regex + strip steps) so the golden fixture agrees.
//
// ASSUMPTION: "first URL ≈ the resource". True for the shapes this targets (CSP "Refused to load '<resource>'",
// "Access to fetch at '<resource>' from origin '<page>'", failed-load/websocket). KNOWN BLIND SPOT: a Mixed
// Content warning emits the PAGE url first and the insecure RESOURCE second, so sourceHost resolves to the
// page (origin:'site') — the frame-vs-resource misclassification this fix removes, for one message family.
// Strictly better than the old exact-host rule; left as-is (a display/fingerprint heuristic, not a boundary).
function resourceHostFromText(text: string): string {
  const m = text.match(/(?:https?|wss?):\/\/([^\s/'"?#)]+)/i);
  if (!m) return '';
  let auth = m[1];
  const at = auth.lastIndexOf('@'); // strip userinfo (user:pass@host)
  if (at >= 0) auth = auth.slice(at + 1);
  const colon = auth.indexOf(':'); // strip port
  if (colon >= 0) auth = auth.slice(0, colon);
  return auth.toLowerCase();
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
