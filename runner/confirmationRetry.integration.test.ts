// LIVE integration proof of confirmation-retry (migration 0077, Option B / P1). Runs only when DATABASE_URL
// is set (skipped offline). index.ts runs main() on import (house convention), so runOne/drainRunRequests
// aren't importable — we test the extracted seam applyRunSideEffects(check, run, ctx) + the read-side rollup
// exclusion (computeRollupForDay). The confirmation OWNS the verdict; an unconfirmed (superseded) transient is
// VISIBLE but excluded from the health signal.
//
// fireRunnerJobStart (ARM jobs/start) is best-effort and SKIPS cleanly when AZURE_* env is unset (as in CI),
// so the durable enqueue (the run_requests INSERT) is what these tests observe — no ARM call is attempted.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { pool, type Check, type RunRecord } from './db.js';
import { applyRunSideEffects } from './evaluate.js';
import { computeRollupForDay } from './rollup.js';

const SKIP = !process.env.DATABASE_URL;

async function makeCheck(name: string, kind: 'browser' | 'http'): Promise<Check> {
  const { rows } = await pool.query(
    `INSERT INTO checks (name, kind, target_url, flow_name, spec_path, failure_threshold, severity, enabled)
     VALUES ($1, $2, 'https://example.test', 'noop', $3, 1, 'critical', true)
     RETURNING *`,
    [name, kind, kind === 'browser' ? 'monitors/__test__/x.spec.ts' : null],
  );
  return rows[0] as unknown as Check;
}

async function seedRun(checkId: number, status: string, confirmationOf: number | null = null): Promise<RunRecord> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO runs (check_id, status, started_at, finished_at, location, error_message, failed_step, confirmation_of_run_id)
     VALUES ($1, $2, now(), now(), 'default', $3, $4, $5) RETURNING id`,
    [checkId, status, status === 'pass' ? null : 'assertion missed', status === 'pass' ? null : 'open the product', confirmationOf],
  );
  return { id: rows[0].id, check_id: checkId, status, error_message: null, failed_step: null, screenshot_url: null, location: 'default' } as RunRecord;
}

async function openIncidentCount(checkId: number): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM incidents WHERE check_id = $1 AND status = 'open'`, [checkId]);
  return Number(rows[0].n);
}
async function pendingConfirmations(checkId: number): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM run_requests WHERE check_id = $1 AND confirmation AND status = 'pending'`, [checkId]);
  return Number(rows[0].n);
}
async function supersededBy(runId: number): Promise<number | null> {
  const { rows } = await pool.query<{ s: number | null }>(`SELECT superseded_by_run_id AS s FROM runs WHERE id = $1`, [runId]);
  return rows[0]?.s ?? null;
}
async function runExists(runId: number): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM runs WHERE id = $1`, [runId]);
  return rows.length > 0;
}

const healthy = { sandbox: false, alreadyFailing: false, confirmationOfRunId: null } as const;

// ★ MUST-GO-RED (the core gate): a healthy browser check's failure DEFERS — evaluate() is SKIPPED (no
// incident), a pending confirmation is enqueued, and the failed run STAYS VISIBLE. Without the gate, evaluate()
// would open an incident on the unconfirmed failure (the false page this whole feature prevents).
nodeTest('healthy browser failure DEFERS: no incident, one pending confirmation, the failed run persists', { skip: SKIP }, async () => {
  const check = await makeCheck('__confirm_defer__', 'browser');
  try {
    const run = await seedRun(check.id, 'fail');
    await applyRunSideEffects(check, run, healthy);

    assert.equal(await openIncidentCount(check.id), 0, 'an UNCONFIRMED failure must NOT open an incident');
    assert.equal(await pendingConfirmations(check.id), 1, 'exactly one confirmation run must be enqueued');
    assert.equal(await runExists(run.id), true, 'the failed run must STAY VISIBLE (never silently discarded)');
    assert.equal(await supersededBy(run.id), null, 'the failed run is awaiting — not yet superseded');
  } finally {
    await pool.query(`DELETE FROM checks WHERE id = $1`, [check.id]);
  }
});

// Confirmation PASSES → the original was a TRANSIENT: it is marked superseded (still exists), NO incident opens.
nodeTest('confirmation PASS → original marked superseded, still visible, no incident', { skip: SKIP }, async () => {
  const check = await makeCheck('__confirm_pass__', 'browser');
  try {
    const original = await seedRun(check.id, 'fail');
    const confirmation = await seedRun(check.id, 'pass', original.id);
    await applyRunSideEffects(check, confirmation, { sandbox: false, alreadyFailing: false, confirmationOfRunId: original.id });

    assert.equal(await supersededBy(original.id), confirmation.id, 'the transient original must be marked superseded_by the confirmation');
    assert.equal(await runExists(original.id), true, 'the superseded transient must STILL EXIST (visible in history)');
    assert.equal(await openIncidentCount(check.id), 0, 'a confirmed-transient failure opens NO incident');
    assert.equal(await pendingConfirmations(check.id), 0, 'a confirmation NEVER enqueues another (D4)');
  } finally {
    await pool.query(`DELETE FROM checks WHERE id = $1`, [check.id]);
  }
});

