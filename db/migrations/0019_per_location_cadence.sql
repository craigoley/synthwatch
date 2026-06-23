-- Migration 0019 — per-location cadence (multi-location was inert).
--
-- findDueChecks()/claim() keyed "due" + claim on a single GLOBAL checks.last_run_at,
-- so a second region pointed at the same Postgres never claimed: one location won
-- every tick and the others got nothing ($LOCATION was label-only on the run row).
-- Verified live (region B's claim -> 0 rows after A) + by history (every run was
-- location='default'; no check ever recorded >1 location).
--
-- Fix: a per-(check, location) cadence cursor. Each region runner claims ONLY its
-- own $LOCATION, UPSERTing its own row — so each region paces itself independently
-- with no global active-location list / cross-region coordination.
--
-- BACKWARD-COMPAT: backfill a 'default' cursor per check from the current global
-- checks.last_run_at, so the existing single-location ('default') runner continues
-- its cadence seamlessly (no immediate re-run burst at deploy). checks.last_run_at
-- is KEPT (expand-contract; still mirror-updated on claim) — just no longer the gate.
--
-- New installs converge from db/schema.sql. Apply with the migrate flow
-- (db/migrate.sh) or:  psql "$DATABASE_URL" -f db/migrations/0019_per_location_cadence.sql
--
-- IDEMPOTENT: CREATE TABLE IF NOT EXISTS + ON CONFLICT DO NOTHING backfill + guarded GRANT.

BEGIN;

CREATE TABLE IF NOT EXISTS check_locations (
    check_id    bigint      NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
    location    text        NOT NULL,
    last_run_at timestamptz,
    PRIMARY KEY (check_id, location)
);

-- Seed the 'default' cursor = the current global last_run_at, so the live 'default'
-- runner's next tick is paced exactly as before (not "everything due at once").
INSERT INTO check_locations (check_id, location, last_run_at)
SELECT id, 'default', last_run_at FROM checks
ON CONFLICT (check_id, location) DO NOTHING;

-- The runner connects as the API MI in some envs; mirror the existing grant pattern
-- (guarded so it's safe on a fresh DB / the Testcontainers snapshot with no MI role).
DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synthwatch-api') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON check_locations TO "synthwatch-api";
    END IF;
END
$grant$;

COMMIT;
