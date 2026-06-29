-- Migration 0046 — B10 trace redaction: per-monitor `sensitive` flag + declared `redact_patterns`.
--
-- A `sensitive` monitor (cart/auth flows whose trace can carry session tokens, cart contents, or
-- account PII) opts into redaction: the runner SKIPS the success-trace baseline zip + the failure
-- trace zip, omits screenshots from the RCA AI call (and doesn't store them), scrubs trace_signals
-- (network URLs + console) via a built-in token denylist + these declared patterns, and genericises
-- error_message. See runner/index.ts + traceSignals.ts + rca.ts. Reconcile sets both from the
-- monitors-as-code manifest (GitOps).
--
-- Additive + idempotent. DEFAULT false → every existing (non-sensitive) monitor is byte-for-byte
-- unchanged. redact_patterns: a JSONB array of regex strings the monitor declares; NULL = none (the
-- built-in denylist still applies for sensitive monitors). New installs converge from db/schema.sql.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0046_sensitive_trace_redaction.sql

BEGIN;

ALTER TABLE checks ADD COLUMN IF NOT EXISTS sensitive       BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE checks ADD COLUMN IF NOT EXISTS redact_patterns JSONB;

COMMIT;
