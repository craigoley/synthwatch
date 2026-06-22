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

// A profile rule: route an alert class to a channel set. Missing fields are
// treated as wildcards; channels not also CONFIGURED are silently skipped.
interface AlertRule {
  severity?: 'critical' | 'warning' | 'any';
  status?: 'fail' | 'error' | 'warn' | 'resolved' | 'any';
  channels?: string[];
}

/** The class an alert routes by — distinct from the message verb (open/resolved/warn). */
type RouteStatus = 'fail' | 'error' | 'warn' | 'resolved';

/**
 * Resolve which channels should fire for (check.severity, routeStatus) from the
 * check's alert profile (or the 'default' profile when unassigned). Returns the
 * unioned channel names, an EMPTY array if the profile matches no rule (route
 * nothing), or `undefined` if no profile exists at all (=> legacy: all channels).
 */
async function profileChannels(
  check: Check,
  routeStatus: RouteStatus,
): Promise<string[] | undefined> {
  const { rows } = await pool.query<{ rules: AlertRule[] | null }>(
    `SELECT rules FROM alert_profiles
      WHERE id = COALESCE($1, (SELECT id FROM alert_profiles WHERE name = 'default'))`,
    [check.alert_profile_id],
  );
  if (rows.length === 0) return undefined; // no assigned + no 'default' -> legacy all
  const rules = Array.isArray(rows[0].rules) ? rows[0].rules : [];
  const channels = new Set<string>();
  for (const r of rules) {
    const sevOk = !r.severity || r.severity === 'any' || r.severity === check.severity;
    const stOk = !r.status || r.status === 'any' || r.status === routeStatus;
    if (sevOk && stOk) for (const ch of r.channels ?? []) channels.add(ch);
  }
  return [...channels];
}

export async function evaluate(check: Check, run: RunRecord): Promise<void> {
  const open = await getOpenIncident(check.id);

  // Incidents track the CROSS-LOCATION verdict, not a single run: the check is
  // "down" only when failing from >= N distinct locations (a single regional blip
  // is recorded + visible but does NOT page). With one location this is exactly
  // the old consecutive-failure behaviour.
  const verdict = await aggregateVerdict(check);

  // UP across locations (fewer than N locations failing) -> clear any incident.
  if (!verdict.down) {
    if (open) {
      await pool.query(
        `UPDATE incidents
            SET status = 'resolved', resolved_at = now(), resolved_run_id = $2
          WHERE id = $1`,
        [open.id, run.id],
      );
      await dispatchAlerts(
        {
          checkId: check.id,
          checkName: check.name,
          severity: check.severity,
          status: 'resolved',
          summary: `Check "${check.name}" recovered.`,
          runId: run.id,
        },
        await profileChannels(check, 'resolved'),
      );
    }

    if (run.status === 'pass') {
      // Clear the warn debounce so a fresh degradation re-notifies immediately.
      await pool.query(
        `UPDATE checks SET last_warn_notified_at = NULL
          WHERE id = $1 AND last_warn_notified_at IS NOT NULL`,
        [check.id],
      );
      return;
    }
    if (run.status === 'warn') {
      // warn: NOTIFY without opening an incident (SLA unaffected). Debounced, and
      // suppressed in a maintenance window.
      await maybeNotifyWarn(check, run);
      return;
    }
    // run is DOWN (fail/error) but the check is UP across locations — a minority
    // (e.g. single-region) failure: recorded + visible, but NO incident, NO page.
    // This is the false-positive class multi-location kills.
    return;
  }

  // DOWN across locations (>= N locations failing). The single-location count
  // (for the unchanged wording) is the current location's consecutive downs.
  const consecutive =
    verdict.total > 1
      ? verdict.failing
      : await countConsecutiveDown(check.id, check.failure_threshold, run.location);

  if (open) {
    // Already paged; keep the count fresh.
    await pool.query(
      `UPDATE incidents SET consecutive_failures = $2 WHERE id = $1`,
      [open.id, consecutive],
    );
    return;
  }

  // About to OPEN (and page). Suppress inside an active maintenance window —
  // planned downtime should not page. The run + status are already recorded;
  // suppression skips only the incident open + alert, never the data.
  if (await inMaintenanceWindow(check.id)) {
    console.log(
      `[runner] check ${check.id} "${check.name}" down (${run.status}) but ` +
        `incident suppressed — active maintenance window`,
    );
    return;
  }

  const where =
    verdict.total > 1
      ? `from ${verdict.failing} of ${verdict.total} locations`
      : `${consecutive} consecutive times`;
  const summary =
    `Check "${check.name}" down (${run.status}) ${where}` +
    (run.failed_step ? ` (died at step: ${run.failed_step})` : '') + '.';

  await pool.query(
    `INSERT INTO incidents (check_id, status, severity, opened_run_id,
                            consecutive_failures, summary)
     VALUES ($1, 'open', $2, $3, $4, $5)`,
    [check.id, check.severity, run.id, consecutive, summary],
  );

  // Route by the down status (fail|error) so a profile can split them. On the open
  // path the triggering run is always down; map defensively (pass/warn can't reach
  // here, but the verdict is cross-location so TS can't prove run.status is down).
  const routeStatus: RouteStatus = run.status === 'error' ? 'error' : 'fail';
  await dispatchAlerts(
    {
      checkId: check.id,
      checkName: check.name,
      severity: check.severity,
      status: 'open',
      summary,
      runId: run.id,
      failedStep: run.failed_step,
      screenshotUrl: run.screenshot_url,
    },
    await profileChannels(check, routeStatus),
  );
}

