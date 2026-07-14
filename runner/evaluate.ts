// Incident evaluation: turn a stream of runs into debounced incidents, and the
// perf-budget comparison that turns a passing browser run into a 'warn'.
//
// Availability partition (matches the SLA view): "up" = pass | warn (reachable,
// possibly degraded); "down" = fail | error. Incidents track DOWN: open after
// `failure_threshold` CONSECUTIVE down runs (so a single blip doesn't page),
// resolve on the first UP run. Because each check is claimed by exactly one
// replica per tick (see index.ts) there is no cross-replica race — the DB's
// partial unique index (one_open_incident_per_check) is a belt-and-braces backstop.
import { pool, type Check, type RunRecord, type TerminalStatus } from './db.js';
import type { RunMetrics } from './metrics.js';
import { dispatchAlerts, resolveChannels, type DispatchResult } from './alerts.js';
import { INVOCATION_ID } from './runnerErrors.js';
import { rcaEnabled, runRca } from './rca.js';
import { confirmByRerunEligible, usesDedicatedExecution } from './retry.js';
import { fireRunnerJobStart } from './jobTrigger.js';
import { classifyTransient, type TraceSignalsLike } from './transientClass.js';

/** Last-N SUCCESSFUL (pass/warn) runs used as the anti-flap baseline for transient classification. N=4
 *  matches the API ErrorDiff.BaselineRuns=4 COUNT, but the runner deliberately baselines against SUCCESSFUL
 *  runs (not settled ones, as the API error-diff does) so a sustained failure never enters its own baseline —
 *  the sustained-outage inversion fix. See classifyAndPersistTransient. */
const TRANSIENT_BASELINE_RUNS = 4;

interface OpenIncident {
  id: number;
  severity: 'critical' | 'warning';
}

/**
 * Compare a browser run's captured Tier-1 metrics against the check's perf
 * budgets. Returns a human description of the breach(es), or null if all budgets
 * are met (or unset, or the metric wasn't captured). This is what makes the
 * perf_budget_* columns non-inert: a breach downgrades an otherwise-passing run
 * to 'warn' (see index.ts).
 */
// ★ Per-location LATENCY tolerance for perf budgets. A geographically distant vantage has legitimately
// higher round-trip latency (physics) — without headroom a 3rd, more-distant region would red on NORMAL
// latency. Applies ONLY to latency metrics (LCP); page weight (transferBytes) is region-independent and
// is NEVER scaled. Primary/central regions = 1.0 (no change); the distant westus2 carries headroom. An
// unknown location falls back to 1.0 (never tightens a budget).
export const LOCATION_LATENCY_TOLERANCE: Record<string, number> = {
  default: 1.0, // primary region (eastus2), label 'default'
  eastus2: 1.0,
  centralus: 1.0,
  westus2: 1.3, // ~cross-continent RTT headroom so normal west-coast latency isn't a false breach
};

export function latencyToleranceFor(location: string): number {
  return LOCATION_LATENCY_TOLERANCE[location] ?? 1.0;
}

