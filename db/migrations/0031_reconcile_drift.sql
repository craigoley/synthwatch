-- Migration 0031 — reconcile_drift: the monitors-as-code drift surface (Phase 6b).
--
-- The reconcile job (runner/reconcileMain.ts) reads synthwatch-monitors' manifest.json and
-- compares it to live `checks`, READ-ONLY. It writes what DIFFERS here; it applies NOTHING
-- to config this PR (detect-first posture, mirroring RCA's "page, don't silently act").
-- A later PR flips on apply; this table stays the audit/dashboard surface either way.
--
-- DRIFT TYPES (one row per (source_key, drift_type) — a monitor can be both new AND orphan):
--   new      — a manifest id with no live check. Apply WOULD insert it.
--   changed  — a Git-managed check whose Git-authoritative fields (name/kind/target_url/
--              flow_name) differ from the manifest. Apply WOULD overwrite those fields only
--              (interval/enabled/severity/tags/locations are never touched — see 0030).
--   missing  — a Git-managed check whose manifest id is GONE from the manifest. Apply WOULD
--              soft-disable it (enabled=false), NEVER hard-delete (it carries history).
--   orphan   — a manifest id whose bound flow_name has no compiled runner module. "Git
--              defines a monitor the runner can't run yet" — the browser-exec gap (spec
--              execution is deferred to a later phase; the manifest's .spec.ts isn't run).
--
-- Each reconcile run UPSERTs the current drift set and DELETEs stale rows (a (source_key,
-- drift_type) that no longer drifts), so the table is always the latest snapshot. detail is
-- JSONB so a 'changed' row can carry the per-field before/after diff.
--
-- New installs converge from db/schema.sql.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0031_reconcile_drift.sql  (IDEMPOTENT).

BEGIN;

CREATE TABLE IF NOT EXISTS reconcile_drift (
    source_key  text        NOT NULL,
    drift_type  text        NOT NULL
                            CHECK (drift_type IN ('new', 'changed', 'missing', 'orphan')),
    detail      jsonb       NOT NULL DEFAULT '{}'::jsonb,
    detected_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (source_key, drift_type)
);

-- The API/dashboard surface drift ("N monitors differ from Git") by reading this table.
DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synthwatch-api') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON reconcile_drift TO "synthwatch-api";
    END IF;
END
$grant$;

COMMIT;
