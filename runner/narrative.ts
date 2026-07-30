// Reporting Layer 3 — "Smart Reports". FACT-PACK-THEN-NARRATE: compute facts/deltas/
// anomalies DETERMINISTICALLY (here, in SQL/code), then the model ONLY narrates the
// structured fact pack (cite-only, change-first), with a deterministic template fallback
// if it returns filler/off-shape. The model NEVER computes a number.
//
// Math rules (must agree with the report API): availability is ADDITIVE from the rollup
// counts (sum up / sum up+down — NEVER average daily %); latency percentiles are
// RECOMPUTED FROM RAW per period (#88 — never average daily p95s), over UP (pass|warn)
// runs with maintenance windows excluded (the rollup's latency definition).
//
// Opt-in on AZURE_OPENAI_* (same as RCA): absent => the job no-ops (Layer 3 dark, zero cost).
import { pool } from './db.js';
import { aoaiConfigured, chatCompletionContent, extractJson, DEFAULT_DEPLOYMENT } from './aoai.js';
import { costRatePerActiveSecond, freeGrantDollars, reconcileTargetMonthly } from './costModel.js';
// ★ The failure-signature normaliser, imported from its ONE definition rather than re-expressed here.
// Postgres supports the same lookbehind, so this aggregate could have been written in SQL — but a second
// copy of the rule is exactly the drift this codebase keeps paying for. One definition, two consumers.
import { normalizeSignatureText } from './rca.js';

const WINDOW = '7d';
export const WINDOW_DAYS = 7;

/**
 * ★ THE MONITOR-DEFECT WINDOW — DELIBERATELY LONGER THAN WINDOW_DAYS. DO NOT UNIFY THEM.
 *
 * They answer different questions, so they are different constants with different names (the same rule
 * that keeps countable_run / latency_sample / flake-budget windows separate rather than collapsed into
 * one "the window"):
 *
 *   • WINDOW_DAYS (7d) answers "WHAT CHANGED RECENTLY". Availability deltas, p95 movement, incident
 *     counts and the week-over-week comparison are all only meaningful against a recent, short baseline.
 *     Widening it would blur exactly the change it exists to detect.
 *
 *   • DEFECT_WINDOW_DAYS (30d) answers "IS THIS CHECK TRUSTWORTHY AT ALL". A wrong assertion stays wrong
 *     for weeks; a monitor that was broken for four days three weeks ago is STILL a broken monitor. On 7d
 *     that history is simply gone.
 *
 * ★ MEASURED, and this is why the constant exists (2026-07-30): check 396 is the loudest defect in the
 *   fleet — 101 failures, ONE signature, 75% of its window — and was INVISIBLE at 7d because those
 *   failures fell on 07-17..07-20. Correct windowed behaviour; wrong horizon for the question.
 *
 * ★ THE THRESHOLDS WERE RE-MEASURED AGAINST THIS WINDOW, not assumed to carry over. A longer window has
 *   more runs, so the SHARE term shrinks for the same defect (check 355 verify-cart-4: 15.02% at 7d ->
 *   5.75% at 30d) — but it still clears the 3% floor, and the fleet fire-count is UNCHANGED at 3. See
 *   the guard constants for the full measurement.
 */
export const DEFECT_WINDOW_DAYS = 30;

export interface PeriodFacts {
  from: string;
  to: string;
  up: number;
  down: number;
  availabilityPct: number | null;
  downtimeMin: number;
  incidents: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  latencyN: number;
  lcpP75: number | null;
}

export interface IncidentFact {
  check: string;
  severity: string;
  openedAt: string;
  resolvedAt: string | null;
  durationMin: number;
  classification: string | null;
  summary: string | null;
}

/** One monitor's estimated monthly cost — from the SHARED cost_projection() SQL fn, so these MATCH
 *  /reports/cost by construction. divergence = measured/projected (null when projected 0). */
export interface CostFact {
  name: string;
  estimatedMonthly: number | null; // ★ 0091: the PRIMARY per-monitor $ — free-grant-aware, Σ = the reconcile anchor; null when no runs
  sharePct: number | null; // 0089: this monitor's share of FLEET measured compute (active-seconds) — the SECONDARY metric; null when no monitor ran
  projected: number;
  measured: number;
  divergence: number | null;
  divergenceFlag: boolean; // divergence > 1.5 — EXTRA runs vs the current schedule (config-change straddle / confirmation / sandbox); a pure run-count ratio, NOT retries (0078)
  availabilityPct: number | null; // this window, so the model can spot unreliable-AND-expensive intersections
}

/** Fleet cost roll-up + the monitors worth naming (expensive / divergent / unreliable). Null when the
 *  cost_projection() fn is unavailable (e.g. migration 0069 not yet applied) — never fabricated. */
export interface CostFacts {
  fleetProjected: number;
  fleetMeasured: number;
  fleetDivergence: number | null;
  topDrivers: Array<{ name: string; projected: number }>; // top by projected $
  notable: CostFact[]; // expensive OR divergent OR low-availability — the cross-signal candidates
}

/** A deploy in the window (from the `deploys` table). The model correlates incident timing to deployedAt —
 *  "incident began N min after deploy <sha>" — instead of guessing "check recent deployments". */
export interface DeployMarker {
  deployedAt: string; // ISO — checkable against incident.openedAt
  targetHost: string;
  source: string;
  sha: string | null; // short (12) — null for non-sha markers (etag)
  isSha: boolean; // a real code RELEASE (weight for correlation) vs a config/etag redeploy (noise)
}

export interface FactPack {
  scopeType: 'fleet' | 'monitor';
  scopeKey: string;
  scopeName: string;
  window: string;
  current: PeriodFacts;
  previous: PeriodFacts;
  deltas: {
    availabilityPts: number | null;
    downtimeMin: number;
    incidents: number;
    p95Pct: number | null;
  };
  incidentList: IncidentFact[];
  anomalies: string[];
  /**
   * ★ The anomalies that must REACH A HUMAN, each with the `token` that proves the prose carried it.
   *
   * These are a SUBSET of `anomalies` (same strings), lifted out because delivery is guaranteed for them
   * specifically: ensureAnomaliesDelivered appends any whose token is absent from the generated prose into
   * `highlights` — a field validShape requires, upsert() persists and the dashboard renders. Being in
   * `anomalies` alone was NOT delivery: the repeat-offender line reached fact_pack.anomalies in 10 of 38
   * stored narratives and appeared in ZERO narrative bodies, because the model was never obliged to echo it.
   */
  criticalFindings: { token: string; line: string }[];
  cost: CostFacts | null; // fleet+notable cost (fleet scope) or this monitor's cost (monitor scope); null if unavailable
  deployMarkers: DeployMarker[]; // deploys in the window, for incident↔deploy correlation
}

