// Incident evaluation: turn a stream of runs into debounced incidents, and the
// perf-budget comparison that turns a passing browser run into a 'warn'.
//
// Availability partition (matches the SLA view): "up" = pass | warn (reachable,
// possibly degraded); "down" = fail | error. Incidents track DOWN: open after
// `failure_threshold` CONSECUTIVE down runs (so a single blip doesn't page),
// resolve on the first UP run. Because each check is claimed by exactly one
// replica per tick (see index.ts) there is no cross-replica race — the DB's
// partial unique index (one_open_incident_per_check) is a belt-and-braces backstop.
import { pool, type Check, type RunRecord } from './db.js';
import type { RunMetrics } from './metrics.js';
import { dispatchAlerts } from './alerts.js';

interface OpenIncident {
  id: number;
}

/**
 * Compare a browser run's captured Tier-1 metrics against the check's perf
 * budgets. Returns a human description of the breach(es), or null if all budgets
 * are met (or unset, or the metric wasn't captured). This is what makes the
 * perf_budget_* columns non-inert: a breach downgrades an otherwise-passing run
 * to 'warn' (see index.ts).
 */
export function perfBudgetBreach(check: Check, m: RunMetrics): string | null {
  const breaches: string[] = [];
  if (
    check.perf_budget_lcp_ms != null &&
    m.lcpMs != null &&
    m.lcpMs > check.perf_budget_lcp_ms
  ) {
    breaches.push(`LCP ${m.lcpMs}ms > budget ${check.perf_budget_lcp_ms}ms`);
  }
  if (
    check.perf_budget_transfer_bytes != null &&
    m.transferBytes != null &&
    m.transferBytes > check.perf_budget_transfer_bytes
  ) {
    breaches.push(
      `transfer ${m.transferBytes}B > budget ${check.perf_budget_transfer_bytes}B`,
    );
  }
  return breaches.length > 0 ? `perf budget breached: ${breaches.join('; ')}` : null;
}

export async function evaluate(check: Check, run: RunRecord): Promise<void> {
  const open = await getOpenIncident(check.id);

  // "up" = reachable (pass or degraded-but-available warn). An up run clears any
  // open availability incident.
  if (run.status === 'pass' || run.status === 'warn') {
    if (open) {
      await pool.query(
        `UPDATE incidents
            SET status = 'resolved', resolved_at = now(), resolved_run_id = $2
          WHERE id = $1`,
        [open.id, run.id],
      );
      await dispatchAlerts({
        checkName: check.name,
        severity: check.severity,
        status: 'resolved',
        summary: `Check "${check.name}" recovered.`,
        runId: run.id,
      });
    }
    return;
  }

  // run is DOWN (fail or error) -> count consecutive trailing down runs.
  const consecutive = await countConsecutiveDown(check.id, check.failure_threshold);
  if (consecutive < check.failure_threshold) {
    return; // still within the debounce window
  }

  if (open) {
    // Already paged; just keep the running count fresh.
    await pool.query(
      `UPDATE incidents SET consecutive_failures = $2 WHERE id = $1`,
      [open.id, consecutive],
    );
    return;
  }

  const summary =
    `Check "${check.name}" down (${run.status}) ${consecutive} consecutive times` +
    (run.failed_step ? ` (died at step: ${run.failed_step})` : '') + '.';

  await pool.query(
    `INSERT INTO incidents (check_id, status, severity, opened_run_id,
                            consecutive_failures, summary)
     VALUES ($1, 'open', $2, $3, $4, $5)`,
    [check.id, check.severity, run.id, consecutive, summary],
  );

  await dispatchAlerts({
    checkName: check.name,
    severity: check.severity,
    status: 'open',
    summary,
    runId: run.id,
    failedStep: run.failed_step,
    screenshotUrl: run.screenshot_url,
  });
}

async function getOpenIncident(checkId: number): Promise<OpenIncident | null> {
  const { rows } = await pool.query<OpenIncident>(
    `SELECT id FROM incidents WHERE check_id = $1 AND status = 'open' LIMIT 1`,
    [checkId],
  );
  return rows[0] ?? null;
}

async function countConsecutiveDown(checkId: number, threshold: number): Promise<number> {
  // We only need to look back as far as the threshold to make the open/skip
  // decision: if the most recent `threshold` runs are all DOWN, that's enough.
  const { rows } = await pool.query<{ status: 'pass' | 'warn' | 'fail' | 'error' | 'running' }>(
    `SELECT status FROM runs
      WHERE check_id = $1
      ORDER BY started_at DESC
      LIMIT $2`,
    [checkId, threshold],
  );
  let count = 0;
  for (const row of rows) {
    // DOWN = fail OR error. Counting only 'fail' (the old behaviour) meant an
    // all-'error' streak NEVER opened an incident — a silent alerting hole.
    // pass/warn (up) and running (in-flight, not a result) break the streak.
    if (row.status === 'fail' || row.status === 'error') count++;
    else break;
  }
  return count;
}
