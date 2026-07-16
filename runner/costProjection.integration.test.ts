// cost_projection(rate) as an executable proof of the two cost-model claims (0069 + 0078), against the
// integration Postgres (gated on DATABASE_URL, like the other *.integration.test.ts; CI runs it on the
// Postgres-service job). Inserts a controlled check + runs, filters cost_projection to that check_id.
//
// Proves:
//   A. the rate is a CLEAN multiplier — cost_projection(2r) is EXACTLY 2× cost_projection(r) for the same
//      run set (projected & measured), divergence unchanged. This is WHY the two-meter fix (0.00003→0.00006
//      at 2.0/4) doubles every figure exactly.
//   B. divergence is a PURE RUN-COUNT ratio — DOUBLING every run's duration leaves divergence UNCHANGED
//      (measured and projected inflate identically). So slow/failing runs cannot move it, and retries
//      (which persist no extra row/duration) are structurally invisible. Bug B, refuted in SQL.
//   C. the new count columns (run_count_7d / confirmation / sandbox / recent+prior) are correct, and
//      recent+prior partition run_count_7d at 3.5d — the cadence-straddle signal the dashboard attributes.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from './db.js';

const SKIP = !process.env.DATABASE_URL;
const test = SKIP ? nodeTest.skip : nodeTest;

interface Row {
  projected_raw: string; measured_raw: string; divergence: string | null;
  run_count_7d: number; confirmation_count_7d: number; sandbox_count_7d: number;
  run_count_recent: number; run_count_prior: number;
}

async function project(rate: number, checkId: number): Promise<Row> {
  const { rows } = await pool.query<Row>(
    `SELECT projected_raw, measured_raw, divergence, run_count_7d, confirmation_count_7d,
            sandbox_count_7d, run_count_recent, run_count_prior
       FROM cost_projection($1::numeric) WHERE check_id = $2`,
    [rate, checkId],
  );
  assert.equal(rows.length, 1, 'the enabled test check appears exactly once');
  return rows[0];
}

test('cost_projection: clean-multiplier rate + pure run-count divergence + count columns', async () => {
  // A check with interval 3600s / 1 region. Expected 7d schedule = 604800/3600 = 168 runs.
  const { rows: cr } = await pool.query<{ id: number }>(
    `INSERT INTO checks (name, kind, target_url, flow_name, spec_path, failure_threshold, severity, interval_seconds, enabled)
     VALUES ('__costproj_test__', 'browser', 'https://example.test', 'noop', 'monitors/__test__/x.spec.ts', 1, 'critical', 3600, true)
     RETURNING id`,
  );
  const checkId = cr[0].id;
  try {
    await pool.query(`INSERT INTO check_locations (check_id, location) VALUES ($1, 'default')`, [checkId]);

    // An anchor run (recent) the confirmation rows can reference (confirmation_of_run_id → runs(id), a real FK).
    const DUR = 10000;
    const { rows: ar } = await pool.query<{ id: number }>(
      `INSERT INTO runs (check_id, status, started_at, finished_at, location, duration_ms)
       VALUES ($1, 'pass', now() - make_interval(hours => 1), now(), 'default', $2) RETURNING id`,
      [checkId, DUR],
    );
    const anchorId = ar[0].id;
    // Counts tracked as we insert (no brittle hardcoding). Anchor: recent, normal.
    let total = 1, recent = 1, prior = 0, confirm = 0, sandbox = 0;
    for (let i = 0; i < 199; i++) {
      const isRecent = i < 100; // <84h (5040min) → recent half; else prior half; all < 168h (7d)
      // INTEGER minutes — make_interval(hours =>) takes an int, so fractional hours are a PG error;
      // mins => $::int is the idiom the other integration tests use. recent: 120..219min; prior: 5400..5498min.
      const ageMins = isRecent ? 120 + i : 5400 + (i - 100);
      const isConfirm = i < 7;
      const isSandbox = i >= 7 && i < 12;
      await pool.query(
        `INSERT INTO runs (check_id, status, started_at, finished_at, location, duration_ms, sandbox, confirmation_of_run_id)
         VALUES ($1, 'pass', now() - make_interval(mins => $2::int), now(), 'default', $3, $4, $5)`,
        [checkId, ageMins, DUR, isSandbox, isConfirm ? anchorId : null],
      );
      total++; if (isRecent) recent++; else prior++; if (isConfirm) confirm++; if (isSandbox) sandbox++;
    }

    const base = await project(0.00003, checkId);
    // C — count columns match exactly what we inserted
    assert.equal(base.run_count_7d, total, 'run_count_7d counts every measured 7d row');
    assert.equal(base.confirmation_count_7d, confirm, 'confirmation runs counted');
    assert.equal(base.sandbox_count_7d, sandbox, 'sandbox runs counted');
    assert.equal(base.run_count_recent + base.run_count_prior, total, 'recent+prior partition the window');
    assert.equal(base.run_count_recent, recent, 'the 3.5d split lands where inserted');
    assert.equal(base.run_count_prior, prior, 'prior half counted');

    // A — clean multiplier: 2× the rate → exactly 2× projected & measured, divergence unchanged.
    const dbl = await project(0.00006, checkId);
    const approxEq = (a: string, b: string, msg: string) =>
      assert.ok(Math.abs(Number(a) - Number(b)) < 1e-9, `${msg}: ${a} ≈ ${b}`);
    approxEq(dbl.projected_raw, String(Number(base.projected_raw) * 2), 'projected doubles with the rate');
    approxEq(dbl.measured_raw, String(Number(base.measured_raw) * 2), 'measured doubles with the rate');
    approxEq(dbl.divergence ?? '0', base.divergence ?? '0', 'divergence is rate-invariant');

    // B — pure run-count: DOUBLE every duration → divergence UNCHANGED (retries/slowness cannot move it).
    await pool.query(`UPDATE runs SET duration_ms = duration_ms * 2 WHERE check_id = $1`, [checkId]);
    const slow = await project(0.00003, checkId);
    approxEq(slow.divergence ?? '0', base.divergence ?? '0', 'doubling duration does NOT move divergence');
    assert.equal(slow.run_count_7d, total, 'run count unchanged by duration');
    // measured DID grow (more $), but the RATIO the warning fires on did not.
    assert.ok(Number(slow.measured_raw) > Number(base.measured_raw), 'slower runs cost more $ (but not more divergence)');
  } finally {
    await pool.query(`DELETE FROM checks WHERE id = $1`, [checkId]); // cascades runs + check_locations
  }
});

