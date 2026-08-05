// REDACTED, REDUCED failure trace for a SENSITIVE monitor — the B10 revision that makes a failed
// credentialed run (sandbox validation included) surface a RETRIEVABLE trace instead of discarding it.
//
// The original B10 line was "a sensitive monitor stores NO trace zip at all" — which made every
// failed run of a credentialed monitor undebuggable from the dashboard (trace captured locally,
// signals extracted, zip unlinked). The revised posture: protect the REAL secrets (the typed login
// credential values, the secret-header bypass token, reusable session material) and store the rest.
//
// What the redacted zip is, entry by entry:
//   • TEXT entries (trace.trace / trace.network / *.stacks NDJSON, and text response bodies —
//     html/js/css/json/svg/…) are KEPT, passed through the monitor's redactor (built-in token
//     denylist + declared redact_patterns + the run's resolved credential/secret-header VALUES as
//     escaped literals) PLUS the structural rules below.
//   • EVERYTHING ELSE is DROPPED — that includes the screencast frames (resources/*.jpeg), which
//     render the logged-in page and cannot be text-scrubbed (same reasoning as the B10 screenshot
//     skip, which is unchanged), and any entry we can't classify (fail-closed). The result opens in
//     the Playwright trace viewer as a "reduced" trace: actions, DOM snapshots, console, network
//     metadata — no film strip, images stripped from snapshot rendering.
//
// Structural rules (on top of the monitor redactor): reusable session material lives in places the
// generic token-shape denylist can't be trusted to catch — HAR header pairs in trace.network
// ({"name":"set-cookie","value":…}) and auth-ish JSON keys in API response bodies
// ({"access_token":…}). Over-redaction is acceptable on a sensitive monitor (redact.ts's stated
// policy); breaking the NDJSON's JSON validity is not, so every rule is escape-aware and rewrites
// only the VALUE inside its quotes.
//
// Fail-closed: buildRedactedTraceZip returns false on ANY problem (bad zip, not a Playwright trace,
// write failure) and the caller uploads NOTHING — a raw byte can never ship because scrubbing broke.
import yauzl from 'yauzl';
import yazl from 'yazl';
import { rmSync, createWriteStream } from 'node:fs';
import type { Redactor } from './redact.js';

const REDACTED = '<redacted>';

// Entries we know how to scrub as text. Playwright trace zips hold: trace.trace / trace.network /
// trace.stacks (NDJSON) + resources/<sha1>.<ext> (network bodies + screencast jpegs). Anything not
// matched here (images, fonts, unknown extensions) is dropped, not kept — fail-closed by default.
// ★ Layout verified EMPIRICALLY against playwright@1.61.1 (the pinned version) with the runner's
// exact tracing options: response bodies DO carry a mime-derived extension — resources/<sha1>.html
// /.css/.json/.png (trace.network's content._sha1 embeds it) — and screencast frames are
// resources/page@<hash>-<ts>.jpeg. So text bodies really are scrubbed-and-kept here, and image
// entries (screencast + body) really are dropped. Re-verify this probe on a Playwright upgrade.
//
// ★★ WHAT THAT PROBE DID NOT COVER, AND WHY EXTENSION-BASED CLASSIFICATION IS THE WEAK POINT. The probe
//    sampled the mimes a page load happens to produce — html/css/json/png — and every one of them maps
//    to a name Playwright recognises. It never saw a mime Playwright CANNOT name. Those land in the
//    `.dat` bucket, and `.dat` was absent from this list, so they dropped silently.
//    OBSERVED 2026-08-05: the Wegmans cart API serves `Content-Type: text/json` (not application/json),
//    so every one of its bodies was written as resources/<sha1>.dat and discarded — ZERO of 15 kept in
//    run 1146366, while 499 `.json` resources from the same run survived.
//    ★ THE LESSON IS ABOUT THE MECHANISM, not the one mime: an extension is a PROXY for content, chosen
//    by the producer from a mime WE do not control, so an empirical sample can only ever show which
//    proxies appeared that day. A mime nobody has emitted yet is indistinguishable from a mime that
//    cannot exist. `.dat` is therefore classified by CONTENT (classifyEntry → 'sniff' →
//    looksLikeRedactableText), which is the only test that does not depend on a naming convention
//    staying complete. The extension list below remains for the mimes Playwright DOES name.
const TEXT_ENTRY = /\.(trace|network|stacks|html?|js|mjs|css|json|txt|svg|xml|csv|map)$/i;

