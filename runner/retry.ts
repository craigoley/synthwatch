// Fast-retry core (mechanism 1 of 2 — within a single run).
//
// Re-runs `execute` while the result is a FAILURE — 'error' (the check couldn't COMPLETE:
// network/timeout/DNS) OR 'fail' (an assertion missed) — up to `retries` extra attempts.
// pass/warn is final the first time (never retry a success; warn = available-but-degraded).
// The LAST attempt is the verdict (Datadog/Splunk/Dynatrace field standard: only the final
// retry counts; the original + intermediate attempts are DISCARDED from evaluation).
// `onBeforeRetry` runs between attempts (backoff + discarding the prior attempt's partial
// side effects — run_steps, run_metrics, the temp trace) so exactly one verdict persists.
// Retrying 'fail' absorbs a transient assertion blip the same way retrying 'error' absorbs a
// transient network blip — and an in-run-confirmed failure can then page IMMEDIATELY rather
// than waiting for consecutive scheduled ticks (failure_threshold, mechanism 2).
//
// Pure/generic + side-effect-free here (the DB/backoff live in onBeforeRetry) so it's
// unit-testable with a scripted fake executor.
function isRetryable(status: string): boolean {
  return status === 'error' || status === 'fail';
}

export async function runWithRetry<T extends { status: string }>(
  execute: (attempt: number) => Promise<T>,
  retries: number,
  onBeforeRetry?: (prev: T, attempt: number) => Promise<void>,
): Promise<T> {
  const maxAttempts = retries + 1;
  let result = await execute(1);
  for (let attempt = 2; attempt <= maxAttempts && isRetryable(result.status); attempt++) {
    if (onBeforeRetry) await onBeforeRetry(result, attempt);
    result = await execute(attempt);
  }
  return result;
}
