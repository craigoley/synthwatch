-- Migration 0068 — model B: checks.secret_headers / checks.login_credentials now store ENCRYPTED VALUES.
--
-- SEMANTICS SHIFT (no DDL / no data change): the columns keep their JSONB { key -> string } shape, but the
-- leaf STRING changes meaning from an ENV_VAR_NAME reference (0061/0067, the ref model) to CIPHERTEXT
-- ("v1:…", CredCrypto v1 = base64(IV‖ct‖tag), AES-256-GCM). The api ENCRYPTS the value on write (editor-
-- gated, write-only DTO); the runner DECRYPTS at run time with CRED_ENC_KEY (crypto.ts). This migration only
-- re-documents the contract at the DB level (COMMENT ON COLUMN) — the interpretation lives in the runner +
-- api code, and new values arrive via the write endpoint.
--
-- ★ NO DATA REWRITE ON PURPOSE. Any pre-existing REF-NAME leaf (e.g. b2c's { username: 'B2C_TEST_USER' }) is
-- NOT "v1:" ciphertext, so the runner's decrypt FAILS CLOSED — that monitor errors until its encrypted values
-- are re-seeded via the editor/write-endpoint (b2c: migration Step D). Fail-closed is the correct signal; we
-- do NOT NULL the legacy data blindly (and login_credentials was never populated by reconcile — recon #235).
--
-- Idempotent (COMMENT is declarative). Transactional. Apply:
--   psql "$DATABASE_URL" -f db/migrations/0068_cred_value_semantics.sql

BEGIN;

COMMENT ON COLUMN checks.secret_headers IS
  'Model B: { headerName -> CIPHERTEXT ("v1:…", CredCrypto v1) }. api encrypts on write; runner decrypts per run + injects per first-party request. WRITE-ONLY (read DTO masked). Fail-closed on decrypt. Value never logged/traced (#219).';

COMMENT ON COLUMN checks.login_credentials IS
  'Model B: { credentialRole -> CIPHERTEXT ("v1:…", CredCrypto v1) }. api encrypts on write; runner decrypts at run time -> SW_CRED_<ROLE> -> spec credential(role). WRITE-ONLY (read DTO masked). Fail-closed on decrypt; a legacy ref-name errors until re-seeded. Value never logged/traced (#219).';

COMMIT;
