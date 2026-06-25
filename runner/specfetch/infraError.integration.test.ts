// Phase 6b Option C — SLICE 5 LIVE integration proof: an infra_error run does NOT page and is
// NOT counted as downtime, at the REAL integration point (the actual evaluate() + the actual
// sla_availability() SQL). Runs only when DATABASE_URL is set (skipped in offline CI). Creates a
// throwaway check, exercises the real code paths, and hard-deletes it (cascades runs/incidents).
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { pool, type Check, type RunRecord } from '../db.js';
import { evaluate } from '../evaluate.js';

const SKIP = !process.env.DATABASE_URL;

nodeTest('★ infra_error: NO incident opened + NOT counted as SLA downtime (live)', { skip: SKIP }, async () => {
  // A throwaway Git-managed browser check (failure_threshold=1 so a single down WOULD page).
  const { rows: created } = await pool.query<{ id: number }>(
    `INSERT INTO checks (name, kind, target_url, flow_name, spec_path, failure_threshold, severity)
     VALUES ('__specfetch_infra_e2e__', 'browser', 'https://example.test', 'noop',
             'monitors/__test__/x.spec.ts', 1, 'critical')
     RETURNING id`,
  );
  const checkId = created[0].id;

  try {
    // 1) An infra_error run -> evaluate() must NOT open an incident or dispatch an alert.
    const { rows: r1 } = await pool.query<{ id: number }>(
      `INSERT INTO runs (check_id, status, started_at, finished_at, location)
       VALUES ($1, 'infra_error', now(), now(), 'default') RETURNING id`,
      [checkId],
    );
    const run: RunRecord = {
      id: r1[0].id,
      check_id: checkId,
      status: 'infra_error',
      error_message: 'could not fetch spec',
      failed_step: null,
      screenshot_url: null,
      location: 'default',
    };
    // Minimal Check — evaluate()'s infra_error short-circuit reads only id + name (it returns
    // BEFORE any incident/alert/verdict logic, so no alert can be dispatched).
    await evaluate({ id: checkId, name: '__specfetch_infra_e2e__' } as unknown as Check, run);

    const { rowCount: incidents } = await pool.query(
      `SELECT 1 FROM incidents WHERE check_id = $1`,
      [checkId],
    );
    assert.equal(incidents, 0, 'infra_error opened NO incident (did not page)');

    // 2) Add a pass + another infra_error, then read the REAL sla_availability(): infra_error
    //    must be excluded from completed/up/down, so availability reflects only the pass.
    await pool.query(
      `INSERT INTO runs (check_id, status, started_at, finished_at, location)
       VALUES ($1, 'pass', now(), now(), 'default'),
              ($1, 'infra_error', now(), now(), 'default')`,
      [checkId],
    );
    const { rows: sla } = await pool.query<{
      completed_runs: string;
      up_runs: string;
      down_runs: string;
      availability_pct: string | null;
    }>(
      `SELECT completed_runs, up_runs, down_runs, availability_pct
         FROM sla_availability(now() - interval '1 hour', now() + interval '1 minute')
        WHERE check_id = $1`,
      [checkId],
    );
    // The check has 2 infra_error + 1 pass. Only the pass is "completed".
    assert.equal(Number(sla[0].completed_runs), 1, 'only the pass is completed (2 infra_error excluded)');
    assert.equal(Number(sla[0].up_runs), 1);
    assert.equal(Number(sla[0].down_runs), 0, 'infra_error is NOT down');
    assert.equal(Number(sla[0].availability_pct), 100, 'availability unmoved by infra_error');
  } finally {
    await pool.query(`DELETE FROM checks WHERE id = $1`, [checkId]); // cascades runs + incidents
  }
});

// Closes the shared pool so `node --test` exits cleanly after the live test (offline runs skip
// the test above but still load this module; pool.end() is safe either way).
nodeTest('close pool', { skip: SKIP }, async () => {
  await pool.end();
});
