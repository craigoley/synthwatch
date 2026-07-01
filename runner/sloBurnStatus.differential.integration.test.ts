// ★★ THE DIFFERENTIAL RED-TEST (P5 PR2 MERGE GATE). Proves the shared SQL function slo_burn_status
// reproduces the runner's TS paging threshold (burnStateFromTs) BYTE-FOR-BYTE, over a fixture matrix, so
// repointing the live paging path to the function cannot change a single page decision. If a cell diverges
// the SQL is wrong — fix the SQL, not the test.
//
// Runs entirely inside ONE transaction (BEGIN/ROLLBACK) on ONE client: the function is created in-txn, the
// fixtures are seeded in-txn, both paths read the same uncommitted rows via the injected client, and it all
// rolls back — zero prod writes. DATABASE_URL-gated (skipped offline). Runs are placed COMFORTABLY inside
// their windows (never at a 1h/6h/30m edge) so the one-now()-vs-three-now()s boundary difference can't bite.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { PoolClient } from 'pg';
import { pool, type Check } from './db.js';
import { burnStateFromTs } from './evaluate.js';

const SKIP = !process.env.DATABASE_URL;
const test = SKIP ? nodeTest.skip : nodeTest;

// The EXACT shipped function body (CREATE OR REPLACE … $$;) from the migration — no duplication. db/ is at
// the repo root; this test compiles to runner/dist/, so go up two (dist → runner → root).
const migSql = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations', '0055_slo_burn_status.sql'),
  'utf8',
);
const FN_SQL = migSql.match(/CREATE OR REPLACE FUNCTION slo_burn_status[\s\S]*?\$\$;/)![0];

type Client = PoolClient;

// Seed a check with an SLO; return its id + a minimal Check for burnStateFromTs (reads only these 4 fields).
async function seedCheck(
  c: Client,
  opts: { target: number; floor: number; minFail: number | null },
): Promise<{ id: number; check: Check }> {
  const { rows } = await c.query<{ id: number }>(
    `INSERT INTO checks (name, kind, target_url, flow_name, failure_threshold, severity, slo_target, min_fail_locations)
     VALUES ('diff-test', 'browser', 'https://x.test', 'noop', $1, 'critical', $2, $3) RETURNING id`,
    [opts.floor, opts.target, opts.minFail],
  );
  const id = rows[0].id;
  return {
    id,
    check: { id, slo_target: opts.target, failure_threshold: opts.floor, min_fail_locations: opts.minFail } as unknown as Check,
  };
}

// Add `total` runs at `minutesAgo` for `location`, of which `down` are 'fail' (rest 'pass').
async function seedRuns(c: Client, checkId: number, location: string, minutesAgo: number, total: number, down: number) {
  for (let i = 0; i < total; i++) {
    await c.query(
      `INSERT INTO runs (check_id, status, location, started_at)
       VALUES ($1, $2, $3, now() - ($4 || ' minutes')::interval)`,
      [checkId, i < down ? 'fail' : 'pass', location, minutesAgo],
    );
  }
}

// buckets: 10m-ago = in {30m,1h,6h}; 180m-ago = in {6h} only.
const IN_ALL = 10, IN_6H = 180;

async function bothAgree(c: Client, id: number, check: Check, label: string) {
  const ts = await burnStateFromTs(check, c);
  const { rows } = await c.query<{ burn_state: string; reported_burn: number }>(
    `SELECT burn_state, reported_burn FROM slo_burn_status($1)`,
    [id],
  );
  const sql = rows[0];
  assert.equal(sql.burn_state, ts.burn_state, `${label}: burn_state TS=${ts.burn_state} SQL=${sql.burn_state}`);
  assert.equal(
    Number(sql.reported_burn),
    ts.reported_burn,
    `${label}: reported_burn TS=${ts.reported_burn} SQL=${sql.reported_burn}`,
  );
  return ts.burn_state;
}

