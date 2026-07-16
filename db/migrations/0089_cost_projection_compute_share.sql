-- 0089_cost_projection_compute_share.sql
--
-- ★ THE HONEST METRIC. cost_projection prices every monitor's active-seconds FROM ZERO and calls the sum a
-- "projected monthly $" — a number more precise than its inputs justify (it ignores the 180k/360k
-- PER-SUBSCRIPTION free grant, models ONLY ACA compute, and annualizes a trailing-7d × 30/7). Per-monitor
-- DOLLARS are not a supportable unit. Per-monitor RESOURCE SHARE is: every check runs on the SAME runner
-- allocation, so its share of fleet compute is just its share of measured active-seconds — attributable,
-- measured, and stable. This adds that share; the fleet DOLLAR headline moves to Azure Cost Management
-- (pulled, azure_cost / 0090), not modeled here.
--
--   active_seconds_7d  = Σ(duration_ms)/1000 over the last 7d (all runs, all regions) — the raw attributable
--                        compute in the unit ACA bills (ACTIVE seconds). Display multiplies by the stamped
--                        vCPU / GiB to show vCPU-seconds + GiB-seconds; the RATIO (share) is identical on
--                        either meter for a uniform fleet shape, so ONE share number suffices.
--   compute_share_pct  = 100 × active_seconds_7d / Σfleet(active_seconds_7d), rounded 2dp; null when the
--                        fleet total is 0 (empty window) — never a fake 0.00 that reads as "measured 0%".
--
-- ★ ADDITIVE, NOT a rename/delete. The existing projected/measured/divergence/*_raw columns STAY so the
-- live /reports/cost (api) keeps serving through the runner-only deploy — the from-zero $ columns get
-- DEMOTED in the api + dashboard PRs, then removed in a later cleanup once no consumer reads them. Deleting
-- them here would 500 the still-old api the instant this migration applies. divergence (0078) is a PURE
-- run-count ratio (duration cancels) and SURVIVES the redesign unchanged — it is the one honest diagnostic.
--
-- ★ SIGNATURE CHANGE (adds 2 return columns) → DROP FUNCTION first, NOT `CREATE OR REPLACE` (Postgres cannot
-- change a function's return type in place — the 0069/0078/0284 lesson). Replay-safe: on a schema.sql base
-- (which carries THIS 20-col end-state) the DROP removes it, the CREATE re-establishes it; on a bare DB the
-- DROP is a no-op. cost_projection is a SHARED function (api /reports/cost calls it, the api schema-parity
-- gate compares its body) — the paired api fixture bump lands with this.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0089_cost_projection_compute_share.sql

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
    active_seconds_7d     numeric,   -- ★ 0089: Σ measured active-seconds over 7d (all runs/regions) — the attributable compute
    compute_share_pct     numeric,   -- ★ 0089: 100 × this check's active_seconds_7d / fleet total; null when fleet total is 0
    projected             numeric,   -- rounded 2dp (display) — DEMOTED: from-zero $, superseded by share + Azure headline
    measured              numeric,   -- rounded 2dp (display) — DEMOTED: ×30/7 annualizer, superseded as above
    divergence            numeric,   -- rounded 3dp; null when projected = 0 — SURVIVES: pure run-count ratio
    divergence_flag       boolean,   -- divergence > 1.5
    projected_raw         numeric,   -- unrounded — sum these for the fleet STEADY-STATE estimate, THEN round
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
         -- ★ 0086: exclude ARCHIVED checks (matches #254 at the source — the last surface it missed).
         WHERE c.enabled AND c.archived_at IS NULL
    ),
    scored AS (
        SELECT b.*,
               -- ★ 0089: measured active-seconds (0 when the window has no runs) + the fleet total as a window
               -- sum, so share is a single pass (no self-join). Σfleet over the WHOLE result set via OVER ().
               coalesce(b.sum_duration_s_7d, 0)::numeric                          AS active_seconds_7d,
               sum(coalesce(b.sum_duration_s_7d, 0)::numeric) OVER ()             AS fleet_active_seconds_7d,
               CASE WHEN b.avg_duration_s IS NOT NULL AND b.interval_seconds > 0
                    THEN b.avg_duration_s::numeric * (2592000::numeric / b.interval_seconds) * b.region_count * p_rate
                    ELSE 0 END AS p_raw,
               CASE WHEN b.sum_duration_s_7d IS NOT NULL
                    THEN b.sum_duration_s_7d::numeric * p_rate * (30::numeric / 7::numeric)
                    ELSE 0 END AS m_raw
          FROM base b
    )
    SELECT s.check_id, s.source_key, s.check_name, s.kind, s.interval_seconds, s.region_count, s.avg_duration_s,
           round(s.active_seconds_7d, 3) AS active_seconds_7d,
           -- share is undefined when NO monitor ran in the window (fleet total 0) → null, never a fake 0.00.
           CASE WHEN s.fleet_active_seconds_7d > 0
                THEN round(100 * s.active_seconds_7d / s.fleet_active_seconds_7d, 2)
                ELSE NULL END AS compute_share_pct,
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
    'Shared cost model (0069, +run-counts 0078, +compute-share 0089): per-check compute_share_pct (share of fleet measured active-seconds — the ATTRIBUTABLE metric; per-monitor $ is NOT supportable under a per-subscription free grant) + active_seconds_7d, plus the SURVIVING divergence run-count ratio. projected/measured are DEMOTED from-zero-$ columns kept only for the staged api/dashboard migration; the fleet DOLLAR headline is Azure Cost Management (azure_cost, 0090), not this function.';

-- The api MI reads /reports/cost; re-grant EXECUTE after the DROP (guarded — no-op on a fresh DB / the
-- Testcontainers snapshot that has no synthwatch-api role).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synthwatch-api') THEN
        GRANT EXECUTE ON FUNCTION cost_projection(numeric) TO "synthwatch-api";
    END IF;
END $$;

COMMIT;
