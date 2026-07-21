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

/**
 * Build the result payload. PURE: no process.env, no I/O, no uploads, no process.exit, no module-level
 * side effects on import — every input arrives as an argument.
 *
 * ★ `hasTrace` / `hasScreenshot` are PARAMETERS, not derived here, and that is load-bearing rather than
 *   incidental. In sandboxMain they are the RETURN VALUES of the artifact uploads, so each means
 *   "captured AND within its size cap AND the upload succeeded" — not merely "the run produced one". An
 *   over-cap artifact is dropped and its flag stays false. Deriving them in here would quietly redefine
 *   them as "was one captured", which is a different and weaker claim.
 */
export function buildResultPayload(
  result: PreviewResult,
  artifacts: { hasTrace: boolean; hasScreenshot: boolean },
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
  };
}
