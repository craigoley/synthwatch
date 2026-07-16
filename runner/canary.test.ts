// Offline unit tests for the canary staleness DECISION (no DB, runs everywhere). The full DB-wired behavior
// (delivered ⇒ no email; failed ⇒ email + runner_errors; stale ⇒ email) is proven in canary.integration.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideStale, CANARY_STALE_MS } from './canary.js';

const NOW = 1_000_000_000_000; // fixed epoch-ms (no Date.now in a unit test)

test('fresh delivery ⇒ not stale', () => {
  assert.equal(decideStale(NOW - 1000, NOW - 2000, NOW), false);
});

test('newest delivery older than the window ⇒ stale', () => {
  assert.equal(decideStale(NOW - CANARY_STALE_MS - 1, NOW - CANARY_STALE_MS - 1, NOW), true);
});

test('delivery exactly at the window boundary ⇒ not yet stale (strict >)', () => {
  assert.equal(decideStale(NOW - CANARY_STALE_MS, null, NOW), false);
});

test('never delivered + no attempt (just deployed) ⇒ NOT stale (no false red before first probe)', () => {
  assert.equal(decideStale(null, null, NOW), false);
});

test('never delivered but attempting longer than the window ⇒ stale', () => {
  assert.equal(decideStale(null, NOW - CANARY_STALE_MS - 1, NOW), true);
});

test('never delivered + recent attempt ⇒ not stale yet', () => {
  assert.equal(decideStale(null, NOW - 1000, NOW), false);
});
