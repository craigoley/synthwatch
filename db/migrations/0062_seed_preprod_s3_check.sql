-- Migration 0062 — SEED the S3 pre-prod check (unblock the pre-prod-regression arc).
--
-- Ground truth (write-gate recon #220 + audit #217, Craig's psql): monitors #54 DECLARES environment +
-- rewrite_from_origin for `wegmans-search-product-preview`, but they never landed in the DB — the
-- reconcile field-split apply is GATED OFF, and no dashboard/api path writes these columns, so all 33
-- checks read environment='prod' / rewrite_from_origin=NULL. This seeds the ONE S3 check to the values
-- monitors #54 declares, writing DIRECTLY (which also dodges the #216 positional-materialize bug — this
-- does NOT go through the broken apply path).
--
-- ★ SURVIVE-RECONCILE (load-bearing): environment + rewrite_from_origin are GIT_AUTHORITATIVE, so the
-- manifest is their durable source — a value that DIVERGES from the manifest is drift and gets reset on
-- the next apply. These seed values are BYTE-IDENTICAL to monitors #54:
--     environment          = 'staging'                     (== #54)
--     rewrite_from_origin  = 'https://www.wegmans.com'      (== #54; no trailing slash, exact scheme/case)
-- so computeDrift sees existing == manifest → NO 'changed' drift → reconcile leaves this row alone.
-- (If they differed by even a byte, the seed would be clobbered — verified against origin/main's manifest.)
--
-- ★ Scoped + idempotent: WHERE source_key = the ONE #54 key AND environment='prod' — touches exactly this
-- check, never the other 32; a re-run (already 'staging') matches nothing → no-op. On a fresh install the
-- row doesn't exist yet → 0 rows updated → harmless no-op (schema.sql is unchanged; this is data-only).
--
-- Does NOT touch the reconcile gate or the #216 materialize path (that is the separate #216 fix).
-- Apply: psql "$DATABASE_URL" -f db/migrations/0062_seed_preprod_s3_check.sql

BEGIN;

UPDATE checks
   SET environment         = 'staging',
       rewrite_from_origin = 'https://www.wegmans.com'
 WHERE source_key = 'wegmans-search-product-preview'
   AND environment = 'prod';

COMMIT;
