// LIVE integration proof of the canonical `countable_run` view (0081) and its consumers. Runs only when
// DATABASE_URL is set (skipped offline). Before 0081, "a countable scheduled observation" was inlined six
// times with five different definitions; sla_availability / slo_status / daily_check_rollup counted
// CONFIRMATION runs (double-counting a confirmed outage), and slo_status also counted SANDBOX runs.
//
// Each consumer test is RED on origin/main and GREEN on the fix — proven by reverting schema.sql + the TS
// consumers and rebuilding (see the PR body). flake_status is NOT tested here: it deliberately counts
// superseded runs (a flap IS a superseded run) and is exempt from countable_run.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from './db.js';
import { computeRollupForDay } from './rollup.js';

const SKIP = !process.env.DATABASE_URL;

async function makeCheck(name: string, sloTarget: number | null = null): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO checks (name, kind, target_url, flow_name, spec_path, failure_threshold, severity, slo_target)
     VALUES ($1, 'browser', 'https://example.test', 'noop', 'monitors/__test__/x.spec.ts', 1, 'critical', $2)
     RETURNING id`,
    [name, sloTarget],
  );
  return rows[0].id;
}

// Seed one run. flags: confirmationOf (this row is a confirmation of that run id), sandbox.
async function seedRun(
  checkId: number,
  status: 'pass' | 'fail' | 'error',
  minutesAgo: number,
  flags: { confirmationOf?: number; sandbox?: boolean } = {},
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO runs (check_id, status, started_at, finished_at, location, sandbox, confirmation_of_run_id)
     VALUES ($1, $2, now() - make_interval(mins => $3::int), now() - make_interval(mins => $3::int),
             'default', $4, $5)
     RETURNING id`,
    [checkId, status, minutesAgo, flags.sandbox ?? false, flags.confirmationOf ?? null],
  );
  return rows[0].id;
}

// Mark `origId` as superseded by `byId` (a real run FK), i.e. a self-healed transient.
async function supersede(origId: number, byId: number): Promise<void> {
  await pool.query(`UPDATE runs SET superseded_by_run_id = $2 WHERE id = $1`, [origId, byId]);
}

const WINDOW: [Date, Date] = [new Date(Date.now() - 3_600_000), new Date(Date.now() + 60_000)];

