-- Migration 0039 — last-known-good success TRACE (per-monitor baseline).
--
-- The runner now captures a Playwright trace on EVERY browser run (it already RECORDED every run;
-- previously it only SAVED on failure). Retention is selective:
--   • FAILURE traces  -> per-run key traces/run-<runId>-<ts>.zip, purged by the 90d artifact
--     lifecycle policy (infra/main.bicep targets the traces/ and run- prefixes).
--   • SUCCESS traces  -> ONE "last known good" baseline per monitor at the STABLE, OVERWRITE key
--     success-latest/check-<id>.zip. That prefix is DELIBERATELY OUTSIDE the lifecycle purge, so a
--     monitor that passes for 90d straight does NOT lose its only baseline. Overwritten (not
--     accumulated) on each success, so it never grows.
--
-- These columns record that baseline's blob URL + when it was last refreshed (success_trace_at also
-- THROTTLES re-upload so a healthy 5-min monitor doesn't re-upload a multi-MB trace every tick).
--
-- New installs converge from db/schema.sql.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0039_success_trace.sql  (IDEMPOTENT).

BEGIN;

ALTER TABLE checks ADD COLUMN IF NOT EXISTS success_trace_url text;
ALTER TABLE checks ADD COLUMN IF NOT EXISTS success_trace_at  timestamptz;

COMMIT;