export interface Narrative {
  headline: string;
  body: string;
  highlights: string[];
}

// --- window math (UTC, day-aligned so rollup-availability + raw-percentiles cover the
// SAME runs) ---------------------------------------------------------------------------
function todayUtcMidnight(): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** One period's facts. availability/downtime from the rollup (additive); percentiles +
 *  vitals from RAW (UP runs, MW-excluded); incidents from the incidents table. checkId
 *  null = fleet (all checks). [startDay, endDay) are UTC dates; [startIso, endIso) the
 *  matching timestamps. */
async function periodFacts(
  checkId: number | null,
  startDay: string,
  endDay: string,
  startIso: string,
  endIso: string,
): Promise<PeriodFacts> {
  const avail = await pool.query<{ up: string; down: string; downtime: string }>(
    `SELECT coalesce(sum(up_count),0) AS up, coalesce(sum(down_count),0) AS down,
            coalesce(sum(downtime_minutes),0) AS downtime
       FROM daily_check_rollup
      WHERE day >= $2::date AND day < $3::date AND ($1::bigint IS NULL OR check_id = $1)`,
    [checkId, startDay, endDay],
  );
  const lat = await pool.query<{ p50: number | null; p95: number | null; p99: number | null; n: string }>(
    // ★ latency_sample (0092): pass/warn + NON-sandbox. Excludes sandbox test-sends (a test at an outlier
    // latency must not move the reported percentile) and pins the pass/warn filter in ONE place. KEEPS
    // confirmations by design — a confirmation's duration is a real measurement (see the view comment). The
    // maintenance-window exclusion stays here (per-consumer, contextual), not in the view.
    `SELECT round(percentile_cont(0.5)  WITHIN GROUP (ORDER BY r.duration_ms))::int AS p50,
            round(percentile_cont(0.95) WITHIN GROUP (ORDER BY r.duration_ms))::int AS p95,
            round(percentile_cont(0.99) WITHIN GROUP (ORDER BY r.duration_ms))::int AS p99,
            count(*) AS n
       FROM latency_sample r
      WHERE r.started_at >= $2 AND r.started_at < $3
        AND ($1::bigint IS NULL OR r.check_id = $1)
        AND NOT EXISTS (
          SELECT 1 FROM maintenance_windows mw
           WHERE (mw.check_id = r.check_id OR mw.check_id IS NULL)
             AND r.started_at >= mw.starts_at AND r.started_at < mw.ends_at)`,
    [checkId, startIso, endIso],
  );
  const inc = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM incidents
      WHERE opened_at >= $2 AND opened_at < $3 AND ($1::bigint IS NULL OR check_id = $1)`,
    [checkId, startIso, endIso],
  );
  const vit = await pool.query<{ lcp_p75: number | null }>(
    // ★ latency_sample (0092): pass/warn + NON-sandbox — the SAME real-measured-sample predicate as the
    // latency percentiles above, because a web-vital is a real measured value too. A sandbox test-send at an
    // outlier LCP must NOT move the reported p75. KEEPS confirmations by design — a confirmation's vitals are
    // a real measurement (the deliberate difference from countable_run; see the view comment). The pass/warn
    // filter lives in the view now, so the inline `r.status IN (…)` is gone. The maintenance-window exclusion
    // stays here (per-consumer, contextual).
    `SELECT round(percentile_cont(0.75) WITHIN GROUP (ORDER BY m.lcp_ms))::int AS lcp_p75
       FROM run_metrics m JOIN latency_sample r ON r.id = m.run_id
      WHERE r.started_at >= $2 AND r.started_at < $3
        AND ($1::bigint IS NULL OR r.check_id = $1)
        AND NOT EXISTS (
          SELECT 1 FROM maintenance_windows mw
           WHERE (mw.check_id = r.check_id OR mw.check_id IS NULL)
             AND r.started_at >= mw.starts_at AND r.started_at < mw.ends_at)`,
    [checkId, startIso, endIso],
  );
  const up = Number(avail.rows[0].up);
  const down = Number(avail.rows[0].down);
  const total = up + down;
  return {
    from: startIso,
    to: endIso,
    up,
    down,
    availabilityPct: total > 0 ? Math.round((10000 * up) / total) / 100 : null,
    downtimeMin: Math.round(Number(avail.rows[0].downtime)),
    incidents: Number(inc.rows[0].n),
    p50: lat.rows[0].p50,
    p95: lat.rows[0].p95,
    p99: lat.rows[0].p99,
    latencyN: Number(lat.rows[0].n),
    lcpP75: vit.rows[0].lcp_p75,
  };
}

/** Compute the full deterministic fact pack for a scope as of `asOf` (UTC midnight end). */
const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

// The $/active-second rate is DERIVED (two ACA meters × the live deploy-stamped allocation) in the ONE
// shared place — runner/costModel.ts. The api's CostRate.cs mirrors the same derivation, so the runner's
// cost facts and /reports/cost use one rate model (no magic scalar). A resize re-prices automatically;
// verify() asserts the stamped SYNTHWATCH_RUNNER_CPU/MEMORY_GIB match the live container resources.
const costRate = costRatePerActiveSecond;

/** Cost facts from the SHARED cost_projection() fn (figures MATCH /reports/cost by construction). Fleet total
 *  + notable monitors (fleet scope), or just this monitor's figures (monitor scope). Availability is joined
 *  from the rollup so the model can find the unreliable-AND-expensive intersection. FAIL-SOFT: if the fn is
 *  unavailable (0069 not yet applied) → null (never a fabricated $0). */
async function costFacts(checkId: number | null, startDay: string, endDay: string): Promise<CostFacts | null> {
  try {
    const cost = await pool.query<{
      check_id: string; check_name: string; estimated_monthly: string | null; compute_share_pct: string | null;
      projected: string; measured: string;
      divergence: string | null; divergence_flag: boolean; projected_raw: string; measured_raw: string;
    }>(
      // ★ 0091: the free-grant-aware 3-param model. estimated_monthly is the PRIMARY per-monitor $ (Σ = the
      // reconcile anchor: coalesce(target, grant-corrected fleet)); compute_share_pct is the SECONDARY share.
      `SELECT check_id, check_name, estimated_monthly, compute_share_pct, projected, measured, divergence, divergence_flag, projected_raw, measured_raw
         FROM cost_projection($1::numeric, $2::numeric, $3::numeric)`,
      [costRate(), freeGrantDollars(), reconcileTargetMonthly()],
    );
    if (cost.rows.length === 0) return null;
    const av = await pool.query<{ check_id: string; pct: string | null }>(
      `SELECT check_id, round(100.0*sum(up_count)/nullif(sum(up_count+down_count),0),2) AS pct
         FROM daily_check_rollup WHERE day >= $1::date AND day < $2::date GROUP BY check_id`,
      [startDay, endDay],
    );
    const availById = new Map(av.rows.map((r) => [r.check_id, r.pct == null ? null : Number(r.pct)]));
    const all = cost.rows.map((r) => ({
      id: r.check_id,
      fact: {
        name: r.check_name,
        estimatedMonthly: r.estimated_monthly == null ? null : Number(r.estimated_monthly),
        sharePct: r.compute_share_pct == null ? null : Number(r.compute_share_pct),
        projected: Number(r.projected),
        measured: Number(r.measured),
        divergence: r.divergence == null ? null : Number(r.divergence),
        divergenceFlag: r.divergence_flag,
        availabilityPct: availById.get(r.check_id) ?? null,
      } as CostFact,
      projRaw: Number(r.projected_raw),
      measRaw: Number(r.measured_raw),
    }));
    const fleetProjected = r2(all.reduce((s, r) => s + r.projRaw, 0));
    const fleetMeasured = r2(all.reduce((s, r) => s + r.measRaw, 0));
    const fleetDivergence = fleetProjected > 0 ? r3(fleetMeasured / fleetProjected) : null;

    // Monitor scope: just this check's cost (fleet* = the monitor's own figures; notable = [itself]).
    if (checkId != null) {
      const me = all.find((r) => r.id === String(checkId));
      if (!me) return null;
      return {
        fleetProjected: me.fact.projected, fleetMeasured: me.fact.measured, fleetDivergence: me.fact.divergence,
        topDrivers: [], notable: [me.fact],
      };
    }
    // Fleet scope: top drivers + notable = expensive ∪ divergent ∪ (unreliable AND costing).
    const byProj = [...all].sort((a, b) => b.projRaw - a.projRaw);
    const topDrivers = byProj.slice(0, 5).map((r) => ({ name: r.fact.name, projected: r.fact.projected }));
    const notable = new Map<string, (typeof all)[number]>();
    for (const r of byProj.slice(0, 8)) notable.set(r.id, r); // most expensive
    for (const r of all) if (r.fact.divergenceFlag) notable.set(r.id, r); // cost-divergent (leading indicator)
    for (const r of all) if (r.fact.availabilityPct != null && r.fact.availabilityPct < 100 && r.fact.projected > 0) notable.set(r.id, r); // unreliable AND costing
    return {
      fleetProjected, fleetMeasured, fleetDivergence, topDrivers,
      notable: [...notable.values()].sort((a, b) => b.projRaw - a.projRaw).map((r) => r.fact),
    };
  } catch (err) {
    console.warn('[narrative] cost facts unavailable (cost_projection missing?) — omitting:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Deploys in the window → the model correlates incident timing to deployedAt. To keep the input focused
 *  (the deploys table is dominated by the dashboard's frequent etag/config redeploys), keep EVERY real code
 *  release (is_sha — the correlation candidates) but only the 10 most-recent config/etag markers. */
async function deployMarkersInWindow(startIso: string, endIso: string): Promise<DeployMarker[]> {
  const { rows } = await pool.query<{ deployed_at: Date; target_host: string; source: string; sha: string | null; is_sha: boolean }>(
    `(SELECT deployed_at, target_host, source, left(sha, 12) AS sha, is_sha
        FROM deploys WHERE deployed_at >= $1 AND deployed_at < $2 AND is_sha)
     UNION ALL
     (SELECT deployed_at, target_host, source, left(sha, 12) AS sha, is_sha
        FROM deploys WHERE deployed_at >= $1 AND deployed_at < $2 AND NOT is_sha
        ORDER BY deployed_at DESC LIMIT 10)
     ORDER BY deployed_at`,
    [startIso, endIso],
  );
  return rows.map((r) => ({
    deployedAt: new Date(r.deployed_at).toISOString(),
    targetHost: r.target_host,
    source: r.source,
    sha: r.sha,
    isSha: r.is_sha,
  }));
}

/** One repeat-offender group, as the aggregate returns it. */
export interface RepeatGroup {
  n: string | number;
  step: string | null;
  ids: number[];
  check_name: string | null;
}

/**
 * The repeat-offender anomaly line. NAMES the group so it is actionable: which step, how many incidents,
 * WHICH incidents, and over what window. A fleet-scope line also names the monitor (a fleet report groups
 * across checks, so "verify-cart-4" alone would not say whose).
 *
 * ★ The old line was "Repeat offender: N incidents with the same failure signature." — measured on check
 *   355's real 7d window it rendered twice, identically, for two DIFFERENT groups (add-bread and
 *   verify-cart-4). Naming the step is what turns it from a count into a work item.
 */
export function repeatOffenderLine(scopeType: 'fleet' | 'monitor', g: RepeatGroup, window: string): string {
  const step = g.step ?? '(no step — non-stepped check)';
  const who = scopeType === 'fleet' && g.check_name ? `${g.check_name} / ` : '';
  const ids = g.ids.map((i) => `#${i}`).join(', ');
  return `Repeat offender: ${who}${step} — ${g.n} incidents with ONE failure signature (${ids}), ${window}.`;
}

