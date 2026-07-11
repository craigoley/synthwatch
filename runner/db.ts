// Shared Postgres connection pool + the row types the runner cares about.
// NodeNext ESM: note the explicit `.js` on every relative import elsewhere.
import pg from 'pg';
import type { Assertion } from './assertions.js';

const { Pool } = pg;

/**
 * Auth config for an http check — a SECRET REFERENCE, never a plaintext
 * credential. The *_env fields name a runner env var holding the actual secret.
 */
export interface AuthConfig {
  type: 'none' | 'basic' | 'bearer' | 'api_key';
  username?: string; // basic (not secret)
  password_env?: string; // basic
  token_env?: string; // bearer
  header?: string; // api_key header name (default x-api-key)
  value_env?: string; // api_key
}

/** Per-kind config for network checks (kind = dns | tcp | ping). Host is parsed
 *  from target_url; these are the extras. */
export interface NetConfig {
  recordType?: string; // dns: A | AAAA | CNAME | MX | TXT | NS (default A)
  expectedValue?: string; // dns: optional substring/value a record must match
  port?: number; // tcp (required unless host:port in target_url) / ping (default 443)
}

/** Pull a value from a step's JSON response into a named variable (kind='multistep'). */
export interface ExtractRule {
  var: string; // variable name; referenced later as {{var}}
  jsonPath: string; // minimal JSONPath into the parsed JSON body (see assertions.jsonPath)
}

/** One step of a multistep chain. The request shape mirrors a single http check;
 *  url/headers/body may contain {{var}} templates resolved from prior extracts. */
export interface ChainStep {
  name: string;
  method?: string; // default GET
  url: string; // may contain {{var}} templates
  headers?: Record<string, string>; // values may contain {{var}} templates
  body?: string; // may contain {{var}} templates
  auth?: AuthConfig | null; // secret-ref auth (the *_env model), never plaintext
  assertions?: Assertion[]; // reuse the assertion engine, per step
  extract?: ExtractRule[]; // pull response values into vars for later steps
}

// DATABASE_URL is required — the runner cannot do anything without the catalogue.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// ★ POOL-ERROR: pg emits an 'error' on the Pool when an IDLE backend connection drops (server restart,
// network blip, an Azure Postgres failover) BETWEEN queries. With NO listener, Node treats it as an
// unhandled 'error' event -> uncaughtException -> the whole tick dies (now visible via #149's handler,
// but it still kills the tick over a transient idle-conn blip). Logging it makes it non-fatal: pg discards
// the dead client and the next query checks out a fresh one. (No recordFatal: that writes to the DB, which
// is the thing that just blipped, and would create a db.ts <-> runnerErrors.ts import cycle.)
pool.on('error', (err) => {
  console.error('[db] idle client error (non-fatal; next query gets a fresh connection):', err.message);
});

/** The full run-status taxonomy (mirrors the runs.status CHECK constraint).
 *
 * 'infra_error' (Phase 6b Option C): the runner could NOT obtain the spec to run a browser
 * check (fetch failed AND no last-known-good cached). ★ It is NEITHER up (pass|warn) NOR down
 * (fail|error): a check that couldn't fetch its OWN spec is an INFRA problem, not a monitored-
 * site outage. It is excluded from SLA/availability (every SLA/rollup query uses explicit
 * pass/warn/fail/error lists, so a 5th status is auto-excluded) AND from incidents/paging
 * (evaluate() short-circuits it; the cross-location verdict ignores it). Like 'running' but
 * terminal — recorded + visible, never paged, never counted as downtime. */
export type RunStatus = 'pass' | 'warn' | 'fail' | 'error' | 'infra_error' | 'running';

/** A run's status once it has finished — 'running' is in-flight, never terminal. */
export type TerminalStatus = Exclude<RunStatus, 'running'>;

