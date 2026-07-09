-- Migration 0069 — cost_projection(rate): the SINGLE shared cost model both synthwatch-api (/reports/cost)
-- and the runner (narrative fact pack) call, so their $ figures are byte-identical BY CONSTRUCTION (one
-- function, never two copies of the formula). Replaces the api's in-C# CostReportProjection math.
--
-- Ports CostReportProjection.cs EXACTLY (verified against live /reports/cost):
--   inputs per enabled check: region_count (check_locations), avg/Σ duration_ms/1000 as float8 over 7d.
--   projected = avg_s × (2,592,000 / interval_seconds) × region_count × rate      (0 when avg null / interval≤0)
--   measured  = Σsec_7d × rate × 30/7                                             (0 when Σ null)
--   divergence = round(measured/projected, 3)  (null when projected=0);  flag when > 1.5
-- The float8 inputs are cast to numeric for the $ math (mirroring C# double->decimal); round(numeric,n) is
-- half-away-from-zero, matching C# MidpointRounding.AwayFromZero. Per-check projected/measured are returned
-- BOTH raw (unrounded — callers sum these for the fleet total, then round: no per-check rounding drift) and
-- rounded-2dp (for display). The RATE is passed in by the caller from COST_RATE_PER_VCPU_SECOND (the api
-- config) — the function is NOT a second rate source.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0069_cost_projection.sql

BEGIN;

CREATE OR REPLACE FUNCTION cost_projection(p_rate numeric)
RETURNS TABLE (
    check_id         bigint,
    source_key       text,
    check_name       text,
    kind             text,
    interval_seconds integer,
    region_count     integer,
    avg_duration_s   double precision,
    projected        numeric,   -- rounded 2dp (display)
    measured         numeric,   -- rounded 2dp (display)
    divergence       numeric,   -- rounded 3dp; null when projected = 0
    divergence_flag  boolean,   -- divergence > 1.5 (retry-amplification / failing-flow)
    projected_raw    numeric,   -- unrounded — sum these for the fleet total, THEN round
    measured_raw     numeric
)
LANGUAGE sql
STABLE
AS $$
    WITH base AS (
        SELECT c.id AS check_id, c.source_key, c.name AS check_name, c.kind, c.interval_seconds,
               (SELECT count(*)::int FROM check_locations cl WHERE cl.check_id = c.id) AS region_count,
               ((SELECT avg(r.duration_ms) FROM runs r
                   WHERE r.check_id = c.id AND r.started_at > now() - interval '7 days'
                     AND r.duration_ms IS NOT NULL) / 1000.0)::float8 AS avg_duration_s,
               ((SELECT sum(r.duration_ms) FROM runs r
                   WHERE r.check_id = c.id AND r.started_at > now() - interval '7 days'
                     AND r.duration_ms IS NOT NULL) / 1000.0)::float8 AS sum_duration_s_7d
          FROM checks c
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
           s.m_raw AS measured_raw
      FROM scored s
$$;

COMMENT ON FUNCTION cost_projection(numeric) IS
    'Shared cost model (0069): per-check projected/measured/divergence for a given $/vCPU-s rate. Called by both /reports/cost (api) and the narrative fact pack (runner) so their figures are identical. Sum projected_raw/measured_raw for the fleet total, then round.';

-- The api MI reads /reports/cost; grant EXECUTE (guarded, like slo_status 0016 — no-op on a fresh DB / the
-- Testcontainers snapshot that has no synthwatch-api role).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synthwatch-api') THEN
        GRANT EXECUTE ON FUNCTION cost_projection(numeric) TO "synthwatch-api";
    END IF;
END $$;

COMMIT;
