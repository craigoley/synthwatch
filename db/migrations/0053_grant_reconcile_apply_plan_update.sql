-- Migration 0053 — grant the API MI UPDATE on reconcile_apply_plan (the approve/reject/apply 500 fix).
--
-- ★ ROOT CAUSE (live 500 on POST /api/reconcile/approve): 0051 created reconcile_apply_plan with NO explicit
-- GRANT, so the `synthwatch-api` MI role got only SELECT (via default privileges). The approve/reject handlers
-- (and the apply executor) do `UPDATE reconcile_apply_plan SET status/decided_at/decided_by` (and apply sets
-- status='applied', applied_at) — which hit "permission denied for table reconcile_apply_plan" → an unhandled
-- 500, and the UPDATE never commits (the plan stays 'pending', so NOTHING was applied — a safe failure).
--   The SELECT path (GET /reconcile/plan, and the read in approve) worked, which is why it compiled + the GET
--   surface looked fine. This is the recurring "table created, API grant missed" dismiss-500 class.
--
-- The API only READS + UPDATES these rows (the runner computes/inserts/deletes plans), so UPDATE is the minimal
-- missing grant — no INSERT/DELETE. Idempotent + role-guarded (safe on a fresh DB / the Testcontainers snapshot).
-- Apply: psql "$DATABASE_URL" -f db/migrations/0053_grant_reconcile_apply_plan_update.sql

BEGIN;

-- Guarded so it's safe on a fresh DB / the Testcontainers snapshot with no MI role (mirrors the existing pattern).
DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synthwatch-api') THEN
        GRANT SELECT, UPDATE ON reconcile_apply_plan TO "synthwatch-api";
    END IF;
END
$grant$;

COMMIT;