// Confirmation FAILS → CONFIRMED: the incident opens exactly as today; the original is NOT superseded; and the
// confirmation does not enqueue another (D4).
nodeTest('confirmation FAIL → incident opens, original not superseded, no further confirmation', { skip: SKIP }, async () => {
  const check = await makeCheck('__confirm_fail__', 'browser');
  try {
    const original = await seedRun(check.id, 'fail');
    const confirmation = await seedRun(check.id, 'fail', original.id);
    await applyRunSideEffects(check, confirmation, { sandbox: false, alreadyFailing: false, confirmationOfRunId: original.id });

    assert.equal(await openIncidentCount(check.id), 1, 'a CONFIRMED failure opens the incident');
    assert.equal(await supersededBy(original.id), null, 'a confirmed failure is real — the original is NOT superseded');
    assert.equal(await pendingConfirmations(check.id), 0, 'a confirmation NEVER enqueues another (D4)');
  } finally {
    await pool.query(`DELETE FROM checks WHERE id = $1`, [check.id]);
  }
});

// ★★ MUST-GO-RED (the WHOLE point of the change): a healthy HTTP failure now DEFERS exactly like a browser one
// — evaluate() SKIPPED (no incident), one pending confirmation enqueued, the failed run persists. Before the
// eligibility extension http went STRAIGHT to evaluate (an incident on the first unconfirmed blip, and NEVER a
// superseded transient → structurally flap-blind). Reverting confirmByRerunEligible flips this red.
nodeTest('healthy HTTP failure DEFERS: no incident, one pending confirmation, the failed run persists (was flap-blind)', { skip: SKIP }, async () => {
  const check = await makeCheck('__confirm_http_defer__', 'http');
  try {
    const run = await seedRun(check.id, 'error');
    await applyRunSideEffects(check, run, healthy);
    assert.equal(await openIncidentCount(check.id), 0, 'an UNCONFIRMED http failure must NOT open an incident');
    assert.equal(await pendingConfirmations(check.id), 1, 'an http failure now enqueues exactly one confirmation');
    assert.equal(await runExists(run.id), true, 'the failed http run STAYS VISIBLE, awaiting confirmation');
    assert.equal(await supersededBy(run.id), null, 'not yet superseded — the confirmation has not run');
  } finally {
    await pool.query(`DELETE FROM checks WHERE id = $1`, [check.id]);
  }
});

// The full HTTP flap lifecycle: confirmation PASS → the transient is superseded (the flap signal that has been
// ZERO for http forever now EXISTS) and NO incident opens; confirmation FAIL → the incident opens as today.
nodeTest('HTTP confirmation PASS → superseded (flap signal exists), FAIL → incident opens', { skip: SKIP }, async () => {
  const passing = await makeCheck('__confirm_http_pass__', 'http');
  const failing = await makeCheck('__confirm_http_fail__', 'http');
  try {
    const orig1 = await seedRun(passing.id, 'error');
    const conf1 = await seedRun(passing.id, 'pass', orig1.id);
    await applyRunSideEffects(passing, conf1, { sandbox: false, alreadyFailing: false, confirmationOfRunId: orig1.id });
    assert.equal(await supersededBy(orig1.id), conf1.id, 'transient http original marked superseded by its confirmation');
    assert.equal(await openIncidentCount(passing.id), 0, 'a confirmed-transient http failure opens NO incident');

    const orig2 = await seedRun(failing.id, 'error');
    const conf2 = await seedRun(failing.id, 'error', orig2.id);
    await applyRunSideEffects(failing, conf2, { sandbox: false, alreadyFailing: false, confirmationOfRunId: orig2.id });
    assert.equal(await openIncidentCount(failing.id), 1, 'a CONFIRMED http failure opens the incident');
    assert.equal(await supersededBy(orig2.id), null, 'a confirmed http failure is real — the original is NOT superseded');
    assert.equal(await pendingConfirmations(failing.id), 0, 'a confirmation NEVER enqueues another (D4)');
  } finally {
    await pool.query(`DELETE FROM checks WHERE id = ANY($1::bigint[])`, [[passing.id, failing.id]]);
  }
});

