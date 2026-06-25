-- Migration 0035 — runs.status += 'infra_error' (Phase 6b Option C, slice 5: live wiring).
--
-- A Git-managed browser check now FETCHES its Playwright spec from synthwatch-monitors at run
-- start (executeBrowser -> getCompiledSpec). When the runner cannot obtain the spec at all
-- (fetch failed AND no last-known-good cached — the #104 nightmare), the run is recorded as
-- 'infra_error': the check could not RUN. ★ This is categorically NOT a monitored-site outage,
-- so it must be NEITHER up nor down:
--   - PAGING: evaluate.ts short-circuits 'infra_error' (no incident, no alert) and the
--     cross-location verdict excludes it (status NOT IN ('running','infra_error')).
--   - SLA/availability: sla_availability() + daily_check_rollup partition with EXPLICIT lists
--     (up=pass|warn, down=fail|error, completed=those four) — a 5th status is auto-excluded
--     from up, down, and completed. So an infra_error run does NOT move availability, exactly
--     like 'running'. rollup.ts also excludes it from row selection (NOT IN running/infra_error).
-- It IS recorded + visible (a distinct state: "couldn't fetch spec"), so the operator sees the
-- fetch path is failing WITHOUT being paged.
--
-- This migration only widens the runs.status CHECK so the runner can WRITE the status; the
-- exclusion from paging/SLA is in code + the explicit-list SQL (no view change needed).
--
-- New installs converge from db/schema.sql.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0035_infra_error_status.sql  (IDEMPOTENT).

BEGIN;

ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_status_check;
ALTER TABLE runs ADD CONSTRAINT runs_status_check
    CHECK (status IN ('pass', 'warn', 'fail', 'error', 'infra_error', 'running'));

COMMIT;
