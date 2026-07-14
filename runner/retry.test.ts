// Unit tests for the confirmation-by-rerun eligibility helpers (0077). The in-run FAST-RETRY core
// (runWithRetry + effectiveRetries, mechanism 1) was RETIRED in 0084 — a failure now confirms by a
// separate RE-RUN, never an in-run loop — so its tests were removed with it. What remains: which
// confirmation PATH each kind uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmByRerunEligible, usesDedicatedExecution } from './retry.js';

// ★★ EVERY kind is confirm-eligible — no kind is structurally flap-blind (which would hand it a vacuous
// "0% flake"). Before, http/ssl/dns/tcp/ping returned FALSE → they never produced a superseded transient.
test('confirmByRerunEligible: EVERY check kind is eligible (no flap-blind kind → no vacuous-green)', () => {
  for (const k of ['browser', 'multistep', 'http', 'ssl', 'dns', 'tcp', 'ping']) {
    assert.equal(confirmByRerunEligible(k), true, `${k} must be confirm-eligible`);
  }
});

// It is a deliberate ALLOWLIST, not `return true`: an unknown/future kind is ineligible until added on
// purpose (a FUTURE expensive kind should be a decision). Guards against a `return true` regression.
test('confirmByRerunEligible: an unknown/future kind is NOT eligible by default (deliberate allowlist)', () => {
  assert.equal(confirmByRerunEligible('grpc'), false);
  assert.equal(confirmByRerunEligible(''), false);
});

// The confirmation MECHANISM differs by cost: browser/multistep get a dedicated fresh execution (jobs/start);
// cheap sub-second kinds ride the next cron tick's drain (no dedicated pod). Reverting either flips this.
test('usesDedicatedExecution: only the expensive flows fire a dedicated execution; cheap kinds drain next-tick', () => {
  assert.equal(usesDedicatedExecution('browser'), true);
  assert.equal(usesDedicatedExecution('multistep'), true);
  for (const k of ['http', 'ssl', 'dns', 'tcp', 'ping']) {
    assert.equal(usesDedicatedExecution(k), false, `${k} must confirm via the next-tick drain, not a dedicated pod`);
  }
});
