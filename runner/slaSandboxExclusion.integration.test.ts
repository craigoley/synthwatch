// LIVE integration proof that a paused monitor's on-demand SANDBOX run (0065 runs.sandbox) never counts
// toward availability — the "sandbox never counts" decision (migration 0066). Runs only when DATABASE_URL
// is set (skipped offline; exercised in CI's Postgres-service job). Two surfaces, both edited in this PR:
//   1. sla_availability() — the on-demand SLO function the 24h/7d/30d/90d views + the API read.
//   2. computeRollupForDay() — the nightly daily_check_rollup writer (historical availability charts).
// Property: a sandbox run in the window is invisible to BOTH; the same run with sandbox=false IS counted,
// proving the exclusion (not some other filter) is what gated it.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from './db.js';
import { computeRollupForDay } from './rollup.js';

const SKIP = !process.env.DATABASE_URL;

async function makeCheck(name: string): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO checks (name, kind, target_url, failure_threshold, severity, enabled)
     VALUES ($1, 'http', 'https://example.test', 1, 'critical', true) RETURNING id`,
    [name],
  );
  return rows[0].id;
}

// A terminal run at a fixed instant, optionally sandbox-flagged.
async function seedRun(checkId: number, status: string, at: string, sandbox: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO runs (check_id, status, started_at, finished_at, location, duration_ms, sandbox)
     VALUES ($1, $2, $3, $3, 'default', 100, $4)`,
    [checkId, status, at, sandbox],
  );
}

// ★ sla_availability(): a sandbox pass does not become an up_run; only the real fail is counted.
nodeTest('sla_availability excludes sandbox runs (paused-monitor validations never move the SLO)', { skip: SKIP }, async () => {
  const id = await makeCheck('__sla_sbx_fn__');
  try {
    const from = '2026-05-01T00:00:00Z';
    const to = '2026-05-02T00:00:00Z';
    await seedRun(id, 'fail', '2026-05-01T01:00:00Z', false); // real down
    await seedRun(id, 'pass', '2026-05-01T02:00:00Z', true); // SANDBOX up — must NOT count

    const { rows } = await pool.query<{ completed_runs: string; up_runs: string; down_runs: string; availability_pct: string | null }>(
      `SELECT completed_runs, up_runs, down_runs, availability_pct
         FROM sla_availability($1::timestamptz, $2::timestamptz) WHERE check_id = $3`,
      [from, to, id],
    );

    assert.equal(rows.length, 1);
    // Only the real fail is seen. If sandbox leaked in it'd be up=1/down=1 → 50%; exclusion → up=0/down=1 → 0%.
    assert.equal(Number(rows[0].up_runs), 0, 'sandbox pass is not an up_run');
    assert.equal(Number(rows[0].down_runs), 1, 'the real fail is counted');
    assert.equal(Number(rows[0].completed_runs), 1, 'sandbox is not in the completed denominator');
    assert.equal(Number(rows[0].availability_pct), 0, '0% — the sandbox pass did not lift availability');
  } finally {
    await pool.query(`DELETE FROM checks WHERE id = $1`, [id]);
  }
});

// ★ computeRollupForDay(): the nightly daily_check_rollup mirrors the exclusion.
nodeTest('daily_check_rollup excludes sandbox runs', { skip: SKIP }, async () => {
  const id = await makeCheck('__sla_sbx_rollup__');
  const day = '2026-05-01';
  try {
    await seedRun(id, 'pass', '2026-05-01T01:00:00Z', false); // real up
    await seedRun(id, 'fail', '2026-05-01T02:00:00Z', false); // real down
    await seedRun(id, 'pass', '2026-05-01T03:00:00Z', true); // SANDBOX up — must NOT count

    await computeRollupForDay(id, day);

    const { rows } = await pool.query<{ up_count: number; down_count: number; total_count: number; availability_pct: string | null }>(
      `SELECT up_count, down_count, total_count, availability_pct FROM daily_check_rollup WHERE check_id = $1 AND day = $2::date`,
      [id, day],
    );
    assert.equal(rows.length, 1);
    // Real: 1 up + 1 down = 2 total → 50%. With sandbox leaking it'd be 2 up / 3 total → 66.67%.
    assert.equal(rows[0].up_count, 1, 'sandbox pass is not counted up');
    assert.equal(rows[0].down_count, 1);
    assert.equal(rows[0].total_count, 2, 'sandbox is not in the rollup total');
    assert.equal(Number(rows[0].availability_pct), 50, '50% — sandbox pass did not lift availability');
  } finally {
    await pool.query(`DELETE FROM checks WHERE id = $1`, [id]);
  }
});
