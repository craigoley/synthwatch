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
    -- 'ssl'     -> declarative TLS cert-expiry check (no browser); see sslCheck.ts.
    -- 'dns' / 'tcp' / 'ping' -> network-layer checks (no browser); see netChecks.ts.
    --   ('ping' is TCP-reachability, not ICMP — see netChecks.ts.)
    -- 'multistep' -> ordered HTTP chain (steps JSONB); see multistep.ts.
    kind               TEXT        NOT NULL
                                   CHECK (kind IN ('http', 'browser', 'ssl', 'dns', 'tcp', 'ping', 'multistep')),
    target_url         TEXT        NOT NULL,

    -- For browser checks: which flow module under runner/checks/ to execute.
    -- Validated in code against /^[a-z0-9-]+$/ before dynamic import.
    flow_name          TEXT,

    -- HTTP-tier assertions (ignored for browser checks).
    method             TEXT        NOT NULL DEFAULT 'GET',
    expected_status    INTEGER     NOT NULL DEFAULT 200,
    body_must_contain  TEXT,

    -- No-code assertion model + request config (mirrors 0008_assertions.sql).
    -- assertions: JSONB array of {source,comparison,target?,expected?}. EMPTY =>
    -- evaluate the legacy expected_status/body_must_contain (no regression).
    -- auth is a SECRET REFERENCE (env-var name), never a plaintext credential.
    assertions         JSONB       NOT NULL DEFAULT '[]'::jsonb,
    request_headers    JSONB,
    request_body       TEXT,
    auth               JSONB,

    -- Per-kind config for dns/tcp/ping checks (mirrors 0011_network_checks.sql).
    -- dns: {recordType, expectedValue}; tcp/ping: {port}. Host is from target_url.
    net_config         JSONB,

    -- Ordered step chain for kind='multistep' (mirrors 0013_multistep.sql). An
    -- array of {name, method, url, headers?, body?, auth?, assertions?, extract?};
    -- url/headers/body may carry {{var}} templates. See multistep.ts.
    steps              JSONB,

    -- Multi-location (mirrors 0014_multi_location.sql): open an incident only when
    -- failing from >= this many distinct locations. NULL => ALL SELECTED locations
    -- must fail (N-of-N, the conservative false-positive-killing default, computed at
    -- verdict time from the check's check_locations count); an explicit INT = that
    -- absolute threshold (e.g. 1 = page if ANY location fails). See evaluate.ts
    -- crossLocationDown(). Single selected location => N=1 => pre-multi-location behaviour.
    min_fail_locations INTEGER,

    -- Cadence + claim bookkeeping. now() - last_run_at >= interval_seconds => due.
    interval_seconds   INTEGER     NOT NULL DEFAULT 300 CHECK (interval_seconds > 0),
    last_run_at        TIMESTAMPTZ,

    timeout_ms         INTEGER     NOT NULL DEFAULT 30000 CHECK (timeout_ms > 0),

    -- Flap debounce: open an incident only after this many CONSECUTIVE failures.
    failure_threshold  INTEGER     NOT NULL DEFAULT 3 CHECK (failure_threshold > 0),

    -- For kind='ssl': days-until-expiry threshold. Cert with more days -> pass;
    -- within this window -> warn; expired/invalid -> fail; unreachable -> error.
    -- Harmless on http/browser rows. (Mirrors db/migrations/0005_ssl_checks.sql.)
    cert_expiry_warn_days INTEGER  NOT NULL DEFAULT 30,

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

    -- Alert routing (mirrors db/migrations/0006_alert_profiles.sql). NULL profile
    -- => the 'default' profile (resolved in code). The FK is added after
    -- alert_profiles is created, below.
    alert_profile_id      BIGINT,
    -- Warn-notify debounce: when we last sent a warn notification, and the min
    -- re-notify interval (so a persistent warn doesn't notify every tick).
    last_warn_notified_at TIMESTAMPTZ,
    warn_renotify_seconds INTEGER NOT NULL DEFAULT 86400 CHECK (warn_renotify_seconds > 0),

    -- SLO / error budget (mirrors 0016_slo.sql). slo_target NULL = SLO off (opt-in;
    -- no budget fabricated). last_burn_notified_at debounces burn-rate alerts
    -- (reuses warn_renotify_seconds cadence). See slo_status() + runner/evaluate.ts.
    slo_target            REAL CHECK (slo_target IS NULL OR (slo_target > 0 AND slo_target < 1)),
    last_burn_notified_at TIMESTAMPTZ,

    -- Most-recent-passing browser screenshot baseline (mirrors 0017). A stable
    -- per-check Blob key (baselines/check-<id>.png) overwritten on each passing
    -- browser run; RCA reads this as the visual-diff baseline. NULL = none yet.
    baseline_screenshot_url TEXT,

    -- A browser check is meaningless without a flow to run.
    CONSTRAINT browser_needs_flow
        CHECK (kind <> 'browser' OR flow_name IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- check_locations: per-(check, location) cadence cursor (mirrors 0019).
-- Multi-location was inert because due/claim keyed on the single global
-- checks.last_run_at. Each region runner claims ONLY its own $LOCATION here,
-- UPSERTing its own last_run_at, so regions pace independently (no global
-- active-location list). checks.last_run_at is kept as a legacy mirror.
-- ---------------------------------------------------------------------------
CREATE TABLE check_locations (
    check_id    bigint      NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
    location    text        NOT NULL,
    last_run_at timestamptz,
    PRIMARY KEY (check_id, location)
);

-- ---------------------------------------------------------------------------
-- locations: registry of deployed regions (mirrors 0020_location_registry.sql).
-- The check_locations rows ARE a check's assignment; this registry says which
-- locations exist / are active and what a new check defaults to (one cursor per
-- active location). Seeded with 'default' (the live single region). The dashboard's
-- location-selector reads this for its options.
-- ---------------------------------------------------------------------------
CREATE TABLE locations (
    name       text        PRIMARY KEY,
    enabled    boolean     NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO locations (name, enabled) VALUES ('default', true);

-- ---------------------------------------------------------------------------
-- runs: one row per execution of a check (one row per claim).
-- ---------------------------------------------------------------------------
CREATE TABLE runs (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    check_id       BIGINT      NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
    -- Full run-status taxonomy (see db/migrations/0003_widen_status.sql):
    --   pass | warn | fail | error | running.
    -- Inserted as 'running' (in-flight) and updated to a terminal status on
    -- finish; a stale 'running' (hard crash mid-run) is reaped to 'error' by the
    -- runner. SLA excludes 'running'; warn counts as up; fail/error are down.
    status         TEXT        NOT NULL DEFAULT 'running'
                               CHECK (status IN ('pass', 'warn', 'fail', 'error', 'running')),
    started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at    TIMESTAMPTZ,
    duration_ms    INTEGER,
    http_status    INTEGER,
    error_message  TEXT,
    -- For browser flows: the StepRecorder name of the step that threw. Lets a
    -- failed run show WHERE it died without re-running anything.
    failed_step    TEXT,
    screenshot_url TEXT,
    -- Failed browser runs only: Blob URL of the captured Playwright trace.zip
    -- (mirrors db/migrations/0012_trace_url.sql). NULL for pass/non-browser runs
    -- and when capture/upload failed (non-fatal).
    trace_url      TEXT,
    -- For kind='ssl' runs: signed days relative to the cert's notAfter (+ = until
    -- expiry, - = past expiry). NULL for non-ssl runs or when no cert was obtained.
    -- (Mirrors db/migrations/0007_cert_days_remaining.sql.) error_message keeps the
    -- human-readable cert line; this is the structured value for the API/dashboard.
    cert_days_remaining INTEGER,
    -- The location (vantage point) that produced this run, from the runner's
    -- SYNTHWATCH_LOCATION (mirrors 0014_multi_location.sql). DEFAULT 'default' so
    -- a single-region deploy uses one location and behaves exactly as before.
    location       TEXT NOT NULL DEFAULT 'default'
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
    -- pass | fail (a flow expectation) | error (an exception/timeout).
    status         TEXT        NOT NULL CHECK (status IN ('pass', 'fail', 'error')),
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

    -- Core Web Vitals (mirrors db/migrations/0010_cls_inp.sql). cls = session-window
    -- Cumulative Layout Shift (0 = stable). inp_ms = Interaction to Next Paint;
    -- BEST-EFFORT: NULL unless the flow performed real interactions.
    cls                   DOUBLE PRECISION,
    inp_ms                INTEGER,

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
    summary              TEXT,
    -- AI root-cause analysis (mirrors 0015_incident_rca.sql). Structured JSON:
    -- { classification, confidence, observed[], inferred[], summary, signature,
    --   model, cached, generated_at }. NULL when RCA is off / failed / pre-existing.
    rca                  JSONB
);

-- At most one OPEN incident per check. Lets evaluate.ts rely on the DB to keep
-- incident state coherent rather than coordinating in application code.
CREATE UNIQUE INDEX one_open_incident_per_check
    ON incidents (check_id)
    WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- maintenance_windows: planned downtime (mirrors db/migrations/0004). A window
-- both SUPPRESSES incident alerting (evaluate.ts) and EXCLUDES the period from
-- availability math (sla_availability). check_id NULL = fleet-wide (all checks);
-- a non-NULL check_id scopes the window to one check.
-- ---------------------------------------------------------------------------
CREATE TABLE maintenance_windows (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    check_id   BIGINT      REFERENCES checks(id) ON DELETE CASCADE, -- NULL => fleet-wide
    starts_at  TIMESTAMPTZ NOT NULL,
    ends_at    TIMESTAMPTZ NOT NULL,
    reason     TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT maintenance_windows_valid_range CHECK (ends_at > starts_at)
);

CREATE INDEX maintenance_windows_span_idx
    ON maintenance_windows (starts_at, ends_at);

-- ---------------------------------------------------------------------------
-- alert_profiles: per-check routing of (severity x status) -> channel set
-- (mirrors db/migrations/0006_alert_profiles.sql). rules is a JSONB array of
--   { "severity": "critical"|"warning"|"any",
--     "status":   "fail"|"error"|"warn"|"resolved"|"any",
--     "channels": ["email","webhook", ...] }.
-- The 'default' profile preserves fail/error/resolved -> all channels and adds
-- warn -> email only. A check with NULL alert_profile_id falls back to 'default'.
-- ---------------------------------------------------------------------------
CREATE TABLE alert_profiles (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       TEXT        NOT NULL UNIQUE,
    rules      JSONB       NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- FK added here (checks is defined above, before alert_profiles existed).
ALTER TABLE checks
    ADD CONSTRAINT checks_alert_profile_id_fkey
        FOREIGN KEY (alert_profile_id) REFERENCES alert_profiles(id) ON DELETE SET NULL;

INSERT INTO alert_profiles (name, rules) VALUES (
    'default',
    '[
       {"severity":"any","status":"fail",    "channels":["email","webhook"]},
       {"severity":"any","status":"error",   "channels":["email","webhook"]},
       {"severity":"any","status":"resolved","channels":["email","webhook"]},
       {"severity":"any","status":"warn",    "channels":["email"]}
     ]'::jsonb
)
ON CONFLICT (name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- flow_manifest: available browser flows (mirrors 0009_flow_manifest.sql).
-- Populated by the runner (it discovers its own flow modules at tick start and
-- upserts here); the API/dashboard read this instead of distinct checks.flow_name.
-- ---------------------------------------------------------------------------
CREATE TABLE flow_manifest (
    name           TEXT        PRIMARY KEY,
    description    TEXT,
    entry_url_hint TEXT,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- schema_migrations: tracks which db/migrations/*.sql files have been applied
-- (version = filename without ".sql"). Owned by the migration runner
-- (db/migrate.sh), which also creates it IF NOT EXISTS.
--
-- Convergence (fresh install vs. migrated DB): this file (schema.sql) already
-- contains the END STATE of every migration, and the migrations are idempotent.
-- So a fresh install = `psql -f db/schema.sql` then run the migration runner:
-- each migration re-applies as a harmless no-op and registers its version. We do
-- NOT pre-seed versions here — idempotent no-op re-apply is the (simpler)
-- convergence mechanism, so there is no version list to keep in sync in two places.
-- ---------------------------------------------------------------------------
CREATE TABLE schema_migrations (
    version    TEXT        PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
    -- MAINTENANCE-WINDOW EXCLUSION (additive anti-join, mirrors 0004): drop runs
    -- that fall inside an active window for this check (check_id = c.id) OR a
    -- fleet-wide window (check_id IS NULL). Uncovered runs keep mw.id NULL and
    -- survive; checks with no runs keep their single null-run row.
    LEFT JOIN maintenance_windows mw
           ON (mw.check_id = c.id OR mw.check_id IS NULL)
          AND r.started_at >= mw.starts_at
          AND r.started_at <  mw.ends_at
    WHERE mw.id IS NULL
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

-- 90d (mirrors 0018_sla_90d.sql) — the SLA/SLO reporting window. GRANT SELECT to
-- "synthwatch-api" is applied via the migration / ops (the snapshot has no MI role).
CREATE OR REPLACE VIEW sla_availability_90d AS
    SELECT * FROM sla_availability(now() - interval '90 days', now());

-- ---------------------------------------------------------------------------
-- slo_status: per-check SLO / error-budget / burn-rate over a window (mirrors
-- 0016_slo.sql). Run-weighted, reusing sla_availability's up/down taxonomy and
-- maintenance-window exclusion. Zero rows when the check has no slo_target. The
-- runner calls it for 1h/6h burn windows; the API/dashboard for the 30d headline.
-- (GRANT EXECUTE to "synthwatch-api" is applied via the migration / ops, not here,
--  mirroring sla_availability — the fresh-install snapshot has no MI role.)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION slo_status(p_check_id bigint, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
    check_id      bigint,
    slo_target    real,
    window_from   timestamptz,
    window_to     timestamptz,
    total_runs    bigint,
    down_runs     bigint,
    budget        numeric,
    consumed      bigint,
    remaining     numeric,
    remaining_pct numeric,
    burn_rate     numeric
)
LANGUAGE sql
STABLE
AS $$
    WITH agg AS (
        SELECT
            c.id         AS check_id,
            c.slo_target AS slo_target,
            count(*) FILTER (WHERE r.status IN ('pass', 'warn', 'fail', 'error')) AS total_runs,
            count(*) FILTER (WHERE r.status IN ('fail', 'error'))                 AS down_runs
        FROM checks c
        LEFT JOIN runs r
               ON r.check_id   = c.id
              AND r.started_at >= p_from
              AND r.started_at <  p_to
        LEFT JOIN maintenance_windows mw
               ON (mw.check_id = c.id OR mw.check_id IS NULL)
              AND r.started_at >= mw.starts_at
              AND r.started_at <  mw.ends_at
        WHERE c.id = p_check_id
          AND c.slo_target IS NOT NULL
          AND mw.id IS NULL
        GROUP BY c.id, c.slo_target
    )
    SELECT
        check_id,
        slo_target,
        p_from AS window_from,
        p_to   AS window_to,
        total_runs,
        down_runs,
        (1::numeric - slo_target::numeric) * total_runs                         AS budget,
        down_runs                                                      AS consumed,
        (1::numeric - slo_target::numeric) * total_runs - down_runs             AS remaining,
        CASE WHEN (1::numeric - slo_target::numeric) * total_runs > 0
             THEN round(1 - down_runs::numeric / ((1::numeric - slo_target::numeric) * total_runs), 6)
             END                                                       AS remaining_pct,
        CASE WHEN total_runs > 0
             THEN round((down_runs::numeric / total_runs) / (1::numeric - slo_target::numeric), 4)
             ELSE 0 END                                                AS burn_rate
    FROM agg
$$;

COMMENT ON FUNCTION slo_status(bigint, timestamptz, timestamptz) IS
    'Per-check SLO over [p_from, p_to): target, error-budget (run-weighted), consumed, remaining, burn_rate=(down/total)/(1-target). Zero rows if no slo_target.';

COMMIT;
