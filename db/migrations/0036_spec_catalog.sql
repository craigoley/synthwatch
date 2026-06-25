-- Migration 0036 — spec_catalog: the manifest-snapshot inventory (Phase 13, read-only catalog).
--
-- The dashboard's spec catalog ("every monitor Git declares + its coverage/runnable state") needs to
-- enumerate EVERY manifest spec, not just the ones that drift. reconcile_drift only holds drifting rows
-- (new/changed/missing/orphan), and an ACTIVE spec has no drift row — so it can't back the catalog. The
-- manifest itself lives only on GitHub (the runner fetches it each reconcile); the API reads runner-owned
-- TABLES, never GitHub. So the reconcile job writes a full snapshot of the manifest here each run, and the
-- API serves GET /api/specs by reading this table LEFT JOIN checks (coverage) — mirroring how it already
-- reads reconcile_drift / report_narratives.
--
-- The reconcile pass ALREADY fetches+validates the manifest AND probes every spec for runnability
-- (probeSpecsFromPool, which also warms spec_cache). This table denormalizes that probe result
-- (runnable + not_runnable_reason) alongside the manifest's suggested defaults, so the catalog's
-- "Runnable?" column is a plain column read — no second probe, no GitHub call from the API.
--
-- FULL RELOAD each run (DELETE + re-INSERT in one txn, like reconcile_drift): always the latest snapshot,
-- no stale rows, readers never see a partial set. One row per manifest monitor, keyed by source_key (=
-- manifest id). READ-ONLY inventory — this table is never applied to `checks` (activation is a later PR).
--
-- New installs converge from db/schema.sql.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0036_spec_catalog.sql  (IDEMPOTENT).

BEGIN;

CREATE TABLE IF NOT EXISTS spec_catalog (
    source_key                 text        PRIMARY KEY,           -- manifest id
    name                       text        NOT NULL,
    spec_path                  text        NOT NULL,              -- manifest script (monitors/.../*.spec.ts)
    kind                       text        NOT NULL,              -- 'browser'
    target                     text,                             -- suggested target url (nullable)
    suggested_interval_seconds integer,                          -- suggestedIntervalSeconds (nullable)
    tags                       jsonb       NOT NULL DEFAULT '[]'::jsonb,
    description                text,
    enabled_by_default         boolean     NOT NULL DEFAULT false,
    runnable                   boolean     NOT NULL,              -- probe: fetchable+compilable from main
    not_runnable_reason        text,                             -- when NOT runnable: why (404 / won't compile)
    probed_at                  timestamptz NOT NULL DEFAULT now()
);

-- The API serves the catalog ("what specs exist + their state") by reading this table. The reconcile
-- job WRITES it; both connect as the synthwatch-api principal (mirrors reconcile_drift's grant).
DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synthwatch-api') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON spec_catalog TO "synthwatch-api";
    END IF;
END
$grant$;

COMMIT;
