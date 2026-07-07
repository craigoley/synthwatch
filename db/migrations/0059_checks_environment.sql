-- Migration 0059 — checks.environment (pre-prod-regression arc S1a; recon docs/recon/2026-07-07-preprod-arc-scope.md).
--
-- Labels which environment a monitor targets. DEFAULT 'prod' backfills EVERY existing check into the
-- prod fleet, so this migration is a metadata-only no-op on behavior: nothing changes until a check is
-- deliberately set environment != 'prod' (S3, the first pre-prod check). Adding a NOT NULL column with a
-- constant DEFAULT is a catalog-only change in Postgres 11+ (no table rewrite).
--
-- ★ WHY A COLUMN, NOT A TAG: the report aggregations filter check_tags INCLUDE-only
-- (key||':'||value = ANY({tags}) HAVING count = cardinality); there is no default-EXCLUDE-by-tag path,
-- so a tag can't make "prod-only" the default. A first-class column that each fleet rollup opts out of
-- with coalesce(environment,'prod')='prod' is the sound model. The CHECK pins the vocabulary so a typo
-- ('Staging') can't silently fall out of the prod fleet (!= 'prod') without being a valid pre-prod env.
--
-- ★ THIS IS THE GATE FOR S3: the default-EXCLUDE must be live in the readers BEFORE any check is set
-- non-prod, or a pre-prod check pollutes every prod rollup (SLO budget, MTTR, trust). `checks` is a
-- SHARED table, so this REDS synthwatch-api's schema-parity gate — its fixture bump + the slo/mttr/trust
-- exclude ship in the SAME deploy window (synthwatch-api PR feat/env-default-exclude).
--
-- No new grant: `checks` is already API-SELECT-readable; a new column inherits the table's grants.
-- New installs converge from db/schema.sql. Idempotent (IF NOT EXISTS). BEGIN/COMMIT.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0059_checks_environment.sql

BEGIN;

ALTER TABLE checks ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT 'prod'
    CONSTRAINT checks_environment_vocab CHECK (environment IN ('prod', 'staging', 'dev'));

COMMIT;
