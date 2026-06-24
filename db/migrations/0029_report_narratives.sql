-- Migration 0029 — report_narratives: Reporting Layer 3 ("Smart Reports") keystone.
--
-- A PRECOMPUTED AI narrative over the reporting data, built by a scheduled runner job
-- (runner/narrative.ts + narrativeMain.ts, mirroring the rollup job). Design:
-- FACT-PACK-THEN-NARRATE — facts/deltas/anomalies are computed DETERMINISTICALLY in code
-- (additive availability from the rollup; percentiles recomputed from raw per #88); the
-- model ONLY narrates the structured fact_pack (cite-only, change-first), with a
-- deterministic template fallback if it returns filler/off-shape. fact_pack is stored for
-- provenance + so the dashboard can show cited numbers alongside the prose.
--
-- Opt-in on AZURE_OPENAI_* (same as RCA): absent => Layer 3 off, the job no-ops, zero cost.
-- Upserted each run (idempotent overwrite, like the rollup). v1 scopes: fleet + per-monitor
-- (per-tag deferred). API/dashboard are separate PRs (read-only consumers of this table).
--
-- NOTE: "window" is a Postgres RESERVED word (the WINDOW clause), so the column is quoted
-- here and in every query (runner/narrative.ts).
--
-- New installs converge from db/schema.sql.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0029_report_narratives.sql  (IDEMPOTENT).

BEGIN;

CREATE TABLE IF NOT EXISTS report_narratives (
    scope_type   text        NOT NULL CHECK (scope_type IN ('fleet', 'monitor')),
    scope_key    text        NOT NULL,  -- '' for fleet; check_id::text for a monitor
    "window"     text        NOT NULL,  -- e.g. '7d'
    generated_at timestamptz NOT NULL DEFAULT now(),
    headline     text,
    body         text,
    highlights   jsonb       NOT NULL DEFAULT '[]'::jsonb,
    model        text,                  -- the AOAI deployment, or 'fallback-template'
    fact_pack    jsonb       NOT NULL,  -- the deterministic facts the narrative cites
    PRIMARY KEY (scope_type, scope_key, "window")
);

-- The API MI reads narratives for the reports UI.
DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synthwatch-api') THEN
        GRANT SELECT ON report_narratives TO "synthwatch-api";
    END IF;
END
$grant$;

COMMIT;
