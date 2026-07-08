// LIVE integration proof of the on-demand SANDBOX run for a PAUSED monitor (migration 0064). Runs only
// when DATABASE_URL is set (skipped offline). Two safety properties — the whole point of option A:
//   1. applyRunSideEffects(check, run, sandbox=true) SKIPS evaluate()/maybeBurnAlert → a FAILING run of a
//      paused monitor opens NO incident (no page — the "C" failure). The same run with sandbox=false DOES
//      open one, proving the skip is what gated it.
//   2. The drain claim filter `(c.enabled OR rr.sandbox)` is sandbox-ONLY: a sandbox request claims a
//      paused check, but a NORMAL request for a paused check is still NOT claimed (no blanket bypass).
// index.ts runs main() on import (house convention), so runOne/drainRunRequests aren't importable — we test
// the extracted seam (applyRunSideEffects) + the exact drain SELECT SQL, the two edited surfaces.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { pool, type Check, type RunRecord } from './db.js';
import { applyRunSideEffects } from './evaluate.js';

const SKIP = !process.env.DATABASE_URL;

// A throwaway PAUSED (enabled=false) Git-managed browser check, failure_threshold=1, NO alert routes
// (dispatchAlerts resolves zero channels → no real send even in the non-sandbox control).
async function makePausedCheck(name: string): Promise<Check> {
  const { rows } = await pool.query(
    `INSERT INTO checks (name, kind, target_url, flow_name, spec_path, failure_threshold, severity, enabled)
     VALUES ($1, 'browser', 'https://example.test', 'noop', 'monitors/__test__/x.spec.ts', 1, 'critical', false)
     RETURNING *`,
    [name],
  );
  return rows[0] as unknown as Check;
}

async function seedFailRun(checkId: number): Promise<RunRecord> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO runs (check_id, status, started_at, finished_at, location, error_message, failed_step)
     VALUES ($1, 'fail', now(), now(), 'default', 'assertion missed', 'open the product') RETURNING id`,
    [checkId],
  );
  return { id: rows[0].id, check_id: checkId, status: 'fail', error_message: 'assertion missed',
    failed_step: 'open the product', screenshot_url: null, location: 'default' };
}

async function openIncidentCount(checkId: number): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM incidents WHERE check_id = $1 AND status = 'open'`, [checkId]);
  return Number(rows[0].n);
}

// ★ THE SAFETY MUST-GO-RED: a sandbox run of a paused, FAILING check opens no incident; the same run
// without the sandbox flag does. If applyRunSideEffects stops gating on sandbox, the first assert fails.
nodeTest('SANDBOX run SKIPS evaluate() → no incident for a failing paused monitor; normal run pages', { skip: SKIP }, async () => {
  const check = await makePausedCheck('__sandbox_skip_e2e__');
  try {
    const run = await seedFailRun(check.id);

    await applyRunSideEffects(check, run, true); // sandbox → skip
    assert.equal(await openIncidentCount(check.id), 0, 'sandbox run must NOT open an incident (no page for a paused monitor)');

    await applyRunSideEffects(check, run, false); // control: normal → evaluate opens it
    assert.equal(await openIncidentCount(check.id), 1, 'a NON-sandbox run of the same failure DOES open an incident (proves the skip gated it)');

    const { rows } = await pool.query<{ enabled: boolean }>(`SELECT enabled FROM checks WHERE id = $1`, [check.id]);
    assert.equal(rows[0].enabled, false, 'a sandbox run never flips checks.enabled');
  } finally {
    await pool.query(`DELETE FROM checks WHERE id = $1`, [check.id]); // CASCADE clears runs/incidents
  }
});

// ★ The drain claim filter is sandbox-ONLY. Two paused checks: one with a NORMAL pending request, one with
// a SANDBOX pending request. The exact drainRunRequests SELECT must return ONLY the sandbox one.
nodeTest('drain claim filter (c.enabled OR rr.sandbox): sandbox request claims a paused check; normal request does not', { skip: SKIP }, async () => {
  const normal = await makePausedCheck('__sandbox_drain_normal__');
  const sandbox = await makePausedCheck('__sandbox_drain_sandbox__');
  try {
    for (const id of [normal.id, sandbox.id]) {
      await pool.query(`INSERT INTO check_locations (check_id, location) VALUES ($1, 'default') ON CONFLICT DO NOTHING`, [id]);
    }
    await pool.query(`INSERT INTO run_requests (check_id, status, sandbox) VALUES ($1, 'pending', false)`, [normal.id]);
    await pool.query(`INSERT INTO run_requests (check_id, status, sandbox) VALUES ($1, 'pending', true)`, [sandbox.id]);

    // The EXACT drainRunRequests SELECT (index.ts), location='default'.
    const { rows } = await pool.query<{ check_id: number; sandbox: boolean }>(
      `SELECT rr.id, rr.check_id, rr.sandbox
         FROM run_requests rr
         JOIN check_locations cl ON cl.check_id = rr.check_id AND cl.location = $1
         JOIN checks c           ON c.id = rr.check_id AND (c.enabled OR rr.sandbox)
        WHERE rr.status = 'pending' AND rr.check_id = ANY($2::bigint[])
        ORDER BY rr.requested_at`,
      ['default', [normal.id, sandbox.id]],
    );

    const claimed = rows.map((r) => r.check_id);
    assert.deepEqual(claimed, [sandbox.id], 'only the SANDBOX-flagged request for a paused check is claimable');
    assert.ok(!claimed.includes(normal.id), 'a NORMAL request for a paused check is still NOT claimed (relax is sandbox-only)');
  } finally {
    await pool.query(`DELETE FROM checks WHERE id = ANY($1::bigint[])`, [[normal.id, sandbox.id]]);
  }
});