/** A per-(check, step) failure shape over the window — the monitor-defect discriminator's inputs. */
export interface DefectCandidate {
  checkId: number;
  checkName: string | null;
  step: string;
  fails: number;
  signatures: number;
  windowRuns: number;
}

// ★ THRESHOLDS, derived from MEASURED fleet data (14d, 2026-07-30) — not picked by feel. All three must
//   hold, because each alone over-fires:
//     • VOLUME floor: a 2-failure step is not a pattern, whatever its ratio.
//     • RATIO (fails per distinct signature): the actual monitor-vs-flaky discriminator.
//       verify-cart-4 = 21.5 · check 396 "Open cart and verify item" = 101.0 · check 396 "Add item to
//       cart" = 28.0, against add-bananas 3.5 / clear-cart 2.3 / checkout-pickup 2.0 / add-milk 1.0.
//     • SHARE of the window: this is the guard that stops a ratio alone from over-firing, and it is
//       load-bearing on REAL data — check 192 "assert a downloadable menu PDF is present" scores 5 fails
//       with 1 signature (ratio 5.0, clearing BOTH the volume floor and the ratio) but only 0.22% of its
//       window, so the share term is the only thing that excludes it. Five failures spread thinly across
//       a month is an intermittent target; 75% of every run failing identically is a broken assertion.
//
// ★ RE-MEASURED against DEFECT_WINDOW_DAYS=30 (2026-07-30) — the thresholds were NOT assumed to carry
//   over from the 7d calibration. Fleet at 30d: 14 steps clear the volume floor, 8 also clear the ratio,
//   and exactly 3 clear all three — check 396's two steps (101/1/75.4% and 28/1/20.9%) and check 355
//   verify-cart-4 (45/2/5.8%). SAME fire-count as the 7d calibration, so no recalibration was needed.
//   ★ AND THE SHARE TERM GOT MORE LOAD-BEARING, not less: at 7d it excluded 1 candidate, at 30d it
//   excludes 5 — check 77 (11 fails/1 sig/0.20%), check 81 (10/1/0.09%), check 80 (6/1/0.10%),
//   check 194 (5/1/0.13%) and check 192 (5/1/0.22%). Those are HIGH-FREQUENCY monitors: thousands of
//   runs a month, so a handful of identical failures is genuine intermittency, not a broken assertion.
//   Without the share term a 30d window would fire on 8 instead of 3 — it is what makes the longer
//   horizon safe.
const DEFECT_MIN_FAILS = 5;
const DEFECT_MIN_RATIO = 5;
const DEFECT_MIN_SHARE_PCT = 3;

