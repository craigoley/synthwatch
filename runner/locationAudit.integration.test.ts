// LIVE proof of the check_locations audit + alarm trigger (0085). Runs only with DATABASE_URL. Removing a
// location is an unlogged way to make a monitor stop being red (westus2 off 341/342 Jul 5; centralus off 355
// Jul 13 — audit_log had ZERO record). The trigger makes every add/remove VISIBLE, records the removed
// location's 24h failure rate, ALARMS (runner_errors) on a removal of a failing location, and NEVER blocks.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from './db.js';

const SKIP = !process.env.DATABASE_URL;

async function makeCheck(name: string): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO checks (name, kind, target_url, flow_name, spec_path, failure_threshold, severity)
     VALUES ($1,'browser','https://x.test','noop','monitors/__test__/x.spec.ts',1,'critical') RETURNING id`,
    [name],
  );
  return rows[0].id;
}
// Seed `n` runs at a location, `fails` of them down (within the last 24h).
async function seedLoc(checkId: number, location: string, n: number, fails: number): Promise<void> {
  await pool.query(
    `INSERT INTO runs (check_id, status, started_at, location)
     SELECT $1, CASE WHEN g <= $3 THEN 'fail' ELSE 'pass' END, now() - make_interval(mins => g), $2
       FROM generate_series(1, $4) g`,
    [checkId, location, fails, n],
  );
}
const auditCount = async (checkId: number): Promise<number> =>
  Number((await pool.query<{ n: string }>(`SELECT count(*) n FROM audit_log WHERE target_id = $1`, [String(checkId)])).rows[0].n);
const alarmCount = async (checkId: number): Promise<number> =>
  Number((await pool.query<{ n: string }>(`SELECT count(*) n FROM runner_errors WHERE check_id = $1 AND phase = 'check_location.remove'`, [checkId])).rows[0].n);

nodeTest('★ removing a FAILING location audits it (with the 24h fail rate) AND alarms — but does NOT block', { skip: SKIP }, async () => {
  const id = await makeCheck('__locaudit_fail__');
  try {
    await pool.query(`INSERT INTO check_locations (check_id, location) VALUES ($1,'centralus'),($1,'eastus2')`, [id]);
    await seedLoc(id, 'centralus', 10, 3); // 30% failing
    await seedLoc(id, 'eastus2', 10, 0); // healthy

    // remove the failing region — must succeed (not blocked)
    const del = await pool.query(`DELETE FROM check_locations WHERE check_id = $1 AND location = 'centralus'`, [id]);
    assert.equal(del.rowCount, 1, 'the removal is NOT blocked — it proceeds');

    const { rows: audit } = await pool.query<{ action: string; note: string; before_json: { fail_pct_24h: number } }>(
      `SELECT action, note, before_json FROM audit_log WHERE target_id = $1 ORDER BY id DESC LIMIT 1`, [String(id)]);
    assert.equal(audit[0].action, 'check_location.remove', 'audited as a location removal');
    assert.match(audit[0].note, /centralus REMOVED/, 'note names the removed location');
    assert.equal(Number(audit[0].before_json.fail_pct_24h), 30, 'the 24h failure rate (30%) is recorded — the reviewable sentence');

    assert.equal(await alarmCount(id), 1, 'a failing-location removal writes a runner_errors ALARM');
  } finally { await pool.query(`DELETE FROM checks WHERE id = $1`, [id]); }
});

nodeTest('removing a HEALTHY location is audited but does NOT alarm', { skip: SKIP }, async () => {
  const id = await makeCheck('__locaudit_healthy__');
  try {
    await pool.query(`INSERT INTO check_locations (check_id, location) VALUES ($1,'eastus2')`, [id]);
    await seedLoc(id, 'eastus2', 10, 0); // 0% failing
    await pool.query(`DELETE FROM check_locations WHERE check_id = $1 AND location = 'eastus2'`, [id]);
    assert.equal(await auditCount(id), 2, 'the add + the remove are both audited');
    assert.equal(await alarmCount(id), 0, '★ a healthy-location removal does NOT alarm (only a failing one does)');
  } finally { await pool.query(`DELETE FROM checks WHERE id = $1`, [id]); }
});

nodeTest('deleting the whole check (CASCADE) does NOT write a spurious per-location remove-audit or alarm', { skip: SKIP }, async () => {
  const id = await makeCheck('__locaudit_cascade__');
  await pool.query(`INSERT INTO check_locations (check_id, location) VALUES ($1,'centralus')`, [id]);
  await seedLoc(id, 'centralus', 10, 5); // 50% failing — would alarm IF the cascade were audited
  const before = await auditCount(id);
  await pool.query(`DELETE FROM checks WHERE id = $1`, [id]); // cascades check_locations
  // target_id survives the check delete (audit_log has no FK), so we can still count
  assert.equal(await auditCount(id), before, '★ the CASCADE removal is NOT audited as a coverage change (the check is gone)');
  assert.equal(await alarmCount(id), 0, 'and it does not alarm');
});
