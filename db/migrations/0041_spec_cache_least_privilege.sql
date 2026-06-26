-- Migration 0041 — spec_cache least-privilege: REVOKE the API role's WRITE on spec_cache.
--
-- SECURITY (defense-in-depth). spec_cache.compiled_js is esbuild output that the runner LOADS AND
-- EXECUTES at runner privilege on a cache hit, WITHOUT re-validation (specfetch/specCache.ts). The
-- only thing standing between "untrusted code" and "executed code" is the synthwatch-monitors merge
-- gate. But 0034 granted INSERT/UPDATE/DELETE on spec_cache to the `synthwatch-api` role — which the
-- API never uses (no API code touches spec_cache). That write grant is a MERGE-GATE BYPASS: anything
-- that can write as the API role (an API-process compromise / SQLi) could poison compiled_js -> RCE on
-- the runner without merging a malicious spec. Remove it.
--
-- ★ CONFIRMED prod role model (separate, not shared): the RUNNER family of jobs connects as the
-- Postgres ADMIN `synthadmin` (password auth in DATABASE_URL — infra/main.bicep), which OWNS spec_cache;
-- the API connects as the limited `synthwatch-api` managed-identity role. So this REVOKE does NOT touch
-- the runner (owner privileges are intrinsic, not grant-based — verified: synthadmin keeps write) and
-- does NOT break the API (it has zero spec_cache code, and no inherited path to the table — verified).
-- The 0034 "runner connects as the API MI in some envs" note is about non-prod/legacy wiring; prod runner
-- is admin.
--
-- SCOPE: only the WRITE privileges that enable poisoning (INSERT/UPDATE/DELETE) are revoked. SELECT is
-- ALSO unused by the API and could be revoked for full least-privilege, but is left to keep this change
-- surgically scoped to the RCE surface (read does not enable poisoning).
--
-- IDEMPOTENT: REVOKE of a privilege not held is a no-op (no error); role-guarded like 0034's GRANT.
-- ROLLBACK (if ever needed): re-run 0034's GRANT block (GRANT SELECT,INSERT,UPDATE,DELETE ON spec_cache
-- TO "synthwatch-api";). Not expected — the API never used these grants.
--
-- New installs converge from db/schema.sql (which never granted spec_cache to the API).
-- Apply: psql "$DATABASE_URL" -f db/migrations/0041_spec_cache_least_privilege.sql  (IDEMPOTENT).

BEGIN;

DO $revoke$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synthwatch-api') THEN
        -- The runner (owner: synthadmin) is unaffected; the API never reads/writes spec_cache.
        REVOKE INSERT, UPDATE, DELETE ON spec_cache FROM "synthwatch-api";
    END IF;
END
$revoke$;

COMMIT;
