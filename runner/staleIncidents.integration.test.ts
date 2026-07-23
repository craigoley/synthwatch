// Integration tests for closeStrandedIncidents (0095) against a REAL Postgres. Same pattern as
// archiveGate.integration.test.ts: gated on DATABASE_URL (the CI Postgres job), drives the SHIPPED SQL, and
// asserts each stop-reason independently plus the negative (a running check is untouched).
//
// ★ COVERS D2 EXPLICITLY: paused, archived, AND git-removed are each a distinct row here. A pause-only
//   implementation would pass a pause-only test — so every reason is asserted with its own check, and the
//   perturbation (narrow the predicate back to enabled-only) is proven to RED the archived case.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from './db.js';
import { closeStrandedIncidents, STOPPED_CHECK_PREDICATE } from './staleIncidents.js';

const SKIP = !process.env.DATABASE_URL;
const test = SKIP ? nodeTest.skip : nodeTest;

type State = { enabled: boolean; archived: boolean; removed: boolean };

// Seed a check in a given lifecycle state + an OPEN incident on it. Returns { checkId, incidentId }.
async function seed(name: string, st: State): Promise<{ checkId: number; incidentId: number }> {
  const { rows: cr } = await pool.query<{ id: number }>(
    `INSERT INTO checks (name, kind, target_url, flow_name, spec_path, failure_threshold, severity,
                         interval_seconds, enabled, archived_at, removed_at)
     VALUES ($1, 'browser', 'https://example.test', 'noop', 'monitors/__test__/x.spec.ts', 1, 'critical', 300,
             $2, ${st.archived ? 'now()' : 'NULL'}, ${st.removed ? 'now()' : 'NULL'})
     RETURNING id`,
    [name, st.enabled],
  );
  const checkId = cr[0].id;
  const { rows: ir } = await pool.query<{ id: number }>(
    `INSERT INTO incidents (check_id, status, severity, consecutive_failures, summary)
     VALUES ($1, 'open', 'critical', 3, 'seeded open incident') RETURNING id`,
    [checkId],
  );
  return { checkId, incidentId: ir[0].id };
}

async function incident(id: number) {
  const { rows } = await pool.query<{
    status: string; resolved_at: Date | null; resolved_run_id: number | null;
    resolution_reason: string | null; notify_status: string | null; notify_attempted_at: Date | null;
  }>(
    `SELECT status, resolved_at, resolved_run_id, resolution_reason, notify_status, notify_attempted_at
       FROM incidents WHERE id = $1`,
    [id],
  );
  return rows[0];
}

async function cleanup(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(`DELETE FROM incidents WHERE check_id = ANY($1::bigint[])`, [ids]);
  await pool.query(`DELETE FROM check_locations WHERE check_id = ANY($1::bigint[])`, [ids]);
  await pool.query(`DELETE FROM checks WHERE id = ANY($1::bigint[])`, [ids]);
}

test('★ closes each stop-reason (paused / archived / removed), leaves a RUNNING check alone', { skip: SKIP }, async () => {
  const tag = `__stale_${Date.now()}__`;
  const paused = await seed(`${tag}_paused`, { enabled: false, archived: false, removed: false });
  const archived = await seed(`${tag}_archived`, { enabled: true, archived: true, removed: false }); // archived but enabled
  const removed = await seed(`${tag}_removed`, { enabled: false, archived: false, removed: true }); // git-removed → soft-disabled
  const running = await seed(`${tag}_running`, { enabled: true, archived: false, removed: false }); // the negative
  const all = [paused, archived, removed, running].map((x) => x.checkId);
  try {
    const closed = await closeStrandedIncidents();

    // Each stopped reason closed, with the RIGHT reason and NO run attributed.
    for (const [label, seeded, reason] of [
      ['paused', paused, 'monitor_paused'],
      ['archived', archived, 'monitor_archived'],
      ['removed', removed, 'monitor_removed'],
    ] as const) {
      const inc = await incident(seeded.incidentId);
      assert.equal(inc.status, 'resolved', `${label}: must be resolved`);
      assert.equal(inc.resolution_reason, reason, `${label}: reason must be ${reason}`);
      assert.equal(inc.resolved_run_id, null, `${label}: no run caused this close`);
      assert.ok(inc.resolved_at !== null, `${label}: resolved_at stamped`);
      // ★ SUPPRESSION: the close must NOT have touched the notification path.
      assert.equal(inc.notify_status, null, `${label}: no recovery notification (notify_status stays NULL)`);
      assert.equal(inc.notify_attempted_at, null, `${label}: no notification attempted`);
    }

    // ★ THE NEGATIVE — a running check's open incident is untouched.
    const run = await incident(running.incidentId);
    assert.equal(run.status, 'open', 'a RUNNING check must keep its open incident');
    assert.equal(run.resolution_reason, null, 'a running check must not be stamped');

    assert.ok(closed >= 3, `closed count includes at least the 3 stopped (was ${closed})`);
  } finally {
    await cleanup(all);
  }
});

test('★ PERTURBATION: an enabled-only predicate misses the ARCHIVED case (proves D2 is load-bearing)', { skip: SKIP }, async () => {
  const tag = `__stale_perturb_${Date.now()}__`;
  const archived = await seed(`${tag}_archived`, { enabled: true, archived: true, removed: false });
  try {
    // The WRONG predicate a pause-only implementation would ship — enabled=false only. The archived-but-
    // enabled check does NOT match it, so its incident would be left stranded. This asserts the bug so the
    // real predicate (STOPPED_CHECK_PREDICATE) is provably broader.
    const wrong = `UPDATE incidents i SET status='resolved', resolved_at=now(), resolution_reason='monitor_paused'
                     FROM checks c WHERE i.check_id=c.id AND i.status='open' AND c.enabled = false
                       AND i.check_id = $1
                    RETURNING i.id`;
    const { rows } = await pool.query<{ id: number }>(wrong, [archived.checkId]);
    assert.equal(rows.length, 0, 'enabled-only predicate leaves the archived incident stranded — the D2 bug');
    assert.equal((await incident(archived.incidentId)).status, 'open', 'still open under the wrong predicate');

    // Now the SHIPPED predicate closes it.
    await closeStrandedIncidents();
    assert.equal((await incident(archived.incidentId)).status, 'resolved', 'STOPPED_CHECK_PREDICATE closes the archived case');
  } finally {
    await cleanup([archived.checkId]);
  }
});

nodeTest('STOPPED_CHECK_PREDICATE is the exact negation of the due-loop gate', () => {
  // A pure-string guard (runs even without a DB): if someone edits the due-loop gate, this documents the
  // link that must move with it.
  assert.equal(STOPPED_CHECK_PREDICATE, 'NOT (c.enabled AND c.archived_at IS NULL)');
});
