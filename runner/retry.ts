// Fast-retry core (mechanism 1 of 2 — within a single run).
//
// Re-runs `execute` while the result is a transient 'error' (the check couldn't
// COMPLETE), up to `retries` extra attempts. A non-'error' result (pass/warn/fail) is
// final the first time — an assertion 'fail' is a real, completed result and is NEVER
// retried. The LAST attempt is the verdict (Datadog: only the final retry counts).
// `onBeforeRetry` runs between attempts (backoff + discarding the prior errored
// attempt's partial side effects) so exactly one verdict persists.
//
// Pure/generic + side-effect-free here (the DB/backoff live in onBeforeRetry) so it's
// unit-testable with a scripted fake executor.
export async function runWithRetry<T extends { status: string }>(
  execute: (attempt: number) => Promise<T>,
  retries: number,
  onBeforeRetry?: (prev: T, attempt: number) => Promise<void>,
): Promise<T> {
  const maxAttempts = retries + 1;
  let result = await execute(1);
  for (let attempt = 2; attempt <= maxAttempts && result.status === 'error'; attempt++) {
    if (onBeforeRetry) await onBeforeRetry(result, attempt);
    result = await execute(attempt);
  }
  return result;
}
