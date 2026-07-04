// Integration proof for the due-loop's starvation-rotation ordering. index.ts self-executes main()
// on import so findDueChecks isn't importable — per house convention (see swallowedErrors.integration
// .test.ts) we run the EXACT production SQL against throwaway rows and hard-delete them.
//
// WHY ordering matters: the loop is sequential and the ACA replicaTimeout (240s) can kill a tick
// mid-list. Unordered (heap-order) selection meant the SAME tail checks starved on every over-budget
// tick; ORDER BY last_run_at ASC NULLS FIRST serves the longest-unserved first, so deferred work
// rotates to the front of the next tick instead of starving persistently.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from './db.js';
import { DUE_PREDICATE_SQL } from './duePredicate.js';

const SKIP = !process.env.DATABASE_URL;
const test = SKIP ? nodeTest.skip : nodeTest;

// A throwaway location name keeps these rows invisible to any other test's queries.
const LOC = '__test_due_order__';

async function makeCheck(name: string): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO checks (name, kind, target_url, flow_name, spec_path, failure_threshold, severity, interval_seconds)
     VALUES ($1, 'browser', 'https://example.test', 'noop', 'monitors/__test__/x.spec.ts', 1, 'critical', 300)
     RETURNING id`,
    [name],
  );
  return rows[0].id;
}

async function seedCursor(checkId: number, lastRunAt: string | null): Promise<void> {
  await pool.query(
    `INSERT INTO check_locations (check_id, location, last_run_at)
     VALUES ($1, $2, ${lastRunAt === null ? 'NULL' : `now() - $3::interval`})`,
    lastRunAt === null ? [checkId, LOC] : [checkId, LOC, lastRunAt],
  );
}

// The EXACT production query from index.ts findDueChecks — the predicate is IMPORTED (the same
// string index.ts interpolates; see duePredicate.ts), so this file cannot silently diverge if the
// predicate changes again. The ORDER BY is what's under test; the guarded due threshold for the
// 300s checks below is 150s (interval − LEAST(150, interval/2)), which the seeded ages respect.
async function findDueChecks(): Promise<number[]> {
  const { rows } = await pool.query<{ id: number }>(
    `SELECT c.id
       FROM checks c
       JOIN check_locations cl
         ON cl.check_id = c.id AND cl.location = $1
      WHERE c.enabled
        AND ${DUE_PREDICATE_SQL}
      ORDER BY cl.last_run_at ASC NULLS FIRST, c.id ASC`,
    [LOC],
  );
  return rows.map((r) => r.id);
}

test('★ due-loop ordering: longest-unserved first — NULL (never ran), then oldest cursor; fresh checks excluded', async () => {
  const neverRan = await makeCheck('__order_never_ran__');
  const mostStarved = await makeCheck('__order_most_starved__');
  const lessStarved = await makeCheck('__order_less_starved__');
  const notDue = await makeCheck('__order_not_due__');
  try {
    // Deliberately seeded in an order UNLIKE the expected result, so heap order can't pass by luck.
    await seedCursor(lessStarved, '10 minutes'); // due (600s > 300s), but least starved
    await seedCursor(notDue, '1 minute'); //        NOT due (60s < 300s) — must be excluded
    await seedCursor(neverRan, null); //            due-now (NULL cursor) — most starved of all
    await seedCursor(mostStarved, '20 minutes'); // due, oldest real cursor

    const due = await findDueChecks();
    assert.deepEqual(
      due,
      [neverRan, mostStarved, lessStarved],
      'NULLS FIRST, then last_run_at ascending; the fresh cursor is not selected at all',
    );
  } finally {
    for (const id of [neverRan, mostStarved, lessStarved, notDue]) {
      await pool.query(`DELETE FROM checks WHERE id = $1`, [id]); // cascades check_locations
    }
  }
});
