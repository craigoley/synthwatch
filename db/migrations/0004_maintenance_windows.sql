-- Migration 0004 — maintenance windows.
--
-- A maintenance window suppresses incident alerting AND excludes the period from
-- availability math, so planned downtime neither pages anyone nor counts against
-- SLA. ADDITIVE / expand-contract-safe: a new table plus an anti-join wired into
-- sla_availability's pre-existing slot. With zero window rows the SLA result is
-- identical (every run has mw.id IS NULL), so the currently-deployed runner keeps
-- working unchanged.
--
-- New installs get the same end state from db/schema.sql (the two converge).
-- Apply with the migrate flow (db/migrate.sh) or:
--   psql "$DATABASE_URL" -f db/migrations/0004_maintenance_windows.sql
--
-- IDEMPOTENT: CREATE ... IF NOT EXISTS + CREATE OR REPLACE FUNCTION, so a re-run
-- (or the migrate runner's record-after-apply retry) converges to the same state.

BEGIN;

-- maintenance_windows: a planned-downtime period. check_id NULL = fleet-wide
-- (applies to ALL checks); a non-NULL check_id scopes the window to one check.
-- Both a check-specific window and a fleet-wide window suppress/exclude.
CREATE TABLE IF NOT EXISTS maintenance_windows (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- NULL => applies to every check (fleet-wide). FK cascades so a deleted
    -- check takes its scoped windows with it.
    check_id   BIGINT      REFERENCES checks(id) ON DELETE CASCADE,
    starts_at  TIMESTAMPTZ NOT NULL,
    ends_at    TIMESTAMPTZ NOT NULL,
    reason     TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT maintenance_windows_valid_range CHECK (ends_at > starts_at)
);

-- Backs the "is this run/now inside a window" lookups (SLA exclusion + the
-- runner's incident suppression).
CREATE INDEX IF NOT EXISTS maintenance_windows_span_idx
    ON maintenance_windows (starts_at, ends_at);

-- Re-create sla_availability with the maintenance-window exclusion wired into the
-- pre-existing additive slot: a LEFT JOIN + "WHERE mw.id IS NULL" anti-join that
-- drops runs falling inside an active window. The aggregation is UNCHANGED.
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
    -- MAINTENANCE-WINDOW EXCLUSION (additive anti-join): a run is dropped if it
    -- falls inside an active window for this check (check_id = c.id) OR a
    -- fleet-wide window (check_id IS NULL). Runs not covered keep mw.id NULL and
    -- survive the WHERE; checks with no runs keep their single null-run row.
    LEFT JOIN maintenance_windows mw
           ON (mw.check_id = c.id OR mw.check_id IS NULL)
          AND r.started_at >= mw.starts_at
          AND r.started_at <  mw.ends_at
    WHERE mw.id IS NULL
    GROUP BY c.id, c.name, c.kind
$$;

COMMIT;
