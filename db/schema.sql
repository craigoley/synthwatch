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
    -- failing from >= this many distinct locations. NULL => ALL REPORTING locations
    -- must fail (N-of-N over what's currently reporting — the conservative default; a
    -- stale/silent region is excluded so it can't block paging); an explicit INT = that
    -- absolute threshold (1 = page if ANY location fails), capped at the reporting count.
    -- See evaluate.ts effectiveN()/crossLocationDown(). One reporting location => N=1 =>
    -- pre-multi-location behaviour.
    min_fail_locations INTEGER,

    -- Cadence + claim bookkeeping. now() - last_run_at >= interval_seconds => due.
    interval_seconds   INTEGER     NOT NULL DEFAULT 300 CHECK (interval_seconds > 0),
    last_run_at        TIMESTAMPTZ,

    timeout_ms         INTEGER     NOT NULL DEFAULT 30000 CHECK (timeout_ms > 0),

    -- Consecutive-SCHEDULED-failure debounce: open an incident only after this many consecutive
    -- down RUNS (each = one scheduled tick). DEFAULT 1 (mirrors 0045) = page on the FIRST confirmed
    -- failure — confirmation now comes from in-run fast-retry (below), so we no longer wait multiple
    -- ticks. >1 stays available as an OPTIONAL debounce for intentionally-noisy monitors.
    failure_threshold  INTEGER     NOT NULL DEFAULT 1 CHECK (failure_threshold > 0),

    -- Fast-retry (mirrors 0021 + 0045): within ONE run, re-run up to `retries` times on ANY failure
    -- — 'error' (couldn't complete) OR 'fail' (assertion missed); only the FINAL attempt counts
    -- (intermediate attempts discarded). Sits IN FRONT of failure_threshold: it confirms a failure
    -- in-run (seconds) so the incident can open immediately. DEFAULT 2 (3 attempts total — Datadog's
    -- recommended default); 0 = no retry. Distinct from failure_threshold.
    retries            INTEGER     NOT NULL DEFAULT 2 CHECK (retries >= 0),

    -- B10 trace redaction (mirrors 0046). `sensitive` = a cart/auth monitor whose trace can carry
    -- session tokens / cart contents / account PII: the runner skips the success-trace baseline +
    -- failure trace zips, omits screenshots from RCA (and doesn't store them), scrubs trace_signals
    -- (built-in token denylist + redact_patterns), and genericises error_message. redact_patterns =
    -- a JSONB array of regex strings the monitor declares (NULL = none; the denylist still applies).
    -- DEFAULT false → non-sensitive monitors are unchanged. Reconcile sets both from the manifest.
    sensitive          BOOLEAN     NOT NULL DEFAULT false,
    redact_patterns    JSONB,

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

    -- Last-known-good Playwright TRACE baseline (mirrors 0039_success_trace.sql). A stable,
    -- purge-EXEMPT per-check Blob key (success-latest/check-<id>.zip) overwritten on each success;
    -- success_trace_at dates it + throttles re-upload. NULL/NULL = none yet.
    success_trace_url       TEXT,
    success_trace_at        TIMESTAMPTZ,

    -- Monitors-as-code identity (mirrors 0030_source_key.sql). Binds this row to a
    -- synthwatch-monitors manifest `id`. NULL => dashboard/seed-created (reconcile
    -- ignores it); NOT NULL => Git-managed. NOT the same as flow_name (manifest id
    -- 'wegmans-search-product' vs runner flow 'wegmans-search'). The partial unique
    -- index is created below (a NULL-tolerant uniqueness).
    source_key         TEXT,

    -- The monitors-repo spec path for runtime fetch (mirrors 0033_spec_path.sql, Phase 6b
    -- Option C). The manifest `script` for this monitor; the hot path reads it directly to
    -- fetch+run the Playwright spec (no per-tick manifest fetch). NULL for native/dashboard
    -- checks. The CHECK mirrors the runtime guard (specfetch/fetchSpec.assertValidSpecPath).
    spec_path          TEXT
                       CONSTRAINT checks_spec_path_shape
                       CHECK (spec_path IS NULL
                              OR (spec_path ~ '^monitors/.+\.spec\.ts$'
                                  AND position('..' in spec_path) = 0)),

    -- A browser check is meaningless without a flow to run.
    CONSTRAINT browser_needs_flow
        CHECK (kind <> 'browser' OR flow_name IS NOT NULL)
);

-- One live check per manifest id; the many unmanaged (NULL) rows don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS checks_source_key_uniq
    ON checks (source_key) WHERE source_key IS NOT NULL;

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
-- check_tags: key:value tags on checks (mirrors 0024_check_tags.sql). The Phase-9a
-- primitive for tag-scoped routing / dashboard filtering / per-team reporting. Normalized
-- table (not JSONB) so "checks WHERE key=X [AND value=Y]" is a clean indexed query.
-- PK(check_id, key) = one value per key. key/value are lowercase + whitespace-free
-- (guarded by CHECKs); key '' = a bare value. See runner/tags.ts.
-- ---------------------------------------------------------------------------
CREATE TABLE check_tags (
    check_id bigint NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
    key      text   NOT NULL DEFAULT ''
                    CHECK (key = lower(key) AND key !~ '[[:space:]]'),
    value    text   NOT NULL
                    CHECK (value <> '' AND value = lower(value) AND value !~ '[[:space:]]'),
    PRIMARY KEY (check_id, key)
);
CREATE INDEX check_tags_key_value_idx ON check_tags (key, value);

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
    -- Full run-status taxonomy (see 0003_widen_status.sql + 0035_infra_error_status.sql):
    --   pass | warn | fail | error | infra_error | running.
    -- Inserted as 'running' (in-flight) and updated to a terminal status on
    -- finish; a stale 'running' (hard crash mid-run) is reaped to 'error' by the
    -- runner. SLA excludes 'running'; warn counts as up; fail/error are down.
    -- 'infra_error' (Option C): the runner couldn't fetch a browser check's spec — NEITHER
    -- up nor down, excluded from SLA + paging (recorded + visible, never pages). Like
    -- 'running' but terminal. See runner/db.ts RunStatus + evaluate.ts.
    status         TEXT        NOT NULL DEFAULT 'running'
                               CHECK (status IN ('pass', 'warn', 'fail', 'error', 'infra_error', 'running')),
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
    -- Compact, filtered trace SIGNALS extracted at capture time (mirrors 0040_trace_signals.sql):
    -- network summary + real site console errors, same shape as the API's TraceExtractor. NULL = no
    -- trace this run or extraction failed (non-fatal). Written for any traced run (success + failure).
    trace_signals  JSONB,
    -- Spec-load forensics (mirrors 0047). For browser spec_path runs: which spec the run loaded, from
    -- where (origin: cache-304 | compiled-200 | fallback-last-good), the resolved version identity
    -- (resolved_etag — a commit SHA since #138), the spec_cache.fetched_at it saw, and a sha256 of the
    -- compiled_js it ACTUALLY executed (executed_sha256 — compare to the cache's compiled_js hash to
    -- prove "is it running the spec I think?"). NULL for http/baked-in-flow runs. Written EARLY (before
    -- execution) so even a failing/crashing run records it.
    spec_provenance JSONB,
    -- For kind='ssl' runs: signed days relative to the cert's notAfter (+ = until
    -- expiry, - = past expiry). NULL for non-ssl runs or when no cert was obtained.
    -- (Mirrors db/migrations/0007_cert_days_remaining.sql.) error_message keeps the
    -- human-readable cert line; this is the structured value for the API/dashboard.
    cert_days_remaining INTEGER,
    -- Attempts taken to reach this verdict (mirrors 0048): 1 = first try; >1 = settled after fast-retry;
    -- = retries+1 when retries were exhausted. status=pass AND retry_count>1 is the degrading-but-green
    -- monitor that never opens an incident. NULL = pre-telemetry (historical rows).
    retry_count    INTEGER,
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
    -- pass | fail (a flow expectation) | error (an exception/timeout) | running (transient — a step in
    -- flight; finalized in place to a terminal status on completion). Mirrors 0043.
    status         TEXT        NOT NULL CHECK (status IN ('pass', 'fail', 'error', 'running')),
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
    rca                  JSONB,
    -- Fire-once guard for the "RCA ready" enrichment notification (mirrors
    -- 0027_rca_notified.sql). Set when the enrichment sends; the conditional UPDATE
    -- (... WHERE rca_notified_at IS NULL) makes the follow-up fire AT MOST ONCE per
    -- incident, race-safe across runner executions. See runner/evaluate.ts.
    rca_notified_at      TIMESTAMPTZ
);

-- At most one OPEN incident per check. Lets evaluate.ts rely on the DB to keep
-- incident state coherent rather than coordinating in application code.
CREATE UNIQUE INDEX one_open_incident_per_check
    ON incidents (check_id)
    WHERE status = 'open';

-- Backs the GET /api/incidents keyset cursor (opened_at DESC, id DESC) — index range
-- scan instead of full-scan-and-sort (mirrors 0032_incidents_opened_idx.sql). Column
-- order MUST match the cursor's ORDER BY exactly. On a live DB the migration builds this
-- CONCURRENTLY; here (fresh, empty table) a plain CREATE INDEX is instant.
CREATE INDEX IF NOT EXISTS incidents_opened_idx
    ON incidents (opened_at DESC, id DESC);

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
-- channels + alert_routes: dashboard-managed alerting v1 (mirrors 0023). CHANNELS
-- are delivery TARGETS (NO transport secret — the ACS connection string stays env);
-- alert_routes is the ROUTING (severity-default XOR per-check override). Supersedes
-- alert_profiles above (kept for back-compat; the runner reads these now). See
-- runner/alerts.ts resolveChannels().
-- ---------------------------------------------------------------------------
CREATE TABLE channels (
    id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       TEXT        NOT NULL UNIQUE,
    type       TEXT        NOT NULL CHECK (type IN ('email', 'webhook')),
    -- email -> {to:[...]}; webhook -> {url, authHeader?}. No secrets, no sender:
    -- the email FROM + ACS conn string are runner env (ALERT_EMAIL_FROM / ACS_EMAIL_CONNECTION_STRING).
    config     JSONB       NOT NULL DEFAULT '{}'::jsonb,
    enabled    BOOLEAN     NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE alert_routes (
    id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    severity   TEXT        CHECK (severity IS NULL OR severity IN ('critical', 'warning')),
    check_id   BIGINT      REFERENCES checks(id) ON DELETE CASCADE,
    channel_id BIGINT      NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT alert_route_one_dimension
        CHECK ((severity IS NOT NULL AND check_id IS NULL)
            OR (severity IS NULL AND check_id IS NOT NULL))
);
CREATE UNIQUE INDEX alert_routes_severity_uq ON alert_routes (severity, channel_id) WHERE check_id IS NULL;
CREATE UNIQUE INDEX alert_routes_check_uq ON alert_routes (check_id, channel_id) WHERE check_id IS NOT NULL;

-- Default channels (empty config => dashboard fills targets) + severity-default routes.
INSERT INTO channels (name, type, config, enabled) VALUES
    ('email',   'email',   '{}'::jsonb, true),
    ('webhook', 'webhook', '{}'::jsonb, true);
INSERT INTO alert_routes (severity, channel_id)
SELECT s.sev, c.id FROM (VALUES ('critical'), ('warning')) AS s(sev)
  CROSS JOIN channels c WHERE c.name IN ('email', 'webhook');

-- tag_routes: the TAG dimension of routing (mirrors 0025_tag_routes.sql). A tag-rule
-- (tag_key, tag_value -> channel) ADDS channels to any incident whose check carries that
-- tag. Composed as a UNION with severity-default + per-check in resolveChannels (all
-- additive). tag_key/tag_value normalized like check_tags so the join is exact. No seed
-- (tag-rules are dashboard-defined).
CREATE TABLE tag_routes (
    id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tag_key    TEXT        NOT NULL
                           CHECK (tag_key = lower(tag_key) AND tag_key !~ '[[:space:]]'),
    tag_value  TEXT        NOT NULL
                           CHECK (tag_value <> '' AND tag_value = lower(tag_value) AND tag_value !~ '[[:space:]]'),
    channel_id BIGINT      NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tag_routes_uq ON tag_routes (tag_key, tag_value, channel_id);
CREATE INDEX tag_routes_key_value_idx ON tag_routes (tag_key, tag_value);

-- ---------------------------------------------------------------------------
-- test_send_requests: channel test-sends through the runner's real dispatch path
-- (mirrors 0026_test_send_requests.sql). The API writes a 'pending' row + triggers the
-- runner job on-demand; the runner drains it at startup, sends a [TEST] alert via the
-- REAL sendEmail/dispatch, and marks delivered/failed. See runner/testSend.ts.
-- ---------------------------------------------------------------------------
CREATE TABLE test_send_requests (
    id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    channel_id   BIGINT      NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    status       TEXT        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'sending', 'delivered', 'failed')),
    detail       TEXT,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
);
CREATE INDEX test_send_requests_pending_idx ON test_send_requests (requested_at) WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- run_requests: on-demand "Run now" queue (mirrors 0042_run_requests.sql). The API writes a
-- 'pending' row + triggers the runner job on-demand (same path as test-sends); the runner drains
-- it at startup, force-runs the check via the normal runOne path (trace/signals/verdict/RCA flow
-- identically), and marks it done. The cron tick is the fallback. See runner/index.ts drainRunRequests.
-- ---------------------------------------------------------------------------
CREATE TABLE run_requests (
    id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    check_id     BIGINT      NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
    status       TEXT        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'done')),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
);
CREATE INDEX run_requests_pending_idx ON run_requests (requested_at) WHERE status = 'pending';
-- Idempotency: at most one pending request per check (re-clicks coalesce).
CREATE UNIQUE INDEX run_requests_one_pending_per_check ON run_requests (check_id) WHERE status = 'pending';

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
-- reconcile_drift: monitors-as-code drift surface (mirrors 0031_reconcile_drift.sql).
-- The reconcile job compares synthwatch-monitors' manifest.json to live `checks`
-- READ-ONLY and writes what differs here (new/changed/missing/orphan). One row per
-- (source_key, drift_type); each run upserts the current set and deletes stale rows.
-- ---------------------------------------------------------------------------
CREATE TABLE reconcile_drift (
    source_key  text        NOT NULL,
    drift_type  text        NOT NULL
                            CHECK (drift_type IN ('new', 'changed', 'missing', 'orphan')),
    detail      jsonb       NOT NULL DEFAULT '{}'::jsonb,
    detected_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (source_key, drift_type)
);

