-- Migration 0005 — SSL/TLS certificate-expiry checks.
--
-- Adds a third check kind, 'ssl': a declarative cert-expiry check (no Playwright)
-- that reads the leaf certificate over a TLS handshake and maps days-until-expiry
-- to the run-status taxonomy. ADDITIVE / expand-contract-safe: widening the kind
-- CHECK only ALLOWS a new value, and the new column has a default, so the
-- currently-deployed runner keeps working unchanged.
--
-- New installs get the same end state from db/schema.sql (the two converge).
-- Apply with the migrate flow (db/migrate.sh) or:
--   psql "$DATABASE_URL" -f db/migrations/0005_ssl_checks.sql
--
-- IDEMPOTENT: DROP CONSTRAINT IF EXISTS + ADD, and ADD COLUMN IF NOT EXISTS.

BEGIN;

-- Allow kind = 'ssl' alongside 'http' and 'browser'.
ALTER TABLE checks DROP CONSTRAINT IF EXISTS checks_kind_check;
ALTER TABLE checks ADD  CONSTRAINT checks_kind_check
    CHECK (kind IN ('http', 'browser', 'ssl'));

-- Threshold (days) for "expiring soon" -> warn. Only meaningful for ssl checks;
-- harmless on http/browser rows. A cert valid for more than this many days passes;
-- within this window it warns; expired/invalid fails; unreachable errors.
ALTER TABLE checks
    ADD COLUMN IF NOT EXISTS cert_expiry_warn_days INTEGER NOT NULL DEFAULT 30;

COMMIT;