// ── The canonical view: excludes ALL confirmation runs (symmetric, 0083) / superseded / sandbox / running /
//    infra_error; keeps a real scheduled run. RED on main (view does not exist → query throws); GREEN on the
//    fix. Also the symmetric must-go-red: the PASSING confirmation (tc) is excluded, not kept. ─────────────
nodeTest('countable_run keeps a scheduled run and excludes ALL confirmations / superseded / sandbox / running', { skip: SKIP }, async () => {
  const id = await makeCheck('__cr_view__');
  try {
    const s1 = await seedRun(id, 'fail', 50);              // scheduled real run — COUNTS
    await seedRun(id, 'fail', 40, { confirmationOf: s1 }); // DOWN confirmation of s1 — excluded (re-check)
    const t = await seedRun(id, 'fail', 35);               // a transient...
    const tc = await seedRun(id, 'pass', 30, { confirmationOf: t }); // ...whose confirmation PASSED
    await supersede(t, tc);                                // t superseded → excluded; tc is a confirmation → ALSO excluded (0083: a re-check is neither up nor down)
    await seedRun(id, 'fail', 20, { sandbox: true });      // sandbox — excluded
    await pool.query(`INSERT INTO runs (check_id, status, started_at, location) VALUES ($1,'running',now()- interval '15 min','default'),($1,'infra_error',now()- interval '10 min','default')`, [id]);
    const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM countable_run WHERE check_id = $1`, [id]);
    assert.equal(Number(rows[0].n), 1, 'kept: ONLY the scheduled fail. excluded: BOTH confirmations (down AND pass — a re-check is not an observation, 0083 symmetric), superseded, sandbox, running, infra_error');
  } finally { await pool.query(`DELETE FROM checks WHERE id = $1`, [id]); }
});

// ── sla_availability: a CONFIRMATION run must contribute ZERO. 1 pass + 1 scheduled fail + its confirmation
//    fail → main counts all 3 (up=1/3 ≈ 33.33%); fix counts 2 (up=1/2 = 50%). RED on main, GREEN on fix. ──
nodeTest('sla_availability EXCLUDES confirmation runs (33.33% on main → 50% on fix)', { skip: SKIP }, async () => {
  const id = await makeCheck('__cr_sla_conf__');
  try {
    await seedRun(id, 'pass', 50);
    const sched = await seedRun(id, 'fail', 40);
    await seedRun(id, 'fail', 30, { confirmationOf: sched }); // its confirmation also failed → not superseded
    const { rows } = await pool.query<{ availability_pct: string; completed_runs: string }>(
      `SELECT availability_pct, completed_runs FROM sla_availability($1, $2) WHERE check_id = $3`,
      [WINDOW[0], WINDOW[1], id]);
    assert.equal(Number(rows[0].completed_runs), 2, 'confirmation run excluded → 2 completed, not 3');
    assert.equal(Number(rows[0].availability_pct), 50, 'availability 50% (1 up of 2), not 33.33%');
  } finally { await pool.query(`DELETE FROM checks WHERE id = $1`, [id]); }
});

// ── ★ A self-healed transient must not CRATER availability: its superseded fail counts ZERO as DOWN, and its
//    passing confirmation is EXCLUDED too (0083 symmetric — a re-check is neither up nor down). So the tick
//    contributes only the surrounding scheduled sample; availability is unmoved (no down counted), NOT
//    inflated by an extra up. ───────────────────────────────────────────────────────────────────────────────
nodeTest('sla_availability: a self-healed transient — fail counts 0 down, its confirmation is excluded (100%, not inflated)', { skip: SKIP }, async () => {
  const id = await makeCheck('__cr_sla_super__');
  try {
    await seedRun(id, 'pass', 40);
    const t = await seedRun(id, 'fail', 35);
    const tc = await seedRun(id, 'pass', 30, { confirmationOf: t }); // the confirmation PASSED → transient recovered
    await supersede(t, tc);                                          // t superseded → excluded; tc is a confirmation → ALSO excluded (0083)
    const { rows } = await pool.query<{ availability_pct: string; completed_runs: string; down_runs: string }>(
      `SELECT availability_pct, completed_runs, down_runs FROM sla_availability($1, $2) WHERE check_id = $3`,
      [WINDOW[0], WINDOW[1], id]);
    assert.equal(Number(rows[0].down_runs), 0, 'the superseded transient fail never counts as down');
    assert.equal(Number(rows[0].completed_runs), 1, 'only the surrounding scheduled pass — BOTH the transient fail (superseded) and its passing confirmation (re-check) are excluded');
    assert.equal(Number(rows[0].availability_pct), 100, 'availability stays 100 from the clean scheduled pass — not inflated by counting the confirmation as an extra up');
  } finally { await pool.query(`DELETE FROM checks WHERE id = $1`, [id]); }
});

// ── ★ slo_status: a CONFIRMATION run contributes ZERO to burn. Also proves the sandbox gap. slo_target=0.9.
//    1 scheduled fail + its confirmation fail + a sandbox fail → main: total=3?/down (counts confirmation
//    AND sandbox); fix: total=1, down=1. RED on main, GREEN on fix. ────────────────────────────────────
nodeTest('slo_status EXCLUDES confirmation AND sandbox runs (burn counts only scheduled failures)', { skip: SKIP }, async () => {
  const id = await makeCheck('__cr_slo__', 0.9);
  try {
    const sched = await seedRun(id, 'fail', 40);
    await seedRun(id, 'fail', 30, { confirmationOf: sched });
    await seedRun(id, 'fail', 20, { sandbox: true });
    const { rows } = await pool.query<{ total_runs: string; down_runs: string }>(
      `SELECT total_runs, down_runs FROM slo_status($1, $2, $3)`, [id, WINDOW[0], WINDOW[1]]);
    assert.equal(Number(rows[0].total_runs), 1, 'only the scheduled fail counts (confirmation + sandbox excluded)');
    assert.equal(Number(rows[0].down_runs), 1, 'one scheduled down run — not 3');
  } finally { await pool.query(`DELETE FROM checks WHERE id = $1`, [id]); }
});

// ── daily_check_rollup (computeRollupForDay): a CONFIRMATION run must not inflate down_count. ────────────
nodeTest('daily_check_rollup EXCLUDES confirmation runs from down_count', { skip: SKIP }, async () => {
  const id = await makeCheck('__cr_rollup__');
  try {
    const day = new Date().toISOString().slice(0, 10);
    // seed within today
    await seedRun(id, 'pass', 50);
    const sched = await seedRun(id, 'fail', 40);
    await seedRun(id, 'fail', 30, { confirmationOf: sched });
    await computeRollupForDay(id, day);
    const { rows } = await pool.query<{ down_count: number; up_count: number; total_count: number }>(
      `SELECT down_count, up_count, total_count FROM daily_check_rollup WHERE check_id = $1 AND day = $2`, [id, day]);
    assert.equal(rows[0].down_count, 1, 'one scheduled down run (confirmation excluded), not 2');
    assert.equal(rows[0].total_count, 2, 'pass + one scheduled fail; confirmation excluded');
  } finally { await pool.query(`DELETE FROM checks WHERE id = $1`, [id]); }
});
