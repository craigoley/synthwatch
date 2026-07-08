-- Migration 0061 — checks.secret_headers (per-monitor SECRET request headers, references-only).
--
-- A monitor sometimes needs a request header whose VALUE is a secret (an API key, a signed token) that
-- must NEVER be extractable — unlike checks.request_headers (JSONB), whose values are plaintext and
-- exposed in the API DTO. This mirrors checks.auth's `*_env` model: store only a REFERENCE — a map of
-- { headerName -> ENV_VAR_NAME } — and resolve process.env[ENV_VAR_NAME] at REQUEST time (runner/
-- secretHeaders.ts). The stored map is non-secret (header names + env-var names); the resolved value is
-- a request header only: never persisted, never logged, never in a DTO, never in trace_signals (the
-- trace extractor captures no request headers — security-invariants audit #219).
--
-- SECRET-PROVISIONING CEILING (honest limit): each ENV_VAR_NAME must be an ACA job env var (like
-- VERCEL_BYPASS_TOKEN) — there is no per-monitor secret vault. Adding a monitor secret = a bicep/ACA
-- secret addition, not a self-service field.
--
-- DB-only for now (mirrors request_headers/auth — neither is manifest-declarable; #214). The reference
-- NAME is not a secret, so it COULD be manifest-declarable later, but that would make it Git-authoritative
-- (the reconcile field-split), out of scope here. Shape validated in code, not by a CHECK (a free
-- header-name -> env-var-name map). NULL = none. No new grant (checks is API-SELECT-readable; the api
-- deliberately does NOT map this column, so its values are never read/exposed).
-- New installs converge from db/schema.sql. BEGIN/COMMIT.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0061_checks_secret_headers.sql

BEGIN;

ALTER TABLE checks ADD COLUMN IF NOT EXISTS secret_headers jsonb;

COMMIT;
