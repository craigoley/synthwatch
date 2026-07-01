// Deploy-recording contract — DATABASE_URL-gated, mirrors reconcileApply.integration.test.ts. Everything runs
// inside a rolled-back txn (and CREATEs `deploys` in-txn) so it's prod-safe AND runs before 0056 is applied.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';

import { pool } from './db.js';
import { recordDeployMarker, recordMarkerSilentNull, hostOf } from './deploys.js';

const SKIP = !process.env.DATABASE_URL;
const test = SKIP ? nodeTest.skip : nodeTest;

const DEPLOYS_DDL = `CREATE TABLE deploys (
  id bigserial PRIMARY KEY, target_host text NOT NULL, sha text, fingerprint text NOT NULL,
  is_sha boolean NOT NULL DEFAULT false, source text NOT NULL,
  deployed_at timestamptz NOT NULL DEFAULT now(), detected_at timestamptz NOT NULL DEFAULT now(), detail jsonb,
  CONSTRAINT deploys_host_fingerprint_key UNIQUE (target_host, fingerprint))`;

nodeTest('hostOf extracts the host (the per-host join key)', () => {
  assert.equal(hostOf('https://www.meals2go.com/menu'), 'www.meals2go.com');
  assert.equal(hostOf('not a url'), null);
});

test('recording: changed→1 row, unchanged→0, per-host dedup (3 regions, same SHA → 1 row), new marker→+1', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(DEPLOYS_DDL);
    const host = 'deploytest.example';
    const shaA = { source: 'sentry-release', value: 'a'.repeat(40), is_sha: true };

    assert.equal(await recordDeployMarker(host, shaA, 1, client), true); // changed → inserted
    assert.equal(await recordDeployMarker(host, shaA, 1, client), false); // unchanged → no row

    // ★ per-host dedup: the SAME sha seen from 3 regions/checks concurrently → still ONE row
    await Promise.all([2, 3, 4].map((cid) => recordDeployMarker(host, shaA, cid, client)));
    const after = await client.query('SELECT count(*)::int AS n, max(sha) AS sha FROM deploys WHERE target_host=$1', [host]);
    assert.equal((after.rows[0] as { n: number }).n, 1);
    assert.equal((after.rows[0] as { sha: string }).sha, shaA.value); // is_sha → sha column populated

    // a genuinely NEW marker (a new deploy) → a second row
    assert.equal(await recordDeployMarker(host, { source: 'sentry-release', value: 'b'.repeat(40), is_sha: true }, 1, client), true);
    const two = await client.query('SELECT count(*)::int AS n FROM deploys WHERE target_host=$1', [host]);
    assert.equal((two.rows[0] as { n: number }).n, 2);

    // an etag marker stores fingerprint but a NULL sha (is_sha=false)
    await recordDeployMarker('etag-host.example', { source: 'etag', value: '93718211', is_sha: false }, 9, client);
    const et = await client.query('SELECT sha, fingerprint, is_sha FROM deploys WHERE target_host=$1', ['etag-host.example']);
    assert.equal((et.rows[0] as { sha: string | null }).sha, null);
    assert.equal((et.rows[0] as { is_sha: boolean }).is_sha, false);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('★ silent-null: a host with PRIOR markers records a runner_errors row; a fresh host does NOT', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(DEPLOYS_DDL);

    // fresh host (never produced a marker) → expected-null, NO runner_errors row
    await recordMarkerSilentNull('fresh-host.example', 1, client);
    const r0 = await client.query(
      `SELECT count(*)::int AS n FROM runner_errors WHERE phase='deploy-marker-silent-null' AND message LIKE '%fresh-host.example%'`);
    assert.equal((r0.rows[0] as { n: number }).n, 0);

    // a host that HAS produced a marker before → the detector going null is a regression → record it
    await client.query(`INSERT INTO deploys (target_host, fingerprint, source) VALUES ('had-markers.example','x','etag')`);
    await recordMarkerSilentNull('had-markers.example', 1, client);
    const r1 = await client.query(
      `SELECT count(*)::int AS n FROM runner_errors WHERE phase='deploy-marker-silent-null' AND message LIKE '%had-markers.example%'`);
    assert.equal((r1.rows[0] as { n: number }).n, 1);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
