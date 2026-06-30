// Reconcile-apply Phase 1 — the runner-side safety property: a human decision (approved/rejected/applied)
// on a reconcile_apply_plan row MUST survive a reconcile re-compute (persistApplyPlan's upsert). Without
// the status-preserving CASE, the next reconcile tick would reset an approved plan to 'pending' and lose
// it. Runs the EXACT upsert (reconcileMain self-executes main() on import, so it isn't importable) against
// a throwaway row inside a rolled-back txn. DATABASE_URL-gated.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from './db.js';

const SKIP = !process.env.DATABASE_URL;
const test = SKIP ? nodeTest.skip : nodeTest;

// The persistApplyPlan upsert (verbatim from reconcileMain.ts).
const UPSERT = `INSERT INTO reconcile_apply_plan (source_key, drift_type, status, plan, computed_at)
   VALUES ($1, $2, $3, $4::jsonb, now())
   ON CONFLICT (source_key, drift_type)
     DO UPDATE SET
       status = CASE
         WHEN reconcile_apply_plan.status IN ('approved', 'rejected', 'applied')
           THEN reconcile_apply_plan.status
         ELSE EXCLUDED.status
       END,
       plan = EXCLUDED.plan,
       computed_at = now()`;

test('★ persistApplyPlan: a re-compute PRESERVES approved/applied, but refreshes a pending plan', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const k = '__phase1_preserve__';
    // an APPROVED plan + a still-PENDING plan.
    await client.query(UPSERT, [k, 'new', 'approved', '{"v":1}']);
    await client.query(UPSERT, [`${k}2`, 'new', 'pending', '{"v":1}']);

    // reconcile re-computes both as 'pending' (the auto disposition) with a fresh plan.
    await client.query(UPSERT, [k, 'new', 'pending', '{"v":2}']);
    await client.query(UPSERT, [`${k}2`, 'new', 'pending', '{"v":2}']);

    const { rows } = await client.query<{ source_key: string; status: string; plan: { v: number } }>(
      `SELECT source_key, status, plan FROM reconcile_apply_plan WHERE source_key IN ($1, $2)`,
      [k, `${k}2`],
    );
    const byKey = new Map(rows.map((r) => [r.source_key, r]));
    assert.equal(byKey.get(k)!.status, 'approved', '★ the approval SURVIVED the re-compute');
    assert.equal(byKey.get(k)!.plan.v, 2, 'but its plan jsonb refreshed to the latest');
    assert.equal(byKey.get(`${k}2`)!.status, 'pending', 'a still-pending plan is re-set normally');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
});
