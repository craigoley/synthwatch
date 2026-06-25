-- Migration 0034 — spec_cache: the durable runtime-spec cache (Phase 6b Option C, slice 3).
--
-- WHY POSTGRES (not in-process): the runner is a SCHEDULED ACA job — it cold-starts every 5 min
-- and exits, so an in-process cache is useless across ticks. The cache MUST be durable shared
-- state (like flow_manifest / reconcile_drift), which also lets eastus2 + centralus share one
-- warmed cache.
--
-- THE FLOW (specfetch/specCache.ts): per due Option-C check, conditional-GET the raw spec with
-- If-None-Match: etag. 304 -> reuse compiled_js (no recompile). 200 -> esbuild-compile, upsert
-- {etag, source_sha, compiled_js, fetched_at} AND set last_good_compiled_js/last_good_at to the
-- just-compiled output.
--
-- ★ last_good_* are POPULATED here (slice 3) but only READ in slice 4: on a fetch FAILURE,
-- slice 4 falls back to last_good_compiled_js so a transient GitHub blip never false-fails a
-- monitor. This slice leaves the fetch-error path as a clean seam (it propagates); the columns
-- exist now so slice 4 has a fallback to read.
--
--   spec_path             — PK; the manifest script path (also checks.spec_path).
--   etag                  — last raw ETag, for the next conditional GET (change-detection).
--   source_sha            — sha256 of the fetched source (content fingerprint; observability).
--   compiled_js           — the current esbuild output (loaded via specfetch's shim to run).
--   fetched_at            — when we last fetched/compiled.
--   last_good_compiled_js — last KNOWN-GOOD compile (slice-4 fallback source).
--   last_good_at          — when last_good was set.
--
-- New installs converge from db/schema.sql.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0034_spec_cache.sql  (IDEMPOTENT).

BEGIN;

CREATE TABLE IF NOT EXISTS spec_cache (
    spec_path             text        PRIMARY KEY,
    etag                  text,
    source_sha            text,
    compiled_js           text        NOT NULL,
    fetched_at            timestamptz NOT NULL DEFAULT now(),
    last_good_compiled_js text,
    last_good_at          timestamptz
);

-- The runner connects as the API MI in some envs; mirror the existing grant pattern so the
-- runner/reconcile can read+write the cache.
DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synthwatch-api') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON spec_cache TO "synthwatch-api";
    END IF;
END
$grant$;

COMMIT;
