-- Migration 0007 — structured cert days-remaining on runs.
--
-- SSL checks already record days-until-expiry, but only as prose in
-- runs.error_message (forcing the dashboard to parse a string; the API correctly
-- refused). Add a structured column the runner populates on ssl runs so consumers
-- read a number, not a parsed message.
--
-- ADDITIVE / expand-contract-safe: a new nullable column. NULL for non-ssl runs
-- and for ssl runs where no cert was obtained (invalid URL / no cert / timeout /
-- connect error). The deployed runner (which ignores the column) keeps working;
-- error_message is unchanged (the prose stays).
--
-- New installs converge from db/schema.sql. Apply with the migrate flow
-- (db/migrate.sh) or:  psql "$DATABASE_URL" -f db/migrations/0007_cert_days_remaining.sql
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS.

BEGIN;

-- Signed days relative to the cert's notAfter, for kind='ssl' runs:
--   positive = days until expiry, negative = days PAST expiry (EXPIRED), 0 = today.
-- NULL = not an ssl run, or no cert was obtained.
ALTER TABLE runs
    ADD COLUMN IF NOT EXISTS cert_days_remaining INTEGER;

COMMIT;
