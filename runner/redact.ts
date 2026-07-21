// B10 redaction — scrub session tokens / declared sensitive values out of trace-derived strings
// (network URLs + console text) BEFORE they're persisted to trace_signals or forwarded to AI.
//
// Applied ONLY to `sensitive` monitors (a non-sensitive monitor uses IDENTITY_REDACTOR → its trace
// is byte-for-byte unchanged). The built-in token denylist runs regardless of whether the monitor
// declared redact_patterns (defense-in-depth). Over-redaction on a sensitive monitor is acceptable
// (we lose a little signal but leak nothing); under-redaction is not.

const REDACTED = '<redacted>';

// Built-in token-shape denylist (always on for sensitive monitors):
//  1) the VALUE of any query param whose NAME looks auth/session-ish (token=, session_id=, jwt=, …)
//     — keep the key (useful signal), redact the value up to the next & # whitespace or quote.
//  2) a JWT anywhere (three base64url segments starting `eyJ`).
//  3) a `Bearer <token>` in text.
const BUILTIN: Array<[RegExp, string]> = [
  [
    // A sensitive-looking key=value, whether a URL query param (?token=…&) or an inline assignment in
    // console text (token=…). Keep the key (useful signal), redact the value to the next & # ws or quote.
    // Escape-aware value (matching traceRedact's JSON_STR): a JSON-escaped char (\") inside the value is
    // consumed via `\\.` rather than truncating the match at the bare `"` — so scrubbing an assignment
    // embedded in an NDJSON string leaves that string's closing quote intact (valid JSON, same bug class).
    /((?:[?&]|\b)[\w-]*(?:token|session|sid|jwt|bearer|auth|secret|password|passwd|pwd|api[_-]?key|access[_-]?token|id[_-]?token|refresh[_-]?token|csrf|xsrf|signature)[\w-]*=)(?:\\.|[^&#\s"'\\])+/gi,
    `$1${REDACTED}`,
  ],
  [/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<redacted-jwt>'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer <redacted>'],
];

export type Redactor = (s: string) => string;

/** No-op redactor for non-sensitive monitors — keeps the extraction hot path byte-for-byte identical. */
export const IDENTITY_REDACTOR: Redactor = (s) => s;

/** Escape a literal string so its regex-special chars are matched verbatim (RE2-safe subset). */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a redactor for a SENSITIVE monitor: the built-in denylist + the monitor's declared regex
 * patterns + any KNOWN SECRET VALUES (registered as escaped-literal rules). An invalid declared pattern
 * is skipped (non-fatal — a bad manifest regex must never crash trace extraction, which is itself non-fatal).
 *
 * ★ VALUE registration (login-credentials, #232 defect-2 fix): the declared patterns scrub session TOKENS
 * and form-encoded `password=VALUE`, but NOT the bare typed credential value in console/error/trace text.
 * So the run's RESOLVED credential values are passed here and each becomes an escaped-literal rule — the
 * exact value is scrubbed wherever it appears, independent of what patterns the monitor declared. Values
 * are registered for the life of ONE run (same lifecycle as the SW_CRED_<ROLE> publish/clear). Empty/short
 * values are skipped (a 1-2 char "value" would over-redact the whole trace). NOTE: this covers TEXT channels
 * only — it CANNOT scrub a DOM value baked into a raw trace/screenshot (PR 1b), which stays view-gated.
 */
export function makeRedactor(
  declaredPatterns: string[] | null | undefined,
  knownValues?: readonly string[],
): Redactor {
  const rules: Array<[RegExp, string]> = [...BUILTIN];
  for (const p of declaredPatterns ?? []) {
    try {
      rules.push([new RegExp(p, 'gi'), REDACTED]);
    } catch {
      console.warn(`[redact] skipping invalid redact_pattern: ${p}`);
    }
  }
  // ★ known secret values → escaped-literal rules. Longest-first so a value that contains another
  // (e.g. password ⊃ username substring) is redacted before its substring can partially match.
  for (const v of [...(knownValues ?? [])].filter((v) => v && v.length >= 3).sort((a, b) => b.length - a.length)) {
    rules.push([new RegExp(escapeRegExp(v), 'g'), REDACTED]);
  }
  return (s) => {
    let out = s;
    for (const [re, repl] of rules) out = out.replace(re, repl);
    return out;
  };
}

// ── B10 artifact-persistence policy (pure + testable) ────────────────────────────────────────────
import type { TerminalStatus } from './db.js';

/** How the per-run failure trace zip is persisted: the raw capture, a redacted/reduced copy
 *  (traceRedact.ts), or not at all. A string mode (not a boolean) so every consumer is forced to say
 *  which one it means — `if (mode)` would treat 'none' as truthy. */
export type FailureTraceMode = 'raw' | 'redacted' | 'none';

/** Which trace artifacts this run may persist. A SENSITIVE monitor stores NO raw artifacts (no
 *  session-bearing zip, no PII screenshot, no permanent baseline) — but a FAILED sensitive run now
 *  persists a REDACTED, REDUCED trace zip (see traceRedact.ts) so credentialed monitors are
 *  debuggable; a non-sensitive monitor follows the normal status rules. */
export interface TracePersistPlan {
  failureTraceMode: FailureTraceMode; // the per-run failure trace zip (runs.trace_url)
  successBaseline: boolean; // the permanent success-trace baseline zip (checks.success_trace_url)
  failureScreenshot: boolean; // the failure screenshot (runs.screenshot_url)
  baselineScreenshot: boolean; // the RCA visual-diff baseline screenshot (checks.baseline_screenshot_url)
}

export function tracePersistPlan(sensitive: boolean, status: TerminalStatus): TracePersistPlan {
  const down = status === 'fail' || status === 'error';
  if (sensitive) {
    // ★ A sensitive monitor persists the REDACTED/REDUCED zip on EVERY run — pass AND fail (the original
    // B10 line discarded green runs entirely; revised so a credentialed monitor's trace is always
    // surface-able). The redacted artifact is identical either way: text entries scrubbed by the monitor's
    // redactor + structural session rules, ALL images dropped (screencast/body images can't be text-
    // scrubbed) — so no login credential, token, session cookie, or logged-in visual ships. It goes to the
    // per-run runs.trace_url (90d purge), NOT the permanent purge-EXEMPT success baseline (a standing
    // logged-in capture stays off), and screenshots stay off (a rendered logged-in page can't be scrubbed).
    return { failureTraceMode: 'redacted', successBaseline: false, failureScreenshot: false, baselineScreenshot: false };
  }
  const up = status === 'pass' || status === 'warn';
  return { failureTraceMode: down ? 'raw' : 'none', successBaseline: up, failureScreenshot: down, baselineScreenshot: status === 'pass' };
}

/**
 * ★ THE PREVIEW PLAN — a SEPARATE function from tracePersistPlan on purpose. Do not merge them.
 *
 * A SANDBOX PREVIEW keeps its screenshot and its trace images even when credentialed; a FLEET monitor
 * with `sensitive=true` keeps neither. That divergence is deliberate and the two audiences are not
 * comparable:
 *
 *   • A preview is run from the Tests area, which is EDITOR/ADMIN ONLY, by a person who TYPED the
 *     credential seconds earlier and is watching the result. Showing them their own password back is not
 *     a disclosure. And `<input type="password">` renders MASKED, so the typed value does not appear
 *     visually in the first place — suppression cost the PRIMARY DIAGNOSTIC (the screenshot is usually
 *     the fastest way to see why an authenticated flow broke) on exactly the monitors with the worst
 *     authoring friction, and bought very little.
 *   • A FLEET sensitive monitor is UNATTENDED and scheduled. Its logged-in pages carry member name,
 *     address and order history — PII that is NOT masked the way a password field is, that nobody asked
 *     to see, and that would land in 90d-retained artifacts. tracePersistPlan stays exactly as it is.
 *
 * So: same `sensitive` input, different verdict, because the threat models differ. Anyone tempted to
 * collapse these into one function should re-read the two bullets above first.
 *
 * ★ Text scrubbing is NOT relaxed here — only IMAGE/artifact retention. A credentialed preview with the
 *   redaction toggle ON still runs every text channel through the redactor; this plan only stops us
 *   throwing away the picture. The toggle's OFF state is expressed by the CALLER passing sensitive=false
 *   (which is what selects IDENTITY_REDACTOR), not by anything in here.
 */
export function previewPersistPlan(sensitive: boolean): TracePersistPlan {
  // A preview never writes the permanent, purge-EXEMPT success baseline or the RCA visual-diff baseline —
  // those are fleet-monitor slots keyed to a check row, and a preview has no check row.
  return {
    // sensitive ⇒ the redacted/reduced zip (text scrubbed, images now KEPT — see buildRedactedTraceZip's
    // keepImages). Non-sensitive (incl. redaction toggled OFF) ⇒ today's preview behaviour: the RAW zip on
    // pass AND fail, because a preview is a one-shot the user is watching and the trace IS the point.
    failureTraceMode: sensitive ? 'redacted' : 'raw',
    successBaseline: false,
    failureScreenshot: true, // ★ the change: was false for credentialed previews
    baselineScreenshot: false,
  };
}

/** Generic error_message for a sensitive monitor — the fallback when scrubbing leaves nothing readable.
 *  Keeps only the safe status + static step name. */
export function sensitiveErrorMessage(status: TerminalStatus, failedStep: string | null): string {
  return `${status}${failedStep ? ` at step "${failedStep}"` : ''} — error details redacted (sensitive monitor)`;
}

/**
 * Scrub sensitive VALUES out of a sensitive monitor's real error/diagnostic message while KEEPING the
 * diagnostic text, instead of blanket-replacing it. Reuses the monitor's own redactor (builtin token
 * denylist + declared redact_patterns — the SAME scrubber proven on trace_signals), so a Bearer / JWT /
 * GUID / token becomes <redacted> but "TimeoutError: locator '.cuisine-tile' not found" stays readable.
 * Falls back to the generic placeholder ONLY if scrubbing leaves nothing readable (e.g. the message was
 * entirely a token) — and even then status + failedStep are carried, so there's always SOME signal.
 */
export function scrubError(
  redact: Redactor,
  status: TerminalStatus,
  failedStep: string | null,
  raw: string | null,
): string {
  const scrubbed = redact(raw ?? '').trim();
  // Fall back ONLY when no DIAGNOSTIC text survived — i.e. the message was empty, or scrubbing left nothing
  // but redaction markers (the error was entirely a secret). Strip the markers and check for any remaining
  // alphanumeric; if none, the scrubbed string carries no signal, so use the placeholder (which still carries
  // status + failedStep). Otherwise keep the readable, scrubbed diagnostic.
  const hasDiagnostic = /[A-Za-z0-9]/.test(scrubbed.replace(/<redacted[^>]*>/g, ''));
  return hasDiagnostic ? scrubbed : sensitiveErrorMessage(status, failedStep);
}
