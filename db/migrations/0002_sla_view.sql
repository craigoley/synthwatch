-- SynthWatch — migration 0002: SLA / availability reporting.
--
-- The #1 Dynatrace-decommission blocker: an auditable, timestamped availability
-- record. Availability is computed ON-DEMAND straight from the runs table, not
-- from precomputed rollups. At ~10k runs/day the windowed aggregate is index-
-- assisted (runs_check_started_idx) and sub-second, so rollups would be
-- premature complexity. If a single SLA query ever exceeds ~1-2s, swap the view
-- for a MATERIALIZED VIEW — callers are unaffected because they query the view,
-- not the underlying SQL.
--
-- This migration is ADDITIVE (function + views only; no table/data changes).
-- Apply with:  psql "$DATABASE_URL" -f db/migrations/0002_sla_view.sql
-- The same objects are appended to db/schema.sql so fresh installs converge.
--
-- ---------------------------------------------------------------------------
-- AVAILABILITY DEFINITION (authoritative — keep in sync with the PR/README)
-- ---------------------------------------------------------------------------
-- A run counts toward availability only if it COMPLETED, i.e. it produced a
-- result. status IN ('pass','warn','fail','error'). 'running' is in-flight (no
-- result yet) and is excluded from BOTH numerator and denominator.
--
--   "Up"   = status IN ('pass','warn')   -- warn = degraded but reachable.
--   "Down" = status IN ('fail','error')
--
--   availability_pct = up_runs / completed_runs * 100   (per check, per window)
--
-- Treating 'warn' (perf-degraded but reachable) as available matches how
-- Dynatrace scores availability — degraded != down.
--
-- NOTE on status values: at the time of this migration the runs.status CHECK
-- constraint only permits ('pass','fail'); 'warn'/'error'/'running' are not yet
-- emitted. The IN-lists below are written against the full intended taxonomy on
-- purpose: today only pass/fail match (so the math is exactly up=pass,
-- down=fail), and the day those statuses are introduced this view is already
-- correct with no edit. Widening the runs CHECK constraint is deliberately NOT
-- part of this PR (read-only computation only).

BEGIN;

-- sla_availability(p_from, p_to): per-check availability over an arbitrary
-- [p_from, p_to) window. Written as a single-SELECT STABLE SQL function so
-- Postgres INLINES it into the caller — the time bounds reach the planner as
-- real values, letting the per-check started_at range ride runs_check_started_idx
-- (check_id, started_at DESC) instead of forcing a seq scan.
--
-- LEFT JOIN from checks means a check with zero runs in the window still appears,
-- with completed_runs = 0 and availability_pct = NULL ("no data" is itself an
-- auditable fact). nullif() guards the divide-by-zero.
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
        -- completed = produced a result; 'running' (in-flight) is excluded here.
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
    -- ┌── MAINTENANCE-WINDOW EXCLUSION SLOT (separate, later PR) ─────────────┐
    -- │ Excluding runs that fall inside a maintenance window is an ADDITIVE   │
    -- │ change here, NOT a rewrite of the aggregation above:                  │
    -- │     LEFT JOIN maintenance_windows mw                                  │
    -- │            ON mw.check_id   = c.id                                    │
    -- │           AND r.started_at <@ mw.during   -- tstzrange column         │
    -- │ then add the matching predicate at the WHERE marker below.            │
    -- └──────────────────────────────────────────────────────────────────────┘
    WHERE true   -- maintenance-window filter slots in here:  AND mw.id IS NULL
    GROUP BY c.id, c.name, c.kind
$$;

COMMENT ON FUNCTION sla_availability(timestamptz, timestamptz) IS
    'Per-check availability over [p_from, p_to). up=(pass,warn) / completed=(pass,warn,fail,error); running excluded. On-demand, index-assisted.';

-- Convenience views for the dashboard API layer (separate PR). Each is a thin
-- wrapper that fixes the window relative to now(); now() is STABLE so the bound
-- is evaluated once and remains index-usable.
CREATE OR REPLACE VIEW sla_availability_24h AS
    SELECT * FROM sla_availability(now() - interval '24 hours', now());

CREATE OR REPLACE VIEW sla_availability_7d AS
    SELECT * FROM sla_availability(now() - interval '7 days', now());

CREATE OR REPLACE VIEW sla_availability_30d AS
    SELECT * FROM sla_availability(now() - interval '30 days', now());

COMMIT;
