// Cadence regression harness — the committed version of the analysis-round proof that found the
// δ-slip (the scratch artifact lived in an ephemeral container; THIS is its permanent home).
//
// It drives the PRODUCTION due predicate (imported from duePredicate.ts — the same string
// findDueChecks and claim() interpolate, so this cannot drift from what ships) with fixed-rate
// simulated cron ticks against the integration Postgres, exactly like ACA fires the job on
// wall-clock marks. Scaled clock: tick = 2s stands in for the 300s cron tier; WORK_MS of explicit
// in-loop delay before each claim stands in for the reap/manifest/drain pre-work + prior checks
// (the δ in the slip mechanism). Every pass/fail boundary keeps >= 0.3s of margin vs timer jitter.
//
// THREE properties, must-go-red BOTH directions (the bad predicates are asserted to VIOLATE the
// property, so a regression in the harness itself — e.g. margins that stop discriminating — fails):
//   1. GUARDED (production): a tick-multiple check claims on EVERY due mark → realized ≈ interval.
//   2. NAIVE (ε = 0, the pre-fix predicate): the SAME setup slips a full extra tick → the harness
//      DETECTS the prod pathology (300s→598s medians, July 4) at scale.
//   3. OVER-EAGER (ε >= interval − tick): a 2×tick check fires on EVERY mark (double rate) → the
//      harness detects the failure mode the TICK_SLIP_GUARD_S < tick-period bound exists to prevent.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from './db.js';
import { DUE_PREDICATE_SQL } from './duePredicate.js';

const SKIP = !process.env.DATABASE_URL;
const test = SKIP ? nodeTest.skip : nodeTest;

const TICK_MS = 2000; // scaled cron tier: 2s stands in for 300s
const TICKS = 5; //     marks t0..t4
const WORK_MS = 300; // explicit in-loop offset δ before each claim: large vs CI timer jitter (~50ms), small vs
// every decision boundary — worst-case δ (2nd claim, 600ms) stays >=0.4s from the 2s-check threshold (1.0s).

// The naive (pre-fix) predicate and an over-eager guard (ε >= interval − tick for the 4s check),
// used to prove the harness goes red in both directions. Only DUE_PREDICATE_SQL ships.
const NAIVE_PREDICATE_SQL = `(cl.last_run_at IS NULL
  OR now() - cl.last_run_at >= make_interval(secs => c.interval_seconds))`;
