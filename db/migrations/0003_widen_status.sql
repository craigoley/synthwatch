-- Migration 0003 — widen the run-status taxonomy.
--
-- Makes the 5-status taxonomy real: pass | warn | fail | error | running.
-- This is ADDITIVE and expand/contract-safe — widening a CHECK only ALLOWS more
-- values, so the currently-deployed runner (which writes only pass/fail) keeps
-- satisfying the constraint. The runner is updated in the same PR to emit the new
-- values; on merge, CD applies this migration BEFORE rolling the new image.
--
-- New installs get the same end state from db/schema.sql (the two converge).
-- Apply with the migrate flow (db/migrate.sh) or:
--   psql "$DATABASE_URL" -f db/migrations/0003_widen_status.sql
--
-- IDEMPOTENT: each constraint is dropped IF EXISTS then re-added, so a re-run
-- (or the migrate runner's record-after-apply retry) converges to the same state.

BEGIN;

-- runs.status: the full taxonomy.
--   pass    = succeeded, budgets met
--   warn    = succeeded but a perf budget was breached (degraded-but-available)
--   fail    = an assertion/expectation failed (HTTP status/body, a flow expectation)
--   error   = an exception/timeout/infra problem (distinct from a clean fail)
--   running = in-flight; written on insert, updated to a terminal status on finish
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_status_check;
ALTER TABLE runs ADD  CONSTRAINT runs_status_check
    CHECK (status IN ('pass', 'warn', 'fail', 'error', 'running'));

-- A freshly-inserted run is in-flight until finalized. (The runner inserts
-- 'running' explicitly; this default just keeps the column honest if omitted.)
ALTER TABLE runs ALTER COLUMN status SET DEFAULT 'running';

-- run_steps.status: a step can pass, fail (a flow expectation), or error (an
-- exception/timeout). 'warn' (perf budget) and 'running' (in-flight) are
-- run-level concepts that do not apply to a discrete, synchronous step.
ALTER TABLE run_steps DROP CONSTRAINT IF EXISTS run_steps_status_check;
ALTER TABLE run_steps ADD  CONSTRAINT run_steps_status_check
    CHECK (status IN ('pass', 'fail', 'error'));

COMMIT;
