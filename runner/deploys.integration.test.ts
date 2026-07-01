// Deploy-recording contract — DATABASE_URL-gated, mirrors reconcileApply.integration.test.ts. Everything runs
// inside a rolled-back txn so it's prod-safe. The DDL is CREATE TABLE IF NOT EXISTS so it works BOTH pre-0056
// (creates the table in-txn) and post-0056 (reuses the real table — writes still roll back).
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';

import { pool } from './db.js';
import { recordDeployMarker, recordMarkerSilentNull, hostOf } from './deploys.js';

const SKIP = !process.env.DATABASE_URL;
const test = SKIP ? nodeTest.skip : nodeTest;

const DEPLOYS_DDL = `CREATE TABLE IF NOT EXISTS deploys (
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

    assert.equal(await recordDeployMarker(host, shaA, 1, 'http', client), true); // changed → inserted
    assert.equal(await recordDeployMarker(host, shaA, 1, 'http', client), false); // unchanged → no row

    // ★ per-host dedup: the SAME sha seen from 3 regions/checks concurrently → still ONE row
    await Promise.all([2, 3, 4].map((cid) => recordDeployMarker(host, shaA, cid, 'http', client)));
    const after = await client.query('SELECT count(*)::int AS n, max(sha) AS sha FROM deploys WHERE target_host=$1', [host]);
    assert.equal((after.rows[0] as { n: number }).n, 1);
    assert.equal((after.rows[0] as { sha: string }).sha, shaA.value); // is_sha → sha column populated

    // a genuinely NEW marker (a new deploy) → a second row
    assert.equal(await recordDeployMarker(host, { source: 'sentry-release', value: 'b'.repeat(40), is_sha: true }, 1, 'http', client), true);
    const two = await client.query('SELECT count(*)::int AS n FROM deploys WHERE target_host=$1', [host]);
    assert.equal((two.rows[0] as { n: number }).n, 2);

    // an etag marker stores fingerprint but a NULL sha (is_sha=false)
    await recordDeployMarker('etag-host.example', { source: 'etag', value: '93718211', is_sha: false }, 9, 'http', client);
    const et = await client.query('SELECT sha, fingerprint, is_sha FROM deploys WHERE target_host=$1', ['etag-host.example']);
    assert.equal((et.rows[0] as { sha: string | null }).sha, null);
    assert.equal((et.rows[0] as { is_sha: boolean }).is_sha, false);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('★ silent-null: a host with PRIOR markers (same path) records a runner_errors row; a fresh host does NOT', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(DEPLOYS_DDL);

    // fresh host (never produced a marker) → expected-null, NO runner_errors row
    await recordMarkerSilentNull('fresh-host.example', 1, 'http', client);
    const r0 = await client.query(
      `SELECT count(*)::int AS n FROM runner_errors WHERE phase='deploy-marker-silent-null' AND message LIKE '%fresh-host.example%'`);
    assert.equal((r0.rows[0] as { n: number }).n, 0);

    // a host that HAS produced a marker before via THIS path → detector going null is a regression → record it
    await recordDeployMarker('had-markers.example', { source: 'etag', value: 'x', is_sha: false }, 1, 'http', client);
    await recordMarkerSilentNull('had-markers.example', 1, 'http', client);
    const r1 = await client.query(
      `SELECT count(*)::int AS n FROM runner_errors WHERE phase='deploy-marker-silent-null' AND message LIKE '%had-markers.example%'`);
    assert.equal((r1.rows[0] as { n: number }).n, 1);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

// ★ SOURCE-AWARE silent-null: markers a host produced via the HTTP path must NOT make a BROWSER-path null read
// as "this host previously produced markers." Wiring the browser path is exactly when this guard must hold —
// otherwise every browser check of an http-marked host false-flags a regression every tick.
test('★ source-aware silent-null: an http-path marker does NOT trip a browser-path null (and vice-versa flags correctly)', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(DEPLOYS_DDL);

    // host produced a marker ONLY via the http path
    await recordDeployMarker('dualpath.example', { source: 'etag', value: 'abc', is_sha: false }, 1, 'http', client);

    // a BROWSER-path null for that host is NOT a regression (browser never produced a marker here) → no row
    await recordMarkerSilentNull('dualpath.example', 1, 'browser', client);
    const browserNull = await client.query(
      `SELECT count(*)::int AS n FROM runner_errors WHERE phase='deploy-marker-silent-null' AND message LIKE '%dualpath.example via the browser path%'`);
    assert.equal((browserNull.rows[0] as { n: number }).n, 0);

    // an HTTP-path null for the same host IS a regression (http did produce before) → recorded, path-attributed
    await recordMarkerSilentNull('dualpath.example', 1, 'http', client);
    const httpNull = await client.query(
      `SELECT count(*)::int AS n FROM runner_errors WHERE phase='deploy-marker-silent-null' AND message LIKE '%dualpath.example via the http path%'`);
    assert.equal((httpNull.rows[0] as { n: number }).n, 1);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
