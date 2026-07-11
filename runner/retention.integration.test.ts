// LIVE integration proof of row retention (runRetention). Runs only when DATABASE_URL is set
// (skipped in offline CI; exercised by the "Test (Node + Postgres)" job). Each case creates a
// throwaway check, seeds runs at explicit ages + children (run_steps/run_metrics) + an incident,
// runs retention over a controlled window, asserts what survived, then hard-deletes the check
// (cascades everything). Mirrors evaluate.integration.test.ts.
//
// Proves: (1) older-than-window runs are deleted, newer ones survive; the boundary is strict
// (< cutoff) — a run just outside is deleted, just inside is kept; (2) CASCADE removes a deleted
// run's run_steps + run_metrics; (3) an incident-pinned run SURVIVES (RESTRICT FK + MTTR history)
// and the incident survives with it; (4) batching deletes the full backlog across multiple small
// batches. Also asserts the constant is aligned to the 90d blob lifecycle.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from './db.js';
import { runRetention, purgeRemovedChecks, RETENTION_DAYS, RETENTION_BATCH_SIZE } from './retention.js';

const SKIP = !process.env.DATABASE_URL;

async function makeCheck(name: string): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO checks (name, kind, target_url, flow_name, spec_path, failure_threshold, severity)
     VALUES ($1, 'browser', 'https://example.test', 'noop', 'monitors/__test__/x.spec.ts', 1, 'critical')
     RETURNING id`,
    [name],
  );
  return rows[0].id;
}

// Insert one completed run at a given age (minutes ago) and return its id.
async function seedRun(checkId: number, minutesAgo: number, status = 'pass'): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO runs (check_id, status, started_at, finished_at, location)
     VALUES ($1, $2, now() - make_interval(mins => $3::int), now() - make_interval(mins => $3::int), 'default')
     RETURNING id`,
    [checkId, status, minutesAgo],
  );
  return rows[0].id;
}

