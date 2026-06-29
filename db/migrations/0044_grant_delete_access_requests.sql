-- Migration 0044 — grant the API role DELETE on access_requests (the missing privilege behind the
-- DELETE /api/access-requests/{email} 500).
--
-- ROOT CAUSE (confirmed from the prod App Insights exception + role_table_grants): 0037_auth.sql granted
-- `SELECT, INSERT, DELETE` on editors but only `SELECT, INSERT` on access_requests — the DELETE was simply
-- omitted. EditorsFunctions.DismissAccessRequest does `_db.AccessRequests.Where(...).ExecuteDeleteAsync()`
-- → DELETE FROM access_requests → Npgsql 42501 "permission denied for table access_requests" for the
-- synthwatch-api role. The C# is correct; the executing ROLE just lacked the privilege (integration tests
-- pass because the test role owns the table → implicit all-privs). Same grant-model class as 0041/spec_cache.
--
-- ★ AUDIT — other tables (this bug class — table created, API grant missed — tends to recur): every table the
-- API DELETEs (channels, checks, editors, alert_routes, tag_routes) ALREADY has DELETE; there are no
-- ExecuteUpdateAsync calls (so no UPDATE-grant gap); every INSERT/SELECT it does is granted. So this DELETE
-- on access_requests is the ONLY gap. No sibling fix needed.
--
-- New installs: the auth-table grants live in migrations only (db/schema.sql's snapshot has no MI role), so
-- there's nothing to change in schema.sql.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0044_grant_delete_access_requests.sql  (IDEMPOTENT — GRANT of
-- an already-held privilege is a no-op; role-guarded like 0037, so it's a no-op if the role doesn't exist).

BEGIN;

DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synthwatch-api') THEN
        GRANT DELETE ON access_requests TO "synthwatch-api";
    END IF;
END
$grant$;

COMMIT;
