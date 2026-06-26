-- Migration 0040 — per-run trace SIGNALS (compact, filtered summary of a run's Playwright trace).
--
-- The runner extracts a few-hundred-token JSON from a run's trace zip AT CAPTURE TIME (while the zip is in
-- hand — no 18 MB re-download) and stores it here: network waterfall summary (failed/slowest/largest/
-- uncompressed + third-party footprint) + the real site console errors (extension noise filtered, capped at
-- 40). Same extraction + shape as the API's TraceExtractor (one schema for trace-diff + ai-insights).
--
-- nullable: null = no trace this run (pass without baseline-refresh, non-browser), or extraction failed
-- (non-fatal — a bad zip never fails the run). Written for ANY traced run (success baseline AND failure).
-- No index yet — read by run id (the PK) for trace-diff; not a hot filter.
--
-- New installs converge from db/schema.sql.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0040_trace_signals.sql  (IDEMPOTENT).

BEGIN;

ALTER TABLE runs ADD COLUMN IF NOT EXISTS trace_signals jsonb;

COMMIT;