/** A row from the `checks` table (the bits the runner reads). */
export interface Check {
  id: number;
  name: string;
  kind: 'http' | 'browser' | 'ssl' | 'dns' | 'tcp' | 'ping' | 'multistep';
  target_url: string;
  flow_name: string | null;
  method: string;
  expected_status: number;
  body_must_contain: string | null;
  // No-code assertion model + request config (kind='http'). assertions empty =>
  // legacy expected_status/body_must_contain. auth is a secret reference.
  assertions: Assertion[];
  request_headers: Record<string, string> | null;
  // Per-monitor SECRET request headers (0061), references-only: { headerName -> ENV_VAR_NAME }. The
  // runner resolves process.env[ENV_VAR_NAME] at request time (secretHeaders.ts); the value is never
  // stored/logged/exposed. Mirrors `auth`'s *_env model. null = none.
  secret_headers: Record<string, string> | null;
  // Per-monitor LOGIN CREDENTIALS (0067), references-only: { credentialRole -> ENV_VAR_NAME } (e.g.
  // { username: 'SOME_USER_ENV', password: 'SOME_PASS_ENV' }). The runner resolves process.env[ENV_VAR_NAME]
  // at run time and exposes it to the browser spec as credential(role) (loginCredentials.ts); the value is
  // never stored/logged/exposed. Mirrors `secret_headers`/`auth`'s *_env model. null = none.
  login_credentials: Record<string, string> | null;
  request_body: string | null;
  auth: AuthConfig | null;
  // Per-kind config for dns/tcp/ping checks (host comes from target_url).
  net_config: NetConfig | null;
  // Ordered step chain for kind='multistep'. null for all other kinds.
  steps: ChainStep[] | null;
  // Multi-location: open an incident only when failing from >= this many distinct
  // locations. null => ALL REPORTING locations must fail (N-of-N over what's currently
  // reporting; a stale region is excluded so it can't block paging). An explicit INT =
  // that absolute threshold, capped at the reporting count. One reporting location =>
  // N=1 => pre-multi-location behaviour. See effectiveN()/crossLocationDown().
  min_fail_locations: number | null;
  interval_seconds: number;
  last_run_at: Date | null;
  timeout_ms: number;
  failure_threshold: number;
  // Fast-retry: within-run re-attempts on a transient 'error' (not 'fail'). The final
  // attempt is the run's verdict; intermediate attempts don't persist. 0 = no retry.
  retries: number;
  // B10 (0046): a cart/auth monitor whose trace can carry session tokens / PII. When true the runner
  // stores no RAW artifacts: a FAILED run persists a REDACTED/REDUCED trace zip (traceRedact.ts),
  // the permanent success-baseline zip + all screenshots are skipped, trace_signals is scrubbed
  // (denylist + redact_patterns), and error_message is value-scrubbed (diagnostic text kept).
  // redact_patterns = declared regex strings (the built-in denylist applies regardless).
  // DEFAULT false → non-sensitive monitors are unchanged.
  sensitive: boolean;
  redact_patterns: string[] | null;
  severity: 'critical' | 'warning';
  enabled: boolean;
  // Reversible dashboard-owned archive (0071). NULL = active; a timestamp = archived (excluded from the
  // due-loop + normal on-demand runs by the `archived_at IS NULL` gates). DISTINCT from enabled/pause.
  // Dashboard-owned: reconcile never writes it (absent from GIT_AUTHORITATIVE/SEED_ONLY), so it survives.
  archived_at: Date | null;
  // Git-removal purge clock (0072). NULL = present in the manifest; a timestamp = git-removed (absent from
  // the manifest) — the 90-day purge clock. RECONCILE-OWNED (the opposite of archived_at): reconcile's
  // removedAtUpdates auto-sync sets it (absent) / clears it (re-added); retention purges past-90d rows.
  removed_at: Date | null;
  // Perf budgets (Tier-1). A browser run that otherwise passes is downgraded to
  // 'warn' when a captured metric exceeds its budget. null => no budget for that
  // metric. claim() does SELECT *, so these ride along; typed here so code reads them.
  perf_budget_lcp_ms: number | null;
  perf_budget_transfer_bytes: number | null;
  // For kind='ssl': days-until-expiry threshold for the warn window (default 30).
  cert_expiry_warn_days: number;
  // Alert routing: the profile this check uses (null => the 'default' profile).
  alert_profile_id: number | null;
  // Warn-notify debounce: when we last sent a warn notification + the min
  // re-notify interval (so a persistent warn doesn't notify every tick).
  last_warn_notified_at: Date | null;
  warn_renotify_seconds: number;
  // SLO / error budget. slo_target in (0,1) e.g. 0.999; null => SLO off (opt-in).
  // last_burn_notified_at debounces burn-rate alerts (reuses warn_renotify_seconds).
  slo_target: number | null;
  last_burn_notified_at: Date | null;
  // Most-recent-passing browser screenshot baseline (Blob URL); RCA's visual-diff
  // reference. Overwritten on each passing browser run; null = none yet.
  baseline_screenshot_url: string | null;
  // Last-known-good Playwright TRACE baseline for this monitor (Blob URL at the stable,
  // purge-EXEMPT key success-latest/check-<id>.zip — overwritten on each success, one slot
  // per monitor). success_trace_at gates re-upload (refresh at most every few hours) and
  // dates the baseline in the UI. null/null => none yet. See uploadSuccessTrace + 0039.
  success_trace_url: string | null;
  success_trace_at: Date | null;
  // Monitors-as-code spec path (Phase 6b Option C, mirrors 0033). A Git-managed browser
  // check fetches+runs this spec from synthwatch-monitors at run start (see executeBrowser);
  // null => a legacy/dashboard check that runs the baked-in flow_name. claim() does SELECT *,
  // so it rides along; typed here so executeBrowser can branch on it.
  spec_path: string | null;
  // Environment dimension (0059). 'prod' (default) | 'staging' | 'dev'. The runner does not gate on it
  // (the pre-prod EXCLUDE is API-side); read here so reconcile can detect drift + it rides SELECT *.
  environment: string;
  // S2 host-rewrite FROM origin (0060). When non-null, executeBrowser re-points requests from this
  // origin to the check's target_url origin (the preview env). null => no rewrite (S2 inert).
  rewrite_from_origin: string | null;
  // Browser red-test route-block pattern (0063, recon #55 gap A). The request glob the browser red-test
  // aborts to prove the monitor reds. Read by the red-test harness; null => no browser red-test anchor.
  redtest_anchor: string | null;
}

/** A row from the `runs` table after we've finished executing a check. */
export interface RunRecord {
  id: number;
  check_id: number;
  status: TerminalStatus;
  /** The terminal run's message — failure reason, or the warn reason (e.g. the
   *  cert-expiry line). Carried into alert summaries. */
  error_message: string | null;
  failed_step: string | null;
  screenshot_url: string | null;
  /** The location that produced this run (the runner's SYNTHWATCH_LOCATION). */
  location: string;
}
