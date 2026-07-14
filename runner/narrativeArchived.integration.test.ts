// Prove-can-fail for the archived-check leak in the Layer-3 narrative loop (narratableCheckIds).
// Before this fix, `SELECT ... FROM checks WHERE enabled` narrated ARCHIVED checks too — rca-demo (retired,
// 0% available, 2,264 dead runs) got an urgent AI action-item written + billed at Azure OpenAI prices every
// cycle. The loop must see LIVE checks only: enabled AND archived_at IS NULL. Gated on DATABASE_URL like the
// other *.integration.test.ts (CI runs it on the Postgres-service job).
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from './db.js';
import { narratableCheckIds } from './narrative.js';

const SKIP = !process.env.DATABASE_URL;
const test = SKIP ? nodeTest.skip : nodeTest;

async function makeCheck(name: string, archived: boolean): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO checks (name, kind, target_url, flow_name, spec_path, failure_threshold, severity, enabled, archived_at)
     VALUES ($1, 'browser', 'https://example.test', 'noop', 'monitors/__test__/x.spec.ts', 1, 'critical', true, $2)
     RETURNING id`,
    [name, archived ? new Date() : null],
  );
  return rows[0].id;
}

// node-pg returns BIGINT ids as strings, so compare numerically on both sides (=== on mixed types is false).
const has = (rows: { id: string }[], id: number | string): boolean => rows.some((r) => Number(r.id) === Number(id));

test('narratableCheckIds: an ARCHIVED check is excluded from the narrative loop; un-archiving restores it', async () => {
  // Two ENABLED checks — the only difference is archived_at. The live one must always narrate; the archived
  // one must never — proving the filter is archived_at, not enabled (both are enabled).
  const liveId = await makeCheck('__narr_live__', false);
  const archId = await makeCheck('__narr_archived__', true);
  try {
    // 1) baseline: live present, archived ABSENT (the leak, gated).
    let rows = await narratableCheckIds();
    assert.ok(has(rows, liveId), 'a live enabled check IS narrated');
    assert.ok(!has(rows, archId), 'an ARCHIVED check is NOT narrated (the fix)');

    // 2) un-archive it in place → it MUST now appear (proves the exclusion is exactly archived_at).
    await pool.query(`UPDATE checks SET archived_at = NULL WHERE id = $1`, [archId]);
    rows = await narratableCheckIds();
    assert.ok(has(rows, archId), 'un-archived → the check reappears in the narrative loop');

    // 3) re-archive → it MUST vanish again.
    await pool.query(`UPDATE checks SET archived_at = now() WHERE id = $1`, [archId]);
    rows = await narratableCheckIds();
    assert.ok(!has(rows, archId), 're-archived → the check vanishes from the narrative loop');

    // 4) a PAUSED-but-not-archived check (enabled=false, archived_at NULL) is also absent here — this loop is
    //    live_check (enabled AND not archived), NOT reportable_check. Confirms the deliberate divergence.
    await pool.query(`UPDATE checks SET enabled = false, archived_at = NULL WHERE id = $1`, [archId]);
    rows = await narratableCheckIds();
    assert.ok(!has(rows, archId), 'a paused (disabled) check is not narrated — live_check requires enabled');
  } finally {
    await pool.query(`DELETE FROM checks WHERE id = ANY($1::int[])`, [[liveId, archId]]);
  }
});
