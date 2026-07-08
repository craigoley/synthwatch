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

/**
 * The fast-retry budget for ONE run. On a monitor that's ALREADY confirmed-down (an open incident),
 * the in-run fast-retry — which exists to absorb a TRANSIENT blip on a HEALTHY monitor — is moot: the
 * failure is sustained, so retrying ×N every tick is wasted browser work (~2–3 min/tick). Skip it
 * (0 retries → 1 attempt, fail fast). A healthy monitor keeps its full `retries` so the FIRST failure
 * is still retried to confirm it's real before paging (the transient-absorption that prevents a false
 * page). Pairs with failure_threshold=1: first failure retries→confirms→opens incident; subsequent
 * failures while it's open skip retry; on recovery the incident resolves and full retry returns.
 *
 * ★ SANDBOX (0064/0065): a sandbox run is an ON-DEMAND validation of a PAUSED monitor — it skips
 * evaluate() (no incident/alert/SLO — option A), so the reason fast-retry exists (confirm a failure
 * before paging) doesn't apply. A "does this work" validation wants the TRUE first-attempt state, not
 * the retry-smoothed one: retry takes the LAST attempt as the verdict, so on a browser flow it would
 * pass on a warmed 2nd/3rd attempt (cookies/session set) where a COLD first contact was blocked —
 * masking exactly the bot-detection/OTP signal the validation is asking about. So sandbox → 0 retries
 * (one honest attempt). Harmless downside: a genuine transient blip shows as fail — but a sandbox fail
 * pages nothing, and Craig just re-fires. (Also stops a hard-failing validation running 4× — cf. the
 * b2c stale-selector run that hit retry_count=3.)
 */
export function effectiveRetries(retries: number, alreadyFailing: boolean, sandbox = false): number {
  return alreadyFailing || sandbox ? 0 : retries;
}

export async function runWithRetry<T extends { status: string }>(
  execute: (attempt: number) => Promise<T>,
  retries: number,
  onBeforeRetry?: (prev: T, attempt: number) => Promise<void>,
): Promise<{ result: T; attempts: number }> {
  const maxAttempts = retries + 1;
  let result = await execute(1);
  // `attempts` = how many times execute() ran to reach the FINAL verdict — the per-run telemetry
  // (1 = settled first try; 2 = settled on the 2nd; maxAttempts = exhausted retries). A status=pass
  // with attempts>1 is the "degrading-but-green" monitor that never opens an incident.
  let attempts = 1;
  for (let attempt = 2; attempt <= maxAttempts && isRetryable(result.status); attempt++) {
    if (onBeforeRetry) await onBeforeRetry(result, attempt);
    result = await execute(attempt);
    attempts = attempt;
  }
  return { result, attempts };
}
