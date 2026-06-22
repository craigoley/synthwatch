-- Migration 0009 — flow_manifest: the source of truth for available browser flows.
--
-- The dashboard's flow picker currently reads "SELECT DISTINCT flow_name FROM
-- checks" — so a flow only appears once a check already uses it. This table is
-- populated by the runner (it discovers its own flow modules at tick start and
-- upserts here), so flows show up the moment they're deployed. The API/dashboard
-- read this table instead.
--
-- ADDITIVE / expand-contract-safe: a new table. The deployed runner that doesn't
-- write it leaves it empty (harmless); the new runner fills it on its first tick.
--
-- New installs converge from db/schema.sql. Apply with the migrate flow
-- (db/migrate.sh) or:  psql "$DATABASE_URL" -f db/migrations/0009_flow_manifest.sql
--
-- IDEMPOTENT: CREATE TABLE IF NOT EXISTS.

BEGIN;

CREATE TABLE IF NOT EXISTS flow_manifest (
    name           TEXT        PRIMARY KEY,   -- the flow module name (= checks.flow_name)
    description    TEXT,                       -- optional, from the flow's exported meta
    entry_url_hint TEXT,                       -- optional suggested target_url
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
