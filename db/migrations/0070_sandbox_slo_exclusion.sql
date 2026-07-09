-- Migration 0070 — exclude sandbox runs from sla_availability (RE-LAND of the lost #228).
--
-- #228 ("exclude sandbox runs from availability") shows MERGED on GitHub (mergeCommit a0307915) but its
-- commit is NOT on origin/main — it was lost to a stacked-PR squash (it was based on the #227 branch), so
-- migration 0066 never landed. The live prod sla_availability() therefore still counts sandbox runs, and a
-- paused monitor's on-demand SANDBOX validations (e.g. b2c) pollute its SLO once it's resumed. This re-lands
-- the fix as 0070 (0066 stays a documented gap — do NOT backfill it; 0067/0068/0069 are already applied).
--
-- A sandbox run (runs.sandbox = true, migration 0065) is a paused-monitor on-demand validation that skipped
-- evaluate() — it is NOT a scheduled health signal and must never move availability. Fix: add `AND NOT
-- r.sandbox` to the LEFT JOIN runs ON (NOT a WHERE) — a check whose only in-window runs are sandbox keeps its
-- LEFT-JOIN null-run row (availability NULL — "no counted runs", not 0%/down) rather than being dropped.
--
-- CREATE OR REPLACE keeps the signature, so sla_availability_{24h,7d,30d,90d} inherit it with no view churn.
-- The runner/rollup.ts daily_check_rollup gets the mirror exclusion in the same PR. This is a READ/AGGREGATION
-- change only: runs.sandbox is a plain predicate column — it does NOT touch GIT_AUTHORITATIVE_COLUMNS,
-- buildApplyUpsert, or the reconcile positional plan tuple (the #216 lesson). Transactional; body matches
-- db/schema.sql byte-for-byte except the added predicate.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0070_sandbox_slo_exclusion.sql

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
          -- SANDBOX EXCLUSION (0070): a paused monitor's on-demand validation persists a runs row but
          -- skipped evaluate() — not a scheduled health signal, so it must never move availability. In the
          -- JOIN (not a WHERE) so a check whose only window runs are sandbox keeps its LEFT-JOIN null-run row.
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
