// LIVE integration proof (migration 0071): an ARCHIVED check (archived_at set) is excluded from the
// due-loop + normal on-demand runs, while a SANDBOX request may still validate it — the exact `archived_at
// IS NULL` gates added to findDueChecks/claim (unconditional) + drainRunRequests/forceClaim (sandbox-relaxed)
// in index.ts. Those functions run main() on import so aren't callable; like cadence.integration.test.ts we
// drive the SAME predicate against a real Postgres. Runs only when DATABASE_URL is set (CI Postgres job).
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from './db.js';
import { DUE_PREDICATE_SQL } from './duePredicate.js';

const SKIP = !process.env.DATABASE_URL;
const test = SKIP ? nodeTest.skip : nodeTest;

// A due check at `loc`: never-run (last_run_at NULL ⇒ due-now under DUE_PREDICATE_SQL). archived toggles
// archived_at. Returns the id. enabled defaults TRUE.
async function makeCheck(name: string, loc: string, archived: boolean): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO checks (name, kind, target_url, flow_name, spec_path, failure_threshold, severity, interval_seconds, archived_at)
     VALUES ($1, 'browser', 'https://example.test', 'noop', 'monitors/__test__/x.spec.ts', 1, 'critical', 300, ${archived ? 'now()' : 'NULL'})
     RETURNING id`,
    [name],
  );
  await pool.query(`INSERT INTO check_locations (check_id, location) VALUES ($1, $2)`, [rows[0].id, loc]);
  return rows[0].id;
}

test('★ archive gate: the due-loop excludes an archived check; an active one is still due', { skip: SKIP }, async () => {
  const loc = `__arch_due_${Date.now()}__`;
  const active = await makeCheck('__arch_active__', loc, false);
  const archived = await makeCheck('__arch_archived__', loc, true);
  try {
    // The EXACT findDueChecks/claim gate: enabled AND archived_at IS NULL AND <due>.
    const { rows } = await pool.query<{ id: number }>(
      `SELECT c.id FROM checks c JOIN check_locations cl ON cl.check_id = c.id AND cl.location = $1
        WHERE c.enabled AND c.archived_at IS NULL AND ${DUE_PREDICATE_SQL} AND c.id = ANY($2::bigint[])`,
      [loc, [active, archived]],
    );
    const ids = rows.map((r) => r.id);
    assert.ok(ids.includes(active), 'the active check is due (claimed)');
    assert.ok(!ids.includes(archived), 'MUST-GO-RED: the archived check must NOT be claimed by the due-loop');
  } finally {
    await pool.query(`DELETE FROM checks WHERE id = ANY($1::bigint[])`, [[active, archived]]);
  }
});

test('★ archive gate: a NORMAL on-demand run refuses an archived check, but a SANDBOX request may validate it', { skip: SKIP }, async () => {
  const loc = `__arch_od_${Date.now()}__`;
  const archived = await makeCheck('__arch_ondemand__', loc, true);
  try {
    // The drainRunRequests/forceClaim gate: (c.enabled OR sandbox) AND (c.archived_at IS NULL OR sandbox).
    const gate = (sandbox: boolean) =>
      pool.query<{ id: number }>(
        `SELECT c.id FROM checks c JOIN check_locations cl ON cl.check_id = c.id AND cl.location = $1
          WHERE (c.enabled OR $2) AND (c.archived_at IS NULL OR $2) AND c.id = $3`,
        [loc, sandbox, archived],
      );
    assert.equal((await gate(false)).rowCount, 0, 'a NORMAL on-demand run must NOT claim an archived check');
    assert.equal((await gate(true)).rowCount, 1, 'a SANDBOX request may still validate an archived check');
  } finally {
    await pool.query(`DELETE FROM checks WHERE id = $1`, [archived]);
  }
});
