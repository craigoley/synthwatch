-- Migration 0021 — fast-retry (within-run transient-error retry).
--
-- Two DISTINCT noise knobs, in pipeline order:
--   run -> [fast-retry: this column] -> per-run verdict -> [failure_threshold] -> alert
-- fast-retry (mechanism 1) re-runs a single check up to `retries` times WITHIN one run
-- when it ERRORS (couldn't complete — network/timeout/DNS), absorbing a transient blip;
-- only the FINAL attempt counts. failure_threshold (mechanism 2, consecutive scheduled
-- runs) is UNCHANGED and runs AFTER. A clean assertion 'fail' is never retried.
--
-- Default 1: the transient-error false-positive reduction is ON by default (an errored
-- check re-runs once before it counts). retries=0 restores the exact pre-0021 behavior.
--
-- New installs converge from db/schema.sql. Apply with the migrate flow
-- (db/migrate.sh) or:  psql "$DATABASE_URL" -f db/migrations/0021_retries.sql
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS (the CHECK rides with the column).

BEGIN;

ALTER TABLE checks
    ADD COLUMN IF NOT EXISTS retries INTEGER NOT NULL DEFAULT 1 CHECK (retries >= 0);

COMMIT;