const OVER_EAGER_PREDICATE_SQL = `(cl.last_run_at IS NULL
  OR now() - cl.last_run_at >= make_interval(secs => c.interval_seconds) - make_interval(secs => 3))`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function makeCheck(name: string, intervalS: number, loc: string): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO checks (name, kind, target_url, flow_name, spec_path, failure_threshold, severity, interval_seconds)
     VALUES ($1, 'browser', 'https://example.test', 'noop', 'monitors/__test__/x.spec.ts', 1, 'critical', $2)
     RETURNING id`,
    [name, intervalS],
  );
  await pool.query(`INSERT INTO check_locations (check_id, location) VALUES ($1, $2)`, [rows[0].id, loc]);
  return rows[0].id;
}

/**
 * Run TICKS fixed-rate simulated cron marks (deadline = start + n×TICK_MS, independent of work
 * time — exactly how ACA cron fires) of the production loop shape: due-SELECT, then per due row a
 * WORK_MS delay (the δ) followed by the conditional-claim UPDATE. Returns claim wall-times per check.
 */
async function simulate(predicate: string, loc: string, checkIds: number[]): Promise<Map<number, number[]>> {
  const claims = new Map<number, number[]>(checkIds.map((id) => [id, []]));
  const t0 = Date.now();
  for (let t = 0; t < TICKS; t++) {
    const deadline = t0 + t * TICK_MS;
    const wait = deadline - Date.now();
    if (wait > 0) await sleep(wait);

    // findDueChecks, verbatim shape (predicate injected exactly as index.ts interpolates it).
    const { rows: due } = await pool.query<{ id: number }>(
      `SELECT c.id FROM checks c
        JOIN check_locations cl ON cl.check_id = c.id AND cl.location = $1
       WHERE c.enabled AND ${predicate}
       ORDER BY cl.last_run_at ASC NULLS FIRST`,
      [loc],
    );
    for (const { id } of due) {
      await sleep(WORK_MS); // the in-loop offset δ — the slip mechanism's whole cause
      // claim(), verbatim shape: conditional UPDATE re-checking the predicate, mirror included.
      const { rows: won } = await pool.query<{ check_id: number }>(
        `WITH claimed AS (
           UPDATE check_locations cl SET last_run_at = now()
             FROM checks c
            WHERE cl.check_id = $2 AND cl.location = $1 AND c.id = cl.check_id AND c.enabled
              AND ${predicate}
           RETURNING cl.check_id),
         mirror AS (UPDATE checks SET last_run_at = now() WHERE id = (SELECT check_id FROM claimed))
         SELECT check_id FROM claimed`,
        [loc, id],
      );
      if (won[0]) claims.get(id)!.push(Date.now());
    }
  }
  return claims;
}

function gapsOf(times: number[]): number[] {
  return times.slice(1).map((t, i) => (t - times[i]) / 1000);
}

async function cleanup(ids: number[]): Promise<void> {
  for (const id of ids) await pool.query(`DELETE FROM checks WHERE id = $1`, [id]);
}

// 1. PRODUCTION predicate: realized cadence ≈ interval, and NO double-fire.
test('★ cadence: the shipped predicate claims a tick-multiple check on EVERY mark (realized ≈ interval), a 2×tick check on every OTHER mark (no double-fire)', async () => {
  const loc = '__cadence_prod__';
  const a = await makeCheck('__cad_prod_2s__', 2, loc); //  interval == tick (the 300s cohort)
  const b = await makeCheck('__cad_prod_4s__', 4, loc); //  interval == 2×tick (the 600s cohort)
  try {
    const claims = await simulate(DUE_PREDICATE_SQL, loc, [a, b]);
    // A: one claim per mark — 5 of 5. Unfixed prod reality was every-other (598s for 300s config).
    assert.equal(claims.get(a)!.length, TICKS, 'tick-multiple check claims on every mark');
    for (const g of gapsOf(claims.get(a)!)) {
      assert.ok(g > 1.4 && g < 2.6, `realized gap ${g}s must sit at ≈ the 2s interval, not 2×`);
    }
    // B: every other mark — 3 claims over marks t0..t4, gaps ≈ 4s. >2.6s also proves the guard
    // never lets consecutive marks both fire (the at-most-once-per-interval property).
    assert.equal(claims.get(b)!.length, 3, '2×tick check claims every other mark — never doubled');
    for (const g of gapsOf(claims.get(b)!)) {
      assert.ok(g > 3.4 && g < 4.6, `2×tick realized gap ${g}s must sit at ≈ its 4s interval`);
    }
  } finally {
    await cleanup([a, b]);
  }
});

// 2. RED direction one — the NAIVE predicate reproduces the δ-slip (this is the pre-fix behavior;
//    if this assertion ever starts passing at ≈interval, the harness has lost its teeth).
test('★ cadence red-test (unfixed): the naive predicate slips a full extra tick — realized ≈ 2× interval', async () => {
  const loc = '__cadence_naive__';
  const a = await makeCheck('__cad_naive_2s__', 2, loc);
  try {
    const claims = await simulate(NAIVE_PREDICATE_SQL, loc, [a]);
    // Marks t0, t2, t4 only → 3 claims, gaps ≈ 4s (= interval + one tick: 300→598 at prod scale).
    assert.equal(claims.get(a)!.length, 3, 'naive predicate must claim only every OTHER mark');
    for (const g of gapsOf(claims.get(a)!)) {
      assert.ok(g > 3.4, `naive realized gap ${g}s must show the +1-tick slip (≈ 4s, not 2s)`);
    }
  } finally {
    await cleanup([a]);
  }
});

// 3. RED direction two — an OVER-EAGER guard (ε >= interval − tick) double-fires a 2×tick check.
//    TICK_SLIP_GUARD_S must stay < the tick period precisely so production can never do this.
test('★ cadence red-test (over-eager ε): a guard >= interval − tick fires a 2×tick check on EVERY mark (double rate)', async () => {
  const loc = '__cadence_eager__';
  const b = await makeCheck('__cad_eager_4s__', 4, loc);
  try {
    const claims = await simulate(OVER_EAGER_PREDICATE_SQL, loc, [b]);
    assert.equal(claims.get(b)!.length, TICKS, 'over-eager ε must double-fire (every mark)');
    const gaps = gapsOf(claims.get(b)!);
    assert.ok(Math.min(...gaps) < 2.6, 'double-fire gaps sit at the tick period, half the interval');
  } finally {
    await cleanup([b]);
  }
});
