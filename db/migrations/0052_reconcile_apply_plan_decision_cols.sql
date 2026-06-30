-- Migration 0052 — reconcile_apply_plan decision/audit columns (reconcile-apply Phase 1).
--
-- Phase 1 wires approve/reject/APPLY (the first thing that writes live monitor config). The plan rows
-- (0051) gain who-decided + when-applied so the decision is auditable and an applied plan is timestamped:
--   decided_at / decided_by — set when a human approves or rejects (the audit-log carries the rich record;
--                             these are the at-a-glance columns on the row itself).
--   applied_at              — set when the apply executor committed the plan's statements.
-- All nullable (a freshly-computed 'pending' plan has none). Additive; new installs converge from schema.sql.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0052_reconcile_apply_plan_decision_cols.sql

BEGIN;

ALTER TABLE reconcile_apply_plan ADD COLUMN IF NOT EXISTS decided_at  timestamptz;
ALTER TABLE reconcile_apply_plan ADD COLUMN IF NOT EXISTS decided_by  text;
ALTER TABLE reconcile_apply_plan ADD COLUMN IF NOT EXISTS applied_at  timestamptz;

COMMIT;
