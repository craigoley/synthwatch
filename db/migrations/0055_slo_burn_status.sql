-- Migration 0055 — slo_burn_status(check_id): the SHARED, location-aware SLO burn STATE (P5 PR2).
--
-- Reproduces the runner's maybeBurnAlert THRESHOLD decision EXACTLY (evaluate.ts) so the read path (the
-- /reports/slo pills) and the paging path compute from ONE definition and can never diverge. STATE ONLY:
-- it does NOT fold in the three DISPATCH suppressors (open incident / maintenance debounce /
-- last_burn_notified_at) — those gate whether to PAGE, not what the burn IS; the runner applies them on
-- top. A function that included them would make the pill read 'none' while burning-but-suppressed (a lying
-- green).
--
-- ★ BYTE-IDENTICAL to the TS: the TS computes burn in JS float64 (down/total/(1-target)) and compares to
-- 14.4 / 6 as float64. So this uses double precision (float8) throughout with float8-cast thresholds —
-- NOT numeric — or the boundary comparisons would drift. effectiveN uses INTEGER division to match
-- Math.floor(reporting/2)+1. A single now() evaluates all 3 windows (the TS issues 3 queries at 3 slightly
-- different now()s — cleaner here; the differential test tolerates that boundary-timing difference).
--
-- The reproduced rule (per the recon):
--   per-location burn over each window = (down::float8 / total) / (1 - slo_target), maintenance anti-joined
--     (the SAME LEFT JOIN maintenance_windows … mw.id IS NULL slo_status uses), locations with total>0.
--   floor       : a location counts only if total >= failure_threshold AND burn >= threshold (14.4 fast / 6 slow).
--   quorum      : effectiveN(reporting, min_fail_locations) = min_fail NULL ? floor(reporting/2)+1
--                 : min(min_fail, reporting), computed PER WINDOW off that window's reporting-location count.
--   FAST (1h)   : rep_1h>0 AND burning(1h,14.4) >= effectiveN(rep_1h).            → 'fast'  (critical)
--   SLOW        : rep_6h>0 AND rep_30m>0 AND burning(6h,6)>=effectiveN(rep_6h)
--                 AND burning(30m,6)>=effectiveN(rep_30m).                        → 'slow'  (warning)
--   else 'none'. slo_target NULL → 'none' (SLO off; mirrors maybeBurnAlert's early return).
--   reported_burn = max(burn) among at-floor locations of the FIRING window (1h for fast, 6h for slow), else 0.
--
-- Apply: psql "$DATABASE_URL" -f db/migrations/0055_slo_burn_status.sql   (IDEMPOTENT: CREATE OR REPLACE)

BEGIN;

CREATE OR REPLACE FUNCTION slo_burn_status(p_check_id bigint)
RETURNS TABLE (
    check_id      bigint,
    burn_state    text,             -- 'fast' | 'slow' | 'none'
    reported_burn double precision, -- max burn among at-floor locations of the firing window; 0 otherwise
    detail        jsonb             -- per-location per-window burn (for the dashboard breakdown)
)
LANGUAGE sql
STABLE
AS $$
WITH cfg AS (
    -- ★ ::text::float8, NOT ::float8: node-pg parses the float4 column from its TEXT form ("0.99" →
    -- float64 0.99), whereas a direct ::float8 widens the float4 BINARY (0.990000009…) — the two give a
    -- different (1-target) and the burn diverges at the boundary. Casting through text reproduces node-pg
    -- byte-for-byte (the differential test proves it).
    SELECT c.slo_target::text::float8 AS target,
           c.failure_threshold         AS floor,     -- INTEGER NOT NULL DEFAULT 1
           c.min_fail_locations        AS minfail    -- INTEGER, NULL => majority
      FROM checks c
     WHERE c.id = p_check_id
),
-- Per-location totals/downs for all 3 windows in ONE pass over the widest (6h) window, ONE now().
-- 1h ⊂ 6h and 30m ⊂ 6h, so a FILTER on started_at derives the narrower windows. Maintenance anti-joined
-- exactly as burnRatesByLocation / slo_status.
loc AS (
    SELECT r.location,
           count(*) FILTER (WHERE r.status IN ('pass','warn','fail','error'))                                              AS total_6h,
           count(*) FILTER (WHERE r.status IN ('fail','error'))                                                            AS down_6h,
           count(*) FILTER (WHERE r.status IN ('pass','warn','fail','error') AND r.started_at >= now() - interval '1 hour')  AS total_1h,
           count(*) FILTER (WHERE r.status IN ('fail','error')                AND r.started_at >= now() - interval '1 hour')  AS down_1h,
           count(*) FILTER (WHERE r.status IN ('pass','warn','fail','error') AND r.started_at >= now() - interval '30 minutes') AS total_30m,
           count(*) FILTER (WHERE r.status IN ('fail','error')                AND r.started_at >= now() - interval '30 minutes') AS down_30m
      FROM runs r
      LEFT JOIN maintenance_windows mw
             ON (mw.check_id = r.check_id OR mw.check_id IS NULL)
            AND r.started_at >= mw.starts_at AND r.started_at < mw.ends_at
     WHERE r.check_id = p_check_id
       AND r.started_at >= now() - interval '6 hours' AND r.started_at < now()
       AND mw.id IS NULL
     GROUP BY r.location
),
-- burn = (down/total)/(1-target) per window, in float8 to match the runner's JS float64. NULL when total=0.
rates AS (
    SELECT l.location,
           l.total_1h,  CASE WHEN l.total_1h  > 0 THEN (l.down_1h::float8  / l.total_1h)  / (1 - (SELECT target FROM cfg)) END AS burn_1h,
           l.total_6h,  CASE WHEN l.total_6h  > 0 THEN (l.down_6h::float8  / l.total_6h)  / (1 - (SELECT target FROM cfg)) END AS burn_6h,
           l.total_30m, CASE WHEN l.total_30m > 0 THEN (l.down_30m::float8 / l.total_30m) / (1 - (SELECT target FROM cfg)) END AS burn_30m
      FROM loc l
),
agg AS (
    SELECT
        (SELECT floor   FROM cfg) AS floor,
        (SELECT minfail FROM cfg) AS minfail,
        count(*) FILTER (WHERE total_1h  > 0)  AS rep_1h,
        count(*) FILTER (WHERE total_6h  > 0)  AS rep_6h,
        count(*) FILTER (WHERE total_30m > 0)  AS rep_30m,
        count(*) FILTER (WHERE total_1h  >= (SELECT floor FROM cfg) AND burn_1h  >= 14.4::float8) AS burn_n_1h,
        count(*) FILTER (WHERE total_6h  >= (SELECT floor FROM cfg) AND burn_6h  >= 6::float8)    AS burn_n_6h,
        count(*) FILTER (WHERE total_30m >= (SELECT floor FROM cfg) AND burn_30m >= 6::float8)    AS burn_n_30m,
        max(burn_1h) FILTER (WHERE total_1h >= (SELECT floor FROM cfg)) AS rb_1h,
        max(burn_6h) FILTER (WHERE total_6h >= (SELECT floor FROM cfg)) AS rb_6h
      FROM rates
),
verdict AS (
    SELECT
        CASE
            -- effectiveN via INTEGER division: minfail NULL ? floor(rep/2)+1 : least(minfail, rep).
            WHEN rep_1h > 0
             AND burn_n_1h >= (CASE WHEN minfail IS NULL THEN rep_1h / 2 + 1 ELSE least(minfail, rep_1h) END)
                THEN 'fast'
            WHEN rep_6h > 0 AND rep_30m > 0
             AND burn_n_6h  >= (CASE WHEN minfail IS NULL THEN rep_6h  / 2 + 1 ELSE least(minfail, rep_6h)  END)
             AND burn_n_30m >= (CASE WHEN minfail IS NULL THEN rep_30m / 2 + 1 ELSE least(minfail, rep_30m) END)
                THEN 'slow'
            ELSE 'none'
        END AS burn_state,
        rb_1h, rb_6h
      FROM agg
)
SELECT
    p_check_id AS check_id,
    CASE WHEN (SELECT target FROM cfg) IS NULL THEN 'none' ELSE v.burn_state END AS burn_state,
    CASE
        WHEN (SELECT target FROM cfg) IS NULL   THEN 0::float8
        WHEN v.burn_state = 'fast'              THEN coalesce(v.rb_1h, 0)
        WHEN v.burn_state = 'slow'              THEN coalesce(v.rb_6h, 0)
        ELSE 0::float8
    END AS reported_burn,
    coalesce(
        (SELECT jsonb_agg(jsonb_build_object(
                    'location', location,
                    'burn_1h',  burn_1h,  'total_1h',  total_1h,
                    'burn_6h',  burn_6h,  'total_6h',  total_6h,
                    'burn_30m', burn_30m, 'total_30m', total_30m
                ) ORDER BY location)
           FROM rates),
        '[]'::jsonb
    ) AS detail
  FROM verdict v;
$$;

-- Grant the API MI EXECUTE (mirrors slo_status @ 0016). Guarded so the migration is safe on a fresh DB /
-- the Testcontainers snapshot that has no synthwatch-api role.
DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synthwatch-api') THEN
        GRANT EXECUTE ON FUNCTION slo_burn_status(bigint) TO "synthwatch-api";
    END IF;
END
$grant$;

COMMIT;
