-- Migration 0028 — daily_check_rollup: the reporting keystone (Layer 1).
--
-- Pre-aggregates raw telemetry into ONE row per check per UTC day, so availability +
-- performance reports (grouped by tag, over 7/30/90-day windows) read pre-aggregated rows
-- instead of scanning raw `runs` every load. Computed by the nightly rollup job
-- (runner/rollup.ts) for COMPLETED days; "today" (partial) is read from raw by reports.
--
-- GRAIN: per (check_id, day) — AGGREGATED ACROSS LOCATIONS. This matches the existing
-- sla_availability() definition (which counts all runs for a check, not per-location), so
-- the rollup and the views AGREE. Per-location is intentionally NOT a dimension here (a
-- separate, different metric; would not match sla_availability). Tags are NOT baked in —
-- the rollup is raw-check-level; reports GROUP BY joining check_tags at read time (tags
-- can change; the rollup must not freeze them).
--
-- AVAILABILITY — the EXACT sla_availability() definition, reused (NON-NEGOTIABLE): up =
-- pass|warn, down = fail|error, completed = those four ('running' excluded), and runs
-- inside a maintenance window (this check's OR a fleet-wide check_id IS NULL one) are
-- excluded by the same anti-join. availability_pct = 100*up/nullif(up+down,0).
--
-- LATENCY — over UP (pass|warn) runs only, MW-excluded: "when it worked, how fast" (a
-- fast 503 or a 30s timeout is not representative page latency). ★ The stored
-- percentiles are SINGLE-DAY ONLY — percentiles are NOT averageable across days, so a
-- multi-day report MUST recompute p50/p95/p99 from raw `runs`, never average these.
--
-- WEB-VITALS — browser checks only (run_metrics is browser-only); NULL for http/ssl
-- (vitals_count = 0). INP is OMITTED entirely — it is never captured (passive synthetic
-- has no interaction), so we don't store a fake 0.
--
-- New installs converge from db/schema.sql.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0028_daily_check_rollup.sql  (IDEMPOTENT).

BEGIN;

CREATE TABLE IF NOT EXISTS daily_check_rollup (
    check_id           bigint      NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
    day                date        NOT NULL,

    -- Availability (sla_availability definition; MW-excluded, running-excluded).
    up_count           integer     NOT NULL DEFAULT 0,
    down_count         integer     NOT NULL DEFAULT 0,
    total_count        integer     NOT NULL DEFAULT 0,   -- completed = up + down
    availability_pct   numeric,                          -- 100*up/nullif(total,0), 4dp; NULL if 0 completed

    -- Latency over UP runs (duration_ms, all check types), MW-excluded.
    -- ★ percentiles are PER-DAY ONLY — do NOT average across days; recompute from raw.
    latency_count      integer     NOT NULL DEFAULT 0,
    duration_avg_ms    numeric,
    duration_p50_ms    integer,
    duration_p95_ms    integer,
    duration_p99_ms    integer,
    duration_min_ms    integer,
    duration_max_ms    integer,

    -- Browser web-vitals (browser checks only; NULL elsewhere). INP intentionally absent.
    vitals_count       integer     NOT NULL DEFAULT 0,   -- browser runs with metrics that day
    lcp_avg_ms         numeric,
    lcp_p75_ms         integer,
    fcp_avg_ms         numeric,
    fcp_p75_ms         integer,
    ttfb_avg_ms        numeric,
    ttfb_p75_ms        integer,
    cls_avg            double precision,
    cls_p75            double precision,
    load_event_avg_ms  numeric,
    transfer_bytes_avg bigint,

    -- Incidents OPENED that day + their total duration (open ones counted to now()).
    incidents_opened   integer     NOT NULL DEFAULT 0,
    downtime_minutes   numeric     NOT NULL DEFAULT 0,

    computed_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (check_id, day)
);

-- Reports scan by day window across checks (then join check_tags); index the day.
CREATE INDEX IF NOT EXISTS daily_check_rollup_day_idx ON daily_check_rollup (day);

-- The API MI reads rollups for reports.
DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synthwatch-api') THEN
        GRANT SELECT ON daily_check_rollup TO "synthwatch-api";
    END IF;
END
$grant$;

COMMIT;
