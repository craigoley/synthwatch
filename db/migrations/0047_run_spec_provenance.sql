-- Migration 0047 — runs.spec_provenance: per-run spec-load forensics.
--
-- THE INVESTIGATION INSTRUMENT. A #138 runner executed the meals2go spec WITHOUT instrumentation that
-- is provably present in spec_cache.compiled_js — and we couldn't see WHY because the spec-load path
-- emits no queryable telemetry. This records, per run, EXACTLY which spec the run loaded, from where,
-- whether it re-fetched, and a fingerprint of the bytes it ACTUALLY executed — so "is it running the
-- spec I think?" is forensically answerable via psql.
--
-- spec_provenance JSONB shape (browser spec_path runs; null for http/baked-in flows):
--   { spec_path, origin, resolved_etag, cache_fetched_at, executed_sha256, executed_len, has_preclick }
--   • origin            = cache-304 | compiled-200 | fallback-last-good (re-fetched vs reused + why)
--   • resolved_etag     = the version identity the runner resolved (a commit SHA since #138)
--   • cache_fetched_at  = the spec_cache.fetched_at the run saw
--   • executed_sha256   = ★ DECISIVE — sha256 of the compiled_js that loadCompiledSpec actually executed.
--                         Compare to encode(digest(spec_cache.compiled_js,'sha256'),'hex') to PROVE
--                         whether the run executed the cache's code or something else.
--   • has_preclick      = convenience marker for the current meals2go investigation.
--
-- Additive + nullable + idempotent — no existing behavior changes. New installs converge from schema.sql.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0047_run_spec_provenance.sql

BEGIN;

ALTER TABLE runs ADD COLUMN IF NOT EXISTS spec_provenance JSONB;

COMMIT;
