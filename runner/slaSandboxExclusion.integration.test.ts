// LIVE integration proof that a paused monitor's on-demand SANDBOX run (runs.sandbox, 0065) is EXCLUDED from
// availability — the re-landed #228 exclusion (migration 0070). DB-gated (DATABASE_URL); runs in CI's
// Postgres-service job, skipped offline. MUST-GO-RED: each test asserts a sandbox run is invisible and a
// NORMAL run IS counted — so if the `AND NOT r.sandbox` predicate is dropped from sla_availability() /
// daily_check_rollup, the sandbox run leaks into the counts and these assertions FAIL. The test only passes
// while the exclusion is present.
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

// ★ sla_availability(): a sandbox pass does NOT become an up_run; only the real fail is counted.
nodeTest('sla_availability EXCLUDES sandbox runs (0070 re-land of #228)', { skip: SKIP }, async () => {
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
    // If the exclusion is dropped, the sandbox pass leaks in → up=1/down=1 → 50%. Exclusion → up=0/down=1 → 0%.
    assert.equal(Number(rows[0].up_runs), 0, 'sandbox pass is NOT an up_run');
    assert.equal(Number(rows[0].down_runs), 1, 'the real fail IS counted');
    assert.equal(Number(rows[0].completed_runs), 1, 'sandbox is not in the completed denominator');
    assert.equal(Number(rows[0].availability_pct), 0, '0% — the sandbox pass did not lift availability');
  } finally {
    await pool.query(`DELETE FROM checks WHERE id = $1`, [id]);
  }
});

// ★ a sandbox-ONLY window → availability NULL (no counted runs), NOT 0% (which would read as fully down).
nodeTest('sla_availability: a sandbox-ONLY window is availability=NULL, not 0%', { skip: SKIP }, async () => {
  const id = await makeCheck('__sla_sbx_only__');
  try {
    await seedRun(id, 'fail', '2026-05-01T01:00:00Z', true); // the ONLY run is sandbox
    const { rows } = await pool.query<{ completed_runs: string; availability_pct: string | null }>(
      `SELECT completed_runs, availability_pct FROM sla_availability('2026-05-01T00:00:00Z'::timestamptz, '2026-05-02T00:00:00Z'::timestamptz) WHERE check_id = $1`,
      [id],
    );
    assert.equal(rows.length, 1, 'the check keeps its null-run row (LEFT JOIN not dropped)');
    assert.equal(Number(rows[0].completed_runs), 0, 'no counted runs');
    assert.equal(rows[0].availability_pct, null, 'NULL (no data), not 0% (which would read as down)');
  } finally {
    await pool.query(`DELETE FROM checks WHERE id = $1`, [id]);
  }
});

// ★ daily_check_rollup mirrors the exclusion.
nodeTest('daily_check_rollup EXCLUDES sandbox runs (0070)', { skip: SKIP }, async () => {
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
    // Real: 1 up + 1 down = 2 → 50%. With sandbox leaking it'd be 2 up / 3 total → 66.67%.
    assert.equal(rows[0].up_count, 1, 'sandbox pass is not counted up');
    assert.equal(rows[0].down_count, 1);
    assert.equal(rows[0].total_count, 2, 'sandbox is not in the rollup total');
    assert.equal(Number(rows[0].availability_pct), 50, '50% — sandbox pass did not lift availability');
  } finally {
    await pool.query(`DELETE FROM checks WHERE id = $1`, [id]);
  }
});