async function runExists(id: number): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM runs WHERE id = $1`, [id]);
  return rows.length > 0;
}

async function cleanup(checkId: number): Promise<void> {
  // Incidents pin runs (RESTRICT) — drop incidents first, then the check (cascades checks->runs->children).
  await pool.query(`DELETE FROM incidents WHERE check_id = $1`, [checkId]);
  await pool.query(`DELETE FROM checks WHERE id = $1`, [checkId]);
}

// The window (in days) used by the tests, expressed in minutes for seeding precise ages.
const WINDOW_DAYS = 90;
const WINDOW_MIN = WINDOW_DAYS * 24 * 60;

nodeTest('RETENTION_DAYS is aligned to the 90d blob lifecycle (artifactRetentionDays)', () => {
  assert.equal(RETENTION_DAYS, 90);
});

nodeTest('deletes older-than-window runs + strict boundary; newer survive (live)', { skip: SKIP }, async () => {
  const checkId = await makeCheck('__ret_boundary__');
  try {
    // Two clearly outside (older than cutoff) + two just around the boundary + one clearly inside.
    const wayOld = await seedRun(checkId, WINDOW_MIN + 60);       // 90d + 1h  -> DELETE
    const justOutside = await seedRun(checkId, WINDOW_MIN + 1);   // 90d + 1m  -> DELETE (older than cutoff)
    const justInside = await seedRun(checkId, WINDOW_MIN - 1);    // 90d - 1m  -> KEEP (newer than cutoff)
    const fresh = await seedRun(checkId, 24 * 60);                // 1d        -> KEEP

    const res = await runRetention({ retentionDays: WINDOW_DAYS });

    assert.equal(await runExists(wayOld), false, 'run 90d+1h old must be deleted');
    assert.equal(await runExists(justOutside), false, 'run just OUTSIDE the window (older) must be deleted');
    assert.equal(await runExists(justInside), true, 'run just INSIDE the window (newer) must survive');
    assert.equal(await runExists(fresh), true, 'fresh run must survive');
    assert.ok(res.deleted >= 2, `expected >=2 deleted for this check, got ${res.deleted}`);
  } finally {
    await cleanup(checkId);
  }
});

nodeTest('CASCADE removes run_steps + run_metrics of a deleted run (live)', { skip: SKIP }, async () => {
  const checkId = await makeCheck('__ret_cascade__');
  try {
    const oldRun = await seedRun(checkId, WINDOW_MIN + 120);
    await pool.query(
      `INSERT INTO run_steps (run_id, step_index, name, status, duration_ms) VALUES ($1, 0, 'open', 'pass', 42)`,
      [oldRun],
    );
    await pool.query(
      `INSERT INTO run_metrics (run_id, lcp_ms) VALUES ($1, 1200)`,
      [oldRun],
    );

    await runRetention({ retentionDays: WINDOW_DAYS });

    assert.equal(await runExists(oldRun), false, 'the old run must be deleted');
    const steps = await pool.query(`SELECT 1 FROM run_steps WHERE run_id = $1`, [oldRun]);
    const metrics = await pool.query(`SELECT 1 FROM run_metrics WHERE run_id = $1`, [oldRun]);
    assert.equal(steps.rows.length, 0, 'run_steps must cascade-delete');
    assert.equal(metrics.rows.length, 0, 'run_metrics must cascade-delete');
  } finally {
    await cleanup(checkId);
  }
});

nodeTest('incident-pinned run SURVIVES + the incident survives (MTTR history; live)', { skip: SKIP }, async () => {
  const checkId = await makeCheck('__ret_incident__');
  try {
    // An OLD failed run that opened + resolved an incident, plus an old UNpinned run.
    const pinnedRun = await seedRun(checkId, WINDOW_MIN + 240, 'fail');
    const unpinnedOld = await seedRun(checkId, WINDOW_MIN + 240, 'pass');
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO incidents (check_id, status, severity, opened_at, resolved_at, opened_run_id, resolved_run_id)
       VALUES ($1, 'resolved', 'critical', now() - make_interval(days => 95), now() - make_interval(days => 94), $2, $2)
       RETURNING id`,
      [checkId, pinnedRun],
    );
    const incidentId = rows[0].id;

    const res = await runRetention({ retentionDays: WINDOW_DAYS });

    assert.equal(await runExists(pinnedRun), true, 'incident-pinned run must SURVIVE (RESTRICT + MTTR history)');
    assert.equal(await runExists(unpinnedOld), false, 'the old UNpinned run must be deleted');
    const inc = await pool.query(`SELECT 1 FROM incidents WHERE id = $1`, [incidentId]);
    assert.equal(inc.rows.length, 1, 'the incident itself must survive');
    // The delete must not have been blocked by the FK — the unpinned run went, proving no RESTRICT abort.
    assert.ok(res.deleted >= 1, 'retention must have deleted the unpinned old run (no FK block)');
  } finally {
    await cleanup(checkId);
  }
});

nodeTest('batching deletes the full backlog across multiple small batches (live)', { skip: SKIP }, async () => {
  const checkId = await makeCheck('__ret_batch__');
  try {
    // Seed 7 old runs; batchSize=3 -> ceil(7/3)=3 non-empty batches + a trailing partial => all gone.
    const ids: number[] = [];
    for (let i = 0; i < 7; i++) ids.push(await seedRun(checkId, WINDOW_MIN + 300 + i));

    const res = await runRetention({ retentionDays: WINDOW_DAYS, batchSize: 3 });

    for (const id of ids) {
      assert.equal(await runExists(id), false, `batched run ${id} must be deleted`);
    }
    assert.ok(res.deleted >= 7, `expected >=7 deleted, got ${res.deleted}`);
    assert.ok(res.batches >= 3, `expected multiple batches with batchSize=3, got ${res.batches}`);
    assert.ok(RETENTION_BATCH_SIZE > 0, 'batch size constant is positive');
  } finally {
    await cleanup(checkId);
  }
});

