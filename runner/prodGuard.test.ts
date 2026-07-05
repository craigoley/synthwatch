// Unit tests for the local-runner-writes-prod guard (pure decision — no DB, no process.exit).
// The four contract cases from the guard's design, plus the edges:
//   (1) local context (no deployed signal) + prod host       → REFUSED
//   (2) same + SYNTHWATCH_ALLOW_PROD=1                       → allowed (deliberate, stated intent)
//   (3) deployed context (SYNTHWATCH_DEPLOYED=1 present) + prod host → allowed silently
//   (4) local context + a local/non-prod DATABASE_URL        → allowed — the MUST-NOT-OVERBLOCK
//       case: developing against a local DB is normal; the guard targets prod writes specifically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prodGuardVerdict, PROD_PG_HOST_SUFFIX } from './prodGuard.js';

const PROD_URL = `postgresql://synthadmin:s3cret@synthwatch-pg-e2${PROD_PG_HOST_SUFFIX}:5432/synthwatch?sslmode=require`;
const LOCAL_URL = 'postgres://postgres@localhost:5433/synthwatch_test';

test('(1) local context + prod host → REFUSED (the June 25–26 incident shape)', () => {
  const v = prodGuardVerdict({ DATABASE_URL: PROD_URL });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, 'local-prod-refused');
});

test('(2) local context + prod host + SYNTHWATCH_ALLOW_PROD=1 → allowed (escape hatch)', () => {
  const v = prodGuardVerdict({ DATABASE_URL: PROD_URL, SYNTHWATCH_ALLOW_PROD: '1' });
  assert.deepEqual(v, { allowed: true, reason: 'allow-prod-hatch' });
});

test('(3) deployed context (SYNTHWATCH_DEPLOYED=1, the universal #197 marker on all 8 jobs) + prod host → allowed', () => {
  const v = prodGuardVerdict({ DATABASE_URL: PROD_URL, SYNTHWATCH_DEPLOYED: '1' });
  assert.deepEqual(v, { allowed: true, reason: 'deployed' });
});

test('(3b) marker must be EXACTLY "1" — a stray truthy value does not read as deployed', () => {
  const v = prodGuardVerdict({ DATABASE_URL: PROD_URL, SYNTHWATCH_DEPLOYED: 'true' });
  assert.equal(v.allowed, false);
});

test('(3c) the RETIRED signals no longer pass — closes #196\'s named falsifier', () => {
  // SYNTHWATCH_LOCATION alone (a local shell testing multi-region logic) used to bypass; no more.
  assert.equal(prodGuardVerdict({ DATABASE_URL: PROD_URL, SYNTHWATCH_LOCATION: 'eastus2' }).allowed, false);
  // CONTAINER_APP_JOB_NAME (never doc-verified) is no longer a signal either.
  assert.equal(
    prodGuardVerdict({ DATABASE_URL: PROD_URL, CONTAINER_APP_JOB_NAME: 'synthwatch-runner-job' }).allowed,
    false,
  );
});

test('(4) local context + LOCAL DATABASE_URL → allowed (must NOT overblock normal local dev)', () => {
  const v = prodGuardVerdict({ DATABASE_URL: LOCAL_URL });
  assert.deepEqual(v, { allowed: true, reason: 'non-prod-host' });
});

test('(4b) docker-style host and a non-Azure remote are both non-prod', () => {
  assert.equal(prodGuardVerdict({ DATABASE_URL: 'postgres://u@db:5432/x' }).allowed, true);
  assert.equal(prodGuardVerdict({ DATABASE_URL: 'postgres://u@pg.internal.example.com/x' }).allowed, true);
});

test('hatch must be EXACTLY "1" — a stray truthy value does not open it', () => {
  const v = prodGuardVerdict({ DATABASE_URL: PROD_URL, SYNTHWATCH_ALLOW_PROD: 'true' });
  assert.equal(v.allowed, false);
});

test('no DATABASE_URL → allowed (nothing to guard; the pool fails on first query anyway)', () => {
  assert.deepEqual(prodGuardVerdict({}), { allowed: true, reason: 'no-database-url' });
});

test('unparseable DATABASE_URL → allowed as unidentifiable (the pool surfaces the real error)', () => {
  assert.deepEqual(prodGuardVerdict({ DATABASE_URL: 'not a url at all' }), {
    allowed: true,
    reason: 'unparseable-url',
  });
});

test('host matching is case-insensitive and suffix-anchored (a lookalike prefix does not match)', () => {
  const upper = `postgresql://u@SYNTHWATCH-PG-E2${PROD_PG_HOST_SUFFIX.toUpperCase()}:5432/db`;
  assert.equal(prodGuardVerdict({ DATABASE_URL: upper }).allowed, false);
  // suffix must anchor at the end — a host merely CONTAINING it is not prod
  const lookalike = `postgres://u@evil${PROD_PG_HOST_SUFFIX}.attacker.example/db`;
  assert.equal(prodGuardVerdict({ DATABASE_URL: lookalike }).allowed, true);
});
