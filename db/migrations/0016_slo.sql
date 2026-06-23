-- Migration 0016 — SLO target + error-budget / burn-rate.
--
-- Complements the SLA layer (sla_availability = availability %): adds an opt-in
-- per-check SLO target, and an on-demand function computing error-budget and
-- multi-window burn-rate over a window — reusing sla_availability's up/down
-- taxonomy (up=pass|warn, down=fail|error) and its maintenance-window exclusion.
-- The runner routes fast/slow burn through the existing alert_profiles; the API
-- and dashboard surface budget/burn in follow-up PRs.
--
-- ADDITIVE / opt-in: slo_target is nullable — NULL means NO SLO (no budget is
-- fabricated; slo_status returns zero rows for the check). last_burn_notified_at
-- debounces burn alerts (mirrors last_warn_notified_at).
--
-- New installs converge from db/schema.sql. Apply with the migrate flow
-- (db/migrate.sh) or:  psql "$DATABASE_URL" -f db/migrations/0016_slo.sql
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE FUNCTION.

BEGIN;

ALTER TABLE checks ADD COLUMN IF NOT EXISTS slo_target REAL
    CHECK (slo_target IS NULL OR (slo_target > 0 AND slo_target < 1));
ALTER TABLE checks ADD COLUMN IF NOT EXISTS last_burn_notified_at TIMESTAMPTZ;

-- Per-check SLO status over [p_from, p_to). RUN-WEIGHTED, mirroring sla_availability
-- (same up/down taxonomy + maintenance-window anti-join). Returns NO rows when the
-- check has no slo_target (opt-in; nothing fabricated). budget/remaining are
-- numeric (remaining may be negative = over budget); burn_rate is window-independent
-- = (down/total) / (1-target).
CREATE OR REPLACE FUNCTION slo_status(p_check_id bigint, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
    check_id      bigint,
    slo_target    real,
    window_from   timestamptz,
    window_to     timestamptz,
    total_runs    bigint,
    down_runs     bigint,
    budget        numeric,
    consumed      bigint,
    remaining     numeric,
    remaining_pct numeric,
    burn_rate     numeric
)
LANGUAGE sql
STABLE
AS $$
    WITH agg AS (
        SELECT
            c.id         AS check_id,
            c.slo_target AS slo_target,
            count(*) FILTER (WHERE r.status IN ('pass', 'warn', 'fail', 'error')) AS total_runs,
            count(*) FILTER (WHERE r.status IN ('fail', 'error'))                 AS down_runs
        FROM checks c
        LEFT JOIN runs r
               ON r.check_id   = c.id
              AND r.started_at >= p_from
              AND r.started_at <  p_to
        -- Maintenance-window anti-join (mirrors sla_availability): drop runs inside
        -- an active window for this check OR a fleet-wide window.
        LEFT JOIN maintenance_windows mw
               ON (mw.check_id = c.id OR mw.check_id IS NULL)
              AND r.started_at >= mw.starts_at
              AND r.started_at <  mw.ends_at
        WHERE c.id = p_check_id
          AND c.slo_target IS NOT NULL   -- opt-in: no target => no rows
          AND mw.id IS NULL
        GROUP BY c.id, c.slo_target
    )
    SELECT
        check_id,
        slo_target,
        p_from AS window_from,
        p_to   AS window_to,
        total_runs,
        down_runs,
        (1::numeric - slo_target::numeric) * total_runs                         AS budget,
        down_runs                                                      AS consumed,
        (1::numeric - slo_target::numeric) * total_runs - down_runs             AS remaining,
        CASE WHEN (1::numeric - slo_target::numeric) * total_runs > 0
             THEN round(1 - down_runs::numeric / ((1::numeric - slo_target::numeric) * total_runs), 6)
             END                                                       AS remaining_pct,
        CASE WHEN total_runs > 0
             THEN round((down_runs::numeric / total_runs) / (1::numeric - slo_target::numeric), 4)
             ELSE 0 END                                                AS burn_rate
    FROM agg
$$;

COMMENT ON FUNCTION slo_status(bigint, timestamptz, timestamptz) IS
    'Per-check SLO over [p_from, p_to): target, error-budget (run-weighted), consumed, remaining, burn_rate=(down/total)/(1-target). Zero rows if no slo_target. Reuses sla_availability taxonomy + maintenance exclusion.';

-- Grant the API MI EXECUTE (mirrors sla_availability). Guarded so the migration is
-- safe on a fresh DB / the Testcontainers snapshot that has no synthwatch-api role.
DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synthwatch-api') THEN
        GRANT EXECUTE ON FUNCTION slo_status(bigint, timestamptz, timestamptz) TO "synthwatch-api";
    END IF;
END
$grant$;

COMMIT;