// ── R5-P2: git-removal purge (purgeRemovedChecks) ─────────────────────────────────────────────────────
const test = SKIP ? nodeTest.skip : nodeTest;

// A GIT-REMOVED check: removed_at stamped `removedDaysAgo` in the past (reconcile does this when the
// manifest id disappears). source_key set (it WAS git-managed). Returns the check id.
async function makeRemovedCheck(name: string, removedDaysAgo: number): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO checks (name, kind, target_url, flow_name, spec_path, failure_threshold, severity, source_key, enabled, removed_at)
     VALUES ($1, 'browser', 'https://example.test', 'noop', 'monitors/__test__/x.spec.ts', 1, 'critical', $1, false,
             now() - make_interval(days => $2::int))
     RETURNING id`,
    [name, removedDaysAgo],
  );
  return rows[0].id;
}
async function checkExists(id: number): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM checks WHERE id = $1`, [id]);
  return rows.length > 0;
}

test('★ purge: a check git-removed > window ago (no incident) is HARD-DELETED; its runs cascade', async () => {
  const id = await makeRemovedCheck(`__purge_past_${Date.now()}__`, WINDOW_DAYS + 1); // 91d removed
  const runId = await seedRun(id, 10); // a recent run — cascades with the check
  try {
    const res = await purgeRemovedChecks({ retentionDays: WINDOW_DAYS });
    assert.equal(await checkExists(id), false, 'a git-removed check past the window must be hard-deleted');
    assert.equal(await runExists(runId), false, 'its runs cascade on the check delete');
    assert.ok(res.purged >= 1, `expected >=1 purged, got ${res.purged}`);
  } finally {
    await cleanup(id);
  }
});

test('★ purge MUST-GO-RED: an incident-pinned git-removed check past the window is DEFERRED (not deleted)', async () => {
  const id = await makeRemovedCheck(`__purge_pinned_${Date.now()}__`, WINDOW_DAYS + 5); // 95d removed
  const pinnedRun = await seedRun(id, 100);
  await pool.query(
    `INSERT INTO incidents (check_id, status, severity, opened_at, resolved_at, opened_run_id, resolved_run_id)
     VALUES ($1, 'resolved', 'critical', now() - make_interval(days => 96), now() - make_interval(days => 95), $2, $2)`,
    [id, pinnedRun],
  );
  try {
    const res = await purgeRemovedChecks({ retentionDays: WINDOW_DAYS });
    // ★ The invariant: a removed check whose runs are incident-pinned is NOT purged (MTTR history + the
    // RESTRICT FK would block). If the purge deleted it, this assert (and the FK) would fail loudly.
    assert.equal(await checkExists(id), true, 'an incident-pinned removed check must be DEFERRED, not deleted');
    assert.equal(await runExists(pinnedRun), true, 'the incident-pinned run survives');
    assert.ok(res.deferred >= 1, `the deferral must be counted (visible), got deferred=${res.deferred}`);
  } finally {
    await cleanup(id); // drops the incident first, then the check
  }
});

test('purge: a check removed INSIDE the window, or re-added (removed_at NULL), is NOT purged', async () => {
  const recent = await makeRemovedCheck(`__purge_recent_${Date.now()}__`, WINDOW_DAYS - 1); // 89d — inside window
  const readded = await makeCheck(`__purge_readded_${Date.now()}__`); // removed_at NULL (present in git / re-added)
  try {
    await purgeRemovedChecks({ retentionDays: WINDOW_DAYS });
    assert.equal(await checkExists(recent), true, 'a check removed inside the window survives (clock not elapsed)');
    assert.equal(await checkExists(readded), true, 'a check with removed_at NULL is never purge-eligible');
  } finally {
    await cleanup(recent);
    await cleanup(readded);
  }
});
