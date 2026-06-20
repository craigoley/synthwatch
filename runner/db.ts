// Shared Postgres connection pool + the row types the runner cares about.
// NodeNext ESM: note the explicit `.js` on every relative import elsewhere.
import pg from 'pg';

const { Pool } = pg;

// DATABASE_URL is required — the runner cannot do anything without the catalogue.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/** A row from the `checks` table (the bits the runner reads). */
export interface Check {
  id: number;
  name: string;
  kind: 'http' | 'browser';
  target_url: string;
  flow_name: string | null;
  method: string;
  expected_status: number;
  body_must_contain: string | null;
  interval_seconds: number;
  last_run_at: Date | null;
  timeout_ms: number;
  failure_threshold: number;
  severity: 'critical' | 'warning';
  enabled: boolean;
}

/** A row from the `runs` table after we've finished executing a check. */
export interface RunRecord {
  id: number;
  check_id: number;
  status: 'pass' | 'fail';
  failed_step: string | null;
  screenshot_url: string | null;
}
