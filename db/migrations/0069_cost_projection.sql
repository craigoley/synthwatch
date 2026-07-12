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
--
-- ★ REPLAY-IDEMPOTENCY (amended 2026-07-12): DROP-then-CREATE, NOT `CREATE OR REPLACE`. This is an
-- EFFECT-PRESERVING amendment of an already-applied migration — prod recorded 0069 in schema_migrations, so
-- migrate.sh NEVER re-runs it; the result is unchanged (a 13-col cost_projection, later superseded by 0078's
-- 17-col DROP+CREATE). What changed is REPLAY-SAFETY: the runner schema materializes as db/schema.sql (now
-- 0078's 17-col end state) and then replays every migration on top (db/migrate.sh's idempotency contract; the
-- api schema-parity gate does the same). `CREATE OR REPLACE` CANNOT change a function's return type, so
-- re-applying this OLD 13-col signature on top of the 17-col schema.sql errored ("cannot change return type of
-- existing function") and halted the replay AT 0069 — breaking a fresh DB (schema.sql + migrate.sh) and the
-- parity gate. `DROP FUNCTION IF EXISTS` drops whatever is present (nothing on a truly-empty DB; the 17-col on
-- a schema.sql base), then CREATE re-establishes the 13-col; 0078 then DROP+CREATEs the 17-col, so the replay
-- CONVERGES to 0078's end state. The function BODY below is BYTE-IDENTICAL to the original 0069 (only the two
-- lines — this DROP and CREATE-OR-REPLACE → CREATE — changed). A plain DROP is safe: 0078 already DROPs this
-- function without CASCADE in prod, proving nothing depends on it. The grant is re-issued below the CREATE.

BEGIN;

DROP FUNCTION IF EXISTS cost_projection(numeric);

CREATE FUNCTION cost_projection(p_rate numeric)
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
