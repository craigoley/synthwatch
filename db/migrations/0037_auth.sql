-- Migration 0037 — auth identity tables (Phase 12, slice 1: identity plumbing).
--
-- Dashboard auth is API-FIRST: the C# API is the security boundary (it enforces authz on writes —
-- slice 2). These four tables are logically API-OWNED (only the API reads/writes them; the runner
-- never touches them), but they live here because the runner owns the schema + the migrate-on-deploy
-- pipeline, so this is the one path that creates tables. SLICE 1 is purely additive: it mints/verifies
-- OTP sessions + records access requests; NOTHING is enforced yet (existing writes stay open until
-- slice 2 adds the AuthorizationMiddleware). audit_log is also slice 2 — not here.
--
--   otp_codes       — emailed 6-digit login codes (sha256-hashed, ~10-min expiry, one-time, attempt-capped).
--   sessions        — opaque bearer tokens (sha256-hashed; the raw token is shown to the client once).
--   editors         — the admin-managed editor allowlist (admins come from the API's ADMIN_EMAILS setting).
--   access_requests — enumeration-safe "request edit access" ledger (rate-limit + admin visibility).
--
-- New installs converge from db/schema.sql.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0037_auth.sql  (IDEMPOTENT).

BEGIN;

-- Emailed login codes. The raw 6-digit code is NEVER stored — only sha256(code), so a DB leak can't
-- replay a live code. consumed_at = one-time use; attempt_count caps brute-force on verify.
CREATE TABLE IF NOT EXISTS otp_codes (
    id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email         text        NOT NULL,
    code_hash     text        NOT NULL,
    expires_at    timestamptz NOT NULL,
    consumed_at   timestamptz,
    attempt_count integer     NOT NULL DEFAULT 0,
    request_ip    text,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- Newest-unconsumed lookup on verify + the per-email request rate-limit both scan by (email, created_at).
CREATE INDEX IF NOT EXISTS otp_codes_email_created_idx ON otp_codes (email, created_at);

-- Opaque bearer sessions. token_hash = sha256(raw token); the raw token (swt_…) is returned to the
-- client once at verify and never persisted. revoked_at = logout / admin revoke. Verified per write
-- in slice 2 by hashing the bearer + this lookup.
CREATE TABLE IF NOT EXISTS sessions (
    id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    token_hash   text        NOT NULL UNIQUE,
    email        text        NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    expires_at   timestamptz NOT NULL,
    revoked_at   timestamptz,
    issued_ip    text
);

-- token_hash is UNIQUE (implicit index) — the per-request session lookup rides it.

-- The editor allowlist (admin-managed; slice 3 adds the management endpoints). Admins are NOT here —
-- they come from the API's ADMIN_EMAILS app setting (env-based so they can't be locked out by a DB edit).
CREATE TABLE IF NOT EXISTS editors (
    email    text        PRIMARY KEY,
    added_by text        NOT NULL,
    added_at timestamptz NOT NULL DEFAULT now()
);

-- Enumeration-safe "request edit access" ledger. The endpoint always returns the same response, so this
-- table — not the response — is where an admin sees who asked. Also the per-email/IP rate-limit ledger.
CREATE TABLE IF NOT EXISTS access_requests (
    id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email        text        NOT NULL,
    requested_at timestamptz NOT NULL DEFAULT now(),
    request_ip   text
);

CREATE INDEX IF NOT EXISTS access_requests_email_requested_idx ON access_requests (email, requested_at);

-- The API MI is the ONLY principal that touches these. otp_codes/sessions need full DML (insert codes,
-- mark consumed/attempts, mint/revoke sessions, bump last_used_at); editors needs read now + manage in
-- slice 3; access_requests is insert + read. The runner connects as the admin role and never reads these.
-- (Identity columns don't need a separate sequence grant — INSERT covers GENERATED ALWAYS AS IDENTITY.)
DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synthwatch-api') THEN
        GRANT SELECT, INSERT, UPDATE ON otp_codes       TO "synthwatch-api";
        GRANT SELECT, INSERT, UPDATE ON sessions        TO "synthwatch-api";
        GRANT SELECT, INSERT, DELETE ON editors         TO "synthwatch-api";
        GRANT SELECT, INSERT         ON access_requests TO "synthwatch-api";
    END IF;
END
$grant$;

COMMIT;
