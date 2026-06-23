-- Migration 0017 — most-recent-passing browser screenshot baseline.
--
-- RCA's visual diff (selector-drift: "your monitor broke" vs "the site broke")
-- needs a known-good baseline to compare the failure screenshot against. Today
-- screenshots are captured only on FAILURE, so the baseline was almost always
-- absent. The runner now captures a screenshot on a PASSING browser run, stores it
-- to Blob at a STABLE per-check key (overwritten each pass — most-recent-passing,
-- not history, so one object per check / no unbounded growth), and records the URL
-- here. rca.ts reads checks.baseline_screenshot_url and feeds it to the vision call.
--
-- ADDITIVE: one nullable column. NULL = no baseline yet (browser checks before
-- their first pass, and all non-browser checks). Non-fatal capture — never set on a
-- run that didn't pass.
--
-- New installs converge from db/schema.sql. Apply with the migrate flow
-- (db/migrate.sh) or:  psql "$DATABASE_URL" -f db/migrations/0017_baseline_screenshot.sql
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS.

BEGIN;

ALTER TABLE checks ADD COLUMN IF NOT EXISTS baseline_screenshot_url TEXT;

COMMIT;
