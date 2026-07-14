// LIVE proof (needs DATABASE_URL) that the transient classifier baselines against the last SUCCESSFUL runs,
// not the last SETTLED runs — the fix for the sustained-outage INVERSION: a first-party failure that has
// failed for four runs straight is IN the settled baseline (so it read monitor-side — most wrong exactly when
// the failure is most real), but is NOT in the last successful run, so it counts.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { pool, type Check } from './db.js';
import { classifyAndPersistTransient } from './evaluate.js';

const SKIP = !process.env.DATABASE_URL;

// A first-party ChunkLoadError (console) + the benign ambient /monitoring network failure (first-party).
const CHUNK_FAIL = {
  console: { messages: [{ level: 'error', origin: 'site', sourceHost: 'www.wegmans.com', text: 'ChunkLoadError: Failed to load chunk /_next/static/chunks/x.js' }] },
  network: { failed: [{ url: 'https://www.wegmans.com/monitoring', thirdParty: false, resourceType: 'fetch' }] },
};
// A clean SUCCESS: only the ambient /monitoring noise, NO chunk error.
const CLEAN_OK = {
  console: { messages: [] },
  network: { failed: [{ url: 'https://www.wegmans.com/monitoring', thirdParty: false, resourceType: 'fetch' }] },
};

async function makeCheck(name: string): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO checks (name, kind, target_url, flow_name, spec_path, failure_threshold, severity)
     VALUES ($1,'browser','https://www.wegmans.com','noop','monitors/__test__/x.spec.ts',1,'critical') RETURNING id`,
    [name],
  );
  return rows[0].id;
}
async function seedRun(checkId: number, status: string, minutesAgo: number, sig: unknown): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO runs (check_id, status, started_at, finished_at, location, trace_signals)
     VALUES ($1,$2, now()-make_interval(mins=>$3::int), now()-make_interval(mins=>$3::int), 'default', $4) RETURNING id`,
    [checkId, status, minutesAgo, sig == null ? null : JSON.stringify(sig)],
  );
  return rows[0].id;
}
async function classOf(runId: number): Promise<string | null> {
  const { rows } = await pool.query<{ transient_class: string | null }>(`SELECT transient_class FROM runs WHERE id = $1`, [runId]);
  return rows[0].transient_class;
}
const asCheck = (id: number) => ({ id }) as unknown as Check;

// ★★ MUST-GO-RED: a chunk failure present in runs 1..5, ABSENT from the last successful run ⇒ SERVICE-SIDE on
// run 5. On post-#299 main the baseline is the last 4 SETTLED runs (all failing, chunk present) ⇒ monitor-side.
nodeTest('★ sustained outage: chunk fails on runs 1..5, absent from last success ⇒ run 5 SERVICE-SIDE', { skip: SKIP }, async () => {
  const id = await makeCheck('__tb_sustained__');
  try {
    await seedRun(id, 'pass', 70, CLEAN_OK);      // the last GOOD run — no chunk error (ambient /monitoring only)
    await seedRun(id, 'fail', 60, CHUNK_FAIL);    // run 1 — chunk starts failing
    await seedRun(id, 'fail', 50, CHUNK_FAIL);    // run 2
    await seedRun(id, 'fail', 40, CHUNK_FAIL);    // run 3
    await seedRun(id, 'fail', 30, CHUNK_FAIL);    // run 4  (fills the 4-run settled baseline with the chunk)
    const run5 = await seedRun(id, 'fail', 20, CHUNK_FAIL); // run 5 — the transient, STILL failing
    await classifyAndPersistTransient(asCheck(id), run5);
    assert.equal(await classOf(run5), 'service-side',
      'the chunk is absent from the last SUCCESSFUL run ⇒ new ⇒ service-side, however many failing runs precede it');
  } finally { await pool.query(`DELETE FROM checks WHERE id = $1`, [id]); }
});

// ★ Teardown noise: /monitoring fails on the SUCCESSFUL run too ⇒ in the success baseline ⇒ monitor-side.
// This proves we did NOT just make everything service-side.
nodeTest('teardown noise (/monitoring fails on passing runs too) ⇒ monitor-side', { skip: SKIP }, async () => {
  const id = await makeCheck('__tb_noise__');
  try {
    await seedRun(id, 'pass', 40, CLEAN_OK);      // success carries the SAME /monitoring failure
    const t = await seedRun(id, 'fail', 20, CLEAN_OK); // the transient's only first-party failure is that same /monitoring
    await classifyAndPersistTransient(asCheck(id), t);
    assert.equal(await classOf(t), 'monitor-side', 'ambient noise present on passing runs must NOT read as a service failure');
  } finally { await pool.query(`DELETE FROM checks WHERE id = $1`, [id]); }
});

// ★ No recent successful run + a first-party error ⇒ empty baseline ⇒ service-side (asserted deliberately).
nodeTest('no recent green + a first-party error ⇒ SERVICE-SIDE (empty baseline)', { skip: SKIP }, async () => {
  const id = await makeCheck('__tb_nogreen__');
  try {
    await seedRun(id, 'fail', 60, CHUNK_FAIL);
    await seedRun(id, 'fail', 40, CHUNK_FAIL);
    const t = await seedRun(id, 'fail', 20, CHUNK_FAIL);
    await classifyAndPersistTransient(asCheck(id), t);
    assert.equal(await classOf(t), 'service-side', 'no green baseline + first-party errors = an outage');
  } finally { await pool.query(`DELETE FROM checks WHERE id = $1`, [id]); }
});

// ★ The dimension must still be REACHABLE: a genuine paint-race — no first-party errors at all, last success clean.
nodeTest('paint-race (no first-party errors, clean last success) ⇒ monitor-side (dimension still alive)', { skip: SKIP }, async () => {
  const id = await makeCheck('__tb_paint__');
  try {
    await seedRun(id, 'pass', 40, { console: { messages: [] }, network: { failed: [] } });
    const t = await seedRun(id, 'fail', 20, { console: { messages: [{ level: 'error', origin: 'third-party', sourceHost: 'sentry.io', text: 'sentry noise' }] }, network: { failed: [] } });
    await classifyAndPersistTransient(asCheck(id), t);
    assert.equal(await classOf(t), 'monitor-side', 'no NEW first-party error (only a third-party one) ⇒ monitor-side');
  } finally { await pool.query(`DELETE FROM checks WHERE id = $1`, [id]); }
});
