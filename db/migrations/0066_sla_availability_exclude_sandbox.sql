-- Migration 0066 — exclude sandbox runs from sla_availability (paused-monitor on-demand validations).
--
-- 0065 added runs.sandbox: true when a PAUSED monitor's on-demand validation writes its (evaluate()-skipped)
-- row. Such a run is NOT a scheduled health signal — no incident/alert — so it must never move availability.
-- Until now sla_availability() counted every non-MW run regardless of sandbox, so once the monitor was
-- RESUMED its historical sandbox runs re-entered its SLO lookback (24h/7d/30d/90d views all read this fn).
--
-- Fix: add `AND NOT r.sandbox` to the LEFT JOIN runs condition (NOT a WHERE) — a check whose only runs in
-- the window are sandbox keeps its LEFT-JOIN null-run row (availability NULL) rather than being dropped.
-- The daily rollup (runner/rollup.ts computeRollupForDay) gets the mirror exclusion in the same PR.
--
-- CREATE OR REPLACE FUNCTION keeps the signature, so the sla_availability_{24h,7d,30d,90d} views inherit
-- the new behavior with no view churn. Transactional (BEGIN/COMMIT) — NOT a CONCURRENTLY index migration.
-- Depends on 0065 (runs.sandbox must exist). Fresh installs converge from db/schema.sql (same fn body).
-- Apply: psql "$DATABASE_URL" -f db/migrations/0066_sla_availability_exclude_sandbox.sql

BEGIN;

CREATE OR REPLACE FUNCTION sla_availability(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
    check_id         bigint,
    check_name       text,
    kind             text,
    window_from      timestamptz,
    window_to        timestamptz,
    completed_runs   bigint,
    up_runs          bigint,
    down_runs        bigint,
    availability_pct numeric
)
LANGUAGE sql
STABLE
AS $$
    SELECT
        c.id   AS check_id,
        c.name AS check_name,
        c.kind AS kind,
        p_from AS window_from,
        p_to   AS window_to,
        count(*) FILTER (WHERE r.status IN ('pass', 'warn', 'fail', 'error')) AS completed_runs,
        count(*) FILTER (WHERE r.status IN ('pass', 'warn'))                  AS up_runs,
        count(*) FILTER (WHERE r.status IN ('fail', 'error'))                 AS down_runs,
        round(
            100.0 * count(*) FILTER (WHERE r.status IN ('pass', 'warn'))
                  / nullif(count(*) FILTER (WHERE r.status IN ('pass', 'warn', 'fail', 'error')), 0),
            4
        ) AS availability_pct
    FROM checks c
    LEFT JOIN runs r
           ON r.check_id   = c.id
          AND r.started_at >= p_from
          AND r.started_at <  p_to
          -- SANDBOX EXCLUSION (this migration): a paused monitor's on-demand validation persists a runs
          -- row but skipped evaluate() — not a scheduled health signal, so it must never move availability.
          -- In the JOIN (not a WHERE) so a check whose only runs are sandbox keeps its LEFT-JOIN null-run row.
          AND NOT r.sandbox
    -- MAINTENANCE-WINDOW EXCLUSION (additive anti-join, mirrors 0004): drop runs
    -- that fall inside an active window for this check (check_id = c.id) OR a
    -- fleet-wide window (check_id IS NULL). Uncovered runs keep mw.id NULL and
    -- survive; checks with no runs keep their single null-run row.
    LEFT JOIN maintenance_windows mw
           ON (mw.check_id = c.id OR mw.check_id IS NULL)
          AND r.started_at >= mw.starts_at
          AND r.started_at <  mw.ends_at
    WHERE mw.id IS NULL
    GROUP BY c.id, c.name, c.kind
$$;

COMMENT ON FUNCTION sla_availability(timestamptz, timestamptz) IS
    'Per-check availability over [p_from, p_to). up=(pass,warn) / completed=(pass,warn,fail,error); running + sandbox excluded. On-demand, index-assisted.';

COMMIT;
