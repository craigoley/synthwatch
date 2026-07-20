// LIVE integration proof of the latency_sample view (0092) and the T2-4 failing-locations alignment.
// DATABASE_URL-gated (skipped offline; CI runs it on the Postgres-service job). Prove-can-fail per bug:
//
//  ① latency_sample EXCLUDES sandbox — a test-send at an outlier latency must NOT move a reported percentile.
//     And it KEEPS confirmations — a confirmation's duration is a real measurement (the deliberate difference
//     from countable_run; see the view comment). RED on raw `runs`, GREEN on latency_sample.
//  ①b the SAME sandbox bug on WEB-VITALS p75 (narrative's vit + the api /reports/performance vitals CTEs read
//     run_metrics joined to raw `runs`) — a sandbox outlier LCP moved p75. RED on raw `runs`, GREEN on the view.
//  ② failingLocationNames (the alert email's list) now reads countable_run, MATCHING aggregateVerdict (the
//     query that decided to page). A location that fails-then-confirms-passes is DOWN per the verdict but was
//     OMITTED from the email under the raw predicate — the email named a different set than the pager decided.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';

import { pool } from './db.js';
import { failingLocationNames } from './evaluate.js';
import type { Check } from './db.js';

const SKIP = !process.env.DATABASE_URL;
const test = SKIP ? nodeTest.skip : nodeTest;

async function makeCheck(name: string, failureThreshold = 1): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO checks (name, kind, target_url, flow_name, spec_path, failure_threshold, severity)
     VALUES ($1, 'browser', 'https://example.test', 'noop', 'monitors/__test__/x.spec.ts', $2, 'critical')
     RETURNING id`,
    [name, failureThreshold],
  );
  return Number(rows[0].id);
}

/** Seed one run with an explicit location + duration + sandbox/confirmation flags. */
async function seedRun(
  checkId: number,
  status: 'pass' | 'warn' | 'fail' | 'error',
  minutesAgo: number,
  opts: { location?: string; durationMs?: number; sandbox?: boolean; confirmationOf?: number } = {},
): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO runs (check_id, status, started_at, finished_at, location, duration_ms, sandbox, confirmation_of_run_id)
     VALUES ($1, $2, now() - make_interval(mins => $3::int), now() - make_interval(mins => $3::int),
             $4, $5, $6, $7)
     RETURNING id`,
    [checkId, status, minutesAgo, opts.location ?? 'default', opts.durationMs ?? 100, opts.sandbox ?? false, opts.confirmationOf ?? null],
  );
  return Number(rows[0].id);
}

const p95 = (src: string, checkId: number) =>
  pool
    .query<{ p95: number | null; n: string }>(
      `SELECT round(percentile_cont(0.95) WITHIN GROUP (ORDER BY r.duration_ms))::int AS p95, count(*) AS n
         FROM ${src} r WHERE r.check_id = $1`,
      [checkId],
    )
    .then((r) => ({ p95: r.rows[0].p95, n: Number(r.rows[0].n) }));

/** Attach a run_metrics row (only lcp_ms matters for the vitals p75). */
async function seedMetric(runId: number, lcpMs: number): Promise<void> {
  await pool.query(`INSERT INTO run_metrics (run_id, lcp_ms) VALUES ($1, $2)`, [runId, lcpMs]);
}

/** p75 LCP over run_metrics joined to `src` (runs = raw/buggy, latency_sample = fixed) — mirrors narrative's vit. */
const lcpP75 = (src: string, checkId: number) =>
  pool
    .query<{ p75: number | null; n: string }>(
      `SELECT round(percentile_cont(0.75) WITHIN GROUP (ORDER BY m.lcp_ms))::int AS p75, count(*) AS n
         FROM run_metrics m JOIN ${src} r ON r.id = m.run_id WHERE r.check_id = $1`,
      [checkId],
    )
    .then((r) => ({ p75: r.rows[0].p75, n: Number(r.rows[0].n) }));

// ── ① sandbox must not move a real percentile; confirmations are kept ──────────────────────────────────
test('★ latency_sample excludes a sandbox outlier from p95 (raw runs does NOT) and keeps confirmations', async () => {
  const id = await makeCheck('__ls_sandbox__');
  try {
    // 10 real scheduled passes at ~100ms (so the single sandbox outlier lands inside the top 5% → it MOVES p95).
    for (let i = 0; i < 10; i++) await seedRun(id, 'pass', 60 + i, { durationMs: 100 });
    // A SANDBOX test-send at an absurd latency — the exact "test traffic moved my p95" bug.
    await seedRun(id, 'pass', 5, { durationMs: 999_999, sandbox: true });

    const raw = await p95('runs', id);
    const view = await p95('latency_sample', id);

    // ★ MUST-GO-RED: the raw query lets the sandbox outlier drag p95 up; latency_sample stays honest.
    assert.ok(raw.p95! > 1000, `raw p95 dragged up by the sandbox outlier (got ${raw.p95})`);
    assert.equal(view.p95, 100, 'latency_sample p95 is the real ~100ms — the sandbox run is excluded');
    assert.equal(view.n, 10, 'latency_sample counted only the 10 real passes (sandbox excluded)');

    // ★ DELIBERATE DIFFERENCE from countable_run: a passing confirmation IS a real latency sample → kept.
    const failId = await seedRun(id, 'fail', 4, { durationMs: 100 }); // a fail carries no useful duration for latency…
    await seedRun(id, 'pass', 3, { durationMs: 100, confirmationOf: failId }); // …its confirmation PASS does — keep it.
    const withConf = await p95('latency_sample', id);
    assert.equal(withConf.n, 11, 'latency_sample KEEPS the confirmation pass (11) — unlike countable_run, which would drop it');
  } finally {
    await pool.query(`DELETE FROM checks WHERE id = $1`, [id]);
  }
});

