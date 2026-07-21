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
    -- Per-monitor SECRET request headers — model B (0068): ENCRYPTED VALUES. { headerName -> CIPHERTEXT
    -- ("v1:…", CredCrypto v1) }. The api ENCRYPTS on write (editor-gated); the runner DECRYPTS once per run
    -- (secretHeaders.ts) and injects the plaintext per FIRST-PARTY request. WRITE-ONLY: the read DTO returns
    -- masked, never plaintext OR ciphertext. Value never logged/traced (audit #219). Fail-CLOSED on decrypt.
    secret_headers     JSONB,
    -- Per-monitor LOGIN CREDENTIALS — model B (0068): ENCRYPTED VALUES. { credentialRole -> CIPHERTEXT }
    -- (e.g. { username -> 'v1:…', password -> 'v1:…' }). The api ENCRYPTS on write; the runner DECRYPTS at
    -- run time (loginCredentials.ts) → the SW_CRED_<ROLE> one-run publish → credential(role) in the spec.
    -- WRITE-ONLY read DTO (masked). Value never logged/traced; a registered redact rule scrubs any text leak.
    -- Fail-CLOSED on decrypt (a legacy env-var-ref-name is NOT "v1:" ciphertext → run errors until re-seeded).
    login_credentials  JSONB,

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

    -- Reversible, DASHBOARD-OWNED archive (mirrors 0071_checks_archived_at.sql). NULL = active;
    -- a timestamp = archived (stops running, shows "archived", re-activatable — clear it to restore the
    -- exact prior enabled/paused state). DISTINCT from pause (enabled=false). The runner's due-loop +
    -- on-demand gates add `archived_at IS NULL`. ★ In NEITHER reconcile allow-list → a manifest apply
    -- NEVER writes it (survives reconcile, like tags). Set/cleared by the api (PUT /checks/{id}/archive).
    archived_at        TIMESTAMPTZ,

    -- Git-removal purge clock (mirrors 0072_checks_removed_at.sql). NULL = the source_key IS in the
    -- manifest (present in git); a timestamp = ABSENT from the manifest (git-removed) — the 90-day purge
    -- clock. ★ RECONCILE-LIFECYCLE-OWNED (the OPPOSITE of archived_at): reconcile's removedAtUpdates
    -- auto-sync stamps now() when the id leaves the manifest (idempotent) and clears it when the id
    -- returns (cancel purge). The daily retention job hard-deletes past-90d rows EXCEPT incident-pinned
    -- ones (deferred). The api only READS it (renders "pending purge"); removal is git-driven, not a user action.
    removed_at         TIMESTAMPTZ,

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

    -- MONITOR trust budget (0080). "this monitor may be MONITOR-SIDE flaky ≤ X% of scheduled runs." NULL ⇒ the
    -- FLEET DEFAULT (2%, in flake_status) — NOT opt-in like slo_target (a per-monitor value overrides). ★
    -- DASHBOARD-OWNED: in NEITHER reconcile write allow-list, so a manifest apply can never clobber an override.
    flake_target          NUMERIC CHECK (flake_target IS NULL OR (flake_target >= 0 AND flake_target < 1)),

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

    -- Environment dimension (mirrors 0059_checks_environment.sql, pre-prod-regression arc S1a).
    -- DEFAULT 'prod' → every existing/native check is in the prod fleet; only a deliberate non-prod
    -- value takes a check OUT of the prod rollups. The default-EXCLUDE lives in the readers
    -- (coalesce(environment,'prod')='prod' in synthwatch-api's slo/mttr/trust). CHECK pins the
    -- vocabulary so a typo can't silently drop a check from the prod fleet.
    environment        TEXT        NOT NULL DEFAULT 'prod'
                       CONSTRAINT checks_environment_vocab
                       CHECK (environment IN ('prod', 'staging', 'dev')),

    -- Per-check ENV OVERRIDE (env PR-3, mirrors 0074_checks_environment_override.sql). DASHBOARD-OWNED:
    -- NULL = no override → use the derived `environment` (manifest ?? domain-inference ?? 'prod', PR-2). A
    -- value WINS over the derived env. ★ In NEITHER reconcile allow-list (like archived_at) → a manifest
    -- apply / re-infer / backfill can NEVER clobber it. Readers coalesce: effective env =
    -- coalesce(environment_override, environment). Set/cleared via PUT /api/checks/{id}/environment.
    environment_override TEXT
                       CONSTRAINT checks_environment_override_vocab
                       CHECK (environment_override IN ('prod', 'staging', 'dev')),

    -- S2 host-rewrite FROM origin (mirrors 0060_checks_rewrite_from_origin.sql, pre-prod-arc S3). When set,
    -- the runner rewrites requests whose origin == this to the check's OWN target_url origin (the preview
    -- env), so a pre-prod check reuses a prod spec WITHOUT editing it. NULL = no rewrite (S2 inert).
    rewrite_from_origin TEXT,

    -- Browser red-test route-block pattern (mirrors 0063_checks_redtest_anchor.sql, recon #55 gap A). The
    -- request glob the browser red-test aborts to prove the monitor goes RED. NULL = no browser red-test
    -- anchor. Manifest-declared + SCOPED-SYNCED (like sensitive/redact) — deliberately NOT in the positional
    -- reconcile-apply plan tuple (avoids the #216 materialize desync).
    redtest_anchor     TEXT,

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
-- env_domain_map: ordered domain→environment inference for reconcile-apply (0073).
-- reconcile resolves checks.environment as manifest.environment ?? inferFromDomain(target_url, map) ?? 'prod'
-- (explicit manifest > inferred > default). Pattern = exact host or `*.suffix` wildcard (host == suffix OR
-- host endsWith '.'+suffix); lowest priority wins, ties by id. runner/envDomainMap.ts is the matcher. The
-- API only SELECTs it (read endpoint; CRUD is env PR-3). Seed is conservative — matches no current prod host.
-- ---------------------------------------------------------------------------
CREATE TABLE env_domain_map (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    pattern     text NOT NULL UNIQUE
                CHECK (pattern = lower(pattern) AND pattern !~ '[[:space:]]'),
    environment text NOT NULL CHECK (environment IN ('prod','staging','dev')),
    priority    int  NOT NULL DEFAULT 100 CHECK (priority >= 0),
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX env_domain_map_priority_idx ON env_domain_map (priority, id);
INSERT INTO env_domain_map (pattern, environment, priority) VALUES
    ('preview.commerce.wegmans.com', 'staging', 100),
    ('*.preview.wegmans.com',        'staging', 200),
    ('*.staging.wegmans.com',        'staging', 200),
    ('*.dev.wegmans.com',            'dev',     200),
    ('localhost',                    'dev',     300),
    ('127.0.0.1',                    'dev',     300)
ON CONFLICT (pattern) DO NOTHING;

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
    location       TEXT NOT NULL DEFAULT 'default',
    -- The PUBLIC egress IP the runner left from (static-egress-IP Phase 0; mirrors 0054_runs_egress_ip.sql).
    -- Best-effort/fail-soft (NULL when the reflector was unreachable); NOT sensitive (our own infra IP).
    egress_ip      TEXT,
    -- Sandbox run (mirrors 0065_runs_sandbox.sql): true when this row was written by a PAUSED-monitor
    -- on-demand validation run (skips evaluate() — no incident/alert/SLO). Stamps the run so a resumed
    -- monitor's historical sandbox runs stay distinguishable (badge + optional SLO exclusion). DEFAULT
    -- false = a normal run.
    sandbox        BOOLEAN NOT NULL DEFAULT false,
    -- Confirmation-retry (mirrors 0077). Browser/multistep only: a failed SCHEDULED run enqueues ONE
    -- confirmation run in a FRESH ACA execution (fresh 660s) that OWNS the verdict.
    --   confirmation_of_run_id — set on the CONFIRMATION run, points at the original it is confirming.
    --   superseded_by_run_id   — set on the ORIGINAL when its confirmation PASSED (⇒ it was a transient). The
    --     read-side health filters (sla_availability, slo_status, aggregateVerdict, rollup, status page) exclude
    --     WHERE this IS NOT NULL, so a transient stays VISIBLE in run history but never moves a health signal.
    -- Both self-FKs are ON DELETE SET NULL so 90d row-retention (purging the pair together) is never blocked.
    confirmation_of_run_id BIGINT REFERENCES runs(id) ON DELETE SET NULL,
    superseded_by_run_id   BIGINT REFERENCES runs(id) ON DELETE SET NULL,
    -- B3-2 stage 2 (mirrors 0079): the classification of a SUPERSEDED transient — monitor-side (a monitor bug
    -- cried wolf), service-side (a real, brief first-party outage the monitor caught), or indeterminate (no
    -- signals to tell). Set ONLY on a superseded transient (evaluate.applyRunSideEffects); NULL otherwise.
    -- B3-3's flake budget burns ONLY monitor-side transients — a service-side one is a real outage and must
    -- not penalise the monitor that caught it. A SHARED column: the synthwatch-api fixture + EF entity mirror it.
    transient_class TEXT
        CONSTRAINT runs_transient_class_check
        CHECK (transient_class IS NULL OR transient_class IN ('monitor-side', 'service-side', 'indeterminate'))
);

-- Hot path: "latest N runs for this check, newest first" (status pages, the
-- consecutive-failure count in evaluate.ts).
CREATE INDEX runs_check_started_idx ON runs (check_id, started_at DESC);

-- Backs the stale-'running' reap (reapStaleRunning() in runner/index.ts, ~288×/day):
--   WHERE status='running' AND started_at < now() - interval '30 min'.
-- PARTIAL on the handful of in-flight rows (not the whole history), so the reap is an
-- index scan over ~1 row instead of a full seq scan of the unbounded runs table.
-- Mirrors 0058_runs_running_started_idx.sql (created CONCURRENTLY on a live DB).
CREATE INDEX runs_running_started_idx ON runs (started_at) WHERE status = 'running';

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
    rca_notified_at      TIMESTAMPTZ,
    -- ★ DELIVERY ACCOUNTING (0082): a failed page and a successful page must NOT leave identical DB state.
    -- Set by recordIncidentDispatch (runner/evaluate.ts) after every incident dispatch (open/resolve/enrich):
    -- 'sent' (>=1 channel delivered) / 'failed' (all channels rejected — ALSO writes a runner_errors row) /
    -- 'skipped' (no deliverable channel — a REAL state, must not read as success). The columns hold the
    -- LATEST attempt + a running count; the durable per-failure trail is runner_errors.
    notify_attempted_at  TIMESTAMPTZ,
    notify_status        TEXT        CONSTRAINT incidents_notify_status_chk CHECK (notify_status IS NULL OR notify_status IN ('sent', 'failed', 'skipped')),
    notify_error         TEXT,
    notify_attempts      INTEGER     NOT NULL DEFAULT 0
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
-- '__canary__' (0088): a DISABLED, unrouted email channel that anchors the notification canary's evidence
-- rows in test_send_requests (channel_id = __canary__ marks a canary probe vs a user test-send). It is NEVER
-- an alert-routing target (enabled=false + no alert_routes row); the canary probe delivers to CANARY_EMAIL_TO
-- (runner env), not to this channel. See runner/canary.ts + db/migrations/0088_canary_channel.sql.
INSERT INTO channels (name, type, config, enabled) VALUES
    ('email',      'email',   '{}'::jsonb, true),
    ('webhook',    'webhook', '{}'::jsonb, true),
    ('__canary__', 'email',   '{}'::jsonb, false);
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
    completed_at TIMESTAMPTZ,
    -- SANDBOX run of a PAUSED monitor (migration 0064). true → the runner claims + runs this request even
    -- though the check is disabled, writing a visible runs row + trace but SKIPPING evaluate() (no incident/
    -- alert/SLO) and never resuming the check. DEFAULT false = a normal request (still rejected for a
    -- disabled check by the `AND c.enabled` claim gates).
    sandbox      BOOLEAN     NOT NULL DEFAULT false,
    -- CONFIRMATION run of a failed scheduled browser/multistep check (mirrors 0077). true → drainRunRequests
    -- runs it as the confirmation that OWNS the verdict (links the new run to the original via
    -- runs.confirmation_of_run_id). Per-request flavor flag, mirroring `sandbox`. DEFAULT false = a normal request.
    confirmation BOOLEAN     NOT NULL DEFAULT false
);
CREATE INDEX run_requests_pending_idx ON run_requests (requested_at) WHERE status = 'pending';
-- Idempotency: at most one pending request per check (re-clicks coalesce).
CREATE UNIQUE INDEX run_requests_one_pending_per_check ON run_requests (check_id) WHERE status = 'pending';

-- sandbox_preview (0093): the lifecycle + AUDIT record for a spec preview-run (POST /api/preview). ★ Written by
-- the API, NOT the sandbox job (the synthwatch-sandbox ACA job is DB-less by design — part of its low-priv
-- shape). The API INSERTs 'running', starts the job, then UPDATEs on completion. ★ Stores the spec SHA-256, NOT
-- the body (retention: the body rides an ephemeral env override to the sandbox; the trace lives in the TTL'd
-- sandbox-artifacts blob). See db/migrations/0093_sandbox_preview.sql.
CREATE TABLE sandbox_preview (
    id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    token         TEXT        NOT NULL UNIQUE,   -- opaque result token (API-generated); names the blob + the GET poll
    actor_email   TEXT        NOT NULL,          -- WHO (IAuthPrincipal) — audit actor + per-user rate-limit key
    actor_ip      TEXT,
    spec_sha256   TEXT        NOT NULL,          -- WHAT (the hash, never the body)
    target_url    TEXT        NOT NULL,
    status        TEXT        NOT NULL DEFAULT 'running'
                              CHECK (status IN ('running', 'done', 'failed', 'timeout')),
    requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at  TIMESTAMPTZ,
    exit_code     INTEGER,
    error         TEXT,
    redact_credentials boolean NOT NULL DEFAULT true  -- 0094: per-run Tests-UI redaction toggle (audit)
);
CREATE INDEX sandbox_preview_actor_idx ON sandbox_preview (actor_email, requested_at DESC);
CREATE INDEX sandbox_preview_running_idx ON sandbox_preview (requested_at) WHERE status = 'running';

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
                            CHECK (drift_type IN ('new', 'changed', 'missing', 'orphan', 'redaction_mismatch')),
    detail      jsonb       NOT NULL DEFAULT '{}'::jsonb,
    detected_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (source_key, drift_type)
);

-- reconcile_apply_plan (0051): the DRY-RUN apply plan (reconcile-apply Phase 0). Per drift row, the exact
-- statement(s) apply WOULD run, persisted read-only — NOTHING is applied to checks/check_locations. Separate
-- from reconcile_drift (which is full-reloaded each run) so the plan + its future approve/reject state survive.
CREATE TABLE reconcile_apply_plan (
    id          bigserial   PRIMARY KEY,
    source_key  text        NOT NULL,
    drift_type  text        NOT NULL
                            CHECK (drift_type IN ('new', 'changed', 'missing', 'orphan', 'redaction_mismatch')),
    status      text        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'auto', 'blocked', 'noop', 'approved', 'rejected', 'applied')),
    plan        jsonb       NOT NULL DEFAULT '{}'::jsonb,
    computed_at timestamptz NOT NULL DEFAULT now(),
    -- Phase 1 (0052): who decided + when applied (the at-a-glance audit columns; the audit_log has the rest).
    decided_at  timestamptz,
    decided_by  text,
    applied_at  timestamptz,
    UNIQUE (source_key, drift_type)
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

