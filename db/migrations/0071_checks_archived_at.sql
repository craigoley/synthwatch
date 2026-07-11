-- Migration 0071 — checks.archived_at: REVERSIBLE, dashboard-owned ARCHIVE (distinct from pause).
--
-- Craig wants to ARCHIVE monitors he no longer wants to run WITHOUT losing them: the monitor stops
-- running, shows "archived" in the dashboard + catalog, and can be RE-ACTIVATED later (data retained).
-- This is distinct from PAUSE (enabled=false, a dashboard PATCH): archive is a SEPARATE column so
-- re-activation restores the EXACT prior enabled/paused state (clearing archived_at doesn't touch enabled).
--
-- NULL = active (the default → every existing check is unarchived, unchanged). A timestamp = archived
-- (when). The runner's due-loop + on-demand gates add `archived_at IS NULL` so an archived check is never
-- claimed (sandbox validation may still run — mirrors the paused precedent, 0064).
--
-- ★ DASHBOARD-OWNED / SURVIVES RECONCILE: archived_at is in NEITHER reconcile.GIT_AUTHORITATIVE_COLUMNS
-- NOR SEED_ONLY_COLUMNS, so a manifest apply NEVER writes it — the same "invisible to reconcile" guarantee
-- as tags/severity/locations. A git-authoritative field would get clobbered every apply; a dashboard-owned
-- one survives. (reconcile.test.ts asserts archived_at is absent from both allow-lists.)
--
-- ★ NO GRANT NEEDED: the synthwatch-api role holds a table-level checks INSERT/UPDATE/DELETE grant
-- (infra required-grants.json), which covers a new column. archived_at is a benign lifecycle flag (NOT
-- RCE-sensitive like spec_cache/0041), so the API is allowed to set/clear it via PUT /checks/{id}/archive.
--
-- checks is a SHARED table (synthwatch-api maps it): the api's schema-parity gate (fixture schema.sql +
-- EF Check.cs) MUST add archived_at in the same/immediately-following api PR, or that gate fails BY DESIGN.
--
-- DEFAULT NULL (active). New installs converge from db/schema.sql. Idempotent (IF NOT EXISTS). BEGIN/COMMIT.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0071_checks_archived_at.sql

BEGIN;

ALTER TABLE checks ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

COMMIT;
