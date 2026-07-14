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

// (confirmation-gating signal) hasOpenIncident drives confirmation gating (alreadyFailing feeds
// applyRunSideEffects: a monitor with an incident ALREADY open does not enqueue another confirmation) and
// handles the heal→re-fail cycle: healthy=false → first fail opens incident=true → recovery pass RESOLVES
// it=false (a fresh fail is a new transient candidate). The in-run fast-retry this signal used to gate was
// retired in 0084; the incident-lifecycle behaviour it now gates is unchanged. Covers all 4 states.
nodeTest('(confirmation-gating signal) hasOpenIncident: healthy→down→recovered cycle resets correctly (live)', { skip: SKIP }, async () => {
  const check = await makeCheck(1, '__eval_skipretry_e2e__');
  try {
    // 1) healthy monitor: no open incident → alreadyFailing false → a fresh failure is a confirmation candidate.
    assert.equal(await hasOpenIncident(check.id), false, 'healthy → alreadyFailing=false');

    // 2) first confirmed failure opens the incident → alreadyFailing true → no further confirmation enqueued.
    await evaluate(check, await seedFailRun(check.id, 1));
    assert.equal(await hasOpenIncident(check.id), true, 'open incident → alreadyFailing=true');

    // 3) recovery: a passing run → evaluate() resolves the incident → 4) alreadyFailing false again.
    await evaluate(check, await seedPassRun(check.id, 0));
    assert.equal(await hasOpenIncident(check.id), false, 'recovery pass resolves incident → confirmation candidacy returns');
  } finally {
    await pool.query(`DELETE FROM checks WHERE id = $1`, [check.id]);
  }
});