// ── ①b the SAME sandbox bug on WEB-VITALS: a sandbox outlier LCP must not move the reported p75 ──────────
test('★ vitals p75 LCP over latency_sample excludes a sandbox outlier (raw runs does NOT) and keeps confirmations', async () => {
  const id = await makeCheck('__ls_vitals_sandbox__');
  try {
    // 8 real scheduled passes at LCP ~2000ms.
    for (let i = 0; i < 8; i++) {
      const rid = await seedRun(id, 'pass', 60 + i, { durationMs: 100 });
      await seedMetric(rid, 2000);
    }
    // A testing session: 4 SANDBOX test-sends of a slow page (LCP 999999). Enough to occupy the top quartile,
    // so they drag p75 — the exact "test traffic moved my reported p75" bug (a single outlier only reaches p90+).
    for (let i = 0; i < 4; i++) {
      const sbx = await seedRun(id, 'pass', 5 + i, { durationMs: 100, sandbox: true });
      await seedMetric(sbx, 999_999);
    }

    const raw = await lcpP75('runs', id);
    const view = await lcpP75('latency_sample', id);

    // ★ MUST-GO-RED: joining run_metrics to raw `runs` (the old narrative/api vit predicate) lets the sandbox
    //   test-sends drag p75 up; joining to latency_sample stays honest.
    assert.ok(raw.p75! > 100_000, `raw p75 LCP dragged up by the sandbox test-sends (got ${raw.p75})`);
    assert.equal(view.p75, 2000, 'latency_sample p75 LCP is the real ~2000ms — the sandbox runs are excluded');
    assert.equal(view.n, 8, 'latency_sample counted only the 8 real passes (sandbox excluded)');

    // ★ DELIBERATE DIFFERENCE from countable_run: a passing confirmation's vitals ARE a real sample → kept.
    const failId = await seedRun(id, 'fail', 4, { durationMs: 100 });
    const confId = await seedRun(id, 'pass', 3, { durationMs: 100, confirmationOf: failId });
    await seedMetric(confId, 2000);
    const withConf = await lcpP75('latency_sample', id);
    assert.equal(withConf.n, 9, 'latency_sample KEEPS the confirmation pass vitals (8 + 1) — unlike countable_run');
  } finally {
    await pool.query(`DELETE FROM checks WHERE id = $1`, [id]);
  }
});

// ── ② the email's failing-location list must match the pager's decision (aggregateVerdict) ──────────────
test('★ failingLocationNames includes a fails-then-confirms-passes location (matches the pager); raw predicate omitted it', async () => {
  const id = await makeCheck('__ls_faillist__', 1);
  const check = { id, failure_threshold: 1 } as unknown as Check;
  try {
    // Location "eastus": a scheduled FAIL, then its CONFIRMATION PASS (off-cadence re-check of that failure).
    const failId = await seedRun(id, 'fail', 6, { location: 'eastus' });
    await seedRun(id, 'pass', 5, { location: 'eastus', confirmationOf: failId });

    // ★ THE FIX: failingLocationNames now reads countable_run — the confirmation is excluded, so the scheduled
    //   fail is the latest countable run → the location is DOWN, exactly as aggregateVerdict (which pages) sees it.
    const names = await failingLocationNames(check);
    assert.deepEqual(names, ['eastus'], 'the email names eastus — the same location the pager decided was down');

    // ★ PROVE THE DIVERGENCE the fix closes: the OLD raw predicate saw the confirmation PASS as the latest run
    //   → eastus failed the "latest N all-down" test → OMITTED. The two predicates disagree on the same data.
    const { rows: rawRows } = await pool.query<{ location: string }>(
      `WITH recent AS (
         SELECT location, status, row_number() OVER (PARTITION BY location ORDER BY started_at DESC) AS rn
           FROM runs WHERE check_id = $1 AND status NOT IN ('running','infra_error'))
       SELECT location FROM recent GROUP BY location
        HAVING bool_and(status IN ('fail','error')) FILTER (WHERE rn <= $2)
           AND count(*) FILTER (WHERE rn <= $2) >= $2`,
      [id, 1],
    );
    assert.deepEqual(rawRows.map((r) => r.location), [], 'the OLD raw query OMITTED eastus (confirmation-pass read as the latest) — the bug the fix closes');
  } finally {
    await pool.query(`DELETE FROM checks WHERE id = $1`, [id]);
  }
});
