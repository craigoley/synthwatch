-- Migration 0072 — checks.removed_at: the GIT-REMOVAL purge clock (R5-P2).
--
-- R5-P1 (0071) added archived_at: a REVERSIBLE, DASHBOARD-owned archive (indefinite, reconcile never
-- touches it). This is its opposite lifecycle: GIT-DRIVEN REMOVAL. When a check's manifest entry is
-- DELETED from monitors.json, reconcile already soft-disables it (enabled=false, never a hard delete) —
-- but sets NO timestamp, so a git-removed check is indistinguishable from a pause and never purges.
--
-- removed_at is the fix: NULL = the source_key IS in the manifest (present in git). A timestamp = the
-- source_key is ABSENT from the manifest (git-removed) — the 90-day purge clock is running.
--
-- ★ RECONCILE-LIFECYCLE-OWNED (the exact OPPOSITE of archived_at). reconcile is its WRITER: an auto-sync
-- (reconcile.removedAtUpdates, mirroring the redtest_anchor scoped sync) stamps removed_at=now() the first
-- time a managed check's id is absent from the manifest, and CLEARS it (→ NULL, purge cancelled) the moment
-- the id returns. Idempotent: re-runs never reset the clock (set only WHERE removed_at IS NULL). archived_at
-- is dashboard-owned and reconcile must never touch it; removed_at is the reconcile-owned counterpart.
--
-- The daily retention job HARD-DELETES a check whose removed_at < now()-90d — but DEFERS (skips) any check
-- whose runs are still pinned by an incident (incidents.opened_run_id/resolved_run_id → runs is RESTRICT;
-- the delete would BOTH lose MTTR history AND be blocked by the FK). So an incident-pinned removed check is
-- preserved until its incidents age out — the incident-preservation invariant.
--
-- checks is a SHARED table (synthwatch-api maps it): the api schema-parity gate (fixture schema.sql +
-- EF Check.cs) MUST add removed_at in the paired api PR, or that gate fails BY DESIGN.
--
-- NO GRANT: removed_at is runner/reconcile-written (the api never sets it — removal is git-driven, not a
-- user action); the api only SELECTs it (covered by the existing table-level grant) to render "pending purge".
--
-- DEFAULT NULL (present in git). New installs converge from db/schema.sql. Idempotent (IF NOT EXISTS). BEGIN/COMMIT.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0072_checks_removed_at.sql

BEGIN;

ALTER TABLE checks ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;

COMMIT;
