-- Migration 0078 — cost_projection: add the RUN-COUNT / window / confirmation / sandbox columns the cost
-- divergence warning needs to attribute HONESTLY. The dashboard warning said "check for retries/failures",
-- but the divergence metric CANNOT SEE retries: since Σdur = avg_dur × N over the SAME 7d run set, duration
-- cancels EXACTLY and
--     divergence = measured/projected = N × (30/7) ÷ (scheduled_runs_month × region_count)
-- is a PURE RUN-COUNT ratio. Retries create no extra rows (one verdict row per run) and no extra duration
-- (only the final attempt persists); slow/failing runs inflate measured AND projected identically. ONLY
-- EXTRA ROWS move it: a config (interval) change straddling the 7d window, confirmation runs (0077), or
-- sandbox/on-demand fires. This migration exposes exactly those counts so /reports/cost + the dashboard can
-- name the real cause from data instead of blaming retries. See docs/recon/2026-07-12-cost-model.md.
--
-- Adding OUT columns changes the RETURN TYPE, which CREATE OR REPLACE cannot do → DROP then recreate. The
-- $ MODEL (projected/measured/divergence) is BYTE-IDENTICAL to 0069 (same avg/Σ over duration_ms IS NOT
-- NULL, same numeric casts/rounding); only new count columns are appended. The api's /reports/cost SELECT
-- names explicit columns, so it is unaffected until it opts into the new ones. Re-GRANT after the drop.
-- All new counts are over the SAME measured set (duration_ms IS NOT NULL, 7d) so run_count_7d is the exact
-- N in the algebra above (divergence = run_count_7d/expected), and run_count_recent/prior split the window
-- at 3.5 days to detect an interval change (a step in the run rate between halves).
-- Apply: psql "$DATABASE_URL" -f db/migrations/0078_cost_projection_run_counts.sql

BEGIN;

DROP FUNCTION IF EXISTS cost_projection(numeric);

CREATE FUNCTION cost_projection(p_rate numeric)
RETURNS TABLE (
    check_id              bigint,
    source_key            text,
    check_name            text,
    kind                  text,
    interval_seconds      integer,
    region_count          integer,
    avg_duration_s        double precision,
    projected             numeric,   -- rounded 2dp (display)
    measured              numeric,   -- rounded 2dp (display)
    divergence            numeric,   -- rounded 3dp; null when projected = 0
    divergence_flag       boolean,   -- divergence > 1.5
    projected_raw         numeric,   -- unrounded — sum these for the fleet total, THEN round
    measured_raw          numeric,
    run_count_7d          integer,   -- runs (duration_ms NOT NULL) in the last 7d = the N in divergence = N/expected
    confirmation_count_7d integer,   -- of those, confirmation re-runs (confirmation_of_run_id NOT NULL, 0077)
    sandbox_count_7d      integer,   -- of those, sandbox / on-demand fires (runs.sandbox, 0065)
    run_count_recent      integer,   -- runs in the RECENT half of the window (last 3.5d)
    run_count_prior       integer    -- runs in the PRIOR half (3.5–7d ago); recent≠prior ⇒ a cadence change
)
LANGUAGE sql
STABLE
AS $$
    WITH run_stats AS (
        -- ONE grouped pass over the measured set (duration_ms NOT NULL, last 7d), byte-identical avg/Σ to
        -- 0069's two correlated subqueries, plus the run-count columns.
        SELECT r.check_id,
               (avg(r.duration_ms) / 1000.0)::float8 AS avg_duration_s,
               (sum(r.duration_ms) / 1000.0)::float8 AS sum_duration_s_7d,
               count(*)::int AS run_count_7d,
               count(*) FILTER (WHERE r.confirmation_of_run_id IS NOT NULL)::int AS confirmation_count_7d,
               count(*) FILTER (WHERE r.sandbox)::int AS sandbox_count_7d,
               count(*) FILTER (WHERE r.started_at >  now() - interval '3.5 days')::int AS run_count_recent,
               count(*) FILTER (WHERE r.started_at <= now() - interval '3.5 days')::int AS run_count_prior
          FROM runs r
         WHERE r.started_at > now() - interval '7 days'
           AND r.duration_ms IS NOT NULL
         GROUP BY r.check_id
    ),
    base AS (
        SELECT c.id AS check_id, c.source_key, c.name AS check_name, c.kind, c.interval_seconds,
               (SELECT count(*)::int FROM check_locations cl WHERE cl.check_id = c.id) AS region_count,
               rs.avg_duration_s, rs.sum_duration_s_7d,
               coalesce(rs.run_count_7d, 0)          AS run_count_7d,
               coalesce(rs.confirmation_count_7d, 0) AS confirmation_count_7d,
               coalesce(rs.sandbox_count_7d, 0)      AS sandbox_count_7d,
               coalesce(rs.run_count_recent, 0)      AS run_count_recent,
               coalesce(rs.run_count_prior, 0)       AS run_count_prior
          FROM checks c
          LEFT JOIN run_stats rs ON rs.check_id = c.id
         WHERE c.enabled
    ),
    scored AS (
        SELECT b.*,
               CASE WHEN b.avg_duration_s IS NOT NULL AND b.interval_seconds > 0
                    THEN b.avg_duration_s::numeric * (2592000::numeric / b.interval_seconds) * b.region_count * p_rate
                    ELSE 0 END AS p_raw,
               CASE WHEN b.sum_duration_s_7d IS NOT NULL
                    THEN b.sum_duration_s_7d::numeric * p_rate * (30::numeric / 7::numeric)
                    ELSE 0 END AS m_raw
          FROM base b
    )
    SELECT s.check_id, s.source_key, s.check_name, s.kind, s.interval_seconds, s.region_count, s.avg_duration_s,
           round(s.p_raw, 2) AS projected,
           round(s.m_raw, 2) AS measured,
           CASE WHEN s.p_raw > 0 THEN round(s.m_raw / s.p_raw, 3) ELSE NULL END AS divergence,
           CASE WHEN s.p_raw > 0 THEN round(s.m_raw / s.p_raw, 3) > 1.5 ELSE false END AS divergence_flag,
           s.p_raw AS projected_raw,
           s.m_raw AS measured_raw,
           s.run_count_7d, s.confirmation_count_7d, s.sandbox_count_7d, s.run_count_recent, s.run_count_prior
      FROM scored s
$$;

COMMENT ON FUNCTION cost_projection(numeric) IS
    'Shared cost model (0069, +run-count columns 0078): per-check projected/measured/divergence for a given '
    '$/active-second rate. Called by /reports/cost (api) + the narrative fact pack (runner) so figures match. '
    'Sum projected_raw/measured_raw for the fleet total, then round. divergence = run_count_7d / expected (a '
    'pure run-count ratio: duration cancels) — attribute a flag from the count columns, NEVER retries.';

-- Re-GRANT (the drop dropped it). Guarded like 0069 — no-op on a fresh DB / the Testcontainers snapshot.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synthwatch-api') THEN
        GRANT EXECUTE ON FUNCTION cost_projection(numeric) TO "synthwatch-api";
    END IF;
END $$;

COMMIT;
