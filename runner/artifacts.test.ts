// Unit test for the success-trace KEY scheme — the purge-safety invariant. Pure (no blob/network).
//
// The 90d artifact lifecycle purge (infra/main.bicep) targets the prefixes `traces/` and `run-`.
// The last-known-good SUCCESS trace must live OUTSIDE those prefixes so a monitor that stays green
// for 90d doesn't lose its only baseline. This test pins that contract so a rename can't silently
// move the success key under a purged prefix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { successTraceBlobName } from './artifacts.js';

// The exact prefixes the lifecycle policy deletes after `artifactRetentionDays` (infra/main.bicep).
const PURGED_PREFIXES = ['traces/', 'run-'];

test('success-trace key is a STABLE per-monitor slot (overwrite, not per-run)', () => {
  // No runId / timestamp in the key => each success OVERWRITES the prior baseline (one slot/monitor).
  assert.equal(successTraceBlobName(74), 'success-latest/check-74.zip');
  assert.equal(successTraceBlobName(1), 'success-latest/check-1.zip');
  // Same check id => same key on every success (idempotent overwrite).
  assert.equal(successTraceBlobName(74), successTraceBlobName(74));
});

test('success-trace key is OUTSIDE the 90d purge prefixes (baseline survives a long green streak)', () => {
  for (const id of [1, 74, 999999]) {
    const key = successTraceBlobName(id);
    for (const prefix of PURGED_PREFIXES) {
      assert.ok(!key.startsWith(prefix), `success key "${key}" must NOT start with purged prefix "${prefix}"`);
    }
    assert.ok(key.startsWith('success-latest/'), `success key "${key}" must live under success-latest/`);
  }
});
