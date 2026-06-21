-- SynthWatch — Postgres 16 schema
--
-- Design note: per-check cadence lives in DATA (checks.interval_seconds +
-- checks.last_run_at), not in the cron expression. The Azure Container Apps Job
-- fires on the finest tier (*/5 UTC) and the runner self-filters to checks that
-- are actually due. This lets a single Job serve checks with mixed cadences
-- (e.g. 5m, 30m, 1h) without one cron entry per tier.
--
-- Apply with:  psql "$DATABASE_URL" -f db/schema.sql

BEGIN;

-- ---------------------------------------------------------------------------
-- checks: the catalogue of things we monitor.
-- ---------------------------------------------------------------------------
CREATE TABLE checks (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name               TEXT        NOT NULL,
    -- 'http'    -> cheap tier, plain fetch(), no browser.
    -- 'browser' -> real Chromium via Playwright, runs a named flow.
    kind               TEXT        NOT NULL CHECK (kind IN ('http', 'browser')),
    target_url         TEXT        NOT NULL,

    -- For browser checks: which flow module under runner/checks/ to execute.
    -- Validated in code against /^[a-z0-9-]+$/ before dynamic import.
    flow_name          TEXT,

    -- HTTP-tier assertions (ignored for browser checks).
    method             TEXT        NOT NULL DEFAULT 'GET',
    expected_status    INTEGER     NOT NULL DEFAULT 200,
    body_must_contain  TEXT,

    -- Cadence + claim bookkeeping. now() - last_run_at >= interval_seconds => due.
    interval_seconds   INTEGER     NOT NULL DEFAULT 300 CHECK (interval_seconds > 0),
    last_run_at        TIMESTAMPTZ,

    timeout_ms         INTEGER     NOT NULL DEFAULT 30000 CHECK (timeout_ms > 0),

    -- Flap debounce: open an incident only after this many CONSECUTIVE failures.
    failure_threshold  INTEGER     NOT NULL DEFAULT 3 CHECK (failure_threshold > 0),

    -- Severity stamped onto incidents opened for this check.
    severity           TEXT        NOT NULL DEFAULT 'critical'
                                   CHECK (severity IN ('critical', 'warning')),

    enabled            BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Lighthouse / perf-budget config (Tier 3 — schema only for now; the audit
    -- code paths land in a later PR and nothing reads these yet). Kept in sync
    -- with db/migrations/0001_run_metrics.sql.
    lighthouse_enabled          BOOLEAN NOT NULL DEFAULT false,
    lighthouse_interval_seconds INTEGER,
    lighthouse_form_factor      TEXT    NOT NULL DEFAULT 'desktop',
    perf_budget_lcp_ms          INTEGER,
    perf_budget_transfer_bytes  BIGINT,

    -- A browser check is meaningless without a flow to run.
    CONSTRAINT browser_needs_flow
        CHECK (kind <> 'browser' OR flow_name IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- runs: one row per execution of a check (one row per claim).
-- ---------------------------------------------------------------------------
CREATE TABLE runs (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    check_id       BIGINT      NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
    -- Inserted pessimistically as 'fail' before execution so that a crashed /
    -- OOM-killed runner leaves an honest failure on the record, then flipped to
    -- 'pass' on success.
    status         TEXT        NOT NULL DEFAULT 'fail' CHECK (status IN ('pass', 'fail')),
    started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at    TIMESTAMPTZ,
    duration_ms    INTEGER,
    http_status    INTEGER,
    error_message  TEXT,
    -- For browser flows: the StepRecorder name of the step that threw. Lets a
    -- failed run show WHERE it died without re-running anything.
    failed_step    TEXT,
    screenshot_url TEXT
);

-- Hot path: "latest N runs for this check, newest first" (status pages, the
-- consecutive-failure count in evaluate.ts).
CREATE INDEX runs_check_started_idx ON runs (check_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- run_steps: structural funnel telemetry. Every StepRecorder.step() writes one
-- row here (pass or fail) so a browser flow's failure point is durable.
-- ---------------------------------------------------------------------------
CREATE TABLE run_steps (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id         BIGINT      NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    step_index     INTEGER     NOT NULL,
    name           TEXT        NOT NULL,
    status         TEXT        NOT NULL CHECK (status IN ('pass', 'fail')),
    duration_ms    INTEGER     NOT NULL,
    error_message  TEXT,
    started_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX run_steps_run_idx ON run_steps (run_id, step_index);

-- ---------------------------------------------------------------------------
-- run_metrics: Tier-1 per-run telemetry. One row per BROWSER run (HTTP checks
-- write nothing here). Captured passively off the run's own navigation; every
-- metric is nullable because a capture failure must never fail the check. Kept
-- in sync with db/migrations/0001_run_metrics.sql.
-- ---------------------------------------------------------------------------
CREATE TABLE run_metrics (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id                BIGINT      NOT NULL UNIQUE
                                      REFERENCES runs(id) ON DELETE CASCADE,

    -- Navigation Timing (W3C) + paint, ms relative to navigation start.
    ttfb_ms               INTEGER,
    dom_content_loaded_ms INTEGER,
    load_event_ms         INTEGER,
    fcp_ms                INTEGER,
    lcp_ms                INTEGER,

    -- Page weight.
    transfer_bytes        BIGINT,
    resource_count        INTEGER,
    dom_node_count        INTEGER,

    -- CDP Performance.getMetrics.
    js_heap_bytes         BIGINT,
    cpu_time_ms           INTEGER,
    layout_count          INTEGER,
    recalc_style_count    INTEGER,

    captured_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- incidents: open/resolved lifecycle per check, debounced against flapping.
-- ---------------------------------------------------------------------------
CREATE TABLE incidents (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    check_id             BIGINT      NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
    status               TEXT        NOT NULL CHECK (status IN ('open', 'resolved')),
    severity             TEXT        NOT NULL CHECK (severity IN ('critical', 'warning')),
    opened_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at          TIMESTAMPTZ,
    opened_run_id        BIGINT      REFERENCES runs(id),
    resolved_run_id      BIGINT      REFERENCES runs(id),
    consecutive_failures INTEGER     NOT NULL DEFAULT 0,
    summary              TEXT
);

-- At most one OPEN incident per check. Lets evaluate.ts rely on the DB to keep
-- incident state coherent rather than coordinating in application code.
CREATE UNIQUE INDEX one_open_incident_per_check
    ON incidents (check_id)
    WHERE status = 'open';

COMMIT;

-- ===========================================================================
-- SLA / availability reporting (mirrors db/migrations/0002_sla_view.sql).
-- Kept here so fresh installs converge with migrated databases. See that
-- migration for the authoritative availability definition and rationale.
--
-- Computed ON-DEMAND from runs (no precomputed rollups): index-assisted via
-- runs_check_started_idx, sub-second at current scale. If a single SLA query
-- ever exceeds ~1-2s, swap the view for a MATERIALIZED VIEW with zero caller
-- impact (callers query the view, not the SQL).
--
-- Availability definition:
--   completed = status IN ('pass','warn','fail','error')   ('running' excluded)
--   "Up"      = status IN ('pass','warn')   (warn = degraded but reachable)
--   "Down"    = status IN ('fail','error')
--   availability_pct = up_runs / completed_runs * 100, per check, per window.
-- The IN-lists use the full intended taxonomy; the runs CHECK currently permits
-- only ('pass','fail'), so today this resolves to up=pass / down=fail and stays
-- correct unchanged when warn/error/running are introduced.
-- ===========================================================================

BEGIN;

CREATE OR REPLACE FUNCTION sla_availability(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
    check_id         bigint,
    check_name       text,
    kind             text,
    window_from      timestamptz,
    window_to        timestamptz,
    completed_runs   bigint,
    up_runs          bigint,
    down_runs        bigint,
    availability_pct numeric
)
LANGUAGE sql
STABLE
AS $$
    SELECT
        c.id   AS check_id,
        c.name AS check_name,
        c.kind AS kind,
        p_from AS window_from,
        p_to   AS window_to,
        count(*) FILTER (WHERE r.status IN ('pass', 'warn', 'fail', 'error')) AS completed_runs,
        count(*) FILTER (WHERE r.status IN ('pass', 'warn'))                  AS up_runs,
        count(*) FILTER (WHERE r.status IN ('fail', 'error'))                 AS down_runs,
        round(
            100.0 * count(*) FILTER (WHERE r.status IN ('pass', 'warn'))
                  / nullif(count(*) FILTER (WHERE r.status IN ('pass', 'warn', 'fail', 'error')), 0),
            4
        ) AS availability_pct
    FROM checks c
    LEFT JOIN runs r
           ON r.check_id   = c.id
          AND r.started_at >= p_from
          AND r.started_at <  p_to
    -- MAINTENANCE-WINDOW EXCLUSION SLOT (later PR): add a
    --   LEFT JOIN maintenance_windows mw ON mw.check_id = c.id
    --        AND r.started_at <@ mw.during
    -- and append "AND mw.id IS NULL" at the WHERE marker below. Additive, no rewrite.
    WHERE true
    GROUP BY c.id, c.name, c.kind
$$;

COMMENT ON FUNCTION sla_availability(timestamptz, timestamptz) IS
    'Per-check availability over [p_from, p_to). up=(pass,warn) / completed=(pass,warn,fail,error); running excluded. On-demand, index-assisted.';

CREATE OR REPLACE VIEW sla_availability_24h AS
    SELECT * FROM sla_availability(now() - interval '24 hours', now());

CREATE OR REPLACE VIEW sla_availability_7d AS
    SELECT * FROM sla_availability(now() - interval '7 days', now());

CREATE OR REPLACE VIEW sla_availability_30d AS
    SELECT * FROM sla_availability(now() - interval '30 days', now());

COMMIT;
