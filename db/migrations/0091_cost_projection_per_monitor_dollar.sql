-- 0091_cost_projection_per_monitor_dollar.sql
--
-- ★ RESTORE the per-monitor DOLLAR estimate — but with FREE-GRANT-AWARE math, so it's CLOSER to Azure's
-- reality than the old from-zero figure. The 0089 rebuild over-corrected: it demoted the per-monitor $ to a
-- share % and (via the dashboard) truncated the list. Craig wants the DOLLARS back (primary), the share kept
-- (secondary), and the FULL monitor list. The sin was false PRECISION ($0.08-to-the-penny from a from-zero
-- rate), NOT the existence of an estimate: an "est." with the free-grant math behind it, summing to a fleet
-- target, is honest and useful.
--
-- THE MATH (why it's closer):
--   • from-zero fleet total FZ = Σ (avg_dur × runs/mo × regions × rate)  — prices every second from ZERO (~$85).
--   • The per-SUBSCRIPTION free grant (180,000 vCPU-s + 360,000 GiB-s/mo) is a FLEET discount. Its $ value at
--     the meters (p_free_grant_dollars, ~$5.40 for 2.0vCPU/4GiB) subtracts from FZ — valid as a flat discount
--     because the fleet's monthly vCPU-s AND GiB-s both far exceed the grant (both meters bill above zero):
--     (FV−free_v)·rv + (FG−free_g)·rg = FZ − p_free_grant_dollars exactly.
--   • grant-corrected fleet = greatest(0, FZ − p_free_grant_dollars).  (fleet_billable_monthly, ~$80)
--   • RECONCILE anchor = coalesce(p_reconcile_target, grant-corrected fleet). p_reconcile_target lets the
--     caller PIN Σ to Azure's steady-state figure (forecast ~$76 or MTD ~$47) — a one-line, deploy-free knob;
--     NULL → the DERIVED grant-corrected total (tracks the fleet, no magic number).
--   • estimated_monthly (per monitor) = round( p_raw / FZ × anchor , 2 ) — allocate the anchor BY compute
--     share, so the free-grant discount is spread PROPORTIONALLY; a cheap high-frequency check keeps its small
--     attributable share of the paid compute above the grant (never zeroed to $0). NULL when p_raw = 0 (no
--     runs / no duration) — never a fake $0.  Σ estimated_monthly = anchor (BY CONSTRUCTION).
--
-- ★ DEPLOY-SAFE OVERLOAD (runner-first merge order): this ADDS a 3-param cost_projection(rate, grant$, target)
-- and REWRITES the existing 1-param cost_projection(rate) as a THIN WRAPPER delegating to it (same 20-col
-- return — so the STILL-OLD api's `SELECT … FROM cost_projection(rate)` keeps working through the window until
-- PR2 switches it to the 3-param). Dropping the 1-param here would 500 the live /reports/cost. A later cleanup
-- drops the 1-param once no consumer calls it. Both CREATE OR REPLACE (idempotent replay); the 3-param is new,
-- the 1-param return type is UNCHANGED so no DROP is needed. Keeps active_seconds_7d + compute_share_pct
-- (share is now SECONDARY) and the divergence run-count ratio. Shared function → the api schema-parity fixture
-- is patched in the paired PR2.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0091_cost_projection_per_monitor_dollar.sql

BEGIN;

-- The 3-param, free-grant-aware model (the real body). p_free_grant_dollars = the free grant's $ value at the
-- meters; p_reconcile_target = the fleet $ to reconcile Σ to (NULL → derived grant-corrected total).
CREATE OR REPLACE FUNCTION cost_projection(p_rate numeric, p_free_grant_dollars numeric, p_reconcile_target numeric)
RETURNS TABLE (
    check_id              bigint,
    source_key            text,
    check_name            text,
    kind                  text,
    interval_seconds      integer,
    region_count          integer,
    avg_duration_s        double precision,
    active_seconds_7d     numeric,   -- 0089: Σ measured active-seconds over 7d — the attributable compute (SECONDARY)
    compute_share_pct     numeric,   -- 0089: 100 × active_seconds_7d / fleet total; null when fleet total is 0 (SECONDARY)
    projected             numeric,   -- from-zero $ (the compute WEIGHT + drift reference) — no longer the display $
    measured              numeric,   -- ×30/7 annualizer (drift reference)
    divergence            numeric,   -- rounded 3dp; null when projected = 0 — SURVIVES (pure run-count ratio)
    divergence_flag       boolean,   -- divergence > 1.5
    projected_raw         numeric,   -- unrounded from-zero — sum for the fleet FZ / drift, THEN round
    measured_raw          numeric,
    run_count_7d          integer,
    confirmation_count_7d integer,
    sandbox_count_7d      integer,
    run_count_recent      integer,
    run_count_prior       integer,
    estimated_monthly     numeric,   -- ★ 0091: the PRIMARY per-monitor $ — free-grant-aware, Σ = the reconcile anchor; null when no runs
    fleet_billable_monthly numeric   -- ★ 0091: grant-corrected fleet total (FZ − free grant $), CONSTANT per row — for the drift check
)
LANGUAGE sql
STABLE
AS $$
    WITH run_stats AS (
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
         -- ★ 0086/#313: exclude ARCHIVED checks — every ACTIVE monitor appears (the truncation fix is client-side).
         WHERE c.enabled AND c.archived_at IS NULL
    ),
    scored AS (
        SELECT b.*,
               coalesce(b.sum_duration_s_7d, 0)::numeric                          AS active_seconds_7d,
               sum(coalesce(b.sum_duration_s_7d, 0)::numeric) OVER ()             AS fleet_active_seconds_7d,
               CASE WHEN b.avg_duration_s IS NOT NULL AND b.interval_seconds > 0
                    THEN b.avg_duration_s::numeric * (2592000::numeric / b.interval_seconds) * b.region_count * p_rate
                    ELSE 0 END AS p_raw,
               CASE WHEN b.sum_duration_s_7d IS NOT NULL
                    THEN b.sum_duration_s_7d::numeric * p_rate * (30::numeric / 7::numeric)
                    ELSE 0 END AS m_raw
          FROM base b
    ),
    fleeted AS (
        -- ★ 0091: fleet from-zero total FZ (window sum of p_raw), and the grant-corrected + reconcile anchor.
        SELECT s.*,
               sum(s.p_raw) OVER ()                                              AS fleet_p_raw,
               greatest(0::numeric, sum(s.p_raw) OVER () - coalesce(p_free_grant_dollars, 0)) AS fleet_billable
          FROM scored s
    )
    SELECT f.check_id, f.source_key, f.check_name, f.kind, f.interval_seconds, f.region_count, f.avg_duration_s,
           round(f.active_seconds_7d, 3) AS active_seconds_7d,
           CASE WHEN f.fleet_active_seconds_7d > 0
                THEN round(100 * f.active_seconds_7d / f.fleet_active_seconds_7d, 2)
                ELSE NULL END AS compute_share_pct,
           round(f.p_raw, 2) AS projected,
           round(f.m_raw, 2) AS measured,
           CASE WHEN f.p_raw > 0 THEN round(f.m_raw / f.p_raw, 3) ELSE NULL END AS divergence,
           CASE WHEN f.p_raw > 0 THEN round(f.m_raw / f.p_raw, 3) > 1.5 ELSE false END AS divergence_flag,
           f.p_raw AS projected_raw,
           f.m_raw AS measured_raw,
           f.run_count_7d, f.confirmation_count_7d, f.sandbox_count_7d, f.run_count_recent, f.run_count_prior,
           -- ★ 0091: allocate the reconcile anchor (target, or grant-corrected fleet) BY compute share. NULL
           -- when this monitor has no from-zero compute (no runs) — never a fake $0. Σ = the anchor.
           CASE WHEN f.fleet_p_raw > 0 AND f.p_raw > 0
                THEN round(f.p_raw / f.fleet_p_raw * coalesce(p_reconcile_target, f.fleet_billable), 2)
                ELSE NULL END AS estimated_monthly,
           round(f.fleet_billable, 2) AS fleet_billable_monthly
      FROM fleeted f
$$;

COMMENT ON FUNCTION cost_projection(numeric, numeric, numeric) IS
    'Free-grant-aware cost model (0091). estimated_monthly = per-monitor $ = (from-zero compute share) × the reconcile anchor, where anchor = coalesce(p_reconcile_target, grant-corrected fleet total = Σprojected − p_free_grant_dollars). Σ estimated_monthly = the anchor; the free grant is spread proportionally (cheap checks discounted, never zeroed); null when no runs. compute_share_pct/active_seconds_7d are the SECONDARY signal; fleet_billable_monthly + projected_raw feed the drift check vs Azure''s forecast.';

-- ★ Deploy-safe: rewrite the 1-param as a thin WRAPPER over the 3-param (same 20-col return), so the still-old
-- api keeps working until PR2 switches it. grant$=0 / target=NULL is irrelevant here (the wrapper drops the two
-- new columns). Return type UNCHANGED → CREATE OR REPLACE (no DROP).
CREATE OR REPLACE FUNCTION cost_projection(p_rate numeric)
RETURNS TABLE (
    check_id              bigint,
    source_key            text,
    check_name            text,
    kind                  text,
    interval_seconds      integer,
    region_count          integer,
    avg_duration_s        double precision,
    active_seconds_7d     numeric,
    compute_share_pct     numeric,
    projected             numeric,
    measured              numeric,
    divergence            numeric,
    divergence_flag       boolean,
    projected_raw         numeric,
    measured_raw          numeric,
    run_count_7d          integer,
    confirmation_count_7d integer,
    sandbox_count_7d      integer,
    run_count_recent      integer,
    run_count_prior       integer
)
LANGUAGE sql
STABLE
AS $$
    SELECT check_id, source_key, check_name, kind, interval_seconds, region_count, avg_duration_s,
           active_seconds_7d, compute_share_pct, projected, measured, divergence, divergence_flag,
           projected_raw, measured_raw, run_count_7d, confirmation_count_7d, sandbox_count_7d,
           run_count_recent, run_count_prior
      FROM cost_projection(p_rate, 0::numeric, NULL::numeric)
$$;

-- Re-grant EXECUTE on BOTH signatures (guarded — no-op on a fresh DB / Testcontainers with no api role).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synthwatch-api') THEN
        GRANT EXECUTE ON FUNCTION cost_projection(numeric) TO "synthwatch-api";
        GRANT EXECUTE ON FUNCTION cost_projection(numeric, numeric, numeric) TO "synthwatch-api";
    END IF;
END $$;

COMMIT;
