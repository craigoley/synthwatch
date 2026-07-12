-- Migration 0075 — grant the API role INSERT/UPDATE/DELETE on env_domain_map (env PR-3 map CRUD).
--
-- PR-2 (0073) created env_domain_map + granted the API SELECT (the read endpoint). PR-3 adds the management
-- page: POST/PUT/DELETE /api/env-domain-map to create/edit/remove domain→env rules. That needs write grants.
--
-- env_domain_map is DASHBOARD-MANAGED config, exactly like check_tags (0024: the API has full CRUD). It is
-- NOT RCE-sensitive — contrast spec_cache (0041), whose compiled_js executes at RUNNER privilege and is
-- therefore API-write-REVOKED. A domain→env rule is inert data the runner only READS to infer an env label,
-- so granting the API write is safe (mirrors the check_tags grant model).
--
-- The api's grant-coverage gate (required-grants.json `writes` + scripts/check-pg-grant-coverage.mjs) is
-- patched to list env_domain_map in the paired api PR; that gate parses THIS migration's GRANT to satisfy the
-- requirement (runner owns the grants), so the runner migration must be merged for the api gate to pass.
--
-- IDEMPOTENT: guarded GRANT (mirrors 0024). BEGIN/COMMIT.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0075_env_domain_map_api_write_grant.sql

BEGIN;

DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synthwatch-api') THEN
        -- INSERT/UPDATE/DELETE on the table. The id is `GENERATED ALWAYS AS IDENTITY` — Postgres allocates it
        -- from the table's OWN identity sequence internally, so the inserting role needs NO separate sequence
        -- USAGE grant (unlike a `serial` default). Table INSERT privilege is sufficient.
        GRANT INSERT, UPDATE, DELETE ON env_domain_map TO "synthwatch-api";
    END IF;
END
$grant$;

COMMIT;