// A location silent longer than this is treated as offline (excluded from the
// verdict) so a decommissioned region can't pin a check down or up forever.
const STALE_LOCATION = '1 hour';

interface Verdict {
  /** down = failing from >= N distinct active locations. */
  down: boolean;
  /** active locations whose latest `failure_threshold` runs are all down. */
  failing: number;
  /** active locations (a completed run within STALE_LOCATION). */
  total: number;
}

/**
 * The cross-location verdict. A location is "failing" when its most-recent
 * `failure_threshold` completed runs are ALL down (the old per-check debounce, now
 * scoped per location). The check is DOWN when failing locations >= N, where
 * N = min_fail_locations, else 2 when >= 2 locations are active, else 1. With a
 * single active location this reduces to exactly the old behaviour.
 */
async function aggregateVerdict(check: Check): Promise<Verdict> {
  const { rows } = await pool.query<{ total: string; failing: string }>(
    `WITH recent AS (
       SELECT location, status,
              row_number() OVER (PARTITION BY location ORDER BY started_at DESC) AS rn,
              max(started_at) OVER (PARTITION BY location) AS loc_last
         FROM runs
        WHERE check_id = $1 AND status <> 'running'
     ),
     per_loc AS (
       SELECT location,
              bool_and(status IN ('fail','error')) FILTER (WHERE rn <= $2) AS all_down,
              count(*) FILTER (WHERE rn <= $2) AS recent_count,
              max(loc_last) AS loc_last
         FROM recent
        GROUP BY location
     )
     SELECT
       count(*) FILTER (WHERE loc_last > now() - $3::interval) AS total,
       count(*) FILTER (
         WHERE all_down AND recent_count >= $2 AND loc_last > now() - $3::interval
       ) AS failing
       FROM per_loc`,
    [check.id, check.failure_threshold, STALE_LOCATION],
  );
  const total = Number(rows[0]?.total ?? 0);
  const failing = Number(rows[0]?.failing ?? 0);
  const n = check.min_fail_locations ?? (total >= 2 ? 2 : 1);
  return { down: failing >= 1 && failing >= n, failing, total };
}

/**
 * Warn notification path — the feature that makes 'warn' (e.g. an expiring cert)
 * actually notify without being "down". No incident is opened (SLA unaffected).
 * Suppressed inside a maintenance window, and DEBOUNCED: notify at most once per
 * check.warn_renotify_seconds (reset to "first warn" on a pass), so a persistent
 * warn doesn't notify every tick.
 */
async function maybeNotifyWarn(check: Check, run: RunRecord): Promise<void> {
  if (await inMaintenanceWindow(check.id)) {
    console.log(
      `[runner] check ${check.id} "${check.name}" warn — notification suppressed (maintenance window)`,
    );
    return;
  }

  const { rows } = await pool.query<{ due: boolean }>(
    `SELECT (last_warn_notified_at IS NULL
             OR now() - last_warn_notified_at >= make_interval(secs => warn_renotify_seconds)) AS due
       FROM checks WHERE id = $1`,
    [check.id],
  );
  if (!rows[0]?.due) {
    console.log(`[runner] check ${check.id} "${check.name}" warn — notification debounced`);
    return;
  }

  await dispatchAlerts(
    {
      checkId: check.id,
      checkName: check.name,
      severity: check.severity,
      status: 'warn',
      summary: `Check "${check.name}" warning: ${run.error_message ?? 'degraded'}`,
      runId: run.id,
      failedStep: run.failed_step,
      screenshotUrl: run.screenshot_url,
    },
    await profileChannels(check, 'warn'),
  );

  // Record the attempt (caps the notify rate even if a channel was unconfigured).
  await pool.query(
    `UPDATE checks SET last_warn_notified_at = now() WHERE id = $1`,
    [check.id],
  );
}

/**
 * Is NOW inside an active maintenance window for this check? A check-specific
 * window (check_id = the check) OR a fleet-wide window (check_id IS NULL) both
 * suppress — either is sufficient. Uses now() (the alerting decision happens now);
 * the SLA exclusion separately uses each run's started_at.
 */
async function inMaintenanceWindow(checkId: number): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM maintenance_windows
      WHERE (check_id = $1 OR check_id IS NULL)
        AND now() >= starts_at
        AND now() <  ends_at
      LIMIT 1`,
    [checkId],
  );
  return rows.length > 0;
}

async function getOpenIncident(checkId: number): Promise<OpenIncident | null> {
  const { rows } = await pool.query<OpenIncident>(
    `SELECT id FROM incidents WHERE check_id = $1 AND status = 'open' LIMIT 1`,
    [checkId],
  );
  return rows[0] ?? null;
}

async function countConsecutiveDown(
  checkId: number,
  threshold: number,
  location?: string,
): Promise<number> {
  // Trailing consecutive down runs (optionally scoped to one location), used for
  // the single-location incident wording/count. Look back only as far as needed.
  const { rows } = await pool.query<{ status: 'pass' | 'warn' | 'fail' | 'error' | 'running' }>(
    `SELECT status FROM runs
      WHERE check_id = $1 ${location ? 'AND location = $3' : ''}
      ORDER BY started_at DESC
      LIMIT $2`,
    location ? [checkId, threshold, location] : [checkId, threshold],
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
