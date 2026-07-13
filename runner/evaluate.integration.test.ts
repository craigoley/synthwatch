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
import { evaluate, hasOpenIncident } from './evaluate.js';

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

// Seed one run at a given age with an explicit status and optional confirmation link, returning the
// RunRecord evaluate() consumes. `confirmationOf` set => this row is a CONFIRMATION of that scheduled run.
async function seedRun(
  checkId: number,
  status: 'fail' | 'error' | 'pass',
  minutesAgo: number,
  confirmationOf: number | null = null,
): Promise<RunRecord> {
  const down = status !== 'pass';
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO runs (check_id, status, started_at, finished_at, location, error_message, failed_step, confirmation_of_run_id)
     VALUES ($1, $2, now() - make_interval(mins => $3::int), now() - make_interval(mins => $3::int),
             'default', $4, $5, $6)
     RETURNING id`,
    [checkId, status, minutesAgo, down ? 'assertion missed' : null, down ? 'open the product' : null, confirmationOf],
  );
  return {
    id: rows[0].id,
    check_id: checkId,
    status,
    error_message: down ? 'assertion missed' : null,
    failed_step: down ? 'open the product' : null,
    screenshot_url: null,
    location: 'default',
  };
}

// ★★ THE BUG (must go RED on today's code, GREEN on the fix). failure_threshold=2. A confirmation run is a
// re-check of a scheduled failure ALREADY in the window — not an independent observation. On today's code the
// window counts BOTH the scheduled fail and its confirmation fail, so a SINGLE confirmed scheduled failure fills
// a threshold-2 window and pages. That is the live over-alerting bug (#174/#175 opened on confirmation runs).
// The window is ordered oldest→newest: S1(fail), C1(confirms S1, fail), S2(fail), C2(confirms S2, fail).
nodeTest('threshold=2: ONE confirmed scheduled failure must NOT page; the SECOND opens the incident (live)', { skip: SKIP }, async () => {
  const check = await makeCheck(2, '__eval_conf_thr2_e2e__');
  try {
    // First confirmed scheduled failure: scheduled S1 fails, its confirmation C1 also fails.
    const s1 = await seedRun(check.id, 'fail', 40);
    const c1 = await seedRun(check.id, 'fail', 35, s1.id);
    // evaluate() runs from the CONFIRMATION run's applyRunSideEffects (branch A, evaluate.ts:950).
    await evaluate(check, c1);
    assert.equal(
      await openIncidentCount(check.id),
      0,
      'ONE confirmed scheduled failure is 1 scheduled down run < threshold 2 → NO incident (was 1 on the buggy code)',
    );

    // Second confirmed scheduled failure: scheduled S2 fails, its confirmation C2 also fails.
    const s2 = await seedRun(check.id, 'fail', 10);
    const c2 = await seedRun(check.id, 'fail', 5, s2.id);
    await evaluate(check, c2);
    assert.equal(
      await openIncidentCount(check.id),
      1,
      'TWO consecutive confirmed scheduled failures = threshold 2 → incident opens on the second',
    );
  } finally {
    await pool.query(`DELETE FROM checks WHERE id = $1`, [check.id]);
  }
});

// A self-healed transient (confirmation PASSED → original superseded) must contribute ZERO to the threshold.
// threshold=2: superseded transient S1 + ONE later real confirmed scheduled failure S2 ⇒ still only 1 scheduled
// down run in the window ⇒ NO incident. If the transient (or either confirmation) leaked in, this would open.
nodeTest('threshold=2: a self-healed transient contributes ZERO — one later real failure still does not page (live)', { skip: SKIP }, async () => {
  const check = await makeCheck(2, '__eval_conf_transient_e2e__');
  try {
    const s1 = await seedRun(check.id, 'fail', 40); // scheduled failure...
    const c1 = await seedRun(check.id, 'pass', 35, s1.id); // ...whose confirmation PASSED (transient)
    // Mirror branch A: the passing confirmation marks the original superseded (evaluate.ts:928).
    await pool.query(`UPDATE runs SET superseded_by_run_id = $2 WHERE id = $1`, [s1.id, c1.id]);

    // One later REAL confirmed scheduled failure.
    const s2 = await seedRun(check.id, 'fail', 10);
    const c2 = await seedRun(check.id, 'fail', 5, s2.id);
    await evaluate(check, c2);
    assert.equal(
      await openIncidentCount(check.id),
      0,
      'superseded transient counts 0 → only S2 is down → 1 < threshold 2 → NO incident',
    );
  } finally {
    await pool.query(`DELETE FROM checks WHERE id = $1`, [check.id]);
  }
});

// ★ REGRESSION GUARD: threshold=1 is UNCHANGED. One confirmed scheduled failure still pages immediately (the
// scheduled run alone fills the 1-slot window; the confirmation being excluded does not matter at N=1).
nodeTest('threshold=1: one confirmed scheduled failure still opens the incident (unchanged) (live)', { skip: SKIP }, async () => {
  const check = await makeCheck(1, '__eval_conf_thr1_e2e__');
  try {
    const s1 = await seedRun(check.id, 'fail', 10);
    const c1 = await seedRun(check.id, 'fail', 5, s1.id);
    await evaluate(check, c1);
    assert.equal(await openIncidentCount(check.id), 1, 'threshold=1 unchanged: one confirmed failure pages immediately');
  } finally {
    await pool.query(`DELETE FROM checks WHERE id = $1`, [check.id]);
  }
});

// A passing run (recovery), newest by default — drives evaluate() to resolve any open incident.
async function seedPassRun(checkId: number, minutesAgo: number): Promise<RunRecord> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO runs (check_id, status, started_at, finished_at, location)
     VALUES ($1, 'pass', now() - make_interval(mins => $2::int), now() - make_interval(mins => $2::int), 'default')
     RETURNING id`,
    [checkId, minutesAgo],
  );
  return {
    id: rows[0].id,
    check_id: checkId,
    status: 'pass',
    error_message: null,
    failed_step: null,
    screenshot_url: null,
    location: 'default',
  };
}

// (skip-fast-retry signal) hasOpenIncident drives the fast-retry skip and handles the heal→re-fail
// cycle: healthy=false (full retry) → first fail opens incident=true (subsequent failures skip retry)
// → recovery pass RESOLVES the incident=false (full retry returns; a fresh fail is a new transient
// candidate). Proves effectiveRetries(check.retries, hasOpenIncident) covers all 4 task cases.
nodeTest('(skip-retry signal) hasOpenIncident: healthy→down→recovered cycle resets correctly (live)', { skip: SKIP }, async () => {
  const check = await makeCheck(1, '__eval_skipretry_e2e__');
  try {
    // 1) healthy monitor: no open incident → signal false → a failure here gets FULL fast-retry.
    assert.equal(await hasOpenIncident(check.id), false, 'healthy → alreadyFailing=false → full retry');

    // 2) first confirmed failure opens the incident → signal true → SUBSEQUENT failures skip retry.
    await evaluate(check, await seedFailRun(check.id, 1));
    assert.equal(await hasOpenIncident(check.id), true, 'open incident → alreadyFailing=true → 1 attempt');

    // 3) recovery: a passing run → evaluate() resolves the incident → 4) signal false → full retry again.
    await evaluate(check, await seedPassRun(check.id, 0));
    assert.equal(await hasOpenIncident(check.id), false, 'recovery pass resolves incident → full retry returns');
  } finally {
    await pool.query(`DELETE FROM checks WHERE id = $1`, [check.id]);
  }
});