// Auth-ish name fragment shared by both structural rules (mirrors the redact.ts BUILTIN key list —
// with the two promiscuous fragments ANCHORED, since here they match arbitrary JSON keys, not just
// `key=` query params: bare `sid` swallowed re[sid]ence/in[sid]e/pre[sid]ent and bare `auth`
// swallowed [auth]or/[auth]ority, redacting ordinary values and eating the diagnostic signal this
// module exists to preserve. `\bsid\b` / `\bauth\b` still match sid, x-sid, auth, x-auth-key
// (`-` is a word boundary; the surrounding [\w-]* covers the rest), `sess[_-]?id` covers
// sessid/sess_id, and authorization/oauth are explicit. Over-redaction stays acceptable — this only
// trims matches that were never auth-shaped at all.
const AUTHISH =
  '(?:token|session|sess[_-]?id|\\bsid\\b|jwt|bearer|authorization|oauth|\\bauth\\b|secret|password|passwd|pwd|api[_-]?key|cookie|csrf|xsrf|signature)';

// Escape-aware JSON string body: consumes \" and \\ correctly so the rewrite never breaks a line's
// JSON validity (the trace viewer parses every NDJSON line).
const JSON_STR = '(?:[^"\\\\]|\\\\.)*';

// ── ★★ SECRET HEADERS BY EXACT NAME — the rule AUTHISH cannot express ───────────────────────────────
//
// ★ FOUND IN PROD, 2026-08-05: `x-vercel-protection-bypass` was riding trace.network in CLEARTEXT on
//   every retained trace (3,230 occurrences in one run). AUTHISH keys on FRAGMENTS —
//   token|cookie|authorization|secret|api[_-]?key|… — and this header name contains none of them. Its
//   sibling `x-vercel-set-bypass-cookie` WAS redacted, purely by accident, because it contains "cookie".
//
// ★ AUDITING THE OTHER DIRECTION (all 52 request-header names a real trace persists) found a SECOND
//   one: `ocp-apim-subscription-key`, the Azure API Management subscription key. AUTHISH's
//   `api[_-]?key` does not match "apim-subscription-key" — "api" is followed by "m", not by `key` or a
//   separator. It was leaking too.
//
// ★ WHY AN EXACT-NAME LIST AND NOT A WIDER FRAGMENT: fragment-matching is precisely how both of these
//   slipped, and widening it (e.g. adding `bypass` or `key`) trades one silent miss for silent
//   over-redaction of ordinary headers. A name we have DECIDED is secret-bearing is a fact worth
//   writing down, reviewable in a diff, and greppable. Add to this list; do not loosen AUTHISH.
//
// ★ THIS IS THE BACKSTOP, NOT THE PRIMARY DEFENCE. For a secret whose VALUE the runner holds (the
//   Vercel bypass token), the value itself is registered with the run's redactor (runner/index.ts) so
//   it is scrubbed wherever it appears — header, body, URL, console — and a future header RENAME cannot
//   reopen it. This list is what covers the other case: a secret the runner never sees the value of and
//   can only recognise by the name it arrives under (ocp-apim-subscription-key is issued by the site).
const SECRET_HEADER_NAMES = [
  'x-vercel-protection-bypass',
  'ocp-apim-subscription-key',
] as const;
const SECRET_HEADER_ALT = SECRET_HEADER_NAMES.join('|');