test('★ differential: slo_burn_status == burnStateFromTs across the fixture matrix', async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(FN_SQL); // create the function in-txn

    // target 0.99 → 1-target = 0.01 → burn = 100*(down/total). floor default 3 unless noted.
    // (1) single-location FAST: 1h burn 20 (>14.4), total 10 >= floor → 'fast'.
    {
      const { id, check } = await seedCheck(c, { target: 0.99, floor: 3, minFail: null });
      await seedRuns(c, id, 'eastus2', IN_ALL, 10, 2); // 0.2 → burn 20
      assert.equal(await bothAgree(c, id, check, 'single fast'), 'fast');
    }
    // (2) single-location SLOW (not fast): burn 10 (>=6, <14.4) in 6h AND 30m → 'slow'.
    {
      const { id, check } = await seedCheck(c, { target: 0.99, floor: 3, minFail: null });
      await seedRuns(c, id, 'eastus2', IN_ALL, 10, 1); // 0.1 → burn 10 in all windows
      assert.equal(await bothAgree(c, id, check, 'single slow'), 'slow');
    }
    // (3) BELOW both thresholds → 'none': burn 5 (<6).
    {
      const { id, check } = await seedCheck(c, { target: 0.99, floor: 3, minFail: null });
      await seedRuns(c, id, 'eastus2', IN_ALL, 20, 1); // 0.05 → burn 5
      assert.equal(await bothAgree(c, id, check, 'below-threshold none'), 'none');
    }
    // (4) FLOOR boundary: total == floor exactly, burning → counts → 'fast'.
    {
      const { id, check } = await seedCheck(c, { target: 0.99, floor: 3, minFail: null });
      await seedRuns(c, id, 'eastus2', IN_ALL, 3, 1); // total 3 == floor, 0.333 → burn 33 → fast
      assert.equal(await bothAgree(c, id, check, 'floor==total fast'), 'fast');
    }
    // (5) FLOOR boundary: total == floor-1, sub-floor → NOT counted → 'none' (even at 83x burn).
    {
      const { id, check } = await seedCheck(c, { target: 0.99, floor: 3, minFail: null });
      await seedRuns(c, id, 'eastus2', IN_ALL, 2, 2); // total 2 < floor 3 → excluded → none
      assert.equal(await bothAgree(c, id, check, 'sub-floor none'), 'none');
    }
    // (6) QUORUM: 3 locations, only 1 burning fast, minFail NULL → effectiveN=2 → below quorum → 'none'.
    {
      const { id, check } = await seedCheck(c, { target: 0.99, floor: 3, minFail: null });
      await seedRuns(c, id, 'eastus2', IN_ALL, 10, 3); // burn 30 (burning)
      await seedRuns(c, id, 'centralus', IN_ALL, 10, 0); // burn 0
      await seedRuns(c, id, 'westus2', IN_ALL, 10, 0); // burn 0  → 1 of 3 burning < effectiveN(3)=2
      assert.equal(await bothAgree(c, id, check, 'quorum 1-of-3 none'), 'none');
    }
    // (7) QUORUM met: 2 of 3 burning fast → effectiveN(3)=2 → 'fast'; reported = max burn among the 2.
    {
      const { id, check } = await seedCheck(c, { target: 0.99, floor: 3, minFail: null });
      await seedRuns(c, id, 'eastus2', IN_ALL, 10, 2); // burn 20
      await seedRuns(c, id, 'centralus', IN_ALL, 10, 3); // burn 30 (the max)
      await seedRuns(c, id, 'westus2', IN_ALL, 10, 0); // burn 0
      assert.equal(await bothAgree(c, id, check, 'quorum 2-of-3 fast'), 'fast');
    }
    // (8) explicit min_fail_locations=1 lowers quorum → 1 burning location pages 'fast'.
    {
      const { id, check } = await seedCheck(c, { target: 0.99, floor: 3, minFail: 1 });
      await seedRuns(c, id, 'eastus2', IN_ALL, 10, 3); // burn 30, 1 loc, minFail=1 → effectiveN=1 → fast
      await seedRuns(c, id, 'centralus', IN_ALL, 10, 0);
      assert.equal(await bothAgree(c, id, check, 'minFail=1 fast'), 'fast');
    }
    // (9) RECOVERED: 6h still elevated but 30m window clean → slow needs BOTH → 'none'.
    {
      const { id, check } = await seedCheck(c, { target: 0.99, floor: 3, minFail: null });
      await seedRuns(c, id, 'eastus2', IN_6H, 10, 5); // 6h-only bucket: burns
      await seedRuns(c, id, 'eastus2', IN_ALL, 10, 0); // fresh clean → 30m + 1h clean
      assert.equal(await bothAgree(c, id, check, 'recovered none'), 'none');
    }
    // (10) MAINTENANCE-windowed: the burning runs fall inside a maintenance window → excluded → 'none'.
    {
      const { id, check } = await seedCheck(c, { target: 0.99, floor: 3, minFail: null });
      await c.query(
        `INSERT INTO maintenance_windows (check_id, starts_at, ends_at, reason)
         VALUES ($1, now() - interval '20 minutes', now() - interval '5 minutes', 'diff-test')`,
        [id],
      );
      await seedRuns(c, id, 'eastus2', IN_ALL, 10, 5); // burn 50 but inside the window → anti-joined out
      assert.equal(await bothAgree(c, id, check, 'maintenance-excluded none'), 'none');
    }
    // (11) NO slo_target → 'none' regardless of runs.
    {
      const { rows } = await c.query<{ id: number }>(
        `INSERT INTO checks (name, kind, target_url, flow_name, failure_threshold, severity)
         VALUES ('diff-noslo','browser','https://x.test','noop',3,'critical') RETURNING id`,
      );
      const id = rows[0].id;
      const check = { id, slo_target: null, failure_threshold: 3, min_fail_locations: null } as unknown as Check;
      await seedRuns(c, id, 'eastus2', IN_ALL, 10, 5);
      assert.equal(await bothAgree(c, id, check, 'no-slo none'), 'none');
    }
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
});
