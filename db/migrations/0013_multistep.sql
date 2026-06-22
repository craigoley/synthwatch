-- Migration 0013 — multistep API chains.
--
-- A new check kind, 'multistep', whose config is an ordered JSONB array of HTTP
-- steps. Each step is a request (method/url/headers/body/auth — the SAME shape a
-- single http check already uses) + per-step assertions (the SAME assertion
-- model) + extract rules ([{var, jsonPath}]) that pull values from the response
-- into named variables. Later steps inject prior vars via {{var}} templates in
-- their url/headers/body, and cookies carry forward — so a login chain
-- (POST creds -> extract token -> use as Bearer -> assert) is expressible
-- WITHOUT a browser. See runner/multistep.ts. Each step records a run_steps row
-- (reusing the existing funnel telemetry).
--
-- ADDITIVE / expand-contract-safe: widening the kind CHECK only ALLOWS a new
-- value (the deployed runner is unaffected), and steps is a new nullable column.
--
-- New installs converge from db/schema.sql. Apply with the migrate flow
-- (db/migrate.sh) or:  psql "$DATABASE_URL" -f db/migrations/0013_multistep.sql
--
-- IDEMPOTENT: DROP CONSTRAINT IF EXISTS + ADD, and ADD COLUMN IF NOT EXISTS.

BEGIN;

ALTER TABLE checks DROP CONSTRAINT IF EXISTS checks_kind_check;
ALTER TABLE checks ADD  CONSTRAINT checks_kind_check
    CHECK (kind IN ('http', 'browser', 'ssl', 'dns', 'tcp', 'ping', 'multistep'));

-- Ordered step chain for kind='multistep'. Each element:
--   { name, method, url, headers?, body?, auth?, assertions?, extract? }
-- where url/headers/body may contain {{var}} templates, auth is a secret-ref
-- (the *_env model — never plaintext credentials), assertions reuse the
-- assertion model, and extract = [{ "var": "...", "jsonPath": "$.a.b" }].
ALTER TABLE checks ADD COLUMN IF NOT EXISTS steps JSONB;

COMMIT;
