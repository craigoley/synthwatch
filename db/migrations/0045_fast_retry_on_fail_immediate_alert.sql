-- Migration 0045 — two-knob separation (Phase 4-MLACT, Option B): page on the FIRST CONFIRMED
-- failure (seconds) instead of after 3 consecutive scheduled ticks (up to 45 min).
--
-- The two knobs are SEPARATE mechanisms (runner code unchanged in shape, only defaults here):
--   • retries           = in-run fast-retry. Now retries 'error' OR 'fail' (retry.ts) — confirms a
--                         failure within ONE run (seconds). DEFAULT 1 -> 2 (3 attempts; Datadog default).
--   • failure_threshold = consecutive-SCHEDULED-down debounce. DEFAULT 3 -> 1 — once the in-run retries
--                         have CONFIRMED the failure, open the incident immediately. >1 stays available
--                         as an OPTIONAL debounce for intentionally-noisy monitors.
--
-- ★★ DECISION — new-default vs backfill (the recon flagged this; Craig's go/no-go):
--   (1) ALTER COLUMN … SET DEFAULT — applies to NEW checks only. Always safe.
--   (2) The two UPDATEs BACKFILL existing rows that are STILL AT THE OLD DEFAULTS (retries=1,
--       failure_threshold=3). Rows with a DELIBERATE custom value (e.g. failure_threshold=5 for a
--       noisy monitor, retries=0 to disable) are UNTOUCHED. This is what actually fixes the delay for
--       the monitors we've been watching (meals2go etc. sit at the default 3).
--   ★ Effect of the backfill: every monitor currently at the default will fast-retry-on-fail ×2 and
--     PAGE ON THE FIRST CONFIRMED failure. The ×2 retry absorbs transients; a genuinely-down monitor
--     pages in seconds, not 45 min. If you'd rather roll defaults forward WITHOUT changing existing
--     monitors' behavior, DELETE the two UPDATE statements before deploy — the SET DEFAULTs alone are
--     safe and only affect newly-created checks.
--
-- New installs converge from db/schema.sql. Idempotent (SET DEFAULT is; the UPDATEs are surgical to the
-- old-default value, so a re-run is a no-op once migrated). BEGIN/COMMIT.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0045_fast_retry_on_fail_immediate_alert.sql

BEGIN;

-- (1) New defaults for new checks.
ALTER TABLE checks ALTER COLUMN retries SET DEFAULT 2;            -- was 1
ALTER TABLE checks ALTER COLUMN failure_threshold SET DEFAULT 1; -- was 3

-- (2) Backfill rows STILL at the old defaults (deliberate custom values untouched). ★ Drop these two
--     lines before deploy to leave existing monitors on the old slow behavior.
UPDATE checks SET retries = 2           WHERE retries = 1;
UPDATE checks SET failure_threshold = 1 WHERE failure_threshold = 3;

COMMIT;
