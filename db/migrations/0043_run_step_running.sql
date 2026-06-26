-- Migration 0043 — run_steps: allow a transient 'running' status (live step progress).
--
-- run_steps is already written LIVE, one row per step as it completes (StepRecorder.step / multistep). For
-- a live step-by-step checklist we also mark a step 'running' the moment it STARTS (then finalize the same
-- row to pass/fail/error on completion), so the dashboard can show "3 ⟳ navigate Courses→Dinner" while
-- step 3 executes. Only the status CHECK needs widening; duration_ms stays NOT NULL (a running row carries 0
-- until it finalizes). Additive + idempotent — existing terminal rows are unaffected.
--
-- New installs converge from db/schema.sql.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0043_run_step_running.sql  (IDEMPOTENT).

BEGIN;

ALTER TABLE run_steps DROP CONSTRAINT IF EXISTS run_steps_status_check;
ALTER TABLE run_steps ADD CONSTRAINT run_steps_status_check
    CHECK (status IN ('pass', 'fail', 'error', 'running'));

COMMIT;