export function perfBudgetBreach(check: Check, m: RunMetrics, location = 'default'): string | null {
  const breaches: string[] = [];
  // LCP is latency-bound → scale the budget by this vantage's tolerance (the distant region gets headroom).
  const lcpTolerance = latencyToleranceFor(location);
  const lcpBudget =
    check.perf_budget_lcp_ms != null ? Math.round(check.perf_budget_lcp_ms * lcpTolerance) : null;
  if (lcpBudget != null && m.lcpMs != null && m.lcpMs > lcpBudget) {
    breaches.push(
      `LCP ${m.lcpMs}ms > budget ${lcpBudget}ms` +
        (lcpTolerance !== 1.0
          ? ` (${check.perf_budget_lcp_ms}ms ×${lcpTolerance} ${location} latency tolerance)`
          : ''),
    );
  }
  // Page weight is region-independent — compared against the raw budget, no location scaling.
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

/** True if this check configures ANY perf budget — i.e. metrics are EXPECTED and must be evaluable. A
 *  check with no budget legitimately needs no metrics; distinguishing it from "has a budget but couldn't
 *  evaluate it" is the crux of the B1 inverted-signal fix. */
export function hasPerfBudget(check: Check): boolean {
  return check.perf_budget_lcp_ms != null || check.perf_budget_transfer_bytes != null;
}

/**
 * ★ B1 silent-null: did a metric the check has a BUDGET for fail to CAPTURE? `captureFailed` (from
 * metrics.collect()) holds fields whose collection section threw → null-because-failed. A budgeted metric
 * in that set is not-evaluable, exactly like the #146 throw path, so the run must NOT pass green.
 * Crucially, a budgeted metric that is null but NOT in the set was captured-and-legitimately-absent (a
 * page that genuinely fires no LCP) → returns false → still passes. This is the line that must not be
 * crossed. Per-budgeted-metric (not a blanket "any capture failed"), so a transfer-capture failure on an
 * LCP-only-budgeted check is not a false error.
 */
export function budgetedMetricCaptureFailed(
  check: Check,
  captureFailed: ReadonlySet<keyof RunMetrics>,
): boolean {
  return (
    (check.perf_budget_lcp_ms != null && captureFailed.has('lcpMs')) ||
    (check.perf_budget_transfer_bytes != null && captureFailed.has('transferBytes'))
  );
}

/**
 * The perf-budget verdict adjustment for an otherwise-PASSING run (pure; runOne in index.ts delegates
 * here). Decides the final status:
 *   • ★ B1 — metricsCaptureFailed AND a budget IS configured → 'error'. The run was BLIND to a budget it
 *     was supposed to enforce; absence of the signal ≠ the signal is good (a blind run is worse than a
 *     failing one), so it must NOT record a healthy pass. This OUTRANKS a breach-warn.
 *   • a real breach (metric present + over budget) → 'warn' (degraded-but-available; unchanged).
 *   • otherwise (no budget configured, or within budget, or capture succeeded) → unchanged 'pass'.
 * A non-'pass' base status or null metrics (HTTP runs — no metrics expected) → returned unchanged, so a
 * legitimately metric-less run is never falsely failed.
 */
export function perfBudgetVerdict(
  check: Check,
  baseStatus: TerminalStatus,
  metrics: RunMetrics | null,
  metricsCaptureFailed: boolean,
  location = 'default',
): { status: TerminalStatus; message: string | null } {
  if (baseStatus !== 'pass' || !metrics) return { status: baseStatus, message: null };
  if (metricsCaptureFailed && hasPerfBudget(check)) {
    return {
      status: 'error',
      message:
        'perf budget configured but metric capture failed — run could not be evaluated; recording error, not a blind pass',
    };
  }
  // location-aware: a distant vantage's LCP budget carries latency headroom (see perfBudgetBreach).
  const breach = perfBudgetBreach(check, metrics, location);
  if (breach) return { status: 'warn', message: breach };
  return { status: 'pass', message: null };
}

// Channel routing now lives in the DB (channels + alert_routes), resolved by
// resolveChannels(checkId, check.severity) in alerts.ts — severity-default with a
// per-check override. (Replaces the old env-targets + alert_profiles status-routing.)

/**
 * ★ DELIVERY ACCOUNTING (0082). Persist the outcome of an incident alert dispatch so a FAILED page is
 * distinguishable from a successful one — before this, both left identical DB state (a send that threw was
 * caught inside dispatchAlerts, logged to the ephemeral container log, returned as {delivered:0}, and dropped,
 * which is why it was UNKNOWABLE whether incidents 167/165 paged once the logs rotated). Writes the LATEST
 * outcome + a running attempt count onto the incident; on a hard failure ALSO writes a runner_errors row (the
 * durable, greppable trail — the incident columns only hold the latest attempt). Non-fatal by construction:
 * an accounting failure must NEVER break the run that just paged.
 *   'sent'    — at least one channel delivered.
 *   'failed'  — channels were tried and ALL rejected (also → runner_errors, phase alert-dispatch-failed).
 *   'skipped' — no deliverable channel configured. A REAL state that must NOT read as success.
 */
export async function recordIncidentDispatch(
  incidentId: number,
  checkId: number,
  phase: 'open' | 'resolve' | 'enrichment',
  r: DispatchResult,
): Promise<void> {
  const status: 'sent' | 'failed' | 'skipped' =
    r.active === 0 ? 'skipped' : r.delivered > 0 ? 'sent' : 'failed';
  const detail =
    status === 'failed'
      ? r.results
          .filter((x) => !x.ok)
          .map((x) => `${x.name} (${x.type}): ${x.error ?? 'no detail'}`)
          .join('; ') || 'all channels rejected'
      : status === 'skipped'
        ? 'no deliverable channel configured'
        : null;
  try {
    await pool.query(
      `UPDATE incidents
          SET notify_attempted_at = now(), notify_status = $2, notify_error = $3,
              notify_attempts = notify_attempts + 1
        WHERE id = $1`,
      [incidentId, status, detail],
    );
    if (status === 'failed') {
      // ★ LOUD: a page that failed to deliver is worse than no page (you believe you were told). Surface it
      // in runner_errors so it isn't swallowed with the rotating container log.
      await pool.query(
        `INSERT INTO runner_errors (invocation_id, phase, check_id, message)
         VALUES ($1, 'alert-dispatch-failed', $2, $3)`,
        [
          INVOCATION_ID,
          checkId,
          `incident ${incidentId} ${phase} alert FAILED to deliver on all ${r.active} channel(s): ${detail}`,
        ],
      );
    }
  } catch (err) {
    console.warn(`[alerts] incident ${incidentId} ${phase} dispatch-accounting failed (non-fatal):`, err);
  }
}

export async function evaluate(check: Check, run: RunRecord): Promise<void> {
  // ★ Option C: 'infra_error' = the runner couldn't FETCH this browser check's own spec. That
  // is an INFRA problem, NOT a monitored-site outage — it must NEVER page. Short-circuit BEFORE
  // any incident/alert logic: no incident opened, no alert dispatched, no open incident touched
  // (an unrelated open incident stays as-is; a real recovery run will resolve it). The run is
  // already recorded + visible; the cross-location verdict also excludes infra_error (below), so
  // it never counts toward 'down'. This is the live integration point of the #104 guard.
  if (run.status === 'infra_error') {
    console.warn(
      `[runner] check ${check.id} "${check.name}" infra_error (couldn't fetch spec) — ` +
        `recorded + visible; NO incident, NO alert (not a site outage).`,
    );
    return;
  }

  const open = await getOpenIncident(check.id);

  // Incidents track the CROSS-LOCATION verdict, not a single run: the check is
  // "down" only when failing from >= N distinct locations (a single regional blip
  // is recorded + visible but does NOT page). With one location this is exactly
  // the old consecutive-failure behaviour.
  const verdict = await aggregateVerdict(check);
  // ★ 0085 (single-region WARNING). Incident severity from the cross-location scope:
  //   null = no region sustainedly down (recover/up) · 'warning' = a single/minority region sustainedly down
  //   · check.severity (CRITICAL) = majority quorum met (unchanged). See incidentSeverity.
  const desired = incidentSeverity(
    verdict.failing,
    verdict.failingWarning,
    verdict.total,
    check.min_fail_locations,
    check.severity as 'critical' | 'warning',
  );

  // No region sustainedly down -> clear any open incident (recovery) + handle this run's pass/warn/sub-threshold.
  if (desired === null) {
    if (open) {
      // Resolve the incident row regardless (the check IS up now). But gate the
      // recovery ALERT on the maintenance window, symmetric with the open path: a
      // maintenance endpoint serving 200 shouldn't fire a "recovered" page mid-window.
      // RETURNING the timestamps + rca for the resolved email (duration + RCA recap —
      // by resolve time RCA has run, so the recovery email CAN carry it).
      const { rows: resolvedRows } = await pool.query<{
        opened_at: Date;
        resolved_at: Date;
        rca: { classification: string; confidence: string; summary?: string } | null;
      }>(
        `UPDATE incidents
            SET status = 'resolved', resolved_at = now(), resolved_run_id = $2
          WHERE id = $1 AND status = 'open'
        RETURNING opened_at, resolved_at, rca`,
        [open.id, run.id],
      );
      const resolvedInc = resolvedRows[0];
      // ★ RESOLVE-RACE: page ONLY if THIS region's UPDATE actually flipped open->resolved (a row
      // returned). With 3 regions two can recover in the SAME tick and both reach here; the `AND status =
      // 'open'` above makes the loser match 0 rows -> resolvedInc undefined -> no second "recovered" page
      // (mirrors the open path's `ON CONFLICT ... DO NOTHING`). A lone resolver still pages exactly once.
      if (resolvedInc) {
        if (await inMaintenanceWindow(check.id)) {
          console.log(
            `[runner] check ${check.id} "${check.name}" recovered — recovery alert suppressed (maintenance window)`,
          );
        } else {
          // ★ 0085: route the RECOVERY at the incident's OWN severity (open.severity), NOT check.severity. A
          // WARNING incident opened + paged the warning-severity channel; its "recovered" must go back to that
          // SAME channel, or the warning channel never sees closure and the critical channel sees a recovery
          // for an incident it never saw open (check.severity is 'critical' for every affected check).
          const resolveDispatch = await dispatchAlerts(
            {
              checkId: check.id,
              checkName: check.name,
              severity: open.severity,
              status: 'resolved',
              summary: `Check "${check.name}" recovered.`,
              runId: run.id,
              incident: {
                incidentId: open.id,
                targetUrl: check.target_url,
                openedAt: resolvedInc.opened_at?.toISOString() ?? null,
                resolvedAt: resolvedInc.resolved_at?.toISOString() ?? null,
                rca: resolvedInc.rca ?? null,
              },
            },
            await resolveChannels(check.id, open.severity),
          );
          await recordIncidentDispatch(open.id, check.id, 'resolve', resolveDispatch);
        }
      }
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

  // ===== DOWN: >= 1 region is sustainedly down. `desired` is 'warning' (a single/minority region) or the
  // check's severity (CRITICAL, majority quorum met). The single-location count (for the wording) is this
  // location's consecutive downs. =====
  const consecutive =
    verdict.total > 1
      ? verdict.failing
      : await countConsecutiveDown(check.id, check.failure_threshold, run.location);
  const where =
    verdict.total > 1
      ? `from ${verdict.failing} of ${verdict.total} locations`
      : `${consecutive} consecutive times`;
  const summary =
    `Check "${check.name}" down (${run.status}) ${where}` +
    (run.failed_step ? ` (died at step: ${run.failed_step})` : '') + '.';

  // (1) An incident is already OPEN. Keep the count fresh and — ★ ESCALATE warning → critical if the outage
  // has now spread to a majority (the per-tick path: getOpenIncident saw the open warning). Escalate-only-UP:
  // a shrinking outage never downgrades a live incident (it resolves via the recovery path). Page on the flip.
  if (open) {
    const escalating = open.severity === 'warning' && desired === 'critical';
    const { rows: escRows } = await pool.query<{ severity: 'critical' | 'warning'; opened_at: Date }>(
      `UPDATE incidents
          SET consecutive_failures = $2,
              severity = CASE WHEN $3 THEN 'critical' ELSE severity END,
              summary  = CASE WHEN $3 THEN $4 ELSE summary END
        WHERE id = $1 AND status = 'open'
        RETURNING severity, opened_at`,
      [open.id, consecutive, escalating, summary],
    );
    if (escalating && escRows[0]?.severity === 'critical') {
      if (await inMaintenanceWindow(check.id)) {
        console.log(
          `[runner] check ${check.id} "${check.name}" escalated warning→critical — page suppressed (maintenance window)`,
        );
      } else {
        const escDispatch = await dispatchAlerts(
          {
            checkId: check.id,
            checkName: check.name,
            severity: 'critical',
            status: 'open',
            summary: `[ESCALATED → CRITICAL] ${summary}`,
            runId: run.id,
            failedStep: run.failed_step,
            screenshotUrl: run.screenshot_url,
            incident: {
              incidentId: open.id,
              targetUrl: check.target_url,
              openedAt: escRows[0].opened_at?.toISOString() ?? new Date().toISOString(),
              locations: await failingLocationNames(check),
              consecutiveFailures: consecutive,
              rca: null,
            },
          },
          await resolveChannels(check.id, 'critical'),
        );
        await recordIncidentDispatch(open.id, check.id, 'open', escDispatch);
      }
    }
    return;
  }

  // (2) No open incident → OPEN at `desired`. Suppress the open + page inside a maintenance window (the run +
  // status are already recorded; suppression skips only the incident open + alert, never the data).
  if (await inMaintenanceWindow(check.id)) {
    console.log(
      `[runner] check ${check.id} "${check.name}" down (${run.status}) but ` +
        `incident suppressed — active maintenance window`,
    );
    return;
  }

  // ON CONFLICT: with per-location cadence two regions can evaluate concurrently, both see no open incident,
  // and both reach this INSERT (the partial unique index one_open_incident_per_check would otherwise make the
  // loser THROW → the run's catch → process.exit(1)). ★ DO UPDATE, not DO NOTHING: if the row already exists as
  // a WARNING and THIS tick computed CRITICAL (the outage spread within the race), ESCALATE it — a regional
  // outage that spreads must never be silently dropped. The WHERE fires ONLY on that escalation; a
  // same-or-higher-severity conflict updates nothing (no row returned) and no-ops. inserted (xmax=0)
  // distinguishes a fresh open (page `desired`) from a race-escalation (page CRITICAL).
  const { rows: incidentRows } = await pool.query<{ id: number; inserted: boolean }>(
    `INSERT INTO incidents (check_id, status, severity, opened_run_id, consecutive_failures, summary)
     VALUES ($1, 'open', $2, $3, $4, $5)
     ON CONFLICT (check_id) WHERE status = 'open'
     DO UPDATE SET severity = 'critical', summary = EXCLUDED.summary,
                   consecutive_failures = EXCLUDED.consecutive_failures
           WHERE incidents.severity = 'warning' AND EXCLUDED.severity = 'critical'
     RETURNING id, (xmax = 0) AS inserted`,
    [check.id, desired, run.id, consecutive, summary],
  );
  if (!incidentRows[0]) {
    // Conflict with no escalation — another location already opened it at >= this severity this tick. It pages.
    console.log(
      `[runner] check ${check.id} "${check.name}" down — incident already open (>= this severity) this tick`,
    );
    return;
  }
  const incidentId = incidentRows[0].id;
  const inserted = incidentRows[0].inserted;
  // inserted → a NEW incident at `desired`; else → we escalated an existing WARNING to CRITICAL in the race.
  const pageSeverity: 'critical' | 'warning' = inserted ? desired : 'critical';
  const pageSummary = inserted ? summary : `[ESCALATED → CRITICAL] ${summary}`;

  // Rich-email context. RCA is null here — it runs AFTER this dispatch (below) so a slow model can't delay
  // paging, so the OPEN email never carries RCA. (The RESOLVED email does.)
  const openDispatch = await dispatchAlerts(
    {
      checkId: check.id,
      checkName: check.name,
      severity: pageSeverity,
      status: 'open',
      summary: pageSummary,
      runId: run.id,
      failedStep: run.failed_step,
      screenshotUrl: run.screenshot_url,
      incident: {
        incidentId,
        targetUrl: check.target_url,
        openedAt: new Date().toISOString(),
        locations: await failingLocationNames(check),
        consecutiveFailures: consecutive,
        rca: null,
      },
    },
    await resolveChannels(check.id, pageSeverity),
  );
  await recordIncidentDispatch(incidentId, check.id, 'open', openDispatch);

  // AI root-cause analysis (opt-in, non-fatal) — fires ONLY on a NEW incident-open (inserted; not a
  // race-escalation of an existing one, which already ran RCA when it opened), so a flapping check isn't
  // RCA-spammed. Runs AFTER the alert so a slow model never delays paging; writes structured JSON into the
  // incident. Any failure is swallowed: the incident keeps its record without rca.
  if (inserted && rcaEnabled()) {
    try {
      const rca = await runRca(check, run, { failing: verdict.failing, total: verdict.total });
      if (rca) {
        await pool.query(`UPDATE incidents SET rca = $2 WHERE id = $1`, [incidentId, JSON.stringify(rca)]);
        console.log(
          `[rca] check ${check.id} incident ${incidentId}: ${rca.classification} ` +
            `(${rca.confidence}${rca.cached ? ', cached' : ''})`,
        );
        // "RCA ready" ENRICHMENT — a SECOND notification to the SAME channels the open page
        // hit, ~10-30s after it, now that RCA is in. Strictly additive + AFTER the open
        // dispatch: a failure here is swallowed (non-fatal) and can never touch the open
        // alert (already sent) or the incident. Only fires when rca exists (RCA-failed ->
        // nothing, by design). Fires at most once (rca_notified_at guard).
        await sendRcaReadyEnrichment(check, incidentId, rca).catch((err) =>
          console.warn(
            `[rca-enrich] incident ${incidentId} enrichment failed (non-fatal):`,
            err instanceof Error ? err.message : err,
          ),
        );
      } else {
        // runRca returns null on failure (it NEVER throws, so the page is never blocked) —
        // a token error, model failure, or truncation. That left rca silently NULL, masked
        // by the 24h cache (the intermittent-RCA bug that hid for days). Surface it on the
        // incident-open path so a high RCA-failure rate is greppable HERE, not only in
        // rca.ts's internal logs. (rca.ts logs the specific reason, e.g. "[rca] failed".)
        console.warn(
          `[rca] check ${check.id} incident ${incidentId}: NO RCA produced (runRca returned null — see [rca] failure logs)`,
        );
      }
    } catch (err) {
      console.warn(
        `[rca] check ${check.id} incident ${incidentId} skipped (non-fatal):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

// A location silent longer than this is treated as offline (excluded from the
// verdict) so a decommissioned region can't pin a check down or up forever.
const STALE_LOCATION = '1 hour';

// ★ 0085 WARNING debounce. A single-region WARNING requires that region to be consecutively down for
// MULTIPLIER × failure_threshold runs — a HIGHER evidence bar than the failure_threshold that gates CRITICAL.
// DERIVED from the 30-day replay, not invented: at the flat failure_threshold bar the flagship flapper (342,
// westus2, failure_threshold=3) produced 30 warnings/month (~1/day about a known state — noise is silence
// wearing different clothes). The curve of warnings/30d vs multiplier: flat=59 → 2×=34 → 3×=22 → 4×=20; #342
// alone: 30 → 4 → 2 → 2. The knee is 2×: it collapses #342's daily churn (30→4) while STILL catching its real
// 16-consecutive outage (16 ≥ 2×3=6), and it is the most sensitive multiplier that does so (3×/4× only shave a
// further ~12 fleet-wide while raising the bar past genuine 6–8-run regional outages). CRITICAL is UNAFFECTED —
// it uses `failing` at the failure_threshold bar, so a spread to majority pages immediately, never debounced.
const WARNING_DEBOUNCE_MULTIPLIER = 2;

interface Verdict {
  /** down = failing from >= effective-N distinct active locations. */
  down: boolean;
  /** active locations whose latest `failure_threshold` runs are all down (the CRITICAL / majority bar). */
  failing: number;
  /** active locations whose latest `MULTIPLIER × failure_threshold` runs are all down (the WARNING bar). */
  failingWarning: number;
  /** active locations (a completed run within STALE_LOCATION). */
  total: number;
}

/**
 * The effective cross-location threshold N — the failing/burning-location count must
 * reach this to page. SHARED by the incident verdict (crossLocationDown) and the burn
 * path so the two can never diverge.
 *
 * N is based on REPORTING locations (those with a recent run), NOT all-ASSIGNED. A
 * stale/silent region (no recent runs — runner crash, region outage, deploy gap) can't
 * be in the failing set, so counting it toward N would SILENTLY BLOCK paging whenever a
 * selected region goes quiet, even when every region that IS reporting is down. That is
 * a monitoring-self-failure; basing N on reporting locations fixes it.
 *   - NULL override (the default) => N = a MAJORITY of REPORTING locations, floor(n/2)+1.
 *     This is the 2-of-3 QUORUM: a lone regional blip (1 of 3) is suppressed, ≥2 still
 *     pages. By reporting count: 1→1, 2→2, 3→2, 4→3, 5→3. ★ Note 1→1 and 2→2 are IDENTICAL
 *     to the old N-of-N default, so the live 2-region fleet is unchanged until a 3rd region
 *     reports — at which point a real outage (≥2 regions) still pages but a single-region
 *     blip no longer does. (Was N-of-N: required ALL reporting to fail — so 3 regions needed
 *     3-of-3, missing real outages where one region happened to stay up.)
 *   - explicit INT => that absolute threshold, CAPPED at the reporting count (so an
 *     override larger than the reporting set can't reintroduce the block-forever trap).
 * Single reporting location => N=1 => exactly the pre-multi-location behaviour.
 */
export function effectiveN(reporting: number, minFailLocations: number | null): number {
  return minFailLocations == null
    ? Math.floor(reporting / 2) + 1 // majority quorum (2-of-3)
    : Math.min(minFailLocations, reporting);
}

/**
 * Cross-location "down" decision: DOWN only when >= effectiveN(reporting) locations are
 * failing. The `failing >= 1` floor keeps a check with nothing failing (incl. a fully
 * silent check, reporting=0) UP. With one reporting location, N=1 => one failing = down.
 */
export function crossLocationDown(
  failing: number,
  reporting: number,
  minFailLocations: number | null,
): boolean {
  return failing >= 1 && failing >= effectiveN(reporting, minFailLocations);
}

/**
 * ★ Incident severity from the cross-location scope (0085 — the single-region WARNING ruling). Reuses the SAME
 * majority quorum as crossLocationDown (effectiveN); it does NOT change that quorum. Takes TWO failing counts:
 *   • `failing`        — regions down for failure_threshold runs (the CRITICAL / majority bar).
 *   • `failingWarning` — regions down for MULTIPLIER × failure_threshold runs (the higher WARNING bar).
 * Decision (CRITICAL is checked FIRST and uses the LOW bar, so it is NEVER delayed by the warning debounce):
 *   • failing >= effectiveN   → check's configured severity (CRITICAL) — the majority path, UNCHANGED.
 *   • failingWarning >= 1      → 'warning'  (a single / minority region sustained PAST the debounce).
 *   • otherwise               → null (no incident).
 * Why a WARNING at all (not silence): the old "minority ⇒ no incident" gave a sustained single-region outage
 * (342: 16 consecutive westus2 failures, 219 failed runs over 3 days) ZERO acknowledgeable signal, so the
 * operator DELETED westus2 to make it stop — manufacturing green by removing the observation. Why a HIGHER bar
 * for the warning (the debounce): the flat bar turned 342's flapping westus2 into ~1 warning/day about a known
 * state — noise, which ends the same way as silence (ignored). The 2× bar (see WARNING_DEBOUNCE_MULTIPLIER)
 * raises the EVIDENCE required for a regional outage; it does not lower the listening rate.
 */
export function incidentSeverity(
  failing: number,
  failingWarning: number,
  total: number,
  minFailLocations: number | null,
  checkSeverity: 'critical' | 'warning',
): 'critical' | 'warning' | null {
  if (failing >= 1 && failing >= effectiveN(total, minFailLocations)) return checkSeverity; // majority → CRITICAL (low bar, immediate)
  if (failingWarning >= 1) return 'warning'; // a single / minority region sustained past the WARNING debounce
  return null;
}

/**
 * The cross-location verdict. A location is "failing" when its most-recent
 * `failure_threshold` completed runs are ALL down (the old per-check debounce, now
 * scoped per location). DOWN per crossLocationDown(): >= effectiveN locations failing,
 * where N defaults to all REPORTING locations (`total` — those with a run within
 * STALE_LOCATION). A stale/silent selected region is NOT in `total`, so it can't block
 * paging. Single reporting location => N=1 => exactly the old behaviour.
 */
async function aggregateVerdict(check: Check): Promise<Verdict> {
  const warningThreshold = WARNING_DEBOUNCE_MULTIPLIER * check.failure_threshold;
  const { rows } = await pool.query<{ total: string; failing: string; failing_warning: string }>(
    `WITH recent AS (
       SELECT location, status,
              row_number() OVER (PARTITION BY location ORDER BY started_at DESC) AS rn,
              max(started_at) OVER (PARTITION BY location) AS loc_last
         FROM countable_run
        -- ★ countable_run (0081): the ONE canonical "countable scheduled observation" — status(not
        -- running/infra) + non-superseded + non-confirmation + non-sandbox. This was inlined here (#295
        -- added the confirmation exclusion) but MISSED the sandbox exclusion; the view adds it and shares
        -- the exact definition with sla_availability / slo_status / rollup so all five count identically.
        -- WHY confirmation is excluded: a confirmation run is a RE-CHECK of a failure already in this window
        -- (the scheduled run it confirms), not an independent observation — counting it double-counts one
        -- failure, silently ~halving every failure_threshold ≥ 2. The scheduled run it confirms stays in the
        -- window (superseded only if its confirmation PASSED), so the window counts exactly "consecutive
        -- confirmed SCHEDULED failures". Under-alerting-safe: the confirmation's evaluate() runs only after
        -- the scheduled run it confirms is durably committed, so the window is never short by one.
        WHERE check_id = $1
     ),
     per_loc AS (
       SELECT location,
              -- CRITICAL / majority bar: the latest failure_threshold ($2) runs all down.
              bool_and(status IN ('fail','error')) FILTER (WHERE rn <= $2) AS all_down,
              count(*) FILTER (WHERE rn <= $2) AS recent_count,
              -- WARNING bar (0085): the latest MULTIPLIER x failure_threshold ($4) runs all down — a higher
              -- evidence bar so a flapping region cannot churn a daily warning. recent_count_warn >= $4 also
              -- requires the region to HAVE that many recent runs (a young region cannot warn early).
              bool_and(status IN ('fail','error')) FILTER (WHERE rn <= $4) AS all_down_warn,
              count(*) FILTER (WHERE rn <= $4) AS recent_count_warn,
              max(loc_last) AS loc_last
         FROM recent
        GROUP BY location
     )
     SELECT
       count(*) FILTER (WHERE loc_last > now() - $3::interval) AS total,
       count(*) FILTER (
         WHERE all_down AND recent_count >= $2 AND loc_last > now() - $3::interval
       ) AS failing,
       count(*) FILTER (
         WHERE all_down_warn AND recent_count_warn >= $4 AND loc_last > now() - $3::interval
       ) AS failing_warning
       FROM per_loc`,
    [check.id, check.failure_threshold, STALE_LOCATION, warningThreshold],
  );
  // N is over REPORTING locations (`total`), NOT assigned — a stale region must not
  // veto paging (the silent-suppression bug). failing <= total always.
  const total = Number(rows[0]?.total ?? 0);
  const failing = Number(rows[0]?.failing ?? 0);
  const failingWarning = Number(rows[0]?.failing_warning ?? 0);
  return { down: crossLocationDown(failing, total, check.min_fail_locations), failing, failingWarning, total };
}

/**
 * Names of the locations currently DOWN for the check — same definition as
 * aggregateVerdict's `failing` count (all of the recent failure_threshold runs down,
 * and reporting within STALE_LOCATION). For the alert email's "Locations" fact.
 */
async function failingLocationNames(check: Check): Promise<string[]> {
  const { rows } = await pool.query<{ location: string }>(
    `WITH recent AS (
       SELECT location, status,
              row_number() OVER (PARTITION BY location ORDER BY started_at DESC) AS rn,
              max(started_at) OVER (PARTITION BY location) AS loc_last
         FROM runs
        WHERE check_id = $1 AND status NOT IN ('running', 'infra_error')
     )
     SELECT location
       FROM recent
      GROUP BY location
     HAVING bool_and(status IN ('fail','error')) FILTER (WHERE rn <= $2)
        AND count(*) FILTER (WHERE rn <= $2) >= $2
        AND max(loc_last) > now() - $3::interval
      ORDER BY location`,
    [check.id, check.failure_threshold, STALE_LOCATION],
  );
  return rows.map((r) => r.location);
}

/**
 * "RCA ready" enrichment — a follow-up notification to the SAME channels the open page
 * reached, once RCA completes for a newly-opened incident. It's an UPDATE to incident #N
 * (subject/header say "RCA READY" + the incident id), NOT a new incident.
 *
 * Fires AT MOST ONCE per incident: a conditional UPDATE claims rca_notified_at atomically
 * (NULL -> now()), so a second runner execution / a reopen never re-sends. Claimed BEFORE
 * the send (standard at-most-once): if the send then fails it isn't retried — acceptable,
 * the open page already did its job and the incident page still shows the RCA.
 *
 * RCA-failed -> this is never called (the caller only enters on a real rca), so a failed
 * RCA sends NOTHING (no broken "RCA ready" with no verdict — Craig's lean, confirmed).
 */
export async function sendRcaReadyEnrichment(
  check: Check,
  incidentId: number,
  rca: { classification: string; confidence: string; summary?: string },
): Promise<void> {
  const claim = await pool.query<{ id: number }>(
    `UPDATE incidents SET rca_notified_at = now()
      WHERE id = $1 AND rca_notified_at IS NULL
      RETURNING id`,
    [incidentId],
  );
  if (!claim.rows[0]) return; // already enriched once — do not re-send

  // SAME channels as the open alert (Craig's decision) — identical resolution.
  const channels = await resolveChannels(check.id, check.severity);
  const enrichDispatch = await dispatchAlerts(
    {
      checkId: check.id,
      checkName: check.name,
      severity: check.severity,
      status: 'open', // still the open incident; rcaReady governs the wording/subject
      rcaReady: true,
      summary: `Root-cause analysis is ready for incident #${incidentId}.`,
      runId: null,
      incident: {
        incidentId,
        targetUrl: check.target_url,
        rca: {
          classification: rca.classification,
          confidence: rca.confidence,
          summary: rca.summary,
        },
      },
    },
    channels,
  );
  await recordIncidentDispatch(incidentId, check.id, 'enrichment', enrichDispatch);
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

  const { active, delivered } = await dispatchAlerts(
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
    await resolveChannels(check.id, check.severity),
  );

  // Stamp the debounce UNLESS every configured channel failed. With no configured
  // channel (active=0) we still stamp — nothing to retry, and the rate must be capped.
  // But if channels were tried and ALL failed (e.g. an ACS outage), DON'T stamp, so
  // the warn re-fires next tick instead of being silently dropped for
  // warn_renotify_seconds (a warn has no persisted incident row to fall back on).
  if (active > 0 && delivered === 0) {
    console.warn(
      `[runner] check ${check.id} "${check.name}" warn — all ${active} channel(s) failed; not debouncing (will retry next tick)`,
    );
  } else {
    await pool.query(
      `UPDATE checks SET last_warn_notified_at = now() WHERE id = $1`,
      [check.id],
    );
  }
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
    `SELECT id, severity FROM incidents WHERE check_id = $1 AND status = 'open' LIMIT 1`,
    [checkId],
  );
  return rows[0] ?? null;
}

/**
 * Cheap "is this check ALREADY confirmed-down?" signal for the fast-retry skip (one lookup on the
 * partial-unique one_open_incident_per_check index). An OPEN incident means a prior run already
 * confirmed the failure and it hasn't recovered — so the in-run fast-retry's transient-absorption is
 * moot. It self-resets: evaluate() resolves the incident on a recovery pass, so the next fresh
 * failure sees no open incident and gets full retry again.
 */
export async function hasOpenIncident(checkId: number): Promise<boolean> {
  return (await getOpenIncident(checkId)) !== null;
}

async function countConsecutiveDown(
  checkId: number,
  threshold: number,
  location?: string,
): Promise<number> {
  // Trailing consecutive down runs (optionally scoped to one location), used for
  // the single-location incident wording/count. Look back only as far as needed.
  // ★ countable_run (0081): the same canonical window as aggregateVerdict — non-superseded, non-confirmation,
  // non-sandbox, real-result runs. A confirmation run (a re-check of a failure already here) and a superseded
  // transient (a self-healed blip) are not independent observations, so counting them made the DISPLAYED
  // consecutive_failures larger than the number that actually triggered the incident. Sourcing from the view
  // also drops running/infra_error before the LIMIT, so N slots hold N real observations (an infra blip no
  // longer consumes a slot). The JS loop's infra_error/running branches below are now unreachable but harmless.
  const { rows } = await pool.query<{
    status: 'pass' | 'warn' | 'fail' | 'error' | 'infra_error' | 'running';
  }>(
    `SELECT status FROM countable_run
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
    // infra_error = "didn't run" (couldn't fetch spec): neither counts nor breaks the
    // down-streak (skip it), so a fetch blip can't reset a genuine outage's count.
    else if (row.status === 'infra_error') continue;
    else break;
  }
  return count;
}

// Multi-window multi-burn-rate (Google SRE). Fast=1h page (burns ~2% of a 30d
// budget in 1h); slow=6h ticket. burn_rate is normalized: (down/total)/(1-target),
// so 1.0 = on track to exactly exhaust the budget over the SLO window.
const BURN_FAST_WINDOW = '1 hour';
const BURN_FAST_THRESHOLD = 14.4;
const BURN_SLOW_WINDOW = '6 hours';
// Short confirmation window paired with the 6h slow window (Google multi-window):
// slow only pages when BOTH the 6h AND this 30m window are burning, so a recovered
// check stops alerting promptly instead of riding the still-elevated 6h window.
const BURN_SLOW_SHORT_WINDOW = '30 minutes';
const BURN_SLOW_THRESHOLD = 6;

/** A location's burn over a window, plus its sample size (for the min-sample floor). */
interface LocBurn {
  burn: number;
  total: number;
}

// A pg Pool OR a checked-out PoolClient — both expose .query. Injecting it lets the differential red-test
// run the TS threshold path on the SAME transaction (BEGIN/ROLLBACK) as slo_burn_status, so it compares
// both over identical uncommitted fixtures without touching prod. Defaults to the shared pool in prod.
type Queryable = Pick<typeof pool, 'query'>;

/** The location-aware SLO burn STATE — the SAME shape slo_burn_status returns. `burn_state` is the paging
 *  verdict (fast/slow/none); `reported_burn` is the max burn among at-floor locations of the firing window. */
export interface BurnState {
  burn_state: 'fast' | 'slow' | 'none';
  reported_burn: number;
}

/**
 * Burn rate PER LOCATION over [now-window, now): (down/total)/(1-target) for each
 * location with runs in the window, maintenance-excluded (same anti-join as
 * slo_status). Pooling all locations into one rate (the old slo_status path) let a
 * single fully-down region trip a critical burn page that the cross-location verdict
 * deliberately suppresses — so we keep the rates separated and let the caller require
 * >= min_fail_locations regions to be burning before paging. `total` rides along so
 * the caller can apply a minimum sample-size floor. caller guards slo_target.
 */
export async function burnRatesByLocation(
  checkId: number,
  windowInterval: string,
  target: number,
  exec: Queryable = pool,
): Promise<LocBurn[]> {
  const { rows } = await exec.query<{ total: string; down: string }>(
    `SELECT count(*) FILTER (WHERE r.status IN ('pass','warn','fail','error')) AS total,
            count(*) FILTER (WHERE r.status IN ('fail','error'))                AS down
       FROM runs r
       LEFT JOIN maintenance_windows mw
              ON (mw.check_id = r.check_id OR mw.check_id IS NULL)
             AND r.started_at >= mw.starts_at AND r.started_at < mw.ends_at
      WHERE r.check_id = $1
        AND r.started_at >= now() - $2::interval AND r.started_at < now()
        AND mw.id IS NULL
      GROUP BY r.location`,
    [checkId, windowInterval],
  );
  return rows
    .map((r) => ({ total: Number(r.total), down: Number(r.down) }))
    .filter((r) => r.total > 0)
    .map((r) => ({ burn: r.down / r.total / (1 - target), total: r.total }));
}

/**
 * How many locations are "burning" over threshold — but only counting locations with
 * a real sample (>= `floor` runs in the window). The floor stops a noisy low-cadence
 * check from paging on a single failed run (e.g. 1 down of 1 => burn 83x at 99.9%):
 * a tight SLO must not bypass the failure_threshold debounce that the incident path
 * relies on. Defaults to the check's failure_threshold (the same debounce knob).
 */
export function burningLocations(rates: LocBurn[], threshold: number, floor: number): number {
  return rates.filter((r) => r.total >= floor && r.burn >= threshold).length;
}

/**
 * The burn rate to REPORT in the alert — the max among locations that meet the sample
 * floor. A sub-floor location (e.g. 1 down of 1 => burn 83x) is excluded from the
 * decision by burningLocations(); it must also be excluded from the reported number,
 * else the alert overstates severity with a burn the gate didn't actually act on.
 * Returns 0 if no location meets the floor (callers only use this once a page fires).
 */
export function reportedBurn(rates: LocBurn[], floor: number): number {
  const atFloor = rates.filter((r) => r.total >= floor).map((r) => r.burn);
  return atFloor.length > 0 ? Math.max(...atFloor) : 0;
}

/**
 * ★ The burn STATE decision, extracted VERBATIM from maybeBurnAlert's threshold composition (fast=1h,
 * slow=6h∧30m, effectiveN per window, the failure_threshold floor). This is the SINGLE source of the TS
 * paging logic: maybeBurnAlert consumes it, and the differential red-test asserts slo_burn_status
 * reproduces it byte-for-byte. STATE ONLY — the dispatch suppressors (open incident / maintenance /
 * debounce) are applied by maybeBurnAlert ON TOP, not here. `exec` lets the test run it in a rolled-back txn.
 */
export async function burnStateFromTs(check: Check, exec: Queryable = pool): Promise<BurnState> {
  if (check.slo_target == null) return { burn_state: 'none', reported_burn: 0 };
  const floor = check.failure_threshold;
  const fastRates = await burnRatesByLocation(check.id, BURN_FAST_WINDOW, check.slo_target, exec);
  const fastN = effectiveN(fastRates.length, check.min_fail_locations);
  if (fastRates.length > 0 && burningLocations(fastRates, BURN_FAST_THRESHOLD, floor) >= fastN) {
    return { burn_state: 'fast', reported_burn: reportedBurn(fastRates, floor) };
  }
  const slowLong = await burnRatesByLocation(check.id, BURN_SLOW_WINDOW, check.slo_target, exec);
  const slowShort = await burnRatesByLocation(check.id, BURN_SLOW_SHORT_WINDOW, check.slo_target, exec);
  const longN = effectiveN(slowLong.length, check.min_fail_locations);
  const shortN = effectiveN(slowShort.length, check.min_fail_locations);
  if (
    slowLong.length > 0 &&
    slowShort.length > 0 &&
    burningLocations(slowLong, BURN_SLOW_THRESHOLD, floor) >= longN &&
    burningLocations(slowShort, BURN_SLOW_THRESHOLD, floor) >= shortN
  ) {
    return { burn_state: 'slow', reported_burn: reportedBurn(slowLong, floor) };
  }
  return { burn_state: 'none', reported_burn: 0 };
}

/**
 * The burn STATE from the SHARED SQL function slo_burn_status — the SAME rows the read path (/reports/slo
 * pills) uses, so read and page can never diverge. The differential red-test proves this equals
 * burnStateFromTs (retained as the frozen oracle) byte-for-byte. slo_burn_status always returns one row.
 */
export async function burnStateFromSql(checkId: number, exec: Queryable = pool): Promise<BurnState> {
  const { rows } = await exec.query<{ burn_state: 'fast' | 'slow' | 'none'; reported_burn: string | number }>(
    `SELECT burn_state, reported_burn FROM slo_burn_status($1)`,
    [checkId],
  );
  const r = rows[0];
  return r
    ? { burn_state: r.burn_state, reported_burn: Number(r.reported_burn) }
    : { burn_state: 'none', reported_burn: 0 };
}

/**
 * SLO burn-rate alerting — opt-in (only when the check has slo_target). Routes a
 * fast-burn (1h) page or slow-burn (6h) ticket through the EXISTING alert profiles
 * (fast => 'error'/critical, slow => 'warn'/warning), debounced via
 * last_burn_notified_at, and SUPPRESSED when an incident already pages the check or
 * inside a maintenance window. Non-fatal — never throws into the run path.
 */
export async function maybeBurnAlert(check: Check): Promise<void> {
  if (check.slo_target == null) return; // SLO off — nothing to burn
  try {
    // Reconcile with incidents: an open incident already pages this check's
    // down-runs, so don't double-page on the same problem.
    if (await getOpenIncident(check.id)) return;
    if (await inMaintenanceWindow(check.id)) return;

    let severity: 'critical' | 'warning';
    let label: string;
    let windowLabel: string;
    let burn: number;

    // Page only when burn crosses threshold from >= N locations — the SAME effectiveN() as the incident
    // verdict, over the burn-REPORTING locations, AND each burning location has a real sample (>=
    // failure_threshold runs) so one flaky region / a single failed run can't page.
    // ★ STEP 3: the burn STATE now comes from the SHARED SQL function slo_burn_status (read == page) — the
    // SAME rows /reports/slo reads. Byte-identical to the old inline TS path: the differential red-test
    // asserts slo_burn_status == burnStateFromTs (the retained frozen oracle). STATE ONLY — the dispatch
    // suppressors (open incident / maintenance / debounce) are applied above + below, exactly as before.
    const state = await burnStateFromSql(check.id);
    if (state.burn_state === 'fast') {
      severity = 'critical'; label = 'fast burn'; windowLabel = '1h';
      burn = state.reported_burn;
    } else if (state.burn_state === 'slow') {
      severity = 'warning'; label = 'slow burn'; windowLabel = '6h';
      burn = state.reported_burn;
    } else {
      return; // budget burn within tolerance, not from enough locations, or recovered
    }

    // Debounce: reuse the warn re-notify cadence so a sustained burn doesn't alert
    // every tick.
    const { rows } = await pool.query<{ due: boolean }>(
      `SELECT (last_burn_notified_at IS NULL
               OR now() - last_burn_notified_at >= make_interval(secs => warn_renotify_seconds)) AS due
         FROM checks WHERE id = $1`,
      [check.id],
    );
    if (!rows[0]?.due) {
      console.log(`[runner] check ${check.id} "${check.name}" SLO ${label} — alert debounced`);
      return;
    }

    const pct = (check.slo_target * 100).toFixed(check.slo_target >= 0.999 ? 2 : 1);
    const summary =
      `Check "${check.name}" SLO ${label}: error budget burning at ${burn.toFixed(1)}x over ` +
      `${windowLabel} (target ${pct}%) — budget will exhaust before the SLO window if sustained.`;

    await dispatchAlerts(
      {
        checkId: check.id,
        checkName: check.name,
        severity,
        status: severity === 'critical' ? 'open' : 'warn',
        summary,
        runId: null, // budget-level, not tied to a single run (no bogus "Run #0")
      },
      await resolveChannels(check.id, check.severity),
    );
    await pool.query(`UPDATE checks SET last_burn_notified_at = now() WHERE id = $1`, [check.id]);
    console.log(`[runner] check ${check.id} "${check.name}" SLO ${label} alert (burn ${burn.toFixed(1)}x/${windowLabel})`);
  } catch (err) {
    console.warn(
      `[runner] check ${check.id} SLO burn check failed (non-fatal):`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Apply a finished run's PROD-FACING side-effects: incident open/resolve + alert dispatch (evaluate) and
 * SLO burn-rate paging (maybeBurnAlert). ★ SANDBOX (0064): a sandbox run of a PAUSED monitor SKIPS ALL of
 * these — the run row + trace are already persisted (inspectable), but no incident opens, no alert/page
 * fires, no SLO burn alert, and checks.enabled is never touched. This is the load-bearing option-A guard
 * (without the skip a paused monitor would page — the "C" failure). Extracted from runOneInner so the skip
 * is UNIT-TESTABLE: index.ts runs main() on import (house convention), so runOneInner itself isn't; this
 * wrapper is the exact seam runOneInner calls, and the sandbox test asserts on it directly.
 */
export interface RunSideEffectContext {
  /** Paused-monitor sandbox validation — persist only, no incident/alert/SLO (0064/0065). */
  sandbox: boolean;
  /** Whether the check had an OPEN incident BEFORE this run (from runOneInner's hasOpenIncident). */
  alreadyFailing: boolean;
  /** Set when THIS run is a CONFIRMATION run — the id of the original run it is confirming (0077). */
  confirmationOfRunId: number | null;
}

/**
 * ★ B3-2 stage 2: classify a just-superseded transient (its OWN failing-run signals vs the last-N SUCCESSFUL
 * baseline) and persist `runs.transient_class`. Same-location baseline keeps it apples-to-apples for a
 * multi-location check. INDETERMINATE when the failing run captured no signals (http/dns/ssl, or a strand).
 */
export async function classifyAndPersistTransient(check: Check, originalRunId: number): Promise<void> {
  const orig = await pool.query<{ trace_signals: TraceSignalsLike | null; location: string | null; started_at: Date }>(
    `SELECT trace_signals, location, started_at FROM runs WHERE id = $1`,
    [originalRunId],
  );
  if (orig.rowCount === 0) return;
  const { trace_signals, location, started_at } = orig.rows[0];

  // ★ Baseline: the last-N SUCCESSFUL (pass/warn) runs (same location) strictly before the transient — NOT
  // the last-N settled runs. Fixes the sustained-outage INVERSION: the classifier's question is "is the SITE
  // broken?", not the error-diff's "what CHANGED this run?". A first-party error that has failed for four runs
  // straight is IN the settled baseline (so it read monitor-side — most wrong exactly when the failure is most
  // real), but it is NOT in the last SUCCESSFUL run, so it counts. The discriminator is already in the data:
  // benign ambient noise (e.g. /monitoring) fails on PASSING runs too (→ in the success baseline → doesn't
  // count); a real failure appears ONLY when the check fails (→ absent from the success baseline → counts, no
  // matter how many in a row). Empty baseline (no recent green) ⇒ every first-party error is new ⇒ service-side
  // — correct: no green + first-party errors IS an outage (loop handles empty, no divide). Bounded to 30d (the
  // SLA window): a success older than that is too stale to define "ambient" → ignored → service-side.
  // ★ Deliberately DIVERGES from the API ErrorDiff's settled baseline — a different question (transientClass.ts).
  const base = await pool.query<{ trace_signals: TraceSignalsLike | null }>(
    `SELECT trace_signals FROM runs
      WHERE check_id = $1 AND status IN ('pass', 'warn')
        AND started_at < $2 AND started_at > $2 - interval '30 days' AND id <> $3
        AND (($4::text IS NULL AND location IS NULL) OR location = $4)
      ORDER BY started_at DESC LIMIT $5`,
    [check.id, started_at, originalRunId, location, TRANSIENT_BASELINE_RUNS],
  );

  const cls = classifyTransient(trace_signals, base.rows.map((r) => r.trace_signals));
  await pool.query(`UPDATE runs SET transient_class = $2 WHERE id = $1`, [originalRunId, cls]);
  console.log(`[confirm] check ${check.id} transient run ${originalRunId} classified ${cls}.`);
}

export async function applyRunSideEffects(
  check: Check,
  run: RunRecord,
  ctx: RunSideEffectContext,
): Promise<void> {
  if (ctx.sandbox) return; // paused-monitor sandbox run: persist the run only, no incident/alert/SLO.

  // ── (A) THIS run IS a confirmation → it OWNS the verdict (0077, D4). ──────────────────────────────────
  if (ctx.confirmationOfRunId != null) {
    if (run.status === 'pass' || run.status === 'warn') {
      // The original failure was TRANSIENT: mark it superseded (it stays VISIBLE in run history but the
      // read-side health filters exclude superseded_by_run_id IS NOT NULL). Done BEFORE evaluate so
      // aggregateVerdict/rollup already exclude it.
      await pool.query(`UPDATE runs SET superseded_by_run_id = $2 WHERE id = $1`, [ctx.confirmationOfRunId, run.id]);
      // ★ B3-2 stage 2: classify the now-superseded transient monitor-side / service-side / indeterminate, so
      // B3-3's flake budget can burn ONLY monitor-side ones (a service-side transient is a real, if brief,
      // outage — it must not penalise the monitor that caught it). Best-effort: a failure here must NEVER block
      // the supersede (the health-critical write above already landed).
      await classifyAndPersistTransient(check, ctx.confirmationOfRunId).catch((err) =>
        console.warn(
          `[confirm] check ${check.id} transient-classification failed (non-fatal):`,
          err instanceof Error ? err.message : err,
        ),
      );
      console.log(
        `[confirm] check ${check.id} "${check.name}" confirmation PASSED — original run ${ctx.confirmationOfRunId} was transient (superseded, no incident).`,
      );
    } else {
      console.log(
        `[confirm] check ${check.id} "${check.name}" confirmation ${run.status.toUpperCase()} — failure CONFIRMED; opening incident as normal.`,
      );
    }
    // Either outcome: the confirmation is the authoritative run. pass/warn → evaluate resolves nothing (no
    // incident was opened); fail/error → evaluate opens the incident exactly as today. A confirmation NEVER
    // enqueues another (D4) — control never reaches branch (B) because confirmationOfRunId is set.
    await evaluate(check, run);
    await maybeBurnAlert(check);
    return;
  }

  // ── (B) A normal SCHEDULED run that just FAILED on a confirm-eligible, HEALTHY check → DEFER (0077, D2/D5). ─
  // Skip evaluate (no incident/alert), enqueue ONE confirmation run in a fresh execution. The failed run
  // PERSISTS visibly as fail/error, awaiting its confirmation — it is NEVER silently discarded.
  if (shouldConfirmByRerun(check, run.status, ctx.alreadyFailing)) {
    await enqueueConfirmationRun(check, run);
    return;
  }

  // ── (C) Everything else → today's behavior. ──────────────────────────────────────────────────────────
  await evaluate(check, run);
  await maybeBurnAlert(check);
}

/**
 * True when a finished run should DEFER its verdict to a fresh-execution confirmation (0077): a browser/multistep
 * check (confirmByRerunEligible) that just went down (fail/error) while HEALTHY (no open incident). Excludes:
 * already-failing checks (D5 — a sustained outage counts immediately, no 2× cost, no retry-storm), warn/pass
 * (not down), infra_error (not a site outage; evaluate short-circuits it), sandbox (handled by the early return),
 * and confirmation runs themselves (handled by branch A). Pure — unit-testable.
 */
export function shouldConfirmByRerun(check: Check, status: string, alreadyFailing: boolean): boolean {
  return (
    !alreadyFailing &&
    (status === 'fail' || status === 'error') &&
    confirmByRerunEligible(check.kind)
  );
}

/**
 * Enqueue ONE confirmation run for a just-failed scheduled check (0077). The run_requests INSERT is the DURABLE
 * enqueue (the one-pending-per-check partial unique index coalesces, so a concurrent enqueue is a safe no-op);
 * the confirmation, when drained, links back to the original via drainRunRequests's "latest awaiting original".
 *
 * ★ Two confirmation mechanisms (usesDedicatedExecution): browser/multistep fire an ARM jobs/start for a
 * DEDICATED fresh execution (immediacy — they can't ride a shared tick's budget and may be on long intervals).
 * Cheap sub-second kinds (http/ssl/dns/tcp/ping) SKIP jobs/start and let the next 5-minute cron tick's drain run the
 * confirmation — no dedicated pod (a fresh ~10-30 s pod for a ~200 ms check is ~98% overhead). The enqueue is
 * identical either way; only the "fire it now vs let the next tick drain it" step differs.
 */
async function enqueueConfirmationRun(check: Check, run: RunRecord): Promise<void> {
  await pool.query(
    `INSERT INTO run_requests (check_id, confirmation) VALUES ($1, true)
       ON CONFLICT (check_id) WHERE status = 'pending' DO NOTHING`,
    [check.id],
  );
  const dedicated = usesDedicatedExecution(check.kind);
  console.log(
    `[confirm] check ${check.id} "${check.name}" down (${run.status}) on run ${run.id} — enqueued a confirmation ` +
      `run (${dedicated ? 'dedicated fresh execution' : 'next-tick drain, no dedicated pod'}); evaluate() DEFERRED ` +
      `until it settles. The failed run is visible, awaiting confirmation.`,
  );
  if (dedicated) {
    await fireRunnerJobStart().catch((err) =>
      console.warn('[confirm] jobs/start failed (non-fatal; the next cron tick drains the pending confirmation):', err),
    );
  }
}
