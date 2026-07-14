// LIVE integration proof of incident delivery accounting (0082). Runs only when DATABASE_URL is set.
// ★ THE POINT: a FAILED page and a SUCCESSFUL page must NOT leave identical DB state. Before this, both
// left nothing. The must-go-red test is #1: a failed dispatch → notify_status='failed' AND a runner_errors
// row. A test that only passed on success would make the accounting itself fake-quiet — the exact bug.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from './db.js';
import { recordIncidentDispatch } from './evaluate.js';
import type { DispatchResult } from './alerts.js';

const SKIP = !process.env.DATABASE_URL;

async function makeIncident(): Promise<{ checkId: number; incidentId: number }> {
  const { rows: c } = await pool.query<{ id: number }>(
    `INSERT INTO checks (name, kind, target_url, flow_name, spec_path, failure_threshold, severity)
     VALUES ($1,'browser','https://example.test','noop','monitors/__test__/x.spec.ts',1,'critical') RETURNING id`,
    [`__notify_acct__${Number(process.hrtime.bigint() % 1000000n)}`],
  );
  const checkId = c[0].id;
  const { rows: i } = await pool.query<{ id: number }>(
    `INSERT INTO incidents (check_id, status, severity) VALUES ($1,'open','critical') RETURNING id`,
    [checkId],
  );
  return { checkId, incidentId: i[0].id };
}
async function readIncident(id: number) {
  const { rows } = await pool.query<{ notify_status: string | null; notify_error: string | null; notify_attempts: number; notify_attempted_at: Date | null }>(
    `SELECT notify_status, notify_error, notify_attempts, notify_attempted_at FROM incidents WHERE id = $1`, [id]);
  return rows[0];
}
async function runnerErrorCount(checkId: number, phase: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM runner_errors WHERE check_id = $1 AND phase = $2`, [checkId, phase]);
  return Number(rows[0].n);
}

const FAILED: DispatchResult = { active: 1, delivered: 0, results: [{ channelId: 1, name: 'ops-email', type: 'email', ok: false, error: 'ACS 500' }] };
const SENT: DispatchResult = { active: 1, delivered: 1, results: [{ channelId: 1, name: 'ops-email', type: 'email', ok: true }] };
const SKIPPED: DispatchResult = { active: 0, delivered: 0, results: [] };

// ★★ MUST-GO-RED: a failed dispatch records status='failed' + writes a runner_errors row. Reverting the
// accounting (or breaking the runner_errors write) flips this red — which is the whole point.
nodeTest('a FAILED dispatch → notify_status=failed + notify_error + a runner_errors row', { skip: SKIP }, async () => {
  const { checkId, incidentId } = await makeIncident();
  try {
    await recordIncidentDispatch(incidentId, checkId, 'open', FAILED);
    const inc = await readIncident(incidentId);
    assert.equal(inc.notify_status, 'failed', 'a failed page must be RECORDED as failed, not left NULL');
    assert.ok(inc.notify_error?.includes('ACS 500'), 'the per-channel error is captured');
    assert.equal(inc.notify_attempts, 1, 'attempt counted');
    assert.ok(inc.notify_attempted_at, 'attempted_at stamped');
    assert.equal(await runnerErrorCount(checkId, 'alert-dispatch-failed'), 1, 'a failed page is LOUD in runner_errors');
  } finally { await pool.query(`DELETE FROM checks WHERE id = $1`, [checkId]); }
});

// A successful dispatch → 'sent', NO runner_errors.
nodeTest('a SENT dispatch → notify_status=sent, no runner_errors', { skip: SKIP }, async () => {
  const { checkId, incidentId } = await makeIncident();
  try {
    await recordIncidentDispatch(incidentId, checkId, 'open', SENT);
    assert.equal((await readIncident(incidentId)).notify_status, 'sent');
    assert.equal(await runnerErrorCount(checkId, 'alert-dispatch-failed'), 0, 'a delivered page writes no error');
  } finally { await pool.query(`DELETE FROM checks WHERE id = $1`, [checkId]); }
});

// ★ 'skipped' (no deliverable channel) is a REAL state — it must be recorded, NOT read as success.
nodeTest('a SKIPPED dispatch (no deliverable channel) → notify_status=skipped (distinct from sent)', { skip: SKIP }, async () => {
  const { checkId, incidentId } = await makeIncident();
  try {
    await recordIncidentDispatch(incidentId, checkId, 'open', SKIPPED);
    const inc = await readIncident(incidentId);
    assert.equal(inc.notify_status, 'skipped', 'no-channel must record skipped, never NULL/sent');
    assert.notEqual(inc.notify_status, 'sent');
    assert.equal(await runnerErrorCount(checkId, 'alert-dispatch-failed'), 0);
  } finally { await pool.query(`DELETE FROM checks WHERE id = $1`, [checkId]); }
});

// notify_attempts accumulates across the three incident dispatches (open → enrichment → resolve).
nodeTest('notify_attempts accumulates across dispatches; latest status wins', { skip: SKIP }, async () => {
  const { checkId, incidentId } = await makeIncident();
  try {
    await recordIncidentDispatch(incidentId, checkId, 'open', SENT);
    await recordIncidentDispatch(incidentId, checkId, 'enrichment', FAILED);
    await recordIncidentDispatch(incidentId, checkId, 'resolve', SENT);
    const inc = await readIncident(incidentId);
    assert.equal(inc.notify_attempts, 3, 'every dispatch counted');
    assert.equal(inc.notify_status, 'sent', 'latest (resolve) status wins');
    assert.equal(await runnerErrorCount(checkId, 'alert-dispatch-failed'), 1, 'the one failed dispatch is durably logged');
  } finally { await pool.query(`DELETE FROM checks WHERE id = $1`, [checkId]); }
});
