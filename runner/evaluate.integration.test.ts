// LIVE integration proof of the two-knob separation (Phase 4-MLACT Option B) at the REAL incident
// decision point (the actual evaluate() + aggregateVerdict SQL). Runs only when DATABASE_URL is set
// (skipped in offline CI). Each case creates a throwaway check WITH NO ALERT ROUTES (so opening an
// incident dispatches to zero channels — no real email), seeds runs, calls evaluate(), asserts the
// incidents table, then hard-deletes the check (cascades runs/incidents).
//
// (c) failure_threshold=1 -> incident opens on the FIRST confirmed (post-retry) down run.
// (d) failure_threshold>1 -> still debounces across consecutive SCHEDULED runs (no incident until N).
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { pool, type Check, type RunRecord } from './db.js';
import { evaluate } from './evaluate.js';

const SKIP = !process.env.DATABASE_URL;

// Create a throwaway Git-managed browser check with the given failure_threshold. No alert routes are
// inserted, so dispatchAlerts resolves zero channels (no send). Returns the full row as a Check.
async function makeCheck(failureThreshold: number, name: string): Promise<Check> {
  const { rows } = await pool.query(
    `INSERT INTO checks (name, kind, target_url, flow_name, spec_path, failure_threshold, severity)
     VALUES ($1, 'browser', 'https://example.test', 'noop', 'monitors/__test__/x.spec.ts', $2, 'critical')
     RETURNING *`,
    [name, failureThreshold],
  );
  return rows[0] as unknown as Check;
}

// Insert one down ('fail') run at a given age (minutes ago) and return the RunRecord evaluate() needs.
async function seedFailRun(checkId: number, minutesAgo: number): Promise<RunRecord> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO runs (check_id, status, started_at, finished_at, location, error_message, failed_step)
     VALUES ($1, 'fail', now() - make_interval(mins => $2::int), now() - make_interval(mins => $2::int),
             'default', 'assertion missed', 'open the product')
     RETURNING id`,
    [checkId, minutesAgo],
  );
  return {
    id: rows[0].id,
    check_id: checkId,
    status: 'fail',
    error_message: 'assertion missed',
    failed_step: 'open the product',
    screenshot_url: null,
    location: 'default',
  };
}

async function openIncidentCount(checkId: number): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM incidents WHERE check_id = $1 AND status = 'open'`,
    [checkId],
  );
  return Number(rows[0].n);
}

// (c) failure_threshold=1 — a single confirmed down run opens the incident immediately.
nodeTest('(c) failure_threshold=1 opens an incident on the FIRST confirmed failure (live)', { skip: SKIP }, async () => {
  const check = await makeCheck(1, '__eval_ft1_e2e__');
  try {
    const run = await seedFailRun(check.id, 0);
    await evaluate(check, run);
    assert.equal(await openIncidentCount(check.id), 1, 'one down run + failure_threshold=1 → incident open');
  } finally {
    await pool.query(`DELETE FROM checks WHERE id = $1`, [check.id]);
  }
});

// (d) failure_threshold=3 — debounce: no incident until the latest 3 SCHEDULED runs are all down.
nodeTest('(d) failure_threshold>1 still debounces across consecutive scheduled runs (live)', { skip: SKIP }, async () => {
  const check = await makeCheck(3, '__eval_ft3_e2e__');
  try {
    // Run 1 (oldest) down -> below threshold, NO incident.
    await evaluate(check, await seedFailRun(check.id, 10));
    assert.equal(await openIncidentCount(check.id), 0, '1 of 3 down → no incident yet');

    // Run 2 down -> still below threshold.
    await evaluate(check, await seedFailRun(check.id, 5));
    assert.equal(await openIncidentCount(check.id), 0, '2 of 3 down → no incident yet');

    // Run 3 (newest) down -> latest 3 all down -> incident opens.
    const run3 = await seedFailRun(check.id, 0);
    await evaluate(check, run3);
    assert.equal(await openIncidentCount(check.id), 1, '3 consecutive down → incident opens on the 3rd');
  } finally {
    await pool.query(`DELETE FROM checks WHERE id = $1`, [check.id]);
  }
});
