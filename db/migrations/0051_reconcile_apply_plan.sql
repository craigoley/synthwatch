-- Migration 0051 — reconcile_apply_plan: the DRY-RUN apply plan (reconcile-apply Phase 0).
--
-- Per ANALYSIS-reconcile-apply-design-2026-06-30.md §(b)(4): reconcile computes, per drift row, the EXACT
-- statement(s) apply WOULD run (buildApplyUpsert SQL+values, the location assignment, the soft-disable) and
-- persists them HERE — read-only, NOTHING is applied to checks/check_locations this phase. A SEPARATE table
-- (not a column on reconcile_drift) because reconcile_drift is full-reloaded every run; the plan — and, in
-- Phase 1, its approve/reject/apply state — must SURVIVE that reload, keyed by (source_key, drift_type).
--
-- status (Phase 0 writes pending|auto|blocked|noop; approved|rejected|applied are reserved for Phase 1 so
-- that gate needs no migration):
--   pending  — actionable, will need a human approval in Phase 1 (new / changed / missing).
--   auto     — redaction_mismatch: already auto-applied by #144 b10FieldUpdates; informational only.
--   blocked  — a forbidden change (a redaction STRIP, sensitive true->false): reconcile may NEVER do it.
--   noop     — nothing to apply (orphan: the spec isn't fetchable/compilable).
--
-- plan jsonb: { summary, disposition, statements:[{purpose,text,values?,regions?}], blockedReason? }.
-- Idempotent: reconcile upserts on (source_key, drift_type) and deletes plans whose drift resolved.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0051_reconcile_apply_plan.sql

BEGIN;

CREATE TABLE IF NOT EXISTS reconcile_apply_plan (
    id          bigserial   PRIMARY KEY,
    source_key  text        NOT NULL,
    drift_type  text        NOT NULL
                            CHECK (drift_type IN ('new', 'changed', 'missing', 'orphan', 'redaction_mismatch')),
    status      text        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'auto', 'blocked', 'noop',
                                              'approved', 'rejected', 'applied')),
    plan        jsonb       NOT NULL DEFAULT '{}'::jsonb,
    computed_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source_key, drift_type)
);

COMMIT;
