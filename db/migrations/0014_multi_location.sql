-- Migration 0014 — multi-location support.
--
-- The same runner image runs in 2-3 regions; each regional runner stamps its
-- SYNTHWATCH_LOCATION onto every run it writes (runs.location). Each location
-- writes its OWN run row (we want to SEE "ok from eastus2, failing from westus",
-- not a merged verdict). The runner then opens an incident only when the check is
-- failing from >= N DISTINCT locations (see runner/evaluate.ts) — a single
-- regional blip is recorded + visible but does NOT page.
--
-- ADDITIVE / single-location-safe:
--   * runs.location is nullable with DEFAULT 'default'; existing rows are
--     backfilled to 'default'. The primary runner with no SYNTHWATCH_LOCATION set
--     keeps writing 'default' -> ONE location -> N=1 -> exactly today's behaviour.
--   * checks.min_fail_locations (nullable) optionally overrides N per check; NULL
--     uses the default rule (>=2 when >=2 locations are active, else 1).
--
-- New installs converge from db/schema.sql. Apply with the migrate flow
-- (db/migrate.sh) or:  psql "$DATABASE_URL" -f db/migrations/0014_multi_location.sql
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS + a backfill that only touches NULLs.

BEGIN;

ALTER TABLE runs ADD COLUMN IF NOT EXISTS location TEXT;
UPDATE runs SET location = 'default' WHERE location IS NULL;
ALTER TABLE runs ALTER COLUMN location SET DEFAULT 'default';

-- Per-check override of the "down from >= N locations" threshold. NULL => default
-- rule in evaluate.ts (>=2 when >=2 locations are active, else 1).
ALTER TABLE checks ADD COLUMN IF NOT EXISTS min_fail_locations INTEGER;

COMMIT;
