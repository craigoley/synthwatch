-- Migration 0065 — runs.sandbox: mark a sandbox run's persisted row (paused-monitor on-demand validation).
--
-- The sandbox-run-when-paused feature (0064 run_requests.sandbox + runner index.ts) lets a PAUSED monitor
-- be validated on-demand; the run writes a NORMAL `runs` row (option A, for inspectability) but skips
-- evaluate() (no incident/alert/SLO — applyRunSideEffects). Today the sandbox flag lives ONLY on
-- run_requests, so the persisted run row is indistinguishable from a real run: after the monitor is
-- RESUMED (enabled), its historical sandbox runs (a) look real in history and (b) re-enter its SLO
-- lookback window. This column stamps the run itself so it stays distinguishable across a resume.
--
-- The runner sets it true when the sandbox path writes the row (runOne(check, sandbox) → INSERT). It is a
-- RUNS-write column — NOT a checks/reconcile column, so it does NOT touch the field-split apply plan tuple
-- (the #216 positional-desync class is not in play here).
--
-- DEFAULT false → every existing + normal run is a real run (unchanged). New installs converge from
-- db/schema.sql. Idempotent (IF NOT EXISTS). BEGIN/COMMIT.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0065_runs_sandbox.sql

BEGIN;

ALTER TABLE runs ADD COLUMN IF NOT EXISTS sandbox boolean NOT NULL DEFAULT false;

COMMIT;