const STRUCTURAL: Array<[RegExp, string]> = [
  // 1) HAR-style header pair — {"name":"cookie","value":"…"} / set-cookie / authorization / any
  //    auth-ish header name. This is where the reusable session material (cookies, bearer headers,
  //    the bypass token) actually lives in trace.network and resource-snapshots, whatever shape the
  //    value has (an opaque cookie value matches no generic token regex).
  [
    new RegExp(`("name"\\s*:\\s*"[\\w-]*${AUTHISH}[\\w-]*"\\s*,\\s*"value"\\s*:\\s*")${JSON_STR}(")`, 'gi'),
    `$1${REDACTED}$2`,
  ],
  // 2) Auth-ish JSON key anywhere — {"access_token":"…"}, {"sessionId":"…"}, {"password":"…"} — the
  //    shape API response bodies use, which the query-param/Bearer denylist can't see.
  [new RegExp(`("[\\w-]*${AUTHISH}[\\w-]*"\\s*:\\s*")${JSON_STR}(")`, 'gi'), `$1${REDACTED}$2`],
  // 3) Raw header-text form — "Set-Cookie: session=…" inlined in console/snapshot text. Stops at a
  //    quote so an occurrence embedded in a JSON string keeps that string's closing quote intact.
  //    Escape-aware (matching rules 1-2's JSON_STR): a JSON-escaped quote (\") inside the value is
  //    consumed via `\\.` as part of the value rather than terminating the match early — otherwise
  //    the trailing `\` was eaten, the now-bare `"` closed the JSON string, and the NDJSON line the
  //    trace viewer parses per-line became invalid (the event was silently dropped).
  [/((?:^|[\s"'])(?:cookie|set-cookie|authorization|proxy-authorization)\s*:\s*)(?:\\.|[^"'\r\n\\])+/gi, `$1${REDACTED}`],
  // 4) ★ SECRET HEADERS BY EXACT NAME, HAR pair form — the AUTHISH gap (see SECRET_HEADER_NAMES).
  //    Same escape-aware VALUE-only rewrite as rule 1, so the NDJSON stays parseable per line.
  [
    new RegExp(`("name"\\s*:\\s*"(?:${SECRET_HEADER_ALT})"\\s*,\\s*"value"\\s*:\\s*")${JSON_STR}(")`, 'gi'),
    `$1${REDACTED}$2`,
  ],
  // 5) ★ Same names in raw header-text form ("x-vercel-protection-bypass: …"), for occurrences inlined
  //    in console output or a DOM snapshot rather than a structured HAR pair. Mirrors rule 3.
  [
    new RegExp(`((?:^|[\\s"'])(?:${SECRET_HEADER_ALT})\\s*:\\s*)(?:\\\\.|[^"'\\r\\n\\\\])+`, 'gi'),
    `$1${REDACTED}`,
  ],
];

// ── ★★ `.dat` — THE EXTENSION PLAYWRIGHT USES WHEN IT CANNOT NAME THE MIME ───────────────────────────
//
// ★ FOUND 2026-08-05: the Wegmans cart API serves `Content-Type: text/json`. Playwright maps a mime it
//   does not recognise to `resources/<sha1>.dat`, `.dat` is not in TEXT_ENTRY, and so the body was
//   dropped fail-closed. MEASURED on run 1146366: ZERO of 15 cart bodies survived while 499 `.json`
//   resources did — i.e. for every SENSITIVE check, this API's response bodies are absent from the
//   persisted trace. That is the exact artifact needed to answer a cart-shape question, and its absence
//   blocked a live diagnosis (check 355 GATE 2).
//
// ★★ NOT SOLVED BY ADDING `.dat` TO THE EXTENSION LIST. `.dat` is Playwright's "unknown mime" bucket, so
//    it is genuinely mixed: a `text/json` body lands there, and so would an `application/octet-stream`
//    download or any binary whose mime is unrecognised. Adding the extension would copy those through a
//    TEXT scrubber — bytes that no rule matches, emitted verbatim into the zip. That is precisely the
//    fail-OPEN this module's drop-by-default exists to prevent.
//
// ★ SO `.dat` IS A CANDIDATE, NOT A CLASS: it is admitted only if its CONTENT proves it is text we can
//   scrub. The test is deliberately narrow (see looksLikeRedactableText) — this widens the kept set by
//   one well-understood shape, JSON documents, rather than by "not obviously binary".
const SNIFF_ENTRY = /\.dat$/i;

/** How many leading bytes the sniff inspects. One chunk's worth is plenty to see a JSON opener, and
 *  bounding it keeps a hostile/huge entry from being buffered just to classify it. */
export const SNIFF_BYTES = 512;

/**
 * Does this entry's leading data prove it is TEXT WE CAN SCRUB? Deliberately strict — three conditions,
 * each of which a binary blob fails:
 *
 *   1. NO NUL BYTE. The single most reliable binary tell; no UTF-8 text contains U+0000 in practice.
 *   2. STRICT UTF-8. A fatal TextDecoder rejects arbitrary bytes. (When the window is full we trim the
 *      last 3 bytes first — a multi-byte character straddling the boundary would otherwise read as
 *      invalid and misclassify a perfectly good JSON body as binary.)
 *   3. STARTS WITH A JSON DOCUMENT — first non-whitespace char is `{` or `[`.
 *
 * ★ WHY REQUIRE (3) AT ALL, when 1+2 already say "this is text"? Because "is valid UTF-8" is not the
 *   question — "is this a shape whose secrets our rules are written for" is. STRUCTURAL and the
 *   knownValue rules are built for JSON and HAR-ish text; a UTF-8 blob of some other format could carry
 *   a secret in an encoding none of them match, and we would ship it believing it scrubbed. Requiring a
 *   JSON opener keeps the widening to the case actually needed (API response bodies) and leaves
 *   everything else on the drop-by-default path where it was.
 *
 * ★ Exported so the policy is pinnable by test, like classifyEntry.
 */
export function looksLikeRedactableText(prefix: Buffer): boolean {
  if (prefix.length === 0) return false; // an empty body carries nothing; drop it
  const head = prefix.subarray(0, SNIFF_BYTES);
  if (head.includes(0)) return false; // (1) NUL ⇒ binary
  // (2) If we filled the window the last character may be cut in half — trim before validating.
  const safe = head.length === SNIFF_BYTES ? head.subarray(0, head.length - 3) : head;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(safe);
  } catch {
    return false;
  }
  const s = safe.toString('utf8').replace(/^\uFEFF/, '').trimStart(); // tolerate a BOM
  return s.startsWith('{') || s.startsWith('['); // (3) a JSON document
}

/** How buildRedactedTraceZip treats a zip entry.
 *  'scrub' — known text extension, redact and keep.
 *  'sniff' — `.dat`, Playwright's unknown-mime bucket: keep ONLY if the content proves it is text.
 *  'drop'  — everything else (fail-closed default).
 *  Exported so the drop-by-default policy is pinnable. */
export function classifyEntry(entryName: string): 'scrub' | 'sniff' | 'drop' {
  if (TEXT_ENTRY.test(entryName)) return 'scrub';
  return SNIFF_ENTRY.test(entryName) ? 'sniff' : 'drop';
}

/** The PLAIN-form scrub: the monitor's redactor first (declared patterns + known secret values), then
 *  the structural session-material rules. This sees only text as it literally appears in the entry —
 *  a percent-ENCODED occurrence is invisible to it (see scrubEncodedRegions). Exported so the
 *  prove-can-fail test can run the plain scrub ALONE and show the encoded sentinel surviving. */
export function scrubPlainText(text: string, redact: Redactor): string {
  let out = redact(text);
  for (const [re, repl] of STRUCTURAL) out = out.replace(re, repl);
  return out;
}

// ── ★★ PERCENT-ENCODED PII — why a decode pass exists at all ────────────────────────────────────────
//
// Every rule above (declared redact_patterns, the builtin denylist, STRUCTURAL) matches the text as it
// LITERALLY appears. But the highest-value PII in a real sensitive trace does not appear literally: the
// 2026-07-29 classification recon found a member identity record — email, firstName, lastName, full
// name, loyaltyNumber, phoneNumber — inside a hidden `<input>` value in the AstuteBot chat widget,
// stored PERCENT-ENCODED in the DOM snapshot:
//
//   %22email%22%3A%22…%40wegmans.com%22%2C%22firstName%22%3A%22…%22%2C%22loyaltyNumber%22%3A104735137
//
// So a perfectly correct plain-form pattern like `"loyaltyNumber"\s*:\s*\d+` matches NOTHING and the
// monitor's redact_patterns are a SILENT NO-OP against exactly the data they were added for. That
// silence is the trap: the manifest looks protected, the tests pass, and the PII ships. Measured
// against the real trace, the blob is SINGLY encoded (one decodeURIComponent pass reaches plain JSON).
//
// ★ DESIGN — scrub-on-decoded, REPLACE-ONLY-ON-CHANGE:
//   1) find maximal runs of `[^"\\\s]` that contain at least one %XX (the charset deliberately EXCLUDES
//      `"` and `\` so a run can never straddle a JSON string boundary in the NDJSON the trace viewer
//      parses line-by-line);
//   2) decode the run (bounded, until stable), scrub the DECODED form with the SAME plain pipeline —
//      so declared patterns and STRUCTURAL both apply to it, no second rule set to drift;
//   3) if the scrub changed nothing, emit the run's ORIGINAL BYTES. Only a run that actually contained
//      PII is rewritten, so the ~everything-else of a 38MB trace is byte-identical to before.
//
// ★ Re-encoding is MINIMAL, not encodeURIComponent: only `%`, `"`, `\` and whitespace/controls are
//   percent-escaped. That is exactly what JSON-string safety and the run charset require, and it keeps
//   `/ : , @ { }` readable instead of blanket-encoding them. A consumer that decodes once gets the same
//   string either way, so the rewrite is semantically equivalent — just legible.
//
// ★ ACCEPTED TRADES (both are over-redaction, which redact.ts states is acceptable on a sensitive
//   monitor): a run that was DOUBLE-encoded is re-emitted at single depth (real data is single, so this
//   is a hypothetical), and a run whose encoding is MALFORMED (`%ZZ`, a lone `%`) cannot be decoded and
//   is left untouched — decoding is impossible there, and the plain pass has already run over it.
const ENCODED_RUN = /[^"\\\s]+/g;
const HAS_PCT_ESCAPE = /%[0-9A-Fa-f]{2}/; // non-global on purpose: .test() on a /g regex is stateful
const MAX_DECODE_PASSES = 3;

/** Decode percent-escapes until stable (bounded). Returns null if the run is not validly encoded — the
 *  caller then leaves it untouched rather than guessing. */
function decodeDeep(run: string): string | null {
  let cur = run;
  for (let i = 0; i < MAX_DECODE_PASSES; i++) {
    let next: string;
    try {
      next = decodeURIComponent(cur);
    } catch {
      return i === 0 ? null : cur; // malformed at the first pass = undecodable; later = stop where we got to
    }
    if (next === cur) return cur;
    cur = next;
  }
  return cur;
}

/** Percent-escape ONLY what JSON-string safety and the ENCODED_RUN charset require. */
function encodeMinimal(s: string): string {
  // Single pass: each matching char is replaced once, so an emitted '%' is never re-encoded. \p{Cc}
  // (Unicode control category) is included because a control char cannot appear raw in a JSON string
  // either. Deliberately NOT `-` or `.`: keeping those raw is what leaves the emitted
  // `<redacted-username>` / `<redacted>` markers greppable inside a rewritten run.
  return s.replace(/[%"\\\s\p{Cc}]/gu, (c) => {
    const code = c.charCodeAt(0);
    return code < 0x80 ? `%${code.toString(16).toUpperCase().padStart(2, '0')}` : encodeURIComponent(c);
  });
}

/**
 * Scrub PII that is present only in percent-ENCODED form. See the block comment above for the design.
 * Exported so the prove-can-fail test can assert this step is load-bearing: with it skipped, an encoded
 * sentinel survives the plain scrub.
 */
export function scrubEncodedRegions(text: string, redact: Redactor): string {
  return text.replace(ENCODED_RUN, (run) => {
    if (!HAS_PCT_ESCAPE.test(run)) return run; // nothing encoded here — cheap reject, original bytes
    const decoded = decodeDeep(run);
    if (decoded === null) return run; // malformed encoding — untouched (documented trade)
    const scrubbed = scrubPlainText(decoded, redact);
    if (scrubbed === decoded) return run; // ★ no PII found — emit the ORIGINAL bytes, not a re-encode
    return encodeMinimal(scrubbed);
  });
}

/** The full text scrub: the plain-form pipeline, then the same pipeline again over any percent-ENCODED
 *  run (which the plain pass is structurally blind to). Exported for direct unit-testing. */
export function scrubTraceText(text: string, redact: Redactor): string {
  return scrubEncodedRegions(scrubPlainText(text, redact), redact);
}

/**
 * Build the redacted/reduced copy of a Playwright trace zip at destPath. Returns true only when the
 * copy was fully built and written; false on ANY failure (unreadable/corrupt zip, not a Playwright
 * trace — no *.trace entry — or a write error), in which case destPath is removed and the caller
 * must upload nothing.
 *
 * ★ STREAMING (was in-memory AdmZip): a long browser flow's raw trace is large — the whole-zip
 * in-memory rebuild (`new AdmZip(srcPath)` loaded the ENTIRE zip, screencast jpegs included, then a
 * second AdmZip accumulated every scrubbed entry) OOM-killed the runner during finalization (run
 * #936920, exit 137, 2Gi container). This streams instead: yauzl reads one entry at a time
 * (lazyEntries), DROPPED entries (jpegs/binaries) are skipped WITHOUT ever being decompressed into
 * memory, and yazl writes the kept+scrubbed text entries straight to destPath. Peak memory is bounded
 * to the LARGEST SINGLE TEXT ENTRY (trace.trace / trace.network) — it no longer scales with the whole
 * trace / the screencast bulk. The security logic is UNCHANGED: same classifyEntry (drop-by-default)
 * + same scrubTraceText (whole-entry scrub, so no token can straddle a chunk boundary), same
 * fail-closed contract — ANY error removes destPath and resolves false so the caller uploads nothing.
 * Now async (streaming); the caller awaits it. Runs on the failure path only, while the zip is in hand.
 */
/**
 * ★ IMAGE RETENTION — a PARAMETER, not a fork, and the FLEET BEHAVIOUR IS THE DEFAULT.
 *
 * `keepImages` defaults to FALSE, which is byte-for-byte today's fleet policy: image entries (screencast
 * jpegs, network body images) are dropped, because a rendered logged-in page cannot be text-scrubbed and a
 * sensitive fleet monitor's pages carry member name / address / order history. Only the SANDBOX PREVIEW
 * path passes true — see previewPersistPlan for why that audience is different.
 *
 * ★ WHY A PARAMETER RATHER THAN A PREVIEW-LOCAL COPY OF THIS BUILDER. Forking ~40 lines of streaming-zip
 *   logic would be the N-implementations bug this codebase keeps paying for (countable_run,
 *   latency_sample, reconcilePlan, runTracedFlow) — except the drift would be IN REDACTION. A second
 *   builder would not stay in step with STRUCTURAL, scrubTraceText, or the fail-closed contract, and the
 *   copy that fell behind would be the one shipping unscrubbed bytes. One builder, one scrubber, one
 *   fail-closed path; the only thing that varies is whether images survive.
 *
 * ★ The fleet default is PINNED BY TEST (traceRedact.test.ts, "fleet default drops image entries") so this
 *   parameter can never quietly become the fleet's behaviour.
 */
export function buildRedactedTraceZip(
  srcPath: string,
  destPath: string,
  redact: Redactor,
  opts: { keepImages?: boolean } = {},
): Promise<boolean> {
  const keepImages = opts.keepImages === true; // explicit opt-in only; anything else = fleet default
  return buildRedactedTraceZipInner(srcPath, destPath, redact, keepImages);
}

/** Image entries a preview may keep verbatim. Screencast frames are `resources/page@<hash>-<ts>.jpeg`;
 *  network body images land in `resources/<sha1>.<ext>`. Deliberately an ALLOWLIST — an unknown binary
 *  extension still drops, so `keepImages` widens the kept set by images ONLY, never by "not text". */
const IMAGE_ENTRY = /\.(jpe?g|png|webp|gif|avif)$/i;

function buildRedactedTraceZipInner(
  srcPath: string,
  destPath: string,
  redact: Redactor,
  keepImages: boolean,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const fail = (zip?: yauzl.ZipFile): void => {
      if (settled) return;
      settled = true;
      try {
        zip?.close();
      } catch {
        /* ignore */
      }
      rmSync(destPath, { force: true }); // never leave a half-written zip for the caller to find
      resolve(false);
    };

    yauzl.open(srcPath, { lazyEntries: true, autoClose: true }, (openErr, zip) => {
      if (openErr || !zip) return fail();

      const out = new yazl.ZipFile();
      const ws = createWriteStream(destPath);
      let sawTrace = false;
      ws.on('error', () => fail(zip));
      // The output stream closing is the completion signal: only NOW is destPath fully written.
      out.outputStream.pipe(ws).on('close', () => {
        if (settled) return;
        if (!sawTrace) return fail(zip); // not a Playwright trace — refuse rather than upload junk
        settled = true;
        resolve(true);
      });

      zip.on('error', () => fail(zip));
      zip.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName;
        // Directory or drop-by-default (jpegs/fonts/binaries/unknown): skip WITHOUT opening a read
        // stream — the entry's data is never decompressed into memory. Advance to the next entry.
        if (/\/$/.test(name)) {
          zip.readEntry();
          return;
        }
        // ★ classifyEntry is UNTOUCHED and still the fleet's drop-by-default policy. keepImages does not
        //   change the classification — it only rescues entries the classifier already dropped that are
        //   images, and copies their bytes through VERBATIM (an image cannot be text-scrubbed; the whole
        //   point is that the preview operator gets to look at it).
        const isImage = keepImages && IMAGE_ENTRY.test(name);
        const cls = classifyEntry(name);
        if (cls === 'drop' && !isImage) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamErr, rs) => {
          if (streamErr || !rs) return fail(zip);
          const chunks: Buffer[] = [];
          // ★ SNIFF ON THE FIRST CHUNK, then either accumulate (text) or DRAIN WITHOUT ACCUMULATING
          //   (binary). That preserves the memory bound this loop is built for — a huge binary `.dat`
          //   costs one chunk, not its whole length — while still letting a text body through to the
          //   scrubber. `null` verdict at 'end' (a zero-byte entry) falls to the drop side.
          let verdict: 'text' | 'binary' | null = cls === 'sniff' ? null : 'text';
          rs.on('error', () => fail(zip));
          rs.on('data', (c: Buffer) => {
            if (verdict === null) verdict = looksLikeRedactableText(c) ? 'text' : 'binary';
            if (verdict === 'binary') return; // drain to 'end' so the walk continues; keep nothing
            chunks.push(c);
          });
          rs.on('end', () => {
            if (settled) return;
            // A sniffed entry that did not prove itself text is DROPPED — same outcome as before this
            // change, reached by evidence rather than by its extension.
            if (verdict !== 'text') {
              zip.readEntry();
              return;
            }
            try {
              const raw = Buffer.concat(chunks);
              if (isImage) {
                // Verbatim — an image has no text to scrub. Reached ONLY on the preview path (keepImages).
                out.addBuffer(raw, name);
              } else {
                // Whole-entry scrub (one text entry in hand at a time) — identical to the old per-entry
                // scrub, so a secret can never straddle a chunk boundary and slip through.
                out.addBuffer(Buffer.from(scrubTraceText(raw.toString('utf8'), redact), 'utf8'), name);
              }
              if (/\.trace$/i.test(name)) sawTrace = true;
            } catch {
              return fail(zip);
            }
            zip.readEntry();
          });
        });
      });
      // All source entries consumed → finalize the output zip; ws 'close' above resolves the result.
      zip.on('end', () => {
        if (!settled) out.end();
      });

      zip.readEntry(); // kick off the lazy walk
    });
  });
}