// ══ 0085: single-region WARNING + escalation (the real evaluate() path against Postgres) ══════════════════
// Seed a run at a SPECIFIC location. status pass|fail; fail carries an error+step. Returns the RunRecord.
async function seedAt(checkId: number, status: 'pass' | 'fail', location: string, minutesAgo: number): Promise<RunRecord> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO runs (check_id, status, started_at, finished_at, location, error_message, failed_step)
     VALUES ($1, $2, now() - make_interval(mins => $4::int), now() - make_interval(mins => $4::int), $3,
             CASE WHEN $2 = 'fail' THEN 'assertion missed' END, CASE WHEN $2 = 'fail' THEN 'open the product' END)
     RETURNING id`,
    [checkId, status, location, minutesAgo],
  );
  return {
    id: rows[0].id, check_id: checkId, status,
    error_message: status === 'fail' ? 'assertion missed' : null,
    failed_step: status === 'fail' ? 'open the product' : null,
    screenshot_url: null, location,
  };
}
async function openIncidentSeverity(checkId: number): Promise<string | null> {
  const { rows } = await pool.query<{ severity: string }>(
    `SELECT severity FROM incidents WHERE check_id = $1 AND status = 'open' LIMIT 1`, [checkId]);
  return rows[0]?.severity ?? null;
}

// ★★ THE WESTUS2 REPLAY (must-go-red). Reproduces check 342's real shape: one region (westus2) sustainedly
// down, the other two healthy. On origin/main this opens NOTHING (a minority is silence) — the bug that made
// the operator delete westus2 to stop it. On the fix it opens a WARNING. RED on main, GREEN on the fix.
nodeTest('★ westus2 replay: a sustained single-region outage (1 of 3) opens a WARNING incident, not silence', { skip: SKIP }, async () => {
  const check = await makeCheck(1, '__westus2_replay__'); // severity=critical, min_fail_locations=null (majority)
  try {
    await seedAt(check.id, 'fail', 'westus2', 30);
    await seedAt(check.id, 'fail', 'westus2', 20);
    const w = await seedAt(check.id, 'fail', 'westus2', 10); // sustained (16-consecutive stand-in)
    await seedAt(check.id, 'pass', 'centralus', 12);
    await seedAt(check.id, 'pass', 'eastus2', 11);
    await evaluate(check, w);
    assert.equal(await openIncidentCount(check.id), 1, '★ a single SUSTAINED region now opens an incident (was silence)');
    assert.equal(await openIncidentSeverity(check.id), 'warning', '★ at WARNING — one region is not a majority (not CRITICAL)');
  } finally { await pool.query(`DELETE FROM checks WHERE id = $1`, [check.id]); }
});

// ★ The quorum's purpose SURVIVES: a single ISOLATED failure (below the per-location threshold) pages nothing.
// This is the test that proves we did not just make everything page.
nodeTest('the quorum survives: a single isolated regional failure (not sustained) opens NO incident', { skip: SKIP }, async () => {
  const check = await makeCheck(3, '__region_blip__'); // threshold 3 → one fail is not a sustained outage
  try {
    await seedAt(check.id, 'pass', 'westus2', 30);
    const blip = await seedAt(check.id, 'fail', 'westus2', 5); // ONE fail, below threshold 3
    await seedAt(check.id, 'pass', 'centralus', 6);
    await seedAt(check.id, 'pass', 'eastus2', 5);
    await evaluate(check, blip);
    assert.equal(await openIncidentCount(check.id), 0, 'a lone blip in one region does NOT page — debounce + quorum intact');
  } finally { await pool.query(`DELETE FROM checks WHERE id = $1`, [check.id]); }
});

// ★ ESCALATION (the hard part): a WARNING incident becomes CRITICAL when the outage spreads to a majority —
// escalated IN PLACE (still one incident), never dropped by the ON CONFLICT.
nodeTest('★ escalation: a WARNING incident escalates to CRITICAL when the outage spreads to a majority', { skip: SKIP }, async () => {
  const check = await makeCheck(1, '__escalation__');
  try {
    await seedAt(check.id, 'pass', 'centralus', 20);
    await seedAt(check.id, 'pass', 'eastus2', 20);
    await seedAt(check.id, 'fail', 'westus2', 16); // 2× failure_threshold (ft=1) → past the WARNING debounce
    const w1 = await seedAt(check.id, 'fail', 'westus2', 15);
    await evaluate(check, w1);
    assert.equal(await openIncidentSeverity(check.id), 'warning', 'tick 1: one region sustained (2×) → WARNING opens');
    const c2 = await seedAt(check.id, 'fail', 'centralus', 3); // now 2 of 3 at the CRITICAL bar → majority
    await evaluate(check, c2);
    assert.equal(await openIncidentCount(check.id), 1, 'still ONE incident — escalated in place, not a second');
    assert.equal(await openIncidentSeverity(check.id), 'critical', '★ escalated WARNING → CRITICAL (not dropped by ON CONFLICT)');
  } finally { await pool.query(`DELETE FROM checks WHERE id = $1`, [check.id]); }
});

// ★ The MAJORITY path is unchanged: 2 of 3 down opens CRITICAL directly (BUILD requirement #2).
nodeTest('the majority path is unchanged: 2 of 3 regions down opens a CRITICAL incident directly', { skip: SKIP }, async () => {
  const check = await makeCheck(1, '__majority_critical__');
  try {
    await seedAt(check.id, 'pass', 'eastus2', 20);
    await seedAt(check.id, 'fail', 'westus2', 12);
    const c = await seedAt(check.id, 'fail', 'centralus', 5);
    await evaluate(check, c);
    assert.equal(await openIncidentCount(check.id), 1, 'majority down → incident opens');
    assert.equal(await openIncidentSeverity(check.id), 'critical', 'directly at CRITICAL — the majority path, unchanged');
  } finally { await pool.query(`DELETE FROM checks WHERE id = $1`, [check.id]); }
});

// ★ THE DEBOUNCE (the churn fix): a single region down AT the critical bar (failure_threshold) but BELOW the
// 2× warning bar opens NO incident. This is what kills check 342's daily westus2 warning.
nodeTest('★ debounce: a single region down at the critical bar but below 2× → NO warning (kills the daily churn)', { skip: SKIP }, async () => {
  const check = await makeCheck(2, '__warning_debounce__'); // failure_threshold=2 → warning bar = 4
  try {
    await seedAt(check.id, 'fail', 'westus2', 20);
    const w = await seedAt(check.id, 'fail', 'westus2', 10); // westus2 down 2 = meets ft=2, but < 2×2=4
    await seedAt(check.id, 'pass', 'centralus', 12);
    await seedAt(check.id, 'pass', 'eastus2', 11);
    await evaluate(check, w);
    assert.equal(await openIncidentCount(check.id), 0, 'sustained at the CRITICAL bar but below the 2× WARNING bar → still silent (debounced)');
  } finally { await pool.query(`DELETE FROM checks WHERE id = $1`, [check.id]); }
});

// ★★ CRITICAL IS NEVER DELAYED BY THE DEBOUNCE (the one way this could be worse than today): a region below
// the warning bar that SPREADS to a majority pages CRITICAL immediately — no warning was ever open, no wait.
nodeTest('★ critical is never debounced: a sub-warning region that spreads to a majority pages CRITICAL immediately', { skip: SKIP }, async () => {
  const check = await makeCheck(1, '__critical_no_delay__'); // ft=1 → warning bar = 2
  try {
    await seedAt(check.id, 'pass', 'eastus2', 20);
    await seedAt(check.id, 'fail', 'westus2', 8); // westus2 down 1 = below the 2× warning bar → NO warning yet
    // (no evaluate here — the warning bar isn't met, nothing would open)
    const c = await seedAt(check.id, 'fail', 'centralus', 3); // now 2 of 3 at the critical bar → majority
    await evaluate(check, c);
    assert.equal(await openIncidentCount(check.id), 1, 'majority reached → incident opens immediately');
    assert.equal(await openIncidentSeverity(check.id), 'critical', '★ CRITICAL directly — the debounce never delayed it');
  } finally { await pool.query(`DELETE FROM checks WHERE id = $1`, [check.id]); }
});
