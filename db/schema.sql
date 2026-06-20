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
