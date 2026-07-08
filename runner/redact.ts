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
    /((?:[?&]|\b)[\w-]*(?:token|session|sid|jwt|bearer|auth|secret|password|passwd|pwd|api[_-]?key|access[_-]?token|id[_-]?token|refresh[_-]?token|csrf|xsrf|signature)[\w-]*=)[^&#\s"']+/gi,
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

/** Which trace artifacts this run may persist. A SENSITIVE monitor persists NONE of them (no
 *  session-bearing zip, no PII screenshot); a non-sensitive monitor follows the normal status rules. */
export interface TracePersistPlan {
  failureTrace: boolean; // the per-run failure trace zip (runs.trace_url)
  successBaseline: boolean; // the permanent success-trace baseline zip (checks.success_trace_url)
  failureScreenshot: boolean; // the failure screenshot (runs.screenshot_url)
  baselineScreenshot: boolean; // the RCA visual-diff baseline screenshot (checks.baseline_screenshot_url)
}

export function tracePersistPlan(sensitive: boolean, status: TerminalStatus): TracePersistPlan {
  if (sensitive) {
    return { failureTrace: false, successBaseline: false, failureScreenshot: false, baselineScreenshot: false };
  }
  const down = status === 'fail' || status === 'error';
  const up = status === 'pass' || status === 'warn';
  return { failureTrace: down, successBaseline: up, failureScreenshot: down, baselineScreenshot: status === 'pass' };
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