-- ---------------------------------------------------------------------------
-- spec_cache: durable runtime-spec cache (mirrors 0034_spec_cache.sql, Phase 6b Option C).
-- The runner cold-starts every 5 min, so the spec cache lives in Postgres. Per due check the runner
-- resolves monitors-repo main's HEAD commit SHA (GitHub commits API — strongly consistent, NOT the
-- raw CDN) and fetches the spec content AT that SHA (contents API). `etag` stores that commit SHA (the
-- version identity): if main still points at it, compiled_js is reused with no content fetch; otherwise
-- recompile + upsert. (Was a raw-CDN If-None-Match etag — swapped to kill the CDN propagation window.)
-- last_good_* are populated here but only READ by slice 4's fetch-failure fallback.
-- ★ LEAST-PRIVILEGE (0041): compiled_js is loaded + EXECUTED at runner privilege, so WRITE here is an
-- RCE-equivalent surface. ONLY the runner (Postgres owner: synthadmin) may write it; the API role
-- (synthwatch-api) is intentionally NOT granted INSERT/UPDATE/DELETE on spec_cache — do NOT add it.
-- ---------------------------------------------------------------------------
CREATE TABLE spec_cache (
    spec_path             text        PRIMARY KEY,
    etag                  text,
    source_sha            text,
    compiled_js           text        NOT NULL,
    fetched_at            timestamptz NOT NULL DEFAULT now(),
    last_good_compiled_js text,
    last_good_at          timestamptz
);

