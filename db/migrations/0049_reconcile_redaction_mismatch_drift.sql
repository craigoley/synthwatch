-- Migration 0049 — reconcile_drift: add the 'redaction_mismatch' drift_type (B10 audit trail).
--
-- Closes the B10 DETECTION loop. #144 made reconcile read sensitive/redact_patterns, surface a
-- divergence, and auto-correct it (b10FieldUpdates). But the divergence was lumped into the generic
-- 'changed' drift_type alongside name/kind/target_url/flow_name — so "manifest declares sensitive but
-- the live check doesn't" (the exact B10 leak shape) wasn't distinctly queryable on /reconcile/drift.
--
-- This adds a DEDICATED 'redaction_mismatch' drift_type. computeDrift now emits a separate row for a
-- sensitive/redact_patterns divergence; since #144 also auto-corrects it on the same run, the row is the
-- AUDIT TRAIL of "this check was redaction-misconfigured and got corrected" (valuable B10 history).
--
-- Detection/audit ONLY — no change to the #144 apply behaviour. The /reconcile/drift endpoint is a
-- pass-through SELECT (drift_type re-emitted verbatim), so the new type surfaces with no API change.
--
-- Additive + idempotent: existing 'new'/'changed'/'missing'/'orphan' rows are unaffected; the unnamed
-- inline CHECK from 0031 is auto-named reconcile_drift_drift_type_check (confirmed in the live DB).
-- New installs converge from db/schema.sql.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0049_reconcile_redaction_mismatch_drift.sql

BEGIN;

ALTER TABLE reconcile_drift DROP CONSTRAINT IF EXISTS reconcile_drift_drift_type_check;

ALTER TABLE reconcile_drift
    ADD CONSTRAINT reconcile_drift_drift_type_check
    CHECK (drift_type IN ('new', 'changed', 'missing', 'orphan', 'redaction_mismatch'));

COMMIT;
