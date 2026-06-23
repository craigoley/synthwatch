-- Migration 0020 — locations registry (multi-location assignment MODEL, 4-MLACT step 1).
--
-- The check_locations cursor table (#68) IS the assignment: a check runs from the
-- locations that have a check_locations row. This adds the REGISTRY of deployed
-- regions — what locations exist, which are active, and what a new check defaults to
-- (one cursor per ACTIVE location). The dashboard's future location-selector reads
-- this registry for its options.
--
-- Today only 'default' is active (the live single region). centralus/eastus2 are NOT
-- added here — this is the model, not a second region.
--
-- BACKWARD-COMPAT: every existing check is explicitly assigned to each active location.
-- Today active = {'default'} and every check already has a 'default' cursor (#68
-- backfill), so this is a NO-OP on the live single region — ON CONFLICT DO NOTHING
-- preserves existing cursors (cadence not reset). It just makes the assignment explicit
-- + idempotent and establishes the default-to-active pattern.
--
-- NOTE (reported in the PR): "rows = assignment" is not yet ENFORCED in the claim loop
-- — claim() still lazy-inserts a cursor for any location it runs in (#68), which is how
-- a new check currently gets its 'default' cursor. Enforcing "only run assigned
-- locations" (findDueChecks INNER JOIN + claim UPDATE-only) must land AFTER the API
-- create-path seeds cursors, else a freshly-created check (no cursor yet) would never
-- run. That enforcement is a later 4-MLACT step; this migration is the model + registry.
--
-- New installs converge from db/schema.sql. Apply with the migrate flow
-- (db/migrate.sh) or:  psql "$DATABASE_URL" -f db/migrations/0020_location_registry.sql
--
-- IDEMPOTENT: CREATE TABLE IF NOT EXISTS + ON CONFLICT DO NOTHING + guarded GRANT.

BEGIN;

CREATE TABLE IF NOT EXISTS locations (
    name       text        PRIMARY KEY,
    enabled    boolean     NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- The live single region. NO second region yet (model only).
INSERT INTO locations (name, enabled) VALUES ('default', true)
ON CONFLICT (name) DO NOTHING;

-- Assign every check to each ACTIVE location (default-to-active). Idempotent; existing
-- cursors are preserved so the live 'default' cadence is untouched.
INSERT INTO check_locations (check_id, location)
SELECT c.id, l.name FROM checks c CROSS JOIN locations l WHERE l.enabled
ON CONFLICT (check_id, location) DO NOTHING;

-- The API MI manages the registry + assignments (mirrors the existing grant pattern;
-- guarded so it's safe on a fresh DB / the Testcontainers snapshot with no MI role).
DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synthwatch-api') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON locations TO "synthwatch-api";
    END IF;
END
$grant$;

COMMIT;