// ★ 0089 — compute_share_pct is the HONEST per-monitor metric: share of fleet measured active-seconds. Proven
// robustly against a SHARED fleet DB by (1) active_seconds_7d == Σduration/1000 exactly, and (2) the RATIO of
// two controlled checks' shares == the ratio of their active-seconds (the fleet total cancels).
test('cost_projection: active_seconds_7d = Σduration, share ratio = active-seconds ratio (0089)', async () => {
  const mk = async (name: string) => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO checks (name, kind, target_url, flow_name, spec_path, failure_threshold, severity, interval_seconds, enabled)
       VALUES ($1, 'browser', 'https://example.test', 'noop', 'monitors/__test__/x.spec.ts', 1, 'critical', 300, true)
       RETURNING id`, [name]);
    await pool.query(`INSERT INTO check_locations (check_id, location) VALUES ($1, 'default')`, [rows[0].id]);
    return rows[0].id;
  };
  const a = await mk('__share_A__');
  const b = await mk('__share_B__');
  try {
    // A: 3 runs × 10_000ms = 30s. B: 3 runs × 20_000ms = 60s. So B's share == 2× A's, regardless of the fleet.
    for (const [id, dur] of [[a, 10000], [b, 20000]] as const)
      for (let i = 0; i < 3; i++)
        await pool.query(
          `INSERT INTO runs (check_id, status, started_at, finished_at, location, duration_ms)
           VALUES ($1, 'pass', now() - make_interval(hours => $2::int), now(), 'default', $3)`,
          [id, i + 1, dur]);

    const q = async (id: number) => (await pool.query<{ active_seconds_7d: string; compute_share_pct: string | null }>(
      `SELECT active_seconds_7d, compute_share_pct FROM cost_projection(0.00006::numeric) WHERE check_id = $1`, [id])).rows[0];
    const ra = await q(a); const rb = await q(b);

    assert.equal(Number(ra.active_seconds_7d), 30, 'A active-seconds = 3×10s');
    assert.equal(Number(rb.active_seconds_7d), 60, 'B active-seconds = 3×20s');
    assert.ok(ra.compute_share_pct != null && rb.compute_share_pct != null, 'shares present (fleet ran)');
    // active_seconds ratio is EXACT (60/30); compute_share_pct is rounded 2dp so allow a small rounding band.
    const ratio = Number(rb.compute_share_pct) / Number(ra.compute_share_pct);
    assert.ok(Math.abs(ratio - 2) < 0.02, `B's compute share is ~2× A's (fleet total cancels): ${ratio}`);
  } finally {
    await pool.query(`DELETE FROM checks WHERE id = ANY($1)`, [[a, b]]);
  }
});

// ★ 0091 — the free-grant-aware per-monitor DOLLAR (restored, primary). Proves: (1) Σ estimated = the anchor
// (grant-corrected fleet, or the target when passed); (2) every ACTIVE monitor WITH runs gets a dollar,
// including a cheap one (spread proportionally, never zeroed); (3) a no-runs monitor → NULL, not $0.
test('cost_projection(3-param): per-monitor $ sums to the anchor; cheap check non-zero; no-runs → NULL (0091)', async () => {
  const mk = async (name: string, interval: number, enabled = true, archived = false) => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO checks (name, kind, target_url, flow_name, spec_path, failure_threshold, severity, interval_seconds, enabled, archived_at)
       VALUES ($1, 'browser', 'https://example.test', 'noop', 'monitors/__test__/x.spec.ts', 1, 'critical', $2, $3, ${archived ? 'now()' : 'NULL'})
       RETURNING id`, [name, interval, enabled]);
    await pool.query(`INSERT INTO check_locations (check_id, location) VALUES ($1, 'default')`, [rows[0].id]);
    return Number(rows[0].id); // node-pg returns bigint as a string — coerce so it matches Number(check_id) keys
  };
  const big = await mk('__d_big__', 300);
  const cheap = await mk('__d_cheap__', 300);
  const norun = await mk('__d_norun__', 300);  // enabled, but no runs → NULL $
  const arch = await mk('__d_arch__', 300, true, true); // archived → excluded
  try {
    const run = (id: number, dur: number) => pool.query(
      `INSERT INTO runs (check_id, status, started_at, finished_at, location, duration_ms)
       VALUES ($1,'pass', now()-interval '1 hour', now(), 'default', $2)`, [id, dur]);
    for (let i = 0; i < 3; i++) { await run(big, 40000); await run(cheap, 200); await run(arch, 99000); }

    // ALL active monitors (the integration DB may hold others — the Σ invariant is fleet-wide, so sum ALL).
    const q = async (target: number | null) => (await pool.query<{ check_id: string; estimated_monthly: string | null; fleet_billable_monthly: string }>(
      `SELECT check_id, estimated_monthly, fleet_billable_monthly FROM cost_projection(0.00006::numeric, 2.00::numeric, $1::numeric)`,
      [target])).rows;
    const derived = await q(null);
    const byId = new Map(derived.map((r) => [Number(r.check_id), r]));

    assert.ok(!byId.has(arch), 'archived monitor is EXCLUDED');
    assert.equal(byId.get(norun)!.estimated_monthly, null, 'no-runs monitor → NULL $, never a fake $0');
    assert.ok(Number(byId.get(big)!.estimated_monthly) > 0, 'big monitor gets a dollar');
    assert.ok(Number(byId.get(cheap)!.estimated_monthly) > 0, 'cheap monitor gets a NON-ZERO dollar (grant spread, not zeroed)');
    assert.ok(Number(byId.get(big)!.estimated_monthly) > Number(byId.get(cheap)!.estimated_monthly), 'big > cheap');

    // Σ estimated over the WHOLE fleet = the grant-corrected fleet total (the anchor).
    const sumAll = (rows: typeof derived) => rows.reduce((s, r) => s + (r.estimated_monthly == null ? 0 : Number(r.estimated_monthly)), 0);
    const anchor = Number(derived[0].fleet_billable_monthly);
    assert.ok(Math.abs(sumAll(derived) - anchor) < 0.05, `fleet Σ estimated (${sumAll(derived).toFixed(2)}) = grant-corrected anchor (${anchor.toFixed(2)})`);

    // With a target, the WHOLE-fleet Σ pins to it exactly.
    const sumPinned = sumAll(await q(9.0));
    assert.ok(Math.abs(sumPinned - 9.0) < 0.05, `target=9 → fleet Σ pins to 9.00 (got ${sumPinned.toFixed(2)})`);
  } finally {
    await pool.query(`DELETE FROM checks WHERE id = ANY($1)`, [[big, cheap, norun, arch]]);
  }
});
