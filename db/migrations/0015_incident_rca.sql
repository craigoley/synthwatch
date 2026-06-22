-- Migration 0015 — AI root-cause analysis on incidents.
--
-- When a failure OPENS an incident and RCA is configured (AZURE_OPENAI_ENDPOINT +
-- deployment), the runner asks an Azure-hosted model to CLASSIFY + explain the
-- failure (real-outage / flaky-transient / selector-drift / environment-regional /
-- perf-regression) with a confidence level and an observed-vs-inferred honesty
-- structure. The result is stored here as structured JSON the dashboard renders.
--
-- ADDITIVE / non-fatal: one nullable JSONB column. NULL when RCA is off (the
-- default), when the model/network failed (RCA never blocks incident-open), or for
-- pre-existing incidents. Storing structured JSON (not prose in summary) lets the
-- dashboard render the class + confidence and gate how it's surfaced.
--
-- New installs converge from db/schema.sql. Apply with the migrate flow
-- (db/migrate.sh) or:  psql "$DATABASE_URL" -f db/migrations/0015_incident_rca.sql
--
-- Shape: { classification, confidence, observed[], inferred[], summary, signature,
--          model, cached, generated_at }  (see runner/rca.ts).
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS.

BEGIN;

ALTER TABLE incidents ADD COLUMN IF NOT EXISTS rca JSONB;

COMMIT;
