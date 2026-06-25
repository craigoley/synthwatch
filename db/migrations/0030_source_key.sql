-- Migration 0030 — checks.source_key: the monitors-as-code identity (Phase 6b).
--
-- The synthwatch-monitors repo (manifest.json) defines browser monitors as code, each
-- with a STABLE `id` (e.g. 'wegmans-search-product'). This column binds a live `checks`
-- row to that manifest id so the reconcile job (runner/reconcile.ts) can upsert by a
-- stable key instead of guessing from name/flow_name (which deliberately differ — the
-- manifest id is NOT the runner flow_name).
--
-- THE "MANAGED BY CODE" FLAG, FOR FREE:
--   source_key IS NULL  => dashboard/seed-created; reconcile ignores it entirely.
--   source_key IS NOT NULL => Git-managed; reconcile owns its Git-authoritative fields.
-- A partial unique index (WHERE source_key IS NOT NULL) enforces one check per manifest
-- id without forcing the many NULL (unmanaged) rows to collide.
--
-- SOURCE-OF-TRUTH SPLIT (enforced in code, not here — this is just the identity column):
--   Git-authoritative (reconcile overwrites): name, kind, target_url, flow_name.
--   Git-seeds-then-dashboard-owns (INSERT only): interval_seconds, enabled.
--   Dashboard-only (reconcile never writes): severity, thresholds, routing, tags, locations.
--
-- This PR is REPORT-ONLY: nothing writes source_key automatically yet. The one-time
-- backfill (db/ops/backfill_source_key.sql) adopts existing checks under their manifest id
-- AFTER a human confirms the mapping. The reconcile job only DETECTS drift this PR.
--
-- New installs converge from db/schema.sql.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0030_source_key.sql  (IDEMPOTENT).

BEGIN;

ALTER TABLE checks ADD COLUMN IF NOT EXISTS source_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS checks_source_key_uniq
    ON checks (source_key) WHERE source_key IS NOT NULL;

COMMIT;
