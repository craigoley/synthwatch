// Daily rollup — the reporting keystone (Layer 1). Computes ONE daily_check_rollup row
// per (check, UTC day) from raw telemetry, idempotently. Run by the daily rollup ACA job
// (see rollupMain.ts + infra bicep). Pure module (no top-level side effects) so it's
// importable by tests; the entry point lives in rollupMain.ts.
//
// Availability REUSES the sla_availability() definition verbatim (up=pass|warn,
// down=fail|error, 'running' excluded, maintenance-window runs anti-joined out) so the
// rollup and the sla_availability views AGREE. Latency is over UP runs only. Web-vitals
// are browser-only (run_metrics is browser-only). See db/migrations/0028.
import { pool } from './db.js';

export interface RollupOptions {
  /** Roll up every (check, day) with runs from the earliest run through yesterday (UTC). */
  backfill?: boolean;
  /** Roll up a single explicit UTC day 'YYYY-MM-DD' (all checks with runs that day). */
  day?: string;
}

/** UTC midnight bounds for a 'YYYY-MM-DD' day → [start, end) ISO timestamps. */
function utcDayBounds(day: string): { startIso: string; endIso: string } {
  const start = new Date(`${day}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 86_400_000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

/** Today's UTC midnight — the exclusive upper bound (we only roll up COMPLETED days). */
function todayUtcMidnight(): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}

/**
 * Compute + upsert the rollup for one check + one UTC day. One idempotent statement:
 * re-running recomputes from raw and overwrites (no double-count). Availability/latency
 * are MW-excluded + running-excluded (the sla_availability definition); latency is over
 * UP (pass|warn) runs; web-vitals join run_metrics (browser-only → NULL for http/ssl).
 */
export async function computeRollupForDay(checkId: number, day: string): Promise<void> {
  const { startIso, endIso } = utcDayBounds(day);
  await pool.query(
    `WITH mw_excluded AS (
       SELECT r.id, r.status, r.duration_ms
         -- ★ countable_run (0081): the canonical predicate — status(not running/infra) + non-superseded +
         -- non-confirmation + non-sandbox. Was inlined here (status/sandbox/superseded) but MISSED the
         -- confirmation exclusion, so a confirmed outage double-counted in daily availability/down_count.
         -- Now shared with sla_availability / slo_status / aggregateVerdict.
         FROM countable_run r
        WHERE r.check_id = $1
          AND r.started_at >= $2 AND r.started_at < $3
          AND NOT EXISTS (
            SELECT 1 FROM maintenance_windows mw
             WHERE (mw.check_id = r.check_id OR mw.check_id IS NULL)
               AND r.started_at >= mw.starts_at AND r.started_at < mw.ends_at
          )
     ),
     av AS (
       SELECT
         count(*) FILTER (WHERE status IN ('pass','warn'))  AS up_count,
         count(*) FILTER (WHERE status IN ('fail','error')) AS down_count,
         count(*)                                           AS total_count,
         round(100.0 * count(*) FILTER (WHERE status IN ('pass','warn'))
               / nullif(count(*), 0), 4)                    AS availability_pct,
         count(duration_ms) FILTER (WHERE status IN ('pass','warn')) AS latency_count,
         round(avg(duration_ms) FILTER (WHERE status IN ('pass','warn')), 1) AS duration_avg_ms,
         round(percentile_cont(0.5)  WITHIN GROUP (ORDER BY duration_ms)
               FILTER (WHERE status IN ('pass','warn')))::int AS duration_p50_ms,
         round(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)
               FILTER (WHERE status IN ('pass','warn')))::int AS duration_p95_ms,
         round(percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms)
               FILTER (WHERE status IN ('pass','warn')))::int AS duration_p99_ms,
         min(duration_ms) FILTER (WHERE status IN ('pass','warn')) AS duration_min_ms,
         max(duration_ms) FILTER (WHERE status IN ('pass','warn')) AS duration_max_ms
       FROM mw_excluded
     ),
     vit AS (
       SELECT
         count(m.run_id) AS vitals_count,
         round(avg(m.lcp_ms), 1)  AS lcp_avg_ms,
         round(percentile_cont(0.75) WITHIN GROUP (ORDER BY m.lcp_ms))::int  AS lcp_p75_ms,
         round(avg(m.fcp_ms), 1)  AS fcp_avg_ms,
         round(percentile_cont(0.75) WITHIN GROUP (ORDER BY m.fcp_ms))::int  AS fcp_p75_ms,
         round(avg(m.ttfb_ms), 1) AS ttfb_avg_ms,
         round(percentile_cont(0.75) WITHIN GROUP (ORDER BY m.ttfb_ms))::int AS ttfb_p75_ms,
         avg(m.cls)                                       AS cls_avg,
         percentile_cont(0.75) WITHIN GROUP (ORDER BY m.cls) AS cls_p75,
         round(avg(m.load_event_ms), 1)    AS load_event_avg_ms,
         round(avg(m.transfer_bytes))::bigint AS transfer_bytes_avg
       FROM mw_excluded me
       JOIN run_metrics m ON m.run_id = me.id
       WHERE me.status IN ('pass','warn')
     ),
     inc AS (
       SELECT
         count(*) AS incidents_opened,
         coalesce(round(sum(EXTRACT(epoch FROM (coalesce(resolved_at, now()) - opened_at)) / 60.0)::numeric, 2), 0) AS downtime_minutes
       FROM incidents
       WHERE check_id = $1 AND opened_at >= $2 AND opened_at < $3
     )
     INSERT INTO daily_check_rollup (
       check_id, day, up_count, down_count, total_count, availability_pct,
       latency_count, duration_avg_ms, duration_p50_ms, duration_p95_ms, duration_p99_ms,
       duration_min_ms, duration_max_ms,
       vitals_count, lcp_avg_ms, lcp_p75_ms, fcp_avg_ms, fcp_p75_ms, ttfb_avg_ms, ttfb_p75_ms,
       cls_avg, cls_p75, load_event_avg_ms, transfer_bytes_avg,
       incidents_opened, downtime_minutes, computed_at)
     SELECT
       $1, $4::date, av.up_count, av.down_count, av.total_count, av.availability_pct,
       av.latency_count, av.duration_avg_ms, av.duration_p50_ms, av.duration_p95_ms, av.duration_p99_ms,
       av.duration_min_ms, av.duration_max_ms,
       coalesce(vit.vitals_count, 0), vit.lcp_avg_ms, vit.lcp_p75_ms, vit.fcp_avg_ms, vit.fcp_p75_ms,
       vit.ttfb_avg_ms, vit.ttfb_p75_ms, vit.cls_avg, vit.cls_p75, vit.load_event_avg_ms, vit.transfer_bytes_avg,
       inc.incidents_opened, inc.downtime_minutes, now()
     FROM av CROSS JOIN inc LEFT JOIN vit ON true
     ON CONFLICT (check_id, day) DO UPDATE SET
       up_count = EXCLUDED.up_count, down_count = EXCLUDED.down_count, total_count = EXCLUDED.total_count,
       availability_pct = EXCLUDED.availability_pct, latency_count = EXCLUDED.latency_count,
       duration_avg_ms = EXCLUDED.duration_avg_ms, duration_p50_ms = EXCLUDED.duration_p50_ms,
       duration_p95_ms = EXCLUDED.duration_p95_ms, duration_p99_ms = EXCLUDED.duration_p99_ms,
       duration_min_ms = EXCLUDED.duration_min_ms, duration_max_ms = EXCLUDED.duration_max_ms,
       vitals_count = EXCLUDED.vitals_count, lcp_avg_ms = EXCLUDED.lcp_avg_ms, lcp_p75_ms = EXCLUDED.lcp_p75_ms,
       fcp_avg_ms = EXCLUDED.fcp_avg_ms, fcp_p75_ms = EXCLUDED.fcp_p75_ms, ttfb_avg_ms = EXCLUDED.ttfb_avg_ms,
       ttfb_p75_ms = EXCLUDED.ttfb_p75_ms, cls_avg = EXCLUDED.cls_avg, cls_p75 = EXCLUDED.cls_p75,
       load_event_avg_ms = EXCLUDED.load_event_avg_ms, transfer_bytes_avg = EXCLUDED.transfer_bytes_avg,
       incidents_opened = EXCLUDED.incidents_opened, downtime_minutes = EXCLUDED.downtime_minutes,
       computed_at = now()`,
    [checkId, startIso, endIso, day],
  );
}

/** The (check, day) pairs with at least one run in [startIso, endIso). */
async function pairsWithRuns(startIso: string, endIso: string): Promise<{ checkId: number; day: string }[]> {
  const { rows } = await pool.query<{ check_id: string; day: string }>(
    `SELECT DISTINCT r.check_id,
            to_char((r.started_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day
       FROM runs r
      WHERE r.started_at >= $1 AND r.started_at < $2
        AND r.status NOT IN ('running', 'infra_error')
      ORDER BY day, r.check_id`,
    [startIso, endIso],
  );
  return rows.map((r) => ({ checkId: Number(r.check_id), day: r.day }));
}

/**
 * Compute rollups. Default = the trailing COMPLETED day (yesterday UTC). backfill = every
 * (check, day) with runs from the earliest run through yesterday. day = one explicit day.
 * Today (partial) is never rolled up — reports read "today" from raw. Returns row count.
 */
export async function runRollup(opts: RollupOptions = {}): Promise<number> {
  const todayMid = todayUtcMidnight();
  let pairs: { checkId: number; day: string }[];

  if (opts.day) {
    const { startIso, endIso } = utcDayBounds(opts.day);
    pairs = await pairsWithRuns(startIso, endIso);
  } else if (opts.backfill) {
    // earliest run .. today-midnight (exclusive → completed days only)
    pairs = await pairsWithRuns(new Date(0).toISOString(), todayMid.toISOString());
  } else {
    const yStart = new Date(todayMid.getTime() - 86_400_000);
    pairs = await pairsWithRuns(yStart.toISOString(), todayMid.toISOString());
  }

  for (const p of pairs) await computeRollupForDay(p.checkId, p.day);
  return pairs.length;
}