-- ★ countable_run (0081): the ONE canonical "countable scheduled observation" — a real-result,
-- non-superseded, non-sandbox run, MINUS redundant DOWN confirmation re-checks. Defined before the
-- functions below because SQL-language function bodies are validated against catalog objects at CREATE
-- time. Consumed by sla_availability, slo_status (below), daily_check_rollup (runner/rollup.ts), and the
-- incident verdict (runner/evaluate.ts aggregateVerdict + countConsecutiveDown). ★ flake_status
-- deliberately does NOT use it — a flap IS a superseded run (see its comment below). Maintenance-window
-- exclusion stays per-consumer (contextual: run.started_at vs each window's range).
-- ★ EXPLICIT column list, NOT SELECT * (0083). SELECT * pinned EVERY runs column into the view's contract —
-- including retry_count, which no consumer reads yet whose drop the view then blocked (a view on SELECT * is
-- a schema contract nobody agreed to; it froze synthwatch-api's fixture-vs-migrations parity gate). List only
-- what the five consumers read — adding a column later is a deliberate act. Consumers & their columns:
-- sla_availability/slo_status (check_id, started_at, status); aggregateVerdict + countConsecutiveDown
-- (check_id, started_at, status, location); computeRollupForDay (id, check_id, started_at, status, duration_ms).
CREATE OR REPLACE VIEW countable_run AS
    SELECT id, check_id, status, started_at, location, duration_ms
      FROM runs
     WHERE status NOT IN ('running', 'infra_error')
       AND superseded_by_run_id IS NULL
       -- ★ A confirmation run is a SECOND SAMPLE of a tick we ALREADY sampled — not a new observation.
       -- The scheduled probe at 10:00 FAILED. That is the observation on the cadence. We then took another
       -- sample, OFF-CADENCE and TRIGGERED BY THE FAILURE, and it passed.
       -- ★ Counting that pass as "up" means: when a scheduled probe fails, re-roll, and report the good
       -- result. We ONLY ever re-roll on a bad result — a passing scheduled run never gets a second sample.
       -- So the extra samples are drawn EXCLUSIVELY from the failure population and ONLY the good outcomes
       -- survive. That is not modeling. It is a bias with a mechanism.
       -- ★★ THE PROOF: a service that fails 50% of scheduled runs, whose confirmations all pass, reports
       -- 100% AVAILABILITY under the asymmetric rule — every failure is superseded (excluded) AND replaced
       -- by a passing confirmation (counted). The denominator never sees them.
       -- ★ The transient is NOT lost information — it is recorded in flake_status, with its own
       -- classification, budget, and directed task. That is why the flake budget is a SEPARATE AXIS.
       -- Excluding both says "this tick was a transient, counted over there." Counting the recovery as "up"
       -- says "it was fine" — which it demonstrably was not.
       -- ★ ACCEPTED COST: a self-healed blip contributes ZERO to availability, thinning the denominator.
       -- A thin denominator is VISIBLE (the sample count is right there). An inflated numerator is INVISIBLE,
       -- and it inflates most on exactly the monitors you trust least. Take the metric that admits it
       -- doesn't know. (Ruling, not a bug fix — see db/migrations/0083; confirmationRetry #7/#8 updated.)
       AND confirmation_of_run_id IS NULL
       AND NOT sandbox;

-- ★ latency_sample (0092): the canonical "real measured latency sample" — a pass/warn, NON-sandbox run.
-- Sibling of countable_run but a DELIBERATELY DIFFERENT predicate, and NOT a bug vs it (do not "unify"):
--   • KEEPS confirmations — a confirmation's DURATION is a real measurement; the re-roll bias countable_run
--     corrects is an AVAILABILITY problem, not a latency one, so latency counts every real sample.
--   • EXCLUDES sandbox — a test-send must not move a reported percentile.
--   • status IN ('pass','warn') — only runs that produced a duration (this also makes superseded moot: we
--     only re-check failures, so a pass/warn run is essentially never superseded).
--   • Maintenance-window exclusion stays PER-CONSUMER (contextual), like countable_run.
-- Consumers: narrative.ts latency percentiles + synthwatch-api /reports/performance. Explicit column list
-- (the 0083 lesson) — only what they read. See db/migrations/0092_latency_sample_view.sql for the rationale.
CREATE OR REPLACE VIEW latency_sample AS
    SELECT id, check_id, status, started_at, duration_ms
      FROM runs
     WHERE status IN ('pass', 'warn')
       AND NOT sandbox;

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
    -- ★ countable_run (0081): status / superseded / confirmation / sandbox are now filtered by the view
    -- (was an inline `LEFT JOIN runs r … AND NOT r.sandbox AND r.superseded_by_run_id IS NULL`, which
    -- missed confirmation runs → a confirmed outage double-counted). One canonical predicate now.
    LEFT JOIN countable_run r
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
    'Per-check availability over [p_from, p_to). up=(pass,warn) / completed=(pass,warn,fail,error); running + sandbox excluded. On-demand, index-assisted.';

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
        -- ★ countable_run (0081): also excludes confirmation runs AND sandbox runs — BOTH were missing
        -- here (only superseded was excluded), so a confirmed outage double-counted its burn and a paused
        -- monitor's sandbox run consumed the error budget. slo_status drives paging, so this was the worst.
        LEFT JOIN countable_run r
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

-- ---------------------------------------------------------------------------
-- flake_status: per-check MONITOR trust budget over a window (0080). Mirrors slo_status' algebra
--   budget = target × N · consumed · remaining · burn_rate = (consumed/N)/target
-- but N = SCHEDULED runs (denominator INCLUDES superseded transients — they ARE scheduled ticks that flaked;
-- EXCLUDES confirmations + sandbox + maintenance), and consumed = MONITOR-SIDE transients ONLY. service_side +
-- indeterminate are surfaced, NEVER consumed. Fleet default 2% via COALESCE; a row for EVERY check (fleet-
-- default, not opt-in). ★ READ-ONLY — no write path to alerts/routing; a breach surfaces a directed task, never
-- a mute. (GRANT EXECUTE to "synthwatch-api" via the migration / ops, mirroring slo_status.)
-- ★ DELIBERATELY NOT a countable_run consumer (0081): the health paths exclude superseded transients, but
-- here a superseded transient IS the flap being measured (the numerator selects superseded_by_run_id IS NOT
-- NULL). Feeding it countable_run would zero the numerator and erase the signal. Do NOT "unify" this.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION flake_status(p_check_id bigint, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
    check_id          bigint,
    flake_target      numeric,
    target_is_default boolean,
    window_from       timestamptz,
    window_to         timestamptz,
    scheduled_runs    bigint,
    monitor_side      bigint,
    service_side      bigint,
    indeterminate     bigint,
    budget            numeric,
    consumed          bigint,
    remaining         numeric,
    remaining_pct     numeric,
    burn_rate         numeric
)
LANGUAGE sql
STABLE
AS $$
    WITH agg AS (
        SELECT
            c.id AS check_id,
            -- ★ FLEET DEFAULT 2% (0.02) — justified by the measured flap distribution (p95 ≤0.016% → ~125×
            -- headroom; worst non-service flapper 1.1%) + stage-1 spurious-red bands (elevated 1%, flaky 5%).
            COALESCE(c.flake_target, 0.02)::numeric AS flake_target,
            (c.flake_target IS NULL)                AS target_is_default,
            count(*) FILTER (
                WHERE r.confirmation_of_run_id IS NULL AND NOT r.sandbox) AS scheduled_runs,
            count(*) FILTER (
                WHERE r.superseded_by_run_id IS NOT NULL AND r.transient_class = 'monitor-side'
                  AND r.confirmation_of_run_id IS NULL AND NOT r.sandbox) AS monitor_side,
            count(*) FILTER (
                WHERE r.superseded_by_run_id IS NOT NULL AND r.transient_class = 'service-side'
                  AND r.confirmation_of_run_id IS NULL AND NOT r.sandbox) AS service_side,
            count(*) FILTER (
                WHERE r.superseded_by_run_id IS NOT NULL AND r.transient_class = 'indeterminate'
                  AND r.confirmation_of_run_id IS NULL AND NOT r.sandbox) AS indeterminate
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
          AND mw.id IS NULL
        GROUP BY c.id, c.flake_target
    )
    SELECT
        check_id,
        flake_target,
        target_is_default,
        p_from AS window_from,
        p_to   AS window_to,
        scheduled_runs,
        monitor_side,
        service_side,
        indeterminate,
        flake_target * scheduled_runs                    AS budget,
        monitor_side                                     AS consumed,
        flake_target * scheduled_runs - monitor_side     AS remaining,
        CASE WHEN flake_target * scheduled_runs > 0
             THEN round(1 - monitor_side::numeric / (flake_target * scheduled_runs), 6)
             END                                         AS remaining_pct,
        CASE WHEN scheduled_runs > 0 AND flake_target > 0
             THEN round((monitor_side::numeric / scheduled_runs) / flake_target, 4)
             ELSE 0 END                                  AS burn_rate
    FROM agg
$$;

COMMENT ON FUNCTION flake_status(bigint, timestamptz, timestamptz) IS
    'Per-check MONITOR trust budget over [p_from, p_to): consumed = MONITOR-SIDE transients ONLY (service-side + indeterminate surfaced, never consumed). budget = flake_target × scheduled_runs; fleet default 2% via COALESCE. READ-ONLY — never mutes an alert; a breach surfaces a directed monitor-health task.';

-- cost_projection — the SINGLE shared cost model (0069, +run-counts 0078, +compute-share 0089, +per-monitor
-- DOLLAR 0091). The 3-param cost_projection(rate, free_grant_$, reconcile_target) is the real model:
-- estimated_monthly is the PRIMARY per-monitor $ (free-grant-aware, Σ = the reconcile anchor); active_seconds_7d
-- + compute_share_pct are the SECONDARY share. The 1-param cost_projection(rate) is a deploy-safe WRAPPER
-- (legacy 20-col shape) the api used before PR2 — a later cleanup drops it. divergence SURVIVES (pure run-count
-- ratio). See runner/costModel.ts for the rate + freeGrantDollars() + reconcileTargetMonthly().
CREATE OR REPLACE FUNCTION cost_projection(p_rate numeric, p_free_grant_dollars numeric, p_reconcile_target numeric)
RETURNS TABLE (
    check_id              bigint,
    source_key            text,
    check_name            text,
    kind                  text,
    interval_seconds      integer,
    region_count          integer,
    avg_duration_s        double precision,
    active_seconds_7d     numeric,   -- 0089: Σ measured active-seconds over 7d — the attributable compute (SECONDARY)
    compute_share_pct     numeric,   -- 0089: 100 × active_seconds_7d / fleet total; null when fleet total is 0 (SECONDARY)
    projected             numeric,   -- from-zero $ (the compute WEIGHT + drift reference) — no longer the display $
    measured              numeric,   -- ×30/7 annualizer (drift reference)
    divergence            numeric,   -- rounded 3dp; null when projected = 0 — SURVIVES (pure run-count ratio)
    divergence_flag       boolean,   -- divergence > 1.5
    projected_raw         numeric,   -- unrounded from-zero — sum for the fleet FZ / drift, THEN round
    measured_raw          numeric,
    run_count_7d          integer,
    confirmation_count_7d integer,
    sandbox_count_7d      integer,
    run_count_recent      integer,
    run_count_prior       integer,
    estimated_monthly     numeric,   -- ★ 0091: the PRIMARY per-monitor $ — free-grant-aware, Σ = the reconcile anchor; null when no runs
    fleet_billable_monthly numeric   -- ★ 0091: grant-corrected fleet total (FZ − free grant $), CONSTANT per row — for the drift check
)
LANGUAGE sql
STABLE
AS $$
    WITH run_stats AS (
        SELECT r.check_id,
               (avg(r.duration_ms) / 1000.0)::float8 AS avg_duration_s,
               (sum(r.duration_ms) / 1000.0)::float8 AS sum_duration_s_7d,
               count(*)::int AS run_count_7d,
               count(*) FILTER (WHERE r.confirmation_of_run_id IS NOT NULL)::int AS confirmation_count_7d,
               count(*) FILTER (WHERE r.sandbox)::int AS sandbox_count_7d,
               count(*) FILTER (WHERE r.started_at >  now() - interval '3.5 days')::int AS run_count_recent,
               count(*) FILTER (WHERE r.started_at <= now() - interval '3.5 days')::int AS run_count_prior
          FROM runs r
         WHERE r.started_at > now() - interval '7 days'
           AND r.duration_ms IS NOT NULL
         GROUP BY r.check_id
    ),
    base AS (
        SELECT c.id AS check_id, c.source_key, c.name AS check_name, c.kind, c.interval_seconds,
               (SELECT count(*)::int FROM check_locations cl WHERE cl.check_id = c.id) AS region_count,
               rs.avg_duration_s, rs.sum_duration_s_7d,
               coalesce(rs.run_count_7d, 0)          AS run_count_7d,
               coalesce(rs.confirmation_count_7d, 0) AS confirmation_count_7d,
               coalesce(rs.sandbox_count_7d, 0)      AS sandbox_count_7d,
               coalesce(rs.run_count_recent, 0)      AS run_count_recent,
               coalesce(rs.run_count_prior, 0)       AS run_count_prior
          FROM checks c
          LEFT JOIN run_stats rs ON rs.check_id = c.id
         -- ★ 0086/#313: exclude ARCHIVED checks — every ACTIVE monitor appears (the truncation fix is client-side).
         WHERE c.enabled AND c.archived_at IS NULL
    ),
    scored AS (
        SELECT b.*,
               coalesce(b.sum_duration_s_7d, 0)::numeric                          AS active_seconds_7d,
               sum(coalesce(b.sum_duration_s_7d, 0)::numeric) OVER ()             AS fleet_active_seconds_7d,
               CASE WHEN b.avg_duration_s IS NOT NULL AND b.interval_seconds > 0
                    THEN b.avg_duration_s::numeric * (2592000::numeric / b.interval_seconds) * b.region_count * p_rate
                    ELSE 0 END AS p_raw,
               CASE WHEN b.sum_duration_s_7d IS NOT NULL
                    THEN b.sum_duration_s_7d::numeric * p_rate * (30::numeric / 7::numeric)
                    ELSE 0 END AS m_raw
          FROM base b
    ),
    fleeted AS (
        -- ★ 0091: fleet from-zero total FZ (window sum of p_raw), and the grant-corrected + reconcile anchor.
        SELECT s.*,
               sum(s.p_raw) OVER ()                                              AS fleet_p_raw,
               greatest(0::numeric, sum(s.p_raw) OVER () - coalesce(p_free_grant_dollars, 0)) AS fleet_billable
          FROM scored s
    )
    SELECT f.check_id, f.source_key, f.check_name, f.kind, f.interval_seconds, f.region_count, f.avg_duration_s,
           round(f.active_seconds_7d, 3) AS active_seconds_7d,
           CASE WHEN f.fleet_active_seconds_7d > 0
                THEN round(100 * f.active_seconds_7d / f.fleet_active_seconds_7d, 2)
                ELSE NULL END AS compute_share_pct,
           round(f.p_raw, 2) AS projected,
           round(f.m_raw, 2) AS measured,
           CASE WHEN f.p_raw > 0 THEN round(f.m_raw / f.p_raw, 3) ELSE NULL END AS divergence,
           CASE WHEN f.p_raw > 0 THEN round(f.m_raw / f.p_raw, 3) > 1.5 ELSE false END AS divergence_flag,
           f.p_raw AS projected_raw,
           f.m_raw AS measured_raw,
           f.run_count_7d, f.confirmation_count_7d, f.sandbox_count_7d, f.run_count_recent, f.run_count_prior,
           -- ★ 0091: allocate the reconcile anchor (target, or grant-corrected fleet) BY compute share. NULL
           -- when this monitor has no from-zero compute (no runs) — never a fake $0. Σ = the anchor.
           CASE WHEN f.fleet_p_raw > 0 AND f.p_raw > 0
                THEN round(f.p_raw / f.fleet_p_raw * coalesce(p_reconcile_target, f.fleet_billable), 2)
                ELSE NULL END AS estimated_monthly,
           round(f.fleet_billable, 2) AS fleet_billable_monthly
      FROM fleeted f
$$;

COMMENT ON FUNCTION cost_projection(numeric, numeric, numeric) IS
    'Free-grant-aware cost model (0091). estimated_monthly = per-monitor $ = (from-zero compute share) × the reconcile anchor, where anchor = coalesce(p_reconcile_target, grant-corrected fleet total = Σprojected − p_free_grant_dollars). Σ estimated_monthly = the anchor; the free grant is spread proportionally (cheap checks discounted, never zeroed); null when no runs. compute_share_pct/active_seconds_7d are the SECONDARY signal; fleet_billable_monthly + projected_raw feed the drift check vs Azure''s forecast.';

-- ★ Deploy-safe: rewrite the 1-param as a thin WRAPPER over the 3-param (same 20-col return), so the still-old
-- api keeps working until PR2 switches it. grant$=0 / target=NULL is irrelevant here (the wrapper drops the two
-- new columns). Return type UNCHANGED → CREATE OR REPLACE (no DROP).
CREATE OR REPLACE FUNCTION cost_projection(p_rate numeric)
RETURNS TABLE (
    check_id              bigint,
    source_key            text,
    check_name            text,
    kind                  text,
    interval_seconds      integer,
    region_count          integer,
    avg_duration_s        double precision,
    active_seconds_7d     numeric,
    compute_share_pct     numeric,
    projected             numeric,
    measured              numeric,
    divergence            numeric,
    divergence_flag       boolean,
    projected_raw         numeric,
    measured_raw          numeric,
    run_count_7d          integer,
    confirmation_count_7d integer,
    sandbox_count_7d      integer,
    run_count_recent      integer,
    run_count_prior       integer
)
LANGUAGE sql
STABLE
AS $$
    SELECT check_id, source_key, check_name, kind, interval_seconds, region_count, avg_duration_s,
           active_seconds_7d, compute_share_pct, projected, measured, divergence, divergence_flag,
           projected_raw, measured_raw, run_count_7d, confirmation_count_7d, sandbox_count_7d,
           run_count_recent, run_count_prior
      FROM cost_projection(p_rate, 0::numeric, NULL::numeric)
$$;


-- azure_cost (0090) — single-row cache of what the runner PULLS from Azure Cost Management (rollup job,
-- azureCost.ts): MTD actual + Azure's own forecast for the RG scope. The cost panel DISPLAYS this (not a
-- modeled number); a stale/absent row → the UI deep-links to the portal (honestly absent beats falsely
-- precise). Runner writes (owner); api reads (SELECT grant below).
CREATE TABLE IF NOT EXISTS azure_cost (
    id             smallint    PRIMARY KEY DEFAULT 1,
    scope          text        NOT NULL,
    currency       text        NOT NULL,
    billing_month  date        NOT NULL,
    mtd_actual     numeric     NOT NULL,
    mtd_days       integer     NOT NULL,
    forecast_month numeric,
    portal_url     text        NOT NULL,
    fetched_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT azure_cost_singleton CHECK (id = 1)
);

-- slo_burn_status (0055): the SHARED, location-aware SLO burn STATE — reproduces the runner's
-- maybeBurnAlert threshold decision EXACTLY (read == page). STATE ONLY (no dispatch suppressors). See
-- 0055_slo_burn_status.sql for the full contract; the differential red-test proves it matches the TS
-- byte-for-byte (incl. ::text::float8 to mirror node-pg's float4 parse).
CREATE OR REPLACE FUNCTION slo_burn_status(p_check_id bigint)
RETURNS TABLE (
    check_id      bigint,
    burn_state    text,
    reported_burn double precision,
    detail        jsonb
)
LANGUAGE sql
STABLE
AS $$
WITH cfg AS (
    -- ★ ::text::float8, NOT ::float8 — DO NOT "simplify" this. node-pg parses the float4 slo_target from its
    -- TEXT form ("0.99" → float64 0.99); a direct ::float8 widens the float4 BINARY (0.990000009…), giving a
    -- different (1 - target), so the burn diverges at the threshold boundary. Casting through text reproduces
    -- node-pg byte-for-byte (the slo_burn_status differential red-test proves it). ★ The schema-parity gate
    -- NORMALIZES COMMENTS AWAY, so NOTHING will catch this comment's re-deletion — it is a comment whose
    -- ABSENCE causes a bug. Keep it in sync with 0055_slo_burn_status.sql.
    SELECT c.slo_target::text::float8 AS target,
           c.failure_threshold         AS floor,
           c.min_fail_locations        AS minfail
      FROM checks c
     WHERE c.id = p_check_id
),
loc AS (
    SELECT r.location,
           count(*) FILTER (WHERE r.status IN ('pass','warn','fail','error'))                                              AS total_6h,
           count(*) FILTER (WHERE r.status IN ('fail','error'))                                                            AS down_6h,
           count(*) FILTER (WHERE r.status IN ('pass','warn','fail','error') AND r.started_at >= now() - interval '1 hour')  AS total_1h,
           count(*) FILTER (WHERE r.status IN ('fail','error')                AND r.started_at >= now() - interval '1 hour')  AS down_1h,
           count(*) FILTER (WHERE r.status IN ('pass','warn','fail','error') AND r.started_at >= now() - interval '30 minutes') AS total_30m,
           count(*) FILTER (WHERE r.status IN ('fail','error')                AND r.started_at >= now() - interval '30 minutes') AS down_30m
      FROM runs r
      LEFT JOIN maintenance_windows mw
             ON (mw.check_id = r.check_id OR mw.check_id IS NULL)
            AND r.started_at >= mw.starts_at AND r.started_at < mw.ends_at
     WHERE r.check_id = p_check_id
       AND r.started_at >= now() - interval '6 hours' AND r.started_at < now()
       AND mw.id IS NULL
     GROUP BY r.location
),
rates AS (
    SELECT l.location,
           l.total_1h,  CASE WHEN l.total_1h  > 0 THEN (l.down_1h::float8  / l.total_1h)  / (1 - (SELECT target FROM cfg)) END AS burn_1h,
           l.total_6h,  CASE WHEN l.total_6h  > 0 THEN (l.down_6h::float8  / l.total_6h)  / (1 - (SELECT target FROM cfg)) END AS burn_6h,
           l.total_30m, CASE WHEN l.total_30m > 0 THEN (l.down_30m::float8 / l.total_30m) / (1 - (SELECT target FROM cfg)) END AS burn_30m
      FROM loc l
),
agg AS (
    SELECT
        (SELECT floor   FROM cfg) AS floor,
        (SELECT minfail FROM cfg) AS minfail,
        count(*) FILTER (WHERE total_1h  > 0)  AS rep_1h,
        count(*) FILTER (WHERE total_6h  > 0)  AS rep_6h,
        count(*) FILTER (WHERE total_30m > 0)  AS rep_30m,
        count(*) FILTER (WHERE total_1h  >= (SELECT floor FROM cfg) AND burn_1h  >= 14.4::float8) AS burn_n_1h,
        count(*) FILTER (WHERE total_6h  >= (SELECT floor FROM cfg) AND burn_6h  >= 6::float8)    AS burn_n_6h,
        count(*) FILTER (WHERE total_30m >= (SELECT floor FROM cfg) AND burn_30m >= 6::float8)    AS burn_n_30m,
        max(burn_1h) FILTER (WHERE total_1h >= (SELECT floor FROM cfg)) AS rb_1h,
        max(burn_6h) FILTER (WHERE total_6h >= (SELECT floor FROM cfg)) AS rb_6h
      FROM rates
),
verdict AS (
    SELECT
        CASE
            WHEN rep_1h > 0
             AND burn_n_1h >= (CASE WHEN minfail IS NULL THEN rep_1h / 2 + 1 ELSE least(minfail, rep_1h) END)
                THEN 'fast'
            WHEN rep_6h > 0 AND rep_30m > 0
             AND burn_n_6h  >= (CASE WHEN minfail IS NULL THEN rep_6h  / 2 + 1 ELSE least(minfail, rep_6h)  END)
             AND burn_n_30m >= (CASE WHEN minfail IS NULL THEN rep_30m / 2 + 1 ELSE least(minfail, rep_30m) END)
                THEN 'slow'
            ELSE 'none'
        END AS burn_state,
        rb_1h, rb_6h
      FROM agg
)
SELECT
    p_check_id AS check_id,
    CASE WHEN (SELECT target FROM cfg) IS NULL THEN 'none' ELSE v.burn_state END AS burn_state,
    CASE
        WHEN (SELECT target FROM cfg) IS NULL THEN 0::float8
        WHEN v.burn_state = 'fast'            THEN coalesce(v.rb_1h, 0)
        WHEN v.burn_state = 'slow'            THEN coalesce(v.rb_6h, 0)
        ELSE 0::float8
    END AS reported_burn,
    coalesce(
        (SELECT jsonb_agg(jsonb_build_object(
                    'location', location,
                    'burn_1h',  burn_1h,  'total_1h',  total_1h,
                    'burn_6h',  burn_6h,  'total_6h',  total_6h,
                    'burn_30m', burn_30m, 'total_30m', total_30m
                ) ORDER BY location)
           FROM rates),
        '[]'::jsonb
    ) AS detail
  FROM verdict v;
$$;

-- ---------------------------------------------------------------------------
-- runner_errors (0050): a QUERYABLE sink for the runner's top-level/uncaught exceptions. The global
-- handler (runnerErrors.ts) writes one row per fatal with a per-invocation correlation id, so a silent
-- failure is a one-grep diagnosis instead of an invisible ACA-stdout fact. Visibility-only.
-- ---------------------------------------------------------------------------
CREATE TABLE runner_errors (
    id            bigserial   PRIMARY KEY,
    invocation_id text        NOT NULL,
    occurred_at   timestamptz NOT NULL DEFAULT now(),
    phase         text        NOT NULL,
    check_id      bigint,
    run_id        bigint,
    message       text        NOT NULL,
    stack         text
);
CREATE INDEX runner_errors_occurred_at_idx ON runner_errors (occurred_at DESC);

-- deploys (migration 0056) — auto-detected deploy markers, one row per (host, distinct marker).
CREATE TABLE deploys (
    id           bigserial   PRIMARY KEY,
    target_host  text        NOT NULL,
    sha          text,
    fingerprint  text        NOT NULL,
    is_sha       boolean     NOT NULL DEFAULT false,
    source       text        NOT NULL,
    deployed_at  timestamptz NOT NULL DEFAULT now(),
    detected_at  timestamptz NOT NULL DEFAULT now(),
    detail       jsonb,
    CONSTRAINT deploys_host_fingerprint_key UNIQUE (target_host, fingerprint)
);
CREATE INDEX deploys_host_time_idx ON deploys (target_host, deployed_at DESC);

-- red_tests (migration 0057) — §D1 red-test capture: one row per HARNESS-CONFIRMED red-test. outcome is
-- CHECK-constrained to 'red' so an inconclusive/not-red run can never be persisted (the honesty guardrail at
-- the schema). The API reads it (trust scorecard); the runner (owner) writes it.
CREATE TABLE red_tests (
    id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    check_id   bigint      NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
    tested_at  timestamptz NOT NULL DEFAULT now(),
    method     text        NOT NULL CHECK (method IN ('executed-red-fixture', 'attested-manual')),
    outcome    text        NOT NULL CHECK (outcome IN ('red')),
    detail     jsonb
);
CREATE INDEX red_tests_check_time_idx ON red_tests (check_id, tested_at DESC);

-- error_mutes (migration 0076) — per-CHECK, per-FINGERPRINT mute for the error-diff NEW bucket (error-diff P4).
-- An operator MUTES a known/accepted NEW error; the API's error-diff read then moves that fingerprint out of
-- new[] into a muted[] bucket (never silently dropped). DASHBOARD-managed (API has SELECT/INSERT/DELETE — grant
-- is in the migration, not here). Notes are set at mute time, not editable (no UPDATE). check_id ON DELETE
-- CASCADE — a check purge takes its mutes with it. The UNIQUE(check_id, fingerprint) index also serves the
-- per-check load (WHERE check_id = $1). See runner db/migrations/0076_error_mutes.sql.
CREATE TABLE error_mutes (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    check_id    bigint NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
    fingerprint text NOT NULL,
    muted_at    timestamptz NOT NULL DEFAULT now(),
    muted_by    text NULL,
    note        text NULL,
    CONSTRAINT error_mutes_check_fingerprint_key UNIQUE (check_id, fingerprint)
);

-- ★ Audit + alarm a check_locations add/REMOVE, without preventing it (0085). Removing a location is an
-- unlogged, unalarmed way to make a monitor stop being red (westus2 off 341/342 Jul 5; centralus off 355
-- Jul 13 — audit_log had ZERO record of either). Best-effort, NEVER-BLOCKING trigger: it records who
-- (best-effort app.actor_email) / when / which check+location / THE LOCATION'S 24H FAILURE RATE to audit_log,
-- and on a removal of a location failing >= 10% ALSO writes a runner_errors row (loud, not illegal). Defined
-- last (needs check_locations + audit_log + runner_errors + runs). See db/migrations/0085.
CREATE OR REPLACE FUNCTION audit_check_location_change() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_check_id bigint;
  v_location text;
  v_runs     int;
  v_fail_pct numeric;
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN
      v_check_id := OLD.check_id;
      v_location := OLD.location;
      IF NOT EXISTS (SELECT 1 FROM checks WHERE id = v_check_id) THEN
        RETURN OLD; -- CASCADE delete of the whole check, not a coverage change
      END IF;
    ELSE
      v_check_id := NEW.check_id;
      v_location := NEW.location;
    END IF;

    SELECT count(*),
           round(100.0 * count(*) FILTER (WHERE status IN ('fail','error')) / nullif(count(*), 0), 1)
      INTO v_runs, v_fail_pct
      FROM runs
     WHERE check_id = v_check_id AND location = v_location
       AND started_at >= now() - interval '24 hours';

    INSERT INTO audit_log (actor_email, action, target_type, target_id, before_json, after_json, note)
    VALUES (
      current_setting('app.actor_email', true),
      CASE WHEN TG_OP = 'DELETE' THEN 'check_location.remove' ELSE 'check_location.add' END,
      'check', v_check_id::text,
      CASE WHEN TG_OP = 'DELETE'
           THEN jsonb_build_object('location', v_location, 'runs_24h', coalesce(v_runs, 0), 'fail_pct_24h', coalesce(v_fail_pct, 0))
           END,
      CASE WHEN TG_OP = 'INSERT' THEN jsonb_build_object('location', v_location) END,
      format('location %s %s check %s (last 24h: %s runs, %s%% failing)',
             v_location,
             CASE WHEN TG_OP = 'DELETE' THEN 'REMOVED from' ELSE 'added to' END,
             v_check_id, coalesce(v_runs, 0), coalesce(v_fail_pct, 0))
    );

    IF TG_OP = 'DELETE' AND coalesce(v_fail_pct, 0) >= 10 THEN
      INSERT INTO runner_errors (invocation_id, phase, check_id, message)
      VALUES (
        'db-trigger', 'check_location.remove', v_check_id,
        format('Location %s removed from check %s while FAILING %s%% over the last 24h (%s runs). Coverage shrank '
               || 'silently and the removal is unpaged by design — verify this was intentional (e.g. a bad egress IP) '
               || 'and not a way to clear a red. See audit_log.', v_location, v_check_id, v_fail_pct, v_runs)
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'audit_check_location_change failed for check % location % (%): %',
      coalesce(v_check_id, -1), coalesce(v_location, '?'), TG_OP, SQLERRM;
  END;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_check_location ON check_locations;
CREATE TRIGGER trg_audit_check_location
  AFTER INSERT OR DELETE ON check_locations
  FOR EACH ROW EXECUTE FUNCTION audit_check_location_change();

COMMIT;
