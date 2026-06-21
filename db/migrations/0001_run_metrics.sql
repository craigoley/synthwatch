-- Migration 0001 — Tier-1 per-run telemetry.
--
-- For ALREADY-DEPLOYED databases. New installs get the same end state from
-- db/schema.sql (the two must converge). Apply with:
--   psql "$DATABASE_URL" -f db/migrations/0001_run_metrics.sql
--
-- IDEMPOTENT (IF NOT EXISTS): safe to re-run. The migration runner relies on this
-- so an already-migrated DB auto-baselines (re-runs as a no-op, then records the
-- version) without a manual baseline step. See db/migrate.sh.

BEGIN;

-- ---------------------------------------------------------------------------
-- run_metrics: one row per BROWSER run (HTTP checks write nothing here).
-- Captured passively off the run's own navigation. Every metric is nullable —
-- partial telemetry beats none, and capture failure never fails the check.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS run_metrics (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- One metrics row per run; ON DELETE CASCADE so it dies with the run.
    run_id                BIGINT      NOT NULL UNIQUE
                                      REFERENCES runs(id) ON DELETE CASCADE,

    -- Navigation Timing (W3C) + paint, ms relative to navigation start.
    ttfb_ms               INT,
    dom_content_loaded_ms INT,
    load_event_ms         INT,
    fcp_ms                INT,
    lcp_ms                INT,

    -- Page weight.
    transfer_bytes        BIGINT,
    resource_count        INT,
    dom_node_count        INT,

    -- CDP Performance.getMetrics.
    js_heap_bytes         BIGINT,
    cpu_time_ms           INT,
    layout_count          INT,
    recalc_style_count    INT,

    captured_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- checks: Lighthouse / perf-budget config columns. SCHEMA ONLY for now — the
-- audit code paths (Tier 3) land in a later PR; nothing reads these yet.
-- ---------------------------------------------------------------------------
ALTER TABLE checks
    ADD COLUMN IF NOT EXISTS lighthouse_enabled          BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS lighthouse_interval_seconds INT,
    ADD COLUMN IF NOT EXISTS lighthouse_form_factor      TEXT    NOT NULL DEFAULT 'desktop',
    ADD COLUMN IF NOT EXISTS perf_budget_lcp_ms          INT,
    ADD COLUMN IF NOT EXISTS perf_budget_transfer_bytes  BIGINT;

COMMIT;
