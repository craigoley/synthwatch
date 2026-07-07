-- Migration 0060 — checks.rewrite_from_origin (pre-prod-regression arc S3 wiring; recon docs/recon/2026-07-07-preprod-arc-scope.md).
--
-- The FROM origin for the S2 runtime host-rewrite (#212). A pre-prod check reuses a PROD spec whose
-- page.goto() hardcodes the prod origin; the runner rewrites requests from THIS origin to the check's
-- own target_url origin (the preview env) at the route layer. Stored per-check because the prod origin
-- a spec hardcodes is not derivable from a pre-prod check's target_url (which is already the preview).
--
-- NULL (the default, and every existing/prod check) = NO rewrite → S2 stays inert (byte-identical to
-- today). Only a deliberately-set value re-points a check. No CHECK constraint: it's a free origin
-- string validated in code (runner compileHostRewrite fail-louds on a malformed origin, refusing the run
-- rather than silently running the spec against its hardcoded prod host — a false-green).
--
-- Git-managed: reconcile treats rewrite_from_origin (+ environment, 0059) as GIT_AUTHORITATIVE, so the
-- monitors manifest is the source of truth. No new grant (checks is already API-SELECT-readable; a new
-- column inherits the table's grants). New installs converge from db/schema.sql. BEGIN/COMMIT.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0060_checks_rewrite_from_origin.sql

BEGIN;

ALTER TABLE checks ADD COLUMN IF NOT EXISTS rewrite_from_origin text;

COMMIT;