-- ---------------------------------------------------------------------------
-- spec_catalog: manifest-snapshot inventory (mirrors 0036_spec_catalog.sql, Phase 13).
-- One row per manifest monitor (FULL RELOAD each reconcile), so the API/dashboard can
-- enumerate EVERY spec + its runnable probe result — reconcile_drift only holds drifting
-- rows, so an Active spec has no drift row and can't back the catalog. READ-ONLY inventory.
-- ---------------------------------------------------------------------------
CREATE TABLE spec_catalog (
    source_key                 text        PRIMARY KEY,
    name                       text        NOT NULL,
    spec_path                  text        NOT NULL,
    kind                       text        NOT NULL,
    target                     text,
    suggested_interval_seconds integer,
    tags                       jsonb       NOT NULL DEFAULT '[]'::jsonb,
    description                text,
    enabled_by_default         boolean     NOT NULL DEFAULT false,
    runnable                   boolean     NOT NULL,
    not_runnable_reason        text,
    probed_at                  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- auth identity tables (mirrors 0037_auth.sql, Phase 12 slice 1). Logically API-owned
-- (only the API reads/writes them); here because the runner owns the schema + migrate
-- pipeline. Slice 1 is additive — these mint/verify OTP sessions; NOTHING is enforced
-- until slice 2 adds the API authz gate. GRANTs to "synthwatch-api" are applied via the
-- migration / ops, not this snapshot (the snapshot has no MI role).
-- ---------------------------------------------------------------------------
CREATE TABLE otp_codes (
    id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email         TEXT        NOT NULL,
    code_hash     TEXT        NOT NULL,          -- sha256(code); the raw code is never stored
    expires_at    TIMESTAMPTZ NOT NULL,
    consumed_at   TIMESTAMPTZ,                   -- one-time use
    attempt_count INTEGER     NOT NULL DEFAULT 0, -- brute-force cap on verify
    request_ip    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX otp_codes_email_created_idx ON otp_codes (email, created_at);

CREATE TABLE sessions (
    id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    token_hash   TEXT        NOT NULL UNIQUE,    -- sha256(opaque bearer); raw token shown once
    email        TEXT        NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    expires_at   TIMESTAMPTZ NOT NULL,
    revoked_at   TIMESTAMPTZ,                    -- logout / admin revoke
    issued_ip    TEXT
);

CREATE TABLE editors (
    email    TEXT        PRIMARY KEY,            -- admin-managed allowlist; admins come from ADMIN_EMAILS
    added_by TEXT        NOT NULL,
    added_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE access_requests (
    id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email        TEXT        NOT NULL,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    request_ip   TEXT
);
CREATE INDEX access_requests_email_requested_idx ON access_requests (email, requested_at);

-- ---------------------------------------------------------------------------
-- audit_log: the API's append-only audit trail (mirrors 0038_audit_log.sql, Phase 12 slice 2).
-- Logically API-owned (the AuthorizationMiddleware writes it on every authorized mutation, with
-- secrets redacted). ★ APPEND-ONLY: the API role is granted INSERT/SELECT and REVOKEd UPDATE/DELETE
-- (applied via the migration / ops, not this snapshot) so history can't be rewritten by the app.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
    id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor_email  TEXT,
    actor_ip     TEXT,
    action       TEXT,                  -- create | update | delete (from the HTTP verb)
    target_type  TEXT,
    target_id    TEXT,
    http_method  TEXT,
    http_path    TEXT,
    status_code  INTEGER,
    success      BOOLEAN,
    before_json  JSONB,                 -- REDACTED snapshot before the change
    after_json   JSONB,                 -- REDACTED snapshot after the change
    note         TEXT
);
CREATE INDEX audit_log_ts_idx ON audit_log (ts DESC);

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
-- daily_check_rollup: reporting keystone (mirrors 0028). One row per check per UTC day,
-- aggregated across locations. Availability reuses the sla_availability definition
-- (up=pass|warn, down=fail|error, MW-excluded, running-excluded) so it AGREES with the
-- views. Latency (over UP runs) percentiles are SINGLE-DAY ONLY — never average across
-- days; multi-day reports recompute from raw. Web-vitals browser-only (NULL elsewhere;
-- INP omitted). Tags applied at read time (runs/rollup -> checks -> check_tags), not
-- baked in. Computed by the nightly rollup job (runner/rollup.ts).
-- ---------------------------------------------------------------------------
CREATE TABLE daily_check_rollup (
    check_id           BIGINT      NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
    day                DATE        NOT NULL,
    up_count           INTEGER     NOT NULL DEFAULT 0,
    down_count         INTEGER     NOT NULL DEFAULT 0,
    total_count        INTEGER     NOT NULL DEFAULT 0,
    availability_pct   NUMERIC,
    latency_count      INTEGER     NOT NULL DEFAULT 0,
    duration_avg_ms    NUMERIC,
    duration_p50_ms    INTEGER,
    duration_p95_ms    INTEGER,
    duration_p99_ms    INTEGER,
    duration_min_ms    INTEGER,
    duration_max_ms    INTEGER,
    vitals_count       INTEGER     NOT NULL DEFAULT 0,
    lcp_avg_ms         NUMERIC,
    lcp_p75_ms         INTEGER,
    fcp_avg_ms         NUMERIC,
    fcp_p75_ms         INTEGER,
    ttfb_avg_ms        NUMERIC,
    ttfb_p75_ms        INTEGER,
    cls_avg            DOUBLE PRECISION,
    cls_p75            DOUBLE PRECISION,
    load_event_avg_ms  NUMERIC,
    transfer_bytes_avg BIGINT,
    incidents_opened   INTEGER     NOT NULL DEFAULT 0,
    downtime_minutes   NUMERIC     NOT NULL DEFAULT 0,
    computed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (check_id, day)
);
CREATE INDEX daily_check_rollup_day_idx ON daily_check_rollup (day);

-- ---------------------------------------------------------------------------
-- report_narratives: Reporting Layer 3 — precomputed AI narrative over the reporting
-- data (mirrors 0029). fact-pack-then-narrate: facts computed deterministically, the
-- model only narrates the stored fact_pack (fallback to a template). Built by the
-- narrative job (runner/narrative.ts). "window" is quoted (reserved word).
-- ---------------------------------------------------------------------------
CREATE TABLE report_narratives (
    scope_type   TEXT        NOT NULL CHECK (scope_type IN ('fleet', 'monitor')),
    scope_key    TEXT        NOT NULL,
    "window"     TEXT        NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    headline     TEXT,
    body         TEXT,
    highlights   JSONB       NOT NULL DEFAULT '[]'::jsonb,
    model        TEXT,
    fact_pack    JSONB       NOT NULL,
    PRIMARY KEY (scope_type, scope_key, "window")
);

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
