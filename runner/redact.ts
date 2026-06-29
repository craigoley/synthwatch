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

/**
 * Build a redactor for a SENSITIVE monitor: the built-in denylist + the monitor's declared regex
 * patterns. An invalid declared pattern is skipped (non-fatal — a bad manifest regex must never crash
 * trace extraction, which is itself non-fatal).
 */
export function makeRedactor(declaredPatterns: string[] | null | undefined): Redactor {
  const rules: Array<[RegExp, string]> = [...BUILTIN];
  for (const p of declaredPatterns ?? []) {
    try {
      rules.push([new RegExp(p, 'gi'), REDACTED]);
    } catch {
      console.warn(`[redact] skipping invalid redact_pattern: ${p}`);
    }
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

/** Generic error_message for a sensitive monitor — keeps only the safe status + static step name. */
export function sensitiveErrorMessage(status: TerminalStatus, failedStep: string | null): string {
  return `${status}${failedStep ? ` at step "${failedStep}"` : ''} — error details redacted (sensitive monitor)`;
}
