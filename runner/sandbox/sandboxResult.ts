// The SANDBOX PREVIEW RESULT PAYLOAD — the JSON the sandbox job writes to `<token>.json` and echoes to
// stdout, and which the api serves VERBATIM as PreviewStatusDto.Trace (an opaque string) for the dashboard
// to JSON.parse.
//
// ★ WHY THIS IS ITS OWN MODULE, not an export on sandboxMain.ts.
//   sandboxMain.ts self-invokes `main()` at module load, so merely IMPORTING it reads process.env, decrypts
//   the payload blob, spawns a browser child, uploads artifacts, and calls process.exit(). An export there
//   would therefore be unusable from a test — the import itself would run the job. Extracting the pure part
//   into this module gives a seam that can be called with controlled input and no I/O at all.
//
// ★ WHY A SEAM IS WANTED. `hasScreenshot` is produced HERE and reaches the dashboard inside that opaque
//   string, so synthwatch-api has no such field (`git grep hasScreenshot` there returns nothing) and the
//   dashboard's captured-fixture contract harness structurally cannot anchor it — see that repo's
//   contract/README.md, "Known-uncapturable seams". The anchor has to live at the producer; this module is
//   where it can attach.
import type { PreviewResult } from './runSandboxPreview.js';

// stdout in the result JSON is bounded so a stdout-spamming spec can't bloat `<token>.json`.
const STDOUT_CAP_BYTES = 128 * 1024;

// ★ Why there is (or isn't) a screenshot — the cause a single `hasScreenshot` boolean COLLAPSES. It has two
//   FALSE arms that a viewer must not confuse: a run that produced none vs. one captured-then-DROPPED at the
//   size cap. This three-state value NAMES that cause; it describes the CAPTURE outcome and is orthogonal to
//   `hasScreenshot` (which still means captured-AND-within-cap-AND-uploaded). Read them together:
//     • 'not_captured' — the run produced no screenshot (e.g. a pass). hasScreenshot=false.
//     • 'captured'     — a screenshot was captured WITHIN the cap. Available iff hasScreenshot=true; a
//                        'captured' with hasScreenshot=false is the rare "captured but the upload failed" edge.
//     • 'over_cap'     — captured but exceeded SCREENSHOT_CAP_BYTES and was DROPPED. hasScreenshot=false.
//   ★ DERIVED WHERE THE CAP DECISION IS MADE (sandboxMain.ts), passed in here — see buildResultPayload's note.
export type ScreenshotCause = 'not_captured' | 'captured' | 'over_cap';

/**
 * Build the result payload. PURE: no process.env, no I/O, no uploads, no process.exit, no module-level
 * side effects on import — every input arrives as an argument.
 *
 * ★ `hasTrace` / `hasScreenshot` / `screenshotCause` are PARAMETERS, not derived here, and that is load-bearing
 *   rather than incidental. In sandboxMain the flags are the RETURN VALUES of the artifact uploads, so each means
 *   "captured AND within its size cap AND the upload succeeded" — not merely "the run produced one". An over-cap
 *   artifact is dropped and its flag stays false. `screenshotCause` is likewise derived THERE, from the same
 *   capture facts and the cap decision. Deriving any of them in here would quietly redefine them as "was one
 *   captured" — a weaker claim that COLLAPSES the not_captured vs over_cap arms (the exact confusion this exists
 *   to prevent; the golden's over-cap arm shares its `result` with the under-cap arm and differs ONLY in these
 *   arguments, so an in-builder derivation reds it).
 */
export function buildResultPayload(
  result: PreviewResult,
  artifacts: { hasTrace: boolean; hasScreenshot: boolean; screenshotCause: ScreenshotCause },
): {
  ok: boolean;
  tests: string[];
  status: string | null;
  error: string | null;
  failedStep: string | null;
  steps: PreviewResult['steps'];
  traceSignals: PreviewResult['traceSignals'];
  stdout: string;
  stderr: string;
  timedOut: boolean;
  exitCode: number | null;
  hasTrace: boolean;
  hasScreenshot: boolean;
  screenshotCause: ScreenshotCause;
} {
  const stdoutCapped =
    result.stdout.length > STDOUT_CAP_BYTES ? `${result.stdout.slice(0, STDOUT_CAP_BYTES)}\n…(truncated)` : result.stdout;
  return {
    ok: result.ok,
    tests: result.tests,
    status: result.status ?? null,
    error: result.error ?? null,
    failedStep: result.failedStep ?? null,
    steps: result.steps ?? [],
    traceSignals: result.traceSignals ?? null,
    stdout: stdoutCapped,
    stderr: result.stderr,
    timedOut: result.timedOut,
    exitCode: result.exitCode,
    hasTrace: artifacts.hasTrace,
    hasScreenshot: artifacts.hasScreenshot,
    screenshotCause: artifacts.screenshotCause,
  };
}