// D5 (the cost guard — has teeth for http: the kitting APIs fail 150-290×/month) + D6 (sandbox), for HTTP and
// browser alike: an already-failing or sandbox run enqueues NOTHING. Without D5, a constantly-failing http check
// would enqueue a confirmation on EVERY tick — doubling its cost forever.
nodeTest('D5 already-failing + D6 sandbox suppress the confirmation for HTTP and browser', { skip: SKIP }, async () => {
  const http = await makeCheck('__confirm_http_d5__', 'http');
  const browser = await makeCheck('__confirm_browser_d5__', 'browser');
  try {
    // ★ D5 for the NEW kind: already-failing http → straight to evaluate, NO confirmation (bounds the 2× cost).
    const r1 = await seedRun(http.id, 'error');
    await applyRunSideEffects(http, r1, { sandbox: false, alreadyFailing: true, confirmationOfRunId: null });
    assert.equal(await pendingConfirmations(http.id), 0, 'D5: an already-failing http check does NOT enqueue a confirmation');
    assert.equal(await openIncidentCount(http.id), 1, 'D5: an already-failing http failure opens the incident immediately');

    // ★ D6 for the new kind: a sandbox http run enqueues nothing (early return, before the confirm branch).
    const r2 = await seedRun(http.id, 'error');
    await applyRunSideEffects(http, r2, { sandbox: true, alreadyFailing: false, confirmationOfRunId: null });
    assert.equal(await pendingConfirmations(http.id), 0, 'D6: a sandbox http run enqueues no confirmation');

    // browser unchanged (the proven path): already-failing → no confirmation, incident opens.
    const r3 = await seedRun(browser.id, 'fail');
    await applyRunSideEffects(browser, r3, { sandbox: false, alreadyFailing: true, confirmationOfRunId: null });
    assert.equal(await pendingConfirmations(browser.id), 0, 'D5 browser unchanged');
    assert.equal(await openIncidentCount(browser.id), 1, 'D5 browser unchanged');
  } finally {
    await pool.query(`DELETE FROM checks WHERE id = ANY($1::bigint[])`, [[http.id, browser.id]]);
  }
});

// ★ READ-SIDE MUST-GO-RED: a superseded transient must NOT enter the daily rollup's down_count (else
// availability craters on a self-resolving blip). One superseded fail + one pass → down_count 0, up_count 1.
nodeTest('rollup down_count EXCLUDES a superseded transient', { skip: SKIP }, async () => {
  const check = await makeCheck('__confirm_rollup__', 'browser');
  try {
    const original = await seedRun(check.id, 'fail');
    const confirmation = await seedRun(check.id, 'pass', original.id);
    await pool.query(`UPDATE runs SET superseded_by_run_id = $2 WHERE id = $1`, [original.id, confirmation.id]);

    const day = new Date().toISOString().slice(0, 10);
    await computeRollupForDay(check.id, day);
    const { rows } = await pool.query<{ down_count: number; up_count: number }>(
      `SELECT down_count, up_count FROM daily_check_rollup WHERE check_id = $1 AND day = $2`, [check.id, day]);
    assert.equal(rows[0].down_count, 0, 'the superseded transient must NOT count as down');
    // ★ DECISION CHANGE (0083 — the symmetric countable_run predicate). The passing confirmation is a
    // RE-CHECK of the sample already in this window — neither a new up nor a new down; it is a transient,
    // which flake_status measures. 0081's "keep it as an up" was asymmetric in the flattering direction
    // (it took the good re-sample and discarded the bad), inflating availability by one up per transient.
    // This assertion is edited ON PURPOSE because the DECISION it encodes changed — NOT to dodge a guardrail
    // (guardrail-2). It is the symmetric must-go-red: a PASSING confirmation must contribute ZERO up —
    // RED on down-only main (up=1), GREEN on the symmetric fix (up=0). See db/migrations/0083 + PR body.
    assert.equal(rows[0].up_count, 0, 'a passing confirmation is a re-check, not an up — excluded (0083 symmetric)');
  } finally {
    await pool.query(`DELETE FROM checks WHERE id = $1`, [check.id]);
  }
});

// ★ READ-SIDE, for HTTP: the rollup exclusion is kind-agnostic (it filters superseded_by_run_id IS NULL, no
// kind gate — same as sla_availability / slo_status / aggregateVerdict / status-page), so an http superseded
// transient is excluded from availability exactly like a browser one. Measured for http, as #278 did for browser.
nodeTest('rollup down_count EXCLUDES a superseded HTTP transient (read-side is kind-agnostic)', { skip: SKIP }, async () => {
  const check = await makeCheck('__confirm_rollup_http__', 'http');
  try {
    const original = await seedRun(check.id, 'error');
    const confirmation = await seedRun(check.id, 'pass', original.id);
    await pool.query(`UPDATE runs SET superseded_by_run_id = $2 WHERE id = $1`, [original.id, confirmation.id]);

    const day = new Date().toISOString().slice(0, 10);
    await computeRollupForDay(check.id, day);
    const { rows } = await pool.query<{ down_count: number; up_count: number }>(
      `SELECT down_count, up_count FROM daily_check_rollup WHERE check_id = $1 AND day = $2`, [check.id, day]);
    assert.equal(rows[0].down_count, 0, 'the superseded http transient must NOT count as down');
    // ★ DECISION CHANGE (0083 symmetric predicate) — kind-agnostic: a passing http confirmation is a
    // re-check, not an up. Edited on purpose (the decision changed), not to dodge guardrail-2. RED on
    // down-only main (up=1), GREEN on the symmetric fix (up=0). See db/migrations/0083 + PR body.
    assert.equal(rows[0].up_count, 0, 'a passing http confirmation is a re-check, not an up — excluded (0083 symmetric)');
  } finally {
    await pool.query(`DELETE FROM checks WHERE id = $1`, [check.id]);
  }
});
