// Red-test CAPTURE contract (PR 2) — DATABASE_URL-gated, mirrors deploys.integration.test.ts. Everything runs
// inside a ROLLED-BACK txn so it's prod-safe. The DDL is CREATE TABLE IF NOT EXISTS so it works BOTH pre-0057
// (creates the table in-txn) and post-0057 (reuses the real table — writes still roll back).
//
// ★ THE MUST-GO-RED FOR THE CAPTURE: a CONFIRMED red writes exactly one row; an INCONCLUSIVE or NOT-RED result
// writes ZERO — an unrelated failure (or a weak assertion) must never persist a red-test.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';

import { pool } from './db.js';
import { persistRedTest, type RedTestResult } from './redTest.js';

const SKIP = !process.env.DATABASE_URL;
const test = SKIP ? nodeTest.skip : nodeTest;

const RED_TESTS_DDL = `CREATE TABLE IF NOT EXISTS red_tests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  check_id bigint NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
  tested_at timestamptz NOT NULL DEFAULT now(),
  method text NOT NULL CHECK (method IN ('executed-red-fixture','attested-manual')),
  outcome text NOT NULL CHECK (outcome IN ('red')),
  detail jsonb)`;

const result = (over: Partial<RedTestResult>): RedTestResult => ({
  checkId: 0, method: 'executed-red-fixture', outcome: 'red', fault: 'bad-url → x', verdict: 'fail', detail: 'd', ...over,
});

async function withCheck(fn: (checkId: number, client: import('pg').PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(RED_TESTS_DDL);
    const { rows } = await client.query(
      `INSERT INTO checks (name, kind, target_url, flow_name, spec_path, failure_threshold, severity)
       VALUES ('rt-test', 'browser', 'https://example.test', 'noop', 'monitors/__test__/x.spec.ts', 1, 'critical') RETURNING id`,
    );
    await fn(Number((rows[0] as { id: number }).id), client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

const count = async (client: import('pg').PoolClient, checkId: number): Promise<number> => {
  const { rows } = await client.query('SELECT count(*)::int AS n FROM red_tests WHERE check_id = $1', [checkId]);
  return (rows[0] as { n: number }).n;
};

test('★ a CONFIRMED red persists exactly ONE row (method + outcome=red + detail)', async () => {
  await withCheck(async (checkId, client) => {
    const wrote = await persistRedTest(result({ checkId, outcome: 'red', method: 'executed-red-fixture' }), client);
    assert.equal(wrote, true);
    assert.equal(await count(client, checkId), 1);
    const { rows } = await client.query('SELECT method, outcome, detail FROM red_tests WHERE check_id = $1', [checkId]);
    assert.equal((rows[0] as { method: string }).method, 'executed-red-fixture');
    assert.equal((rows[0] as { outcome: string }).outcome, 'red');
    assert.equal((rows[0] as { detail: { verdict: string } }).detail.verdict, 'fail'); // the fault+verdict audit trail
  });
});

// ★★ THE MUST-GO-RED: an INCONCLUSIVE run (failed for an unrelated reason — NOT the monitor's assertion) must
// persist NOTHING. This is the exact unbacked-confidence the guardrail kills — an infra failure is not a red-test.
test('★ an INCONCLUSIVE run writes ZERO rows (an unrelated failure is NOT a red-test)', async () => {
  await withCheck(async (checkId, client) => {
    const wrote = await persistRedTest(result({ checkId, outcome: 'inconclusive', verdict: 'error' }), client);
    assert.equal(wrote, false);
    assert.equal(await count(client, checkId), 0);
  });
});

test('★ a NOT-RED run (the monitor stayed green — a weak assertion) writes ZERO rows', async () => {
  await withCheck(async (checkId, client) => {
    const wrote = await persistRedTest(result({ checkId, outcome: 'not-red', verdict: 'pass' }), client);
    assert.equal(wrote, false);
    assert.equal(await count(client, checkId), 0);
  });
});

test('an attested-manual RED persists one row with method=attested-manual', async () => {
  await withCheck(async (checkId, client) => {
    const wrote = await persistRedTest(result({ checkId, method: 'attested-manual', outcome: 'red', verdict: null }), client);
    assert.equal(wrote, true);
    const { rows } = await client.query('SELECT method FROM red_tests WHERE check_id = $1', [checkId]);
    assert.equal((rows[0] as { method: string }).method, 'attested-manual');
  });
});
