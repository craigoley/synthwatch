-- Migration 0067 — checks.login_credentials: per-monitor LOGIN CREDENTIALS, references-only.
--
-- Extends the checks.secret_headers / checks.auth *_env references-only model (0061) to LOGIN CREDENTIALS.
-- Stores { credentialRole -> ENV_VAR_NAME } (e.g. { "username": "B2C_TEST_USER", "password": "B2C_TEST_PASS" }):
-- the runner resolves process.env[ENV_VAR_NAME] at RUN time and exposes the value to the browser spec via
-- credential(role) (runner/loginCredentials.ts + specShim.ts). The stored map is NON-secret (role names +
-- env-var names); the resolved VALUE is never persisted/logged/traced, and the api DTO maps only the
-- reference names (audit #219). A login monitor thus declares its cred refs per-monitor (manifest) instead
-- of hardcoding env-var names in the spec.
--
-- DEFAULT NULL → every existing monitor is unchanged (no login creds). New installs converge from
-- db/schema.sql. Transactional (BEGIN/COMMIT), NOT a CONCURRENTLY index migration. Idempotent (IF NOT EXISTS).
--
-- ★ SHARED TABLE: `checks` is mapped by synthwatch-api. This column REDS the api schema-parity gate until a
-- companion api PR adds `login_credentials` to tests/fixtures/schema.sql (+ reconcile mapping + DTO ref-names).
-- Apply: psql "$DATABASE_URL" -f db/migrations/0067_checks_login_credentials.sql

BEGIN;

ALTER TABLE checks ADD COLUMN IF NOT EXISTS login_credentials JSONB;

COMMIT;