/**
 * Per-(check, step) failure shapes in the window that look like a MONITOR DEFECT rather than a flaky
 * target. Reads `countable_run` — the same canonical window aggregateVerdict and countConsecutiveDown use
 * (non-superseded, non-confirmation, non-sandbox), so a confirmation re-run cannot inflate a count (0081).
 *
 * Signatures are counted with rca.ts's OWN normalizeSignatureText, imported rather than re-expressed:
 * Postgres does support the same lookbehind, but a second copy of the rule in SQL is a drift waiting to
 * happen, and this codebase has paid for that class of divergence more than once.
 */
export async function monitorDefectCandidates(
  checkId: number | null,
  fromIso: string,
  toIso: string,
): Promise<DefectCandidate[]> {
  const { rows } = await pool.query<{
    check_id: number;
    check_name: string | null;
    failed_step: string | null;
    error_message: string | null;
  }>(
    `SELECT cr.check_id, c.name AS check_name, r.failed_step, r.error_message
       FROM countable_run cr
       JOIN runs   r ON r.id = cr.id
       LEFT JOIN checks c ON c.id = cr.check_id
      WHERE cr.started_at >= $2 AND cr.started_at < $3
        AND ($1::bigint IS NULL OR cr.check_id = $1)`,
    [checkId, fromIso, toIso],
  );

  // Window size per check = ALL countable runs (pass included) — the denominator for "share of runs".
  const windowRuns = new Map<number, number>();
  const byStep = new Map<string, { c: DefectCandidate; sigs: Set<string> }>();
  for (const r of rows) {
    windowRuns.set(r.check_id, (windowRuns.get(r.check_id) ?? 0) + 1);
    if (!r.failed_step) continue;
    const key = `${r.check_id}|${r.failed_step}`;
    let e = byStep.get(key);
    if (!e) {
      e = {
        c: { checkId: r.check_id, checkName: r.check_name, step: r.failed_step, fails: 0, signatures: 0, windowRuns: 0 },
        sigs: new Set<string>(),
      };
      byStep.set(key, e);
    }
    e.c.fails += 1;
    e.sigs.add(normalizeSignatureText(r.error_message ?? ''));
  }

  const out: DefectCandidate[] = [];
  for (const { c, sigs } of byStep.values()) {
    c.signatures = sigs.size;
    c.windowRuns = windowRuns.get(c.checkId) ?? 0;
    if (isMonitorDefectShape(c)) out.push(c);
  }
  return out.sort((a, b) => b.fails / b.signatures - a.fails / a.signatures);
}

/** All three guards. Exported so the thresholds are pinnable — see the constants for why each exists. */
export function isMonitorDefectShape(c: DefectCandidate): boolean {
  if (c.signatures <= 0 || c.windowRuns <= 0) return false; // nothing measured → no claim
  const ratio = c.fails / c.signatures;
  const sharePct = (100 * c.fails) / c.windowRuns;
  return c.fails >= DEFECT_MIN_FAILS && ratio >= DEFECT_MIN_RATIO && sharePct >= DEFECT_MIN_SHARE_PCT;
}

/**
 * The monitor-defect anomaly line. Says what was measured, what it implies, and what to DO — the action
 * is "fix the check", which no RCA classification currently recommends (real-outage / flaky-transient /
 * infra-deterministic all point at the world or the runner, never at the assertion).
 */
export function monitorDefectLine(
  c: DefectCandidate,
  windowDays: number,
  scopeType: 'fleet' | 'monitor' = 'fleet',
): string {
  const ratio = Math.round((10 * c.fails) / c.signatures) / 10;
  const sharePct = Math.round((1000 * c.fails) / c.windowRuns) / 10;
  // Name the monitor only on a FLEET report — a per-monitor report already knows whose it is (same rule as
  // repeatOffenderLine, so the two lines read consistently side by side).
  const who = scopeType === 'fleet' && c.checkName ? `${c.checkName} / ` : '';
  const sigs = c.signatures === 1 ? '1 distinct error signature' : `${c.signatures} distinct error signatures`;
  return (
    `LIKELY MONITOR DEFECT: ${who}${c.step} failed ${c.fails}× with only ${sigs} — ${ratio} failures per ` +
    `signature, ${sharePct}% of ${c.windowRuns} runs, ${windowDays}d. A wrong assertion repeats ONE error; ` +
    `a flaky target drifts. Fix the check before investigating the target.`
  );
}

