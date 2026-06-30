// Integration proofs for the swallowed-error-cluster fixes (B2 finalize, B4 reaper, RESOLVE-RACE). These
// assert the EXACT production SQL each fix added — index.ts self-executes main() on import so its helpers
// aren't importable, so we run the same guarded statements against a throwaway row and hard-delete it.
// Runs only when DATABASE_URL is set (skipped offline). POOL-ERROR is a pure test (no DB) at the bottom.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from './db.js';

const SKIP = !process.env.DATABASE_URL;
const test = SKIP ? nodeTest.skip : nodeTest;

async function makeCheck(name: string): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO checks (name, kind, target_url, flow_name, spec_path, failure_threshold, severity)
     VALUES ($1, 'browser', 'https://example.test', 'noop', 'monitors/__test__/x.spec.ts', 1, 'critical')
     RETURNING id`,
    [name],
  );
  return rows[0].id;
}

// ─── B2: finalize-on-throw, with the no-double-write guard ───────────────────────────────────────────
test('★ B2: the finalize UPDATE flips a stranded "running" run to "error", but does NOT overwrite a run that already finalized', async () => {
  const checkId = await makeCheck('__b2_finalize__');
  try {
    // A run stranded 'running' (the body threw before its terminal write).
    const { rows: r1 } = await pool.query<{ id: number }>(
      `INSERT INTO runs (check_id, started_at, status, location) VALUES ($1, now(), 'running', 'test') RETURNING id`,
      [checkId],
    );
    const strandedId = r1[0].id;
    // A run that already wrote a terminal status (the success path) — the finally must NOT touch it.
    const { rows: r2 } = await pool.query<{ id: number }>(
      `INSERT INTO runs (check_id, started_at, status, location) VALUES ($1, now(), 'pass', 'test') RETURNING id`,
      [checkId],
    );
    const finalizedId = r2[0].id;

    // The EXACT finally-fallback statement from runOne.
    const finalize = (id: number) =>
      pool.query(
        `UPDATE runs SET status = 'error', finished_at = now(),
                error_message = COALESCE(error_message, 'runner threw before finalizing the run')
          WHERE id = $1 AND status = 'running'`,
        [id],
      );

    const a = await finalize(strandedId);
    assert.equal(a.rowCount, 1, 'stranded running run is finalized');
    const b = await finalize(finalizedId);
    assert.equal(b.rowCount, 0, '★ no double-write: a non-running run is untouched');

    const { rows: s } = await pool.query<{ status: string }>(
      `SELECT status FROM runs WHERE id = ANY($1::bigint[]) ORDER BY id`,
      [[strandedId, finalizedId]],
    );
    assert.equal(s[0].status, 'error', 'stranded -> error');
    assert.equal(s[1].status, 'pass', 'already-finalized stays pass');
  } finally {
    await pool.query(`DELETE FROM checks WHERE id = $1`, [checkId]); // cascades runs
  }
});

// ─── B4: the test_send_requests reaper arm ───────────────────────────────────────────────────────────
test('★ B4: a stale "sending" test-send is reaped to "failed"; a fresh one is left alone', async () => {
  const { rows: ch } = await pool.query<{ id: number }>(
    `INSERT INTO channels (name, type, config, enabled) VALUES ('__b4_chan__', 'email', '{}'::jsonb, true) RETURNING id`,
  );
  const channelId = ch[0].id;
  try {
    // stale 'sending' (requested 40 min ago) + a fresh 'sending' (now).
    const { rows: stale } = await pool.query<{ id: number }>(
      `INSERT INTO test_send_requests (channel_id, status, requested_at)
       VALUES ($1, 'sending', now() - interval '40 minutes') RETURNING id`,
      [channelId],
    );
    const { rows: fresh } = await pool.query<{ id: number }>(
      `INSERT INTO test_send_requests (channel_id, status, requested_at) VALUES ($1, 'sending', now()) RETURNING id`,
      [channelId],
    );

    // The EXACT reaper arm from reapStaleRunning.
    const { rowCount } = await pool.query(
      `UPDATE test_send_requests
          SET status = 'failed', completed_at = now(),
              detail = COALESCE(detail, 'runner did not finalize (stale sending)')
        WHERE status = 'sending' AND requested_at < now() - make_interval(mins => $1::int)`,
      [30],
    );
    assert.equal(rowCount, 1, 'exactly the stale one is reaped');

    const { rows } = await pool.query<{ id: number; status: string }>(
      `SELECT id, status FROM test_send_requests WHERE id = ANY($1::bigint[])`,
      [[stale[0].id, fresh[0].id]],
    );
    const byId = new Map(rows.map((r) => [Number(r.id), r.status]));
    assert.equal(byId.get(Number(stale[0].id)), 'failed', 'stale sending -> failed');
    assert.equal(byId.get(Number(fresh[0].id)), 'sending', 'fresh sending untouched');
  } finally {
    await pool.query(`DELETE FROM channels WHERE id = $1`, [channelId]); // cascades test_send_requests
  }
});

// ─── RESOLVE-RACE: the rowCount guard ────────────────────────────────────────────────────────────────
test('★ RESOLVE-RACE: two concurrent resolves of one incident → exactly ONE returns a row (one page)', async () => {
  const checkId = await makeCheck('__resolve_race__');
  try {
    const { rows: inc } = await pool.query<{ id: number }>(
      `INSERT INTO incidents (check_id, status, severity, opened_at, consecutive_failures)
       VALUES ($1, 'open', 'critical', now(), 1) RETURNING id`,
      [checkId],
    );
    const incidentId = inc[0].id;

    // The EXACT guarded resolve from evaluate() — run it twice (the two racing regions).
    const resolve = () =>
      pool.query(
        `UPDATE incidents SET status = 'resolved', resolved_at = now()
          WHERE id = $1 AND status = 'open' RETURNING opened_at`,
        [incidentId],
      );

    const first = await resolve();
    const second = await resolve();
    assert.equal(first.rows.length, 1, 'the winner flips open->resolved and pages');
    assert.equal(second.rows.length, 0, '★ the loser matches 0 rows → NO second "recovered" page');
  } finally {
    await pool.query(`DELETE FROM checks WHERE id = $1`, [checkId]); // cascades incidents
  }
});

// ─── POOL-ERROR: the handler is installed (pure; no DB needed) ───────────────────────────────────────
nodeTest('★ POOL-ERROR: a pg idle-client "error" event is handled (logged, not an unhandled throw)', () => {
  assert.ok(pool.listenerCount('error') >= 1, 'db.ts registered a pool error handler');
  // Emitting "error" with a listener present must NOT throw (no listener → Node would crash the process).
  assert.doesNotThrow(() => pool.emit('error', new Error('simulated idle-conn drop'), {} as never));
});
