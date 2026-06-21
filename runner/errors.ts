// Error classification for the run-status taxonomy.
//
// A run/step can end two ways when something goes wrong:
//   - fail  = a clean EXPECTATION failure the check is designed to detect
//             (wrong HTTP status, body-must-contain miss, a flow assertion).
//   - error = an unexpected EXCEPTION/timeout/infra problem (a Playwright
//             TimeoutError, a navigation crash, a thrown non-expectation Error).
//
// Flows signal the first kind by throwing ExpectationError (use `expect(...)`).
// Everything else is treated as `error`.

export class ExpectationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpectationError';
  }
}

/**
 * True for a clean expectation failure. Checks the name as well as instanceof so
 * classification survives module-realm / bundling quirks where instanceof can
 * fail across boundaries.
 */
export function isExpectationError(err: unknown): err is ExpectationError {
  return (
    err instanceof ExpectationError ||
    (err instanceof Error && err.name === 'ExpectationError')
  );
}

/** Assert a flow expectation. Throws ExpectationError (=> status 'fail') if falsy. */
export function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ExpectationError(message);
}
