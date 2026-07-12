// cost_projection(rate) as an executable proof of the two cost-model claims (0069 + 0078), against the
// integration Postgres (gated on DATABASE_URL, like the other *.integration.test.ts; CI runs it on the
// Postgres-service job). Inserts a controlled check + runs, filters cost_projection to that check_id.
//
// Proves:
//   A. the rate is a CLEAN multiplier — cost_projection(2r) is EXACTLY 2× cost_projection(r) for the same
//      run set (projected & measured), divergence unchanged. This is WHY the two-meter fix (0.00003→0.00006
//      at 2.0/4) doubles every figure exactly.
//   B. divergence is a PURE RUN-COUNT ratio — DOUBLING every run's duration leaves divergence UNCHANGED
//      (measured and projected inflate identically). So slow/failing runs cannot move it, and retries
//      (which persist no extra row/duration) are structurally invisible. Bug B, refuted in SQL.
//   C. the new count columns (run_count_7d / confirmation / sandbox / recent+prior) are correct, and
//      recent+prior partition run_count_7d at 3.5d — the cadence-straddle signal the dashboard attributes.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from './db.js';

const SKIP = !process.env.DATABASE_URL;
const test = SKIP ? nodeTest.skip : nodeTest;

interface Row {
  projected_raw: string; measured_raw: string; divergence: string | null;
  run_count_7d: number; confirmation_count_7d: number; sandbox_count_7d: number;
  run_count_recent: number; run_count_prior: number;
}

async function project(rate: number, checkId: number): Promise<Row> {
  const { rows } = await pool.query<Row>(
    `SELECT projected_raw, measured_raw, divergence, run_count_7d, confirmation_count_7d,
            sandbox_count_7d, run_count_recent, run_count_prior
       FROM cost_projection($1::numeric) WHERE check_id = $2`,
    [rate, checkId],
  );
  assert.equal(rows.length, 1, 'the enabled test check appears exactly once');
  return rows[0];
}

test('cost_projection: clean-multiplier rate + pure run-count divergence + count columns', async () => {
  // A check with interval 3600s / 1 region. Expected 7d schedule = 604800/3600 = 168 runs.
  const { rows: cr } = await pool.query<{ id: number }>(
    `INSERT INTO checks (name, kind, target_url, flow_name, spec_path, failure_threshold, severity, interval_seconds, enabled)
     VALUES ('__costproj_test__', 'browser', 'https://example.test', 'noop', 'monitors/__test__/x.spec.ts', 1, 'critical', 3600, true)
     RETURNING id`,
  );
  const checkId = cr[0].id;
  try {
    await pool.query(`INSERT INTO check_locations (check_id, location) VALUES ($1, 'default')`, [checkId]);

    // An anchor run (recent) the confirmation rows can reference (confirmation_of_run_id → runs(id), a real FK).
    const DUR = 10000;
    const { rows: ar } = await pool.query<{ id: number }>(
      `INSERT INTO runs (check_id, status, started_at, finished_at, location, duration_ms)
       VALUES ($1, 'pass', now() - make_interval(hours => 1), now(), 'default', $2) RETURNING id`,
      [checkId, DUR],
    );
    const anchorId = ar[0].id;
    // Counts tracked as we insert (no brittle hardcoding). Anchor: recent, normal.
    let total = 1, recent = 1, prior = 0, confirm = 0, sandbox = 0;
    for (let i = 0; i < 199; i++) {
      const isRecent = i < 100; // <84h (5040min) → recent half; else prior half; all < 168h (7d)
      // INTEGER minutes — make_interval(hours =>) takes an int, so fractional hours are a PG error;
      // mins => $::int is the idiom the other integration tests use. recent: 120..219min; prior: 5400..5498min.
      const ageMins = isRecent ? 120 + i : 5400 + (i - 100);
      const isConfirm = i < 7;
      const isSandbox = i >= 7 && i < 12;
      await pool.query(
        `INSERT INTO runs (check_id, status, started_at, finished_at, location, duration_ms, sandbox, confirmation_of_run_id)
         VALUES ($1, 'pass', now() - make_interval(mins => $2::int), now(), 'default', $3, $4, $5)`,
        [checkId, ageMins, DUR, isSandbox, isConfirm ? anchorId : null],
      );
      total++; if (isRecent) recent++; else prior++; if (isConfirm) confirm++; if (isSandbox) sandbox++;
    }

    const base = await project(0.00003, checkId);
    // C — count columns match exactly what we inserted
    assert.equal(base.run_count_7d, total, 'run_count_7d counts every measured 7d row');
    assert.equal(base.confirmation_count_7d, confirm, 'confirmation runs counted');
    assert.equal(base.sandbox_count_7d, sandbox, 'sandbox runs counted');
    assert.equal(base.run_count_recent + base.run_count_prior, total, 'recent+prior partition the window');
    assert.equal(base.run_count_recent, recent, 'the 3.5d split lands where inserted');
    assert.equal(base.run_count_prior, prior, 'prior half counted');

    // A — clean multiplier: 2× the rate → exactly 2× projected & measured, divergence unchanged.
    const dbl = await project(0.00006, checkId);
    const approxEq = (a: string, b: string, msg: string) =>
      assert.ok(Math.abs(Number(a) - Number(b)) < 1e-9, `${msg}: ${a} ≈ ${b}`);
    approxEq(dbl.projected_raw, String(Number(base.projected_raw) * 2), 'projected doubles with the rate');
    approxEq(dbl.measured_raw, String(Number(base.measured_raw) * 2), 'measured doubles with the rate');
    approxEq(dbl.divergence ?? '0', base.divergence ?? '0', 'divergence is rate-invariant');

    // B — pure run-count: DOUBLE every duration → divergence UNCHANGED (retries/slowness cannot move it).
    await pool.query(`UPDATE runs SET duration_ms = duration_ms * 2 WHERE check_id = $1`, [checkId]);
    const slow = await project(0.00003, checkId);
    approxEq(slow.divergence ?? '0', base.divergence ?? '0', 'doubling duration does NOT move divergence');
    assert.equal(slow.run_count_7d, total, 'run count unchanged by duration');
    // measured DID grow (more $), but the RATIO the warning fires on did not.
    assert.ok(Number(slow.measured_raw) > Number(base.measured_raw), 'slower runs cost more $ (but not more divergence)');
  } finally {
    await pool.query(`DELETE FROM checks WHERE id = $1`, [checkId]); // cascades runs + check_locations
  }
});
