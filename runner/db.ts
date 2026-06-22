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

// DATABASE_URL is required — the runner cannot do anything without the catalogue.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/** The full run-status taxonomy (mirrors the runs.status CHECK constraint). */
export type RunStatus = 'pass' | 'warn' | 'fail' | 'error' | 'running';

/** A run's status once it has finished — 'running' is in-flight, never terminal. */
export type TerminalStatus = Exclude<RunStatus, 'running'>;

/** A row from the `checks` table (the bits the runner reads). */
export interface Check {
  id: number;
  name: string;
  kind: 'http' | 'browser' | 'ssl';
  target_url: string;
  flow_name: string | null;
  method: string;
  expected_status: number;
  body_must_contain: string | null;
  // No-code assertion model + request config (kind='http'). assertions empty =>
  // legacy expected_status/body_must_contain. auth is a secret reference.
  assertions: Assertion[];
  request_headers: Record<string, string> | null;
  request_body: string | null;
  auth: AuthConfig | null;
  interval_seconds: number;
  last_run_at: Date | null;
  timeout_ms: number;
  failure_threshold: number;
  severity: 'critical' | 'warning';
  enabled: boolean;
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
}
