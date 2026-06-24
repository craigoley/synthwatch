-- Migration 0027 — "RCA ready" enrichment: fire-once guard column.
--
-- The OPEN alert pages FAST, before RCA runs (so a slow model never delays a Sev-1 page).
-- ~10-30s later, once runRca completes IN THE SAME runner execution, the runner sends a
-- SECOND notification — "RCA ready: likely <verdict> (<confidence>)" — to the SAME
-- channels that got the open page (an enrichment of the EXISTING incident, not a new one).
--
-- rca_notified_at guards it to fire AT MOST ONCE per incident: the enrichment is sent only
-- when a conditional `UPDATE incidents SET rca_notified_at = now() WHERE id = $1 AND
-- rca_notified_at IS NULL RETURNING id` claims the row (atomic -> race-safe across runner
-- executions; a reopen / a second run never re-sends). See runner/evaluate.ts.
--
-- New installs converge from db/schema.sql.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0027_rca_notified.sql  (IDEMPOTENT).

BEGIN;

ALTER TABLE incidents ADD COLUMN IF NOT EXISTS rca_notified_at timestamptz;

COMMIT;
