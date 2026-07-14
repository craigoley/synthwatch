// Confirmation-by-rerun eligibility helpers (0077) — how a failed run is CONFIRMED.
//
// ★ The in-run FAST-RETRY mechanism (effectiveRetries + runWithRetry, migrations 0021/0045) was RETIRED in
// 0084. Every check kind became confirm-by-rerun eligible (confirmByRerunEligible returns true for all kinds,
// post-#291), so effectiveRetries returned 0 for EVERY run and the in-run loop never took a second attempt —
// ZERO runs with retry_count > 1 after 2026-07-13. A monitor now confirms a transient failure with a SEPARATE
// run (a fresh ACA execution, or the next cron drain), never an in-run loop. That removed the last reader of
// checks.retries, which 0084 drops. (runs.retry_count survives — the api trust report's retryRate reads it —
// and is now structurally 1 for every run; see the PR body on retiring/re-sourcing that dimension.)
//
// The two helpers below decide WHICH confirmation path a kind uses; both are consumed by evaluate.ts.

/**
 * Confirm-by-rerun eligibility (0077, extended). A failed SCHEDULED run of an eligible kind confirms via ONE
 * separate run instead of retrying in-run — so EVERY check gets a flakiness signal (runs.superseded_by_run_id).
 *
 * ★ Originally browser/multistep ONLY (D2), which left http/dns/ssl STRUCTURALLY flap-blind: in 90 days they
 * logged ZERO superseded transients — not "few", impossible — so any flake budget built on that would hand them
 * a vacuously-perfect "0% flake" (a NEW vacuous-green, the anti-pattern this platform refuses). D2's exclusion
 * argued against the COST of a fresh POD for a 2-second check — NOT against confirmation. A rerun of a ~200ms
 * http check is seconds, and cheap kinds don't even need a pod (they ride the next-tick drain — see
 * usesDedicatedExecution), so the expensive-flow reasoning simply doesn't apply. Every kind is eligible.
 * (An allowlist, not `return true`: a FUTURE expensive kind should be a deliberate decision, not a default.)
 */
export function confirmByRerunEligible(kind: string): boolean {
  return (
    kind === 'browser' ||
    kind === 'multistep' ||
    kind === 'http' ||
    kind === 'ssl' ||
    kind === 'dns' ||
    kind === 'tcp' ||
    kind === 'ping'
  );
}

/**
 * How a confirm-eligible kind runs its confirmation:
 *   • DEDICATED fresh execution (ARM jobs/start) — browser/multistep. Their 3×~5-min budget can't ride a shared
 *     tick (the strand 0077 fixed), and they may be on long intervals, so waiting for the next scheduled tick is
 *     too slow — a fresh execution starts within seconds.
 *   • NEXT-TICK DRAIN (no dedicated pod) — cheap sub-second kinds (http/ssl/dns/tcp/ping). The runner's 5-minute
 *     cron drains pending run_requests at the START of every tick (index.ts), so the confirmation runs within ≤5 min
 *     with ZERO extra pods. A fresh pod (~10-30 s startup) for a ~200 ms check is ~98% pod overhead — wildly
 *     disproportionate, and the sequential-budget problem that FORCED a fresh execution for browser (3×5 min >
 *     660 s replicaTimeout) does not exist for a sub-second check. Measured p50: http 216 ms, dns 39 ms, ssl 78 ms.
 */
export function usesDedicatedExecution(kind: string): boolean {
  return kind === 'browser' || kind === 'multistep';
}