export async function computeFactPack(
  scope: { type: 'fleet' | 'monitor'; checkId: number | null; key: string; name: string },
  asOf: Date = todayUtcMidnight(),
): Promise<FactPack> {
  const end = asOf;
  const curStart = new Date(end.getTime() - WINDOW_DAYS * 86_400_000);
  const prevStart = new Date(end.getTime() - 2 * WINDOW_DAYS * 86_400_000);
  const checkId = scope.checkId;

  const current = await periodFacts(checkId, isoDay(curStart), isoDay(end), curStart.toISOString(), end.toISOString());
  const previous = await periodFacts(checkId, isoDay(prevStart), isoDay(curStart), prevStart.toISOString(), curStart.toISOString());

  const incList = await pool.query<{
    check: string; severity: string; opened_at: string; resolved_at: string | null;
    duration_min: number; classification: string | null; summary: string | null;
  }>(
    `SELECT c.name AS check, i.severity, i.opened_at, i.resolved_at,
            round(EXTRACT(epoch FROM (coalesce(i.resolved_at, now()) - i.opened_at)) / 60)::int AS duration_min,
            i.rca->>'classification' AS classification, i.rca->>'summary' AS summary
       FROM incidents i JOIN checks c ON c.id = i.check_id
      WHERE i.opened_at >= $2 AND i.opened_at < $3 AND ($1::bigint IS NULL OR i.check_id = $1)
      ORDER BY i.opened_at`,
    [checkId, current.from, current.to],
  );
  const incidentList: IncidentFact[] = incList.rows.map((r) => ({
    check: r.check,
    severity: r.severity,
    openedAt: r.opened_at,
    resolvedAt: r.resolved_at,
    durationMin: r.duration_min,
    classification: r.classification,
    summary: r.summary,
  }));

  // Deltas (current vs previous).
  const availabilityPts =
    current.availabilityPct != null && previous.availabilityPct != null
      ? Math.round((current.availabilityPct - previous.availabilityPct) * 100) / 100
      : null;
  const p95Pct =
    current.p95 != null && previous.p95 != null && previous.p95 > 0
      ? Math.round(((current.p95 - previous.p95) / previous.p95) * 1000) / 10
      : null;

  // Anomalies — flagged BY CODE thresholds, so the model is HANDED "what's notable".
  const anomalies: string[] = [];
  if (availabilityPts != null && availabilityPts < -1)
    anomalies.push(`Availability dropped ${Math.abs(availabilityPts)}pts w/w (${previous.availabilityPct}% -> ${current.availabilityPct}%).`);
  if (p95Pct != null && p95Pct > 20)
    anomalies.push(`p95 latency up ${p95Pct}% w/w (${previous.p95}ms -> ${current.p95}ms).`);
  if (current.incidents > previous.incidents)
    anomalies.push(`Incidents up ${current.incidents - previous.incidents} w/w (${previous.incidents} -> ${current.incidents}).`);

  // Repeat-offender: same RCA signature across >= 2 incidents this period.
  // ★ NAMES THE GROUP (2026-07-30). The line used to read "Repeat offender: N incidents with the same
  //   failure signature." — no step, no ids, no check. Two groups on ONE monitor therefore rendered
  //   IDENTICALLY and neither was actionable: a reader could not tell which assertion to go look at.
  //   The signature already contains check_id|message|failed_step, so the step is CONSTANT within a group
  //   (max() is a constant-pick, not an aggregate choice) and the incident ids come free from array_agg.
  const repeat = await pool.query<{ n: string; step: string | null; ids: number[]; check_name: string | null }>(
    `SELECT count(*) AS n,
            max(r.failed_step)  AS step,
            array_agg(i.id ORDER BY i.id) AS ids,
            max(c.name) AS check_name
       FROM incidents i
       LEFT JOIN runs r   ON r.id = i.opened_run_id
       LEFT JOIN checks c ON c.id = i.check_id
      WHERE i.opened_at >= $2 AND i.opened_at < $3 AND i.rca->>'signature' IS NOT NULL
        AND ($1::bigint IS NULL OR i.check_id = $1)
      GROUP BY i.rca->>'signature' HAVING count(*) >= 2 ORDER BY count(*) DESC`,
    [checkId, current.from, current.to],
  );
  const criticalFindings: { token: string; line: string }[] = [];
  for (const r of repeat.rows) {
    const line = repeatOffenderLine(scope.type, r, WINDOW);
    anomalies.push(line);
    if (r.step) criticalFindings.push({ token: r.step, line });
  }

  // ★ MONITOR-DEFECT SHAPE — "same step, one signature, over and over" vs "same step, many signatures".
  //   A wrong assertion emits ONE error string forever; genuinely flaky target behaviour DRIFTS (different
  //   timeouts, elements, counts) or resolves. This is the distinction the RCA taxonomy could not make:
  //   flaky-transient means "ignore", so a recurring monitor bug wearing that label suppresses its own fix.
  //   ★ Runs over DEFECT_WINDOW_DAYS, NOT the 7d report window — see that constant for why the two differ.
  //   Everything else in this fact pack is week-over-week by design; this one question is not.
  const defectStart = new Date(end.getTime() - DEFECT_WINDOW_DAYS * 86_400_000);
  const defects = await monitorDefectCandidates(checkId, defectStart.toISOString(), end.toISOString());
  for (const d of defects) {
    const line = monitorDefectLine(d, DEFECT_WINDOW_DAYS, scope.type);
    anomalies.push(line);
    criticalFindings.push({ token: d.step, line });
  }

  // Worst monitors (fleet only).
  if (scope.type === 'fleet') {
    const worst = await pool.query<{ name: string; avail: number | null }>(
      `SELECT c.name, round(100.0*sum(dcr.up_count)/nullif(sum(dcr.up_count+dcr.down_count),0),2) AS avail
         FROM daily_check_rollup dcr JOIN checks c ON c.id = dcr.check_id
        WHERE dcr.day >= $1::date AND dcr.day < $2::date
        GROUP BY c.id, c.name HAVING sum(dcr.up_count+dcr.down_count) > 0
        ORDER BY avail ASC NULLS LAST LIMIT 3`,
      [isoDay(curStart), isoDay(end)],
    );
    const worstLine = worst.rows
      .filter((w) => w.avail != null && Number(w.avail) < 100)
      .map((w) => `${w.name} ${w.avail}%`)
      .join(', ');
    if (worstLine) anomalies.push(`Lowest-availability monitors: ${worstLine}.`);
  }

  // Cost (shared cost_projection fn — matches /reports/cost) + deploy markers (for incident↔deploy timing).
  const cost = await costFacts(checkId, isoDay(curStart), isoDay(end));
  const deployMarkers = await deployMarkersInWindow(curStart.toISOString(), end.toISOString());

  return {
    scopeType: scope.type,
    scopeKey: scope.key,
    scopeName: scope.name,
    window: WINDOW,
    current,
    previous,
    deltas: {
      availabilityPts,
      downtimeMin: current.downtimeMin - previous.downtimeMin,
      incidents: current.incidents - previous.incidents,
      p95Pct,
    },
    incidentList,
    anomalies,
    criticalFindings,
    cost,
    deployMarkers,
  };
}

