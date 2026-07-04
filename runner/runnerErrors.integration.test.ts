// LIVE write-proof for the runner_errors sink (recon A3): prod has had ZERO rows ever, which is
// consistent with "the fatal paths simply haven't fired" — but only if the REAL insert path actually
// works when one does. This exercises the REAL recordFatal() (same pool, same INSERT, same bounded
// race) against a real Postgres and asserts the row LANDS with the correlation id + context, so a
// silent-write regression (renamed column, swallowed insert, broken race) fails CI instead of
// manufacturing a false "no fatals" fact — the exact meta-lesson-A failure recordFatal exists to kill.
//
// Runs only when DATABASE_URL is set (skipped in offline CI), like the other *.integration tests.
// runner_errors.check_id/run_id are plain bigints (0050 — no FK), so no fixture rows are needed.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from './db.js';
import { INVOCATION_ID, recordFatal, setErrorContext } from './runnerErrors.js';

const SKIP = !process.env.DATABASE_URL;

interface Row {
  invocation_id: string;
  phase: string;
  check_id: string | null;
  run_id: string | null;
  message: string;
  stack: string | null;
}

async function rowsForPhase(phase: string): Promise<Row[]> {
  const { rows } = await pool.query<Row>(
    `SELECT invocation_id, phase, check_id, run_id, message, stack
       FROM runner_errors WHERE invocation_id = $1 AND phase = $2 ORDER BY id`,
    [INVOCATION_ID, phase],
  );
  return rows;
}

// One cleanup for everything this file wrote — keyed on this process's INVOCATION_ID, so parallel
// CI runs against a shared DB can't delete each other's rows.
async function cleanup(): Promise<void> {
  await pool.query(`DELETE FROM runner_errors WHERE invocation_id = $1`, [INVOCATION_ID]);
}

nodeTest('recordFatal persists a queryable row via the REAL insert path (Error → message + stack)', { skip: SKIP }, async () => {
  try {
    setErrorContext(4242, 991199);
    await recordFatal('__proof_error__', new Error('boom from the write-proof'));
    const rows = await rowsForPhase('__proof_error__');
    assert.equal(rows.length, 1, 'exactly one runner_errors row lands');
    const r = rows[0];
    assert.equal(r.invocation_id, INVOCATION_ID, 'correlation id stamps the row');
    assert.equal(r.check_id, '4242', 'in-flight check context is attributed');
    assert.equal(r.run_id, '991199', 'in-flight run context is attributed');
    assert.equal(r.message, 'boom from the write-proof');
    assert.ok(r.stack && r.stack.includes('boom from the write-proof'), 'stack is persisted for an Error');
  } finally {
    setErrorContext(null, null);
    await cleanup();
  }
});

nodeTest('recordFatal with cleared context persists NULL check/run (startup/teardown fatal shape)', { skip: SKIP }, async () => {
  try {
    setErrorContext(null, null);
    await recordFatal('__proof_nocontext__', 'a thrown string, not an Error');
    const rows = await rowsForPhase('__proof_nocontext__');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].check_id, null, 'no in-flight check → NULL');
    assert.equal(rows[0].run_id, null, 'no in-flight run → NULL');
    assert.equal(rows[0].message, 'a thrown string, not an Error');
    assert.equal(rows[0].stack, null, 'a non-Error has no stack');
  } finally {
    await cleanup();
  }
});
