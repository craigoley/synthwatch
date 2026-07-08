-- Migration 0064 — run_requests.sandbox (on-demand run for a PAUSED monitor).
--
-- On-demand "Run now" today refuses a paused (enabled=false) check: the API 409s, and both runner claim
-- paths (drainRunRequests JOIN + forceClaim) filter `AND c.enabled`, so a disabled check can never be
-- claimed. This column lets ONE request opt into a SANDBOX run of a paused monitor: the runner claims +
-- runs it out-of-band, writes a visible runs row + trace (so it's inspectable), but SKIPS evaluate()
-- (no incident / alert / SLO side-effects) and NEVER flips checks.enabled. Immediate use: validate the S3
-- check (wegmans-search-product-preview) + B2C (wegmans-b2c-login-test), both enabled=false, WITHOUT
-- turning them on.
--
-- ★ DEFAULT false = today's behavior byte-identical: a normal on-demand/cron request is NOT a sandbox
-- run, so the `AND c.enabled` gates still reject a disabled check for it. Only a sandbox-flagged request
-- bypasses (the runner's filter becomes `c.enabled OR rr.sandbox`). The flag is per-REQUEST (transient
-- queue row), NOT a check property — it never touches GIT_AUTHORITATIVE / the reconcile-apply plan tuple,
-- so the #216 positional trap cannot recur here.
--
-- The API (synthwatch-api) sets sandbox=true on the run_requests INSERT when POST /checks/{id}/run
-- carries ?sandbox=true; the runner honors it. ★ APPLY THIS BEFORE the API's sandbox write-path deploys
-- (a normal request omits the column → DEFAULT false → safe even pre-migration; only a sandbox INSERT
-- needs the column). New installs converge from db/schema.sql. Idempotent add. No new grant (same table).
-- Apply: psql "$DATABASE_URL" -f db/migrations/0064_run_requests_sandbox.sql

BEGIN;

ALTER TABLE run_requests
  ADD COLUMN IF NOT EXISTS sandbox BOOLEAN NOT NULL DEFAULT false;

COMMIT;