/**
 * ★ DELIVERY GUARANTEE. Every criticalFinding must appear in what a human actually reads.
 *
 * The failure mode this closes, measured: the repeat-offender line reached `fact_pack.anomalies` in 10 of
 * 38 stored narratives and ZERO narrative bodies. The model was handed the anomaly and simply did not echo
 * it, so a correct signal sat in a JSON column nobody opens. Instructing the prompt harder does not FIX
 * that — it only makes it likelier; the model may still drop the line and there is no way to tell after the
 * fact that it did.
 *
 * So: if the prose (headline + body + highlights — the same surface missingFigures searches) does not carry
 * a finding's token, the finding's LINE is appended to `highlights` verbatim. Additive, never destructive:
 *
 *   • it cannot fabricate — every line is computed from SQL in computeFactPack, not from the model;
 *   • it does not DISCARD a good narrative the way missingFigures does. Forcing a fallback over a missing
 *     step name would throw away genuinely useful cross-signal prose to punish a formatting miss; appending
 *     the line delivers the signal AND keeps the analysis.
 *
 * Applied to the model path AND the fallback path — buildFallback slices highlights to 5, so a monitor
 * defect could otherwise be truncated out of the deterministic output too.
 */
export function ensureAnomaliesDelivered(n: Narrative, fp: FactPack): Narrative {
  if (!fp.criticalFindings.length) return n;
  const prose = [n.headline, n.body, ...n.highlights].join(' ');
  const undelivered = fp.criticalFindings.filter((f) => !prose.includes(f.token)).map((f) => f.line);
  if (!undelivered.length) return n;
  return { ...n, highlights: [...n.highlights, ...undelivered] };
}

// --- narrate (model only narrates) + deterministic fallback ---------------------------
const SYSTEM_PROMPT =
  `You are a FinOps/SRE analyst writing a terse, cross-cutting report for an engineer. The JSON data is the ` +
  `SOLE source of truth: cite ONLY figures present in it — never invent, estimate, or round beyond it. ` +
  `Prose is INTERPRETATION of those facts, not new facts.\n` +
  `SYNTHESIZE across signals — do NOT produce three separate lists (reliability, cost, deploys). Weave them:\n` +
  `- LEAD with the single highest-priority item, ordered by impact.\n` +
  `- The headline signal is the INTERSECTION: a monitor that is SIMULTANEOUSLY unreliable AND expensive ` +
  `AND/OR recently-changed. Name it and connect the facts (e.g. "X is <avail>% available AND still ` +
  `projected $<proj>/mo = wasted spend — fix or retire"). Use cost.notable for these candidates.\n` +
  `- Treat cost DIVERGENCE (measured >> projected; divergenceFlag) as a LEADING indicator — retries/` +
  `slowdowns inflating cost before they show as failures. Call it out with the ratio.\n` +
  `- CORRELATE incident timing with deployMarkers: for an incident, compare its openedAt to each ` +
  `deployedAt; if one is shortly before, say "began ~N min after the <date> deploy <sha> (<target>)" ` +
  `using the ACTUAL timestamps. If NO deploy plausibly precedes it, say so explicitly ("no correlated ` +
  `deploy in-window → likely external/regional"). ★ NEVER assert a correlation the timestamps don't ` +
  `support — a claimed "after deploy X" must be checkable against that deploy's deployedAt.\n` +
  `- Speak in deviations-from-normal (week-over-week) where the deltas have them. Cite incidents by ` +
  `classification. Reference the connections (the anomaly's cost, the change's deploy-timing) — sections ` +
  `must interlock, not stand alone.\n` +
  `- If cost is null or deployMarkers is empty, simply omit that dimension — do NOT fabricate $ or a deploy.\n` +
  `- ★ ABSOLUTE FIGURES, NOT JUST DELTAS: you MUST state the scope's current.availabilityPct as a LITERAL ` +
  `percentage (e.g. "93.33%") somewhere — headline, body, OR a highlight — and, when current.incidents > 0, ` +
  `the literal incident COUNT. A week-over-week delta ("+11.36 pts w/w") COMPLEMENTS the aggregate, it never ` +
  `REPLACES it: reporting only the delta, or only per-monitor availabilities, is INCOMPLETE — the reader must ` +
  `see the actual current availability number. This does NOT dilute the holistic style: still lead with the ` +
  `story and weave signals, then anchor it to the real aggregate figure (copy the number from the fact pack ` +
  `verbatim — do not round or restate it).\n` +
  `- ★ criticalFindings, IF NON-EMPTY, OUTRANKS EVERYTHING ABOVE — including cost. Each is a monitor that ` +
  `is failing the SAME assertion over and over, i.e. the MONITOR is probably wrong, not the target. LEAD ` +
  `with it, name the step verbatim (its "token"), and say the action is to fix the CHECK — do NOT frame it ` +
  `as an outage to investigate or as flakiness to wait out. A recurring monitor bug labelled "flaky" is ` +
  `what suppresses its own fix.\n` +
  `- BAN filler: no greetings, no "in conclusion", no "all systems nominal". Every line carries a cited ` +
  `signal; if truly nothing notable changed, say that in one sentence.\n` +
  `Respond ONLY as JSON: {"headline": "<=1 sentence, the top item", "body": "2-6 sentences, markdown, ` +
  `woven across signals", "highlights": ["short cited string", ...]}.`;

/** Deterministic templated summary from the fact pack — used when the model is off/empty/
 *  filler, so a bad generation NEVER ships mush. Cites the same numbers. */
