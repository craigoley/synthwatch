-- Migration 0056 — deploys: auto-detected deploy markers (deploy-markers v1).
--
-- The runner extracts a deploy-identity marker from the response it ALREADY fetches each run (see
-- runner/deployMarker.ts — a CURATED ladder: sentry-release SHA > build-id meta > Next buildId > etag; NO
-- per-request-volatile values, the false-positive guard). A marker CHANGE = a deploy. This table records one
-- row per (host, distinct marker) — so the dashboard can overlay ReferenceLines on the time-series charts.
--
-- ★ Per-HOST dedup is enforced by UNIQUE (target_host, fingerprint): the SAME marker seen from N regions / M
-- checks hitting one host is ONE deploy row, not N×M — and an UNCHANGED marker re-inserts nothing (ON CONFLICT
-- DO NOTHING), which also makes the concurrent-insert race (3 regions, same tick) safe with no advisory lock.
-- deployed_at is FIRST-SEEN (honest ≈, cadence-bounded — not the real deploy instant, which we can't know).
--
-- Additive; new installs converge from db/schema.sql. Apply: psql "$DATABASE_URL" -f db/migrations/0056_deploys.sql

BEGIN;

CREATE TABLE IF NOT EXISTS deploys (
    id           bigserial   PRIMARY KEY,
    -- Host of the check's target_url (the join key — check_tags has no per-service tag). A deploy is per-HOST.
    target_host  text        NOT NULL,
    -- The commit SHA when the marker is a real git sha (is_sha); NULL for etag / build-id markers.
    sha          text,
    -- The raw marker value (sha | build-id | etag). The dedup key with target_host.
    fingerprint  text        NOT NULL,
    is_sha       boolean     NOT NULL DEFAULT false,
    -- Which ladder rung produced it: 'sentry-release' | 'meta:<name>' | 'next-build-id' | 'etag'.
    source       text        NOT NULL,
    -- FIRST-SEEN ≈ deploy time (honest; the real instant is unknowable without pipeline access).
    deployed_at  timestamptz NOT NULL DEFAULT now(),
    detected_at  timestamptz NOT NULL DEFAULT now(),
    detail       jsonb,
    -- ★ per-host dedup: one row per distinct marker per host (N regions × M checks → 1 row; unchanged → 0).
    CONSTRAINT deploys_host_fingerprint_key UNIQUE (target_host, fingerprint)
);

-- The chart-overlay query is "a host's deploys, newest first, in a window" → index it.
CREATE INDEX IF NOT EXISTS deploys_host_time_idx ON deploys (target_host, deployed_at DESC);

-- The API reads deploys for the chart overlay (GET /reports/deploys). Guarded so the migration is safe on a
-- fresh DB / the Testcontainers snapshot that has no synthwatch-api role. (The runner owns the table → writes.)
DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synthwatch-api') THEN
        GRANT SELECT ON deploys TO "synthwatch-api";
    END IF;
END
$grant$;

COMMIT;
