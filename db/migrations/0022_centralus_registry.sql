-- Migration 0022 — bring centralus into the locations registry (multi-location activation).
--
-- ADDITIVE + SAFE TO AUTO-RUN: adds the centralus region to the registry and backfills a
-- centralus check_locations cursor (last_run_at NULL = due-now, the assignment-model
-- pattern) for EVERY check, so every check is now assigned to {existing-region, centralus}.
-- It does NOT touch the existing region's cursors/runs and does NOT enforce the claim
-- loop — the existing runner keeps claiming only its own $LOCATION, so the centralus
-- cursors sit UNCLAIMED until the centralus ACA job is deployed. Harmless until then.
--
-- NOTE — the 'default' -> 'eastus2' RELABEL is deliberately NOT here. Relabeling is
-- coupled to the existing job's SYNTHWATCH_LOCATION env (if the DB relabels but the job
-- still runs as 'default', its lazy-insert re-creates 'default' cursors) — so it must
-- land WITH the env-switch at cutover. It lives in db/ops/relabel_default_to_eastus2.sql
-- (a coordinated operational step, race-safe), NOT in an auto-applied migration.
--
-- New installs converge from db/schema.sql (which seeds the generic single-region
-- 'default' — a fresh install is one region; centralus is THIS stack's activation, not
-- a schema default, so schema.sql is unchanged). Data-only, no DDL => no snapshot drift.
--
-- Apply with the migrate flow (db/migrate.sh) or:
--   psql "$DATABASE_URL" -f db/migrations/0022_centralus_registry.sql
--
-- IDEMPOTENT: ON CONFLICT DO NOTHING throughout.

BEGIN;

INSERT INTO locations (name, enabled) VALUES ('centralus', true)
ON CONFLICT (name) DO NOTHING;

-- Assign every check to centralus (NULL last_run_at = due on the centralus runner's
-- first tick). Existing cursors are untouched.
INSERT INTO check_locations (check_id, location)
SELECT id, 'centralus' FROM checks
ON CONFLICT (check_id, location) DO NOTHING;

COMMIT;