export function buildFallback(fp: FactPack): Narrative {
  const c = fp.current;
  const avail = c.availabilityPct != null ? `${c.availabilityPct}%` : 'n/a';
  const dPts = fp.deltas.availabilityPts;
  const dStr = dPts == null ? '' : ` (${dPts >= 0 ? '+' : ''}${dPts}pts w/w)`;
  const p95 = c.p95 != null ? `${c.p95}ms` : 'n/a';
  const p95d = fp.deltas.p95Pct == null ? '' : ` (${fp.deltas.p95Pct >= 0 ? '+' : ''}${fp.deltas.p95Pct}% w/w)`;
  const classes = fp.incidentList.map((i) => i.classification ?? 'unclassified');
  const classBreak = classes.length ? ` (${[...new Set(classes)].join(', ')})` : '';
  const headline = `${fp.scopeName} ${fp.window}: availability ${avail}${dStr}, ${c.incidents} incident(s).`;
  const bodyParts = [
    `Availability ${avail}${dStr} over ${fp.window}.`,
    `${c.incidents} incident(s) opened${classBreak}; ${c.downtimeMin} min downtime.`,
    `p95 ${p95}${p95d}.`,
  ];
  if (fp.anomalies.length) bodyParts.push(fp.anomalies.join(' '));
  else bodyParts.push('Nothing notable changed week-over-week.');
  // Cost — ONLY when present (never a fabricated $0). Names the divergent monitor if one is flagged.
  const highlights = fp.anomalies.length ? fp.anomalies.slice(0, 5) : [`Availability ${avail}`, `p95 ${p95}`, `${c.incidents} incident(s)`];
  if (fp.cost) {
    const fd = fp.cost.fleetDivergence;
    bodyParts.push(`Projected $${fp.cost.fleetProjected}/mo, measured $${fp.cost.fleetMeasured}/mo${fd != null ? ` (divergence ${fd}×)` : ''}.`);
    const div = fp.cost.notable.find((m) => m.divergenceFlag);
    if (div) {
      bodyParts.push(`${div.name}: $${div.measured}/mo measured vs $${div.projected} projected (${div.divergence}×) — retry/slowdown amplification.`);
      highlights.push(`${div.name} cost divergence ${div.divergence}×`);
    }
  }
  // Deploys — factual list only; the deterministic fallback does NOT assert correlation (that's the model's job).
  if (fp.deployMarkers.length) {
    const shas = fp.deployMarkers.map((d) => d.sha ?? d.source).slice(0, 3).join(', ');
    bodyParts.push(`${fp.deployMarkers.length} deploy(s) in-window (${shas}).`);
  }
  return {
    headline,
    body: bodyParts.join(' '),
    highlights: highlights.slice(0, 6),
  };
}

/** Validate the model output shape: {headline:string, body:string, highlights:string[]}. */
function validShape(o: unknown): o is Narrative {
  if (typeof o !== 'object' || o === null) return false;
  const r = o as Record<string, unknown>;
  return (
    typeof r.headline === 'string' && r.headline.trim().length > 0 &&
    typeof r.body === 'string' && r.body.trim().length > 0 &&
    Array.isArray(r.highlights) && r.highlights.every((h) => typeof h === 'string')
  );
}

/**
 * The HEADLINE figures the prose must surface — proof the model used the fact pack rather
 * than emitting generic filler/hallucination. Returns the labels of any MISSING figure
 * (empty array = passes). Deliberately a REASONABLE SUBSET, not every number:
 *  - availability — the primary reliability figure; rounding-tolerant (accept the
 *    truncated OR rounded integer, e.g. 73.98% -> "73" or "74") so a faithful citation
 *    in any rendering passes.
 *  - incident COUNT — but only when there were incidents (>0); a 0-count is often phrased
 *    "no incidents", so don't demand the literal "0".
 * Secondary metrics (p95, downtime, vitals) are NOT required: a change-focused fleet
 * summary legitimately leads with availability + incidents + anomalies and may omit or
 * reformat p95 (e.g. "10.8s" not "10830") — that previously rejected good fleet prose.
 * The guardrail still fires on filler (no real availability/incident figures -> missing).
 */
export function missingFigures(n: Narrative, fp: FactPack): string[] {
  // ★ SEARCH THE WHOLE NARRATIVE — headline + body + HIGHLIGHTS. `highlights` is a first-class model
  // output field (validShape requires it; SYSTEM_PROMPT asks for `"highlights": ["short cited string"]`;
  // upsert() persists it and the dashboard renders it), so it is exactly where a HOLISTIC fleet narrative
  // (the #241 rewrite) parks a bare cited figure while the body carries the cross-signal STORY. Searching
  // only headline+body false-rejected such a narrative even though it cited the figure verbatim in a
  // highlight — that is what fell back the 2026-07-09 fleet run (`missing: availability(93.33%)` while the
  // model finished clean, finish_reason=stop, 1894 chars). Including highlights also closes a latent hole:
  // an invented $ or unsupported deploy-sha in a highlight (shown to the user) now trips the guard too.
  const prose = [n.headline, n.body, ...n.highlights].join(' ');
  const missing: string[] = [];
  const pct = fp.current.availabilityPct;
  if (pct != null) {
    const alts = [String(Math.trunc(pct)), String(Math.round(pct))]; // rounding-tolerant
    if (!alts.some((a) => prose.includes(a))) missing.push(`availability(${pct}%)`);
  }
  if (fp.current.incidents > 0 && !prose.includes(String(fp.current.incidents))) {
    missing.push(`incidents(${fp.current.incidents})`);
  }

  // ★ ANTI-HALLUCINATION (reinforced for the bigger pack): the prose may cite ONLY figures the pack holds.
  // (a) COST — every "$<n>" must be near a cost figure the pack carries (fleet + drivers + notable),
  //     tolerant of rounding to the whole dollar. An out-of-pack $ = an invented number → fallback.
  const packVals: number[] = [];
  if (fp.cost) {
    packVals.push(fp.cost.fleetProjected, fp.cost.fleetMeasured);
    for (const d of fp.cost.topDrivers) packVals.push(d.projected);
    for (const c of fp.cost.notable) packVals.push(c.projected, c.measured);
  }
  for (const m of prose.matchAll(/\$\s?(\d+(?:\.\d+)?)/g)) {
    const num = Number(m[1]);
    if (!packVals.some((v) => Math.abs(v - num) < 0.5)) missing.push(`invented-cost($${m[1]})`);
  }
  // (b) DEPLOY — any hex commit-sha cited in a deploy claim must be a REAL in-window marker (prefix-match,
  //     since the model may cite a shorter prefix). A sha not among deployMarkers = an unsupported
  //     correlation ("began after deploy <sha>" the timestamps can't back) → fallback.
  if (/deploy/i.test(prose)) {
    const packShas = fp.deployMarkers.map((d) => d.sha).filter((s): s is string => !!s).map((s) => s.toLowerCase());
    for (const m of prose.matchAll(/\b([0-9a-f]{7,40})\b/gi)) {
      const sha = m[1].toLowerCase();
      if (!packShas.some((p) => p.startsWith(sha) || sha.startsWith(p))) missing.push(`unsupported-deploy-sha(${sha})`);
    }
  }
  return missing;
}

/** True when the prose surfaces the headline figures (see missingFigures). */
export function spotCheck(n: Narrative, fp: FactPack): boolean {
  return missingFigures(n, fp).length === 0;
}

/** Narrate the fact pack. Returns the narrative + which model produced it (the deployment,
 *  or 'fallback-template'). The model only narrates; on any failure/filler -> fallback. */
