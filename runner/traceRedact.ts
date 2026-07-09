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
import AdmZip from 'adm-zip';
import { rmSync } from 'node:fs';
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
];

/** How buildRedactedTraceZip treats a zip entry. Exported so the drop-by-default policy is pinnable. */
export function classifyEntry(entryName: string): 'scrub' | 'drop' {
  return TEXT_ENTRY.test(entryName) ? 'scrub' : 'drop';
}

/** The full text scrub: the monitor's redactor first (declared patterns + known secret values),
 *  then the structural session-material rules. Exported for direct unit-testing. */
export function scrubTraceText(text: string, redact: Redactor): string {
  let out = redact(text);
  for (const [re, repl] of STRUCTURAL) out = out.replace(re, repl);
  return out;
}

/**
 * Build the redacted/reduced copy of a Playwright trace zip at destPath. Returns true only when the
 * copy was fully built and written; false on ANY failure (unreadable/corrupt zip, not a Playwright
 * trace — no *.trace entry — or a write error), in which case destPath is removed and the caller
 * must upload nothing. Synchronous (AdmZip), same as extractTraceSignals — runs while the zip is in
 * hand on the failure path only.
 */
export function buildRedactedTraceZip(srcPath: string, destPath: string, redact: Redactor): boolean {
  try {
    const src = new AdmZip(srcPath);
    const out = new AdmZip();
    let sawTrace = false;
    for (const entry of src.getEntries()) {
      if (entry.isDirectory || classifyEntry(entry.entryName) === 'drop') continue;
      const scrubbed = scrubTraceText(entry.getData().toString('utf8'), redact);
      out.addFile(entry.entryName, Buffer.from(scrubbed, 'utf8'));
      if (/\.trace$/i.test(entry.entryName)) sawTrace = true;
    }
    if (!sawTrace) return false; // not a Playwright trace — refuse rather than upload junk
    out.writeZip(destPath);
    return true;
  } catch {
    rmSync(destPath, { force: true }); // never leave a half-written zip for the caller to find
    return false;
  }
}
