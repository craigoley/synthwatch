-- Migration 0008 — no-code assertion model + request config for http checks.
--
-- Today http checks assert only status + body-contains. This adds the data model
-- for rich assertions (status / response_time / header / body / json_path / size)
-- and request config (custom headers, body, auth). The runner half (generic
-- evaluator + request sending) lands in this PR; the API/dashboard surfaces that
-- edit these are follow-ups deriving from this contract.
--
-- ADDITIVE / expand-contract-safe: new columns only. `assertions` defaults to an
-- empty array, and the runner treats "empty" as "evaluate the legacy
-- expected_status/body_must_contain" — so existing checks behave identically and
-- the deployed runner (which ignores these columns) keeps working.
--
-- New installs converge from db/schema.sql. Apply with the migrate flow
-- (db/migrate.sh) or:  psql "$DATABASE_URL" -f db/migrations/0008_assertions.sql
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS.
--
-- SECURITY: auth credentials are NOT stored here in plaintext. `auth` holds a
-- SECRET REFERENCE — the NAME of a runner env var holding the token/password
-- (token_env / password_env / value_env); the runner resolves the value from the
-- environment at request time. Never put a real token in a checks row.

BEGIN;

-- assertions: JSONB array. Each element:
--   { "source":     "status"|"response_time"|"header"|"body"|"json_path"|"size",
--     "comparison": "eq"|"ne"|"lt"|"gt"|"gte"|"lte"|"contains"|"not_contains"
--                   |"matches"|"exists"|"one_of",
--     "target":     "<header name | JSONPath expr>",   -- when applicable
--     "expected":   <value | array for one_of> }
-- Empty array => evaluate legacy expected_status (+ body_must_contain), unchanged.
ALTER TABLE checks ADD COLUMN IF NOT EXISTS assertions JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Request config (all nullable; only meaningful for http checks).
-- request_headers: JSONB object { "Header-Name": "value", ... }
ALTER TABLE checks ADD COLUMN IF NOT EXISTS request_headers JSONB;
-- request_body: raw body string (sent for non-GET/HEAD methods when present).
ALTER TABLE checks ADD COLUMN IF NOT EXISTS request_body TEXT;
-- auth: JSONB secret-REFERENCE (no plaintext credentials). Shapes:
--   {"type":"none"}
--   {"type":"bearer","token_env":"ENV_NAME"}
--   {"type":"basic","username":"u","password_env":"ENV_NAME"}
--   {"type":"api_key","header":"X-API-Key","value_env":"ENV_NAME"}
ALTER TABLE checks ADD COLUMN IF NOT EXISTS auth JSONB;

COMMIT;