// gpt-5-mini is a REASONING model: max_completion_tokens bounds reasoning + output COMBINED. The old 700
// was output-sized — low-effort reasoning over the enriched fleet pack (cost + deploys + 34-check data)
// consumed the whole budget BEFORE any content → finish_reason=length, content_len=0 → fallback. 4000 gives
// comfortable headroom for the reasoning pass + the ~700-token JSON output (RCA, same model, uses 16000).
const NARRATIVE_MAX_TOKENS = 4000;

export async function narrate(fp: FactPack): Promise<{ narrative: Narrative; model: string }> {
  const user = JSON.stringify(fp);
  // Observability: surface the input size + the budget so a future budget-starve is diagnosable at a glance
  // (finish_reason=length with a big prompt vs a small max = starved; the log below pairs with it).
  console.log(
    `[narrative] ${fp.scopeType}:${fp.scopeKey || 'fleet'} prompt≈${SYSTEM_PROMPT.length + user.length} chars ` +
      `(~${Math.round((SYSTEM_PROMPT.length + user.length) / 4)} tok in), max_completion_tokens=${NARRATIVE_MAX_TOKENS}`,
  );
  const content = await chatCompletionContent({
    system: SYSTEM_PROMPT,
    user,
    maxTokens: NARRATIVE_MAX_TOKENS,
    reasoningEffort: 'low',
    logPrefix: '[narrative]',
  });
  if (content) {
    try {
      const parsed = JSON.parse(extractJson(content)) as unknown;
      if (validShape(parsed)) {
        const n: Narrative = {
          headline: parsed.headline.trim(),
          body: parsed.body.trim(),
          highlights: parsed.highlights.slice(0, 5),
        };
        const missing = missingFigures(n, fp);
        // ★ Delivery guarantee applied to the ACCEPTED model output: a criticalFinding the prose dropped is
        //   appended to highlights rather than silently lost (see ensureAnomaliesDelivered).
        if (missing.length === 0) return { narrative: ensureAnomaliesDelivered(n, fp), model: DEFAULT_DEPLOYMENT ?? 'aoai' };
        // meta-lesson A: the DISCARDED output was previously invisible (only the fallback was stored), so a
        // spot-check false-rejection was un-diagnosable without re-deriving. Log the full discarded narrative
        // (non-sensitive fleet stats) + the exact figure it wanted, so the NEXT failure is one-glance:
        // "rephrased/omitted (CASE 1/2)" vs "cited-but-in-a-field-we-don't-search (CASE 3)".
        console.warn(
          `[narrative] ${fp.scopeType}:${fp.scopeKey || 'fleet'} model output failed spot-check ` +
            `(missing: ${missing.join(', ')}) — fallback. DISCARDED output below (searched headline+body+highlights):\n` +
            `  headline: ${n.headline}\n  body: ${n.body}\n  highlights: ${JSON.stringify(n.highlights)}`,
        );
      } else {
        console.warn('[narrative] model output off-shape — fallback');
      }
    } catch (err) {
      console.warn('[narrative] model output not JSON — fallback:', err instanceof Error ? err.message : err);
    }
  }
  // The fallback carries anomalies in its body, but slices highlights to 5 — so run it through the same
  // guarantee, or a monitor defect could be truncated out of the deterministic output too.
  return { narrative: ensureAnomaliesDelivered(buildFallback(fp), fp), model: 'fallback-template' };
}

async function upsert(fp: FactPack, n: Narrative, model: string): Promise<void> {
  await pool.query(
    `INSERT INTO report_narratives (scope_type, scope_key, "window", generated_at, headline, body, highlights, model, fact_pack)
     VALUES ($1, $2, $3, now(), $4, $5, $6::jsonb, $7, $8::jsonb)
     ON CONFLICT (scope_type, scope_key, "window") DO UPDATE SET
       generated_at = now(), headline = EXCLUDED.headline, body = EXCLUDED.body,
       highlights = EXCLUDED.highlights, model = EXCLUDED.model, fact_pack = EXCLUDED.fact_pack`,
    [fp.scopeType, fp.scopeKey, fp.window, n.headline, n.body, JSON.stringify(n.highlights), model, JSON.stringify(fp)],
  );
}

/**
 * The monitors that get a per-monitor AI narrative each cycle: LIVE checks only.
 *
 * ★ TWO DIFFERENT "active check" predicates live in this codebase and the divergence on `enabled` is
 * DELIBERATE — do NOT unify them (that erases a real distinction: the countable_run / flake-budget lesson):
 *   live_check       = enabled AND archived_at IS NULL   — "does this produce LIVE health RIGHT NOW?"
 *                      THIS loop. A paused check produces no live signal to narrate, and an ARCHIVED/retired
 *                      check must NEVER get an urgent AI action-item written about it (rca-demo: 0% avail,
 *                      2,264 dead runs, narrated + billed at AOAI prices every cycle until this).
 *   reportable_check = archived_at IS NULL               — "is this a real HISTORICAL record?" A PAUSED
 *                      check's incidents + SLO history are real and stay reportable.
 * `archived_at IS NULL` is the shared floor both need; `enabled` is the extra liveness filter only the live
 * predicate adds. (Mirrors #313's cost_projection fix exactly — exclude archived, keep paused visible.)
 */
export async function narratableCheckIds(): Promise<{ id: string; name: string }[]> {
  const { rows } = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM checks WHERE enabled AND archived_at IS NULL ORDER BY id`,
  );
  return rows;
}

/**
 * Generate + store narratives for the fleet and each LIVE monitor (enabled AND not archived). No-ops
 * (returns 0) when AOAI is not configured (Layer 3 dark, zero cost). Returns the number of narratives
 * written.
 */
export async function runNarratives(): Promise<number> {
  if (!aoaiConfigured()) {
    console.log('[narrative] AZURE_OPENAI_* absent — Layer 3 off (no narratives generated)');
    return 0;
  }
  let written = 0;

  const fleet = await computeFactPack({ type: 'fleet', checkId: null, key: '', name: 'Fleet' });
  const fleetN = await narrate(fleet);
  await upsert(fleet, fleetN.narrative, fleetN.model);
  written++;
  console.log(`[narrative] fleet: "${fleetN.narrative.headline}" (${fleetN.model})`);

  const rows = await narratableCheckIds();
  for (const c of rows) {
    const fp = await computeFactPack({ type: 'monitor', checkId: Number(c.id), key: String(c.id), name: c.name });
    const res = await narrate(fp);
    await upsert(fp, res.narrative, res.model);
    written++;
  }
  console.log(`[narrative] wrote ${written} narrative(s) (1 fleet + ${rows.length} monitor(s))`);
  return written;
}
