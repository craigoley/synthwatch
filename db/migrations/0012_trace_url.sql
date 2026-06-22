-- Migration 0012 — Playwright trace reference on failed browser runs.
--
-- On a FAILED browser run the runner captures a Playwright trace (screenshots +
-- snapshots), uploads the trace.zip to Blob storage, and records a reference here
-- so a failure can be debugged by scrubbing the real trace (npx playwright
-- show-trace). The API serving a download/SAS URL + the dashboard "View trace"
-- link are follow-ups.
--
-- ADDITIVE / expand-contract-safe: one nullable column. NULL for passing runs,
-- non-browser runs, and runs where capture/upload failed (non-fatal). The blob
-- itself lives in Blob storage, NOT the DB (a 1-50MB zip is not a DB row).
--
-- New installs converge from db/schema.sql. Apply with the migrate flow
-- (db/migrate.sh) or:  psql "$DATABASE_URL" -f db/migrations/0012_trace_url.sql
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS.

BEGIN;

-- Blob URL of the captured Playwright trace.zip for a failed browser run.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS trace_url TEXT;

COMMIT;
