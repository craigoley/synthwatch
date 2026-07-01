import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyRedTest, runHttpRedTest, recordAttested, type Fault } from './redTest.js';
import type { Check } from './db.js';

// A minimal Check stub — only the fields the harness reads.
const check = (over: Partial<Check> = {}): Check =>
  ({ id: 42, name: 'test monitor', kind: 'http', target_url: 'https://www.wegmans.com/', ...over }) as Check;

// ── ★ THE HONESTY CLASSIFIER (the load-bearing must-go-red) ─────────────────────────────────────────────────
test('classify: verdict fail → RED (the monitor\'s assertion fired on the known-bad input)', () => {
  assert.equal(classifyRedTest('fail').outcome, 'red');
});

// ★★ THE MUST-GO-RED FOR THE HARNESS: an UNRELATED failure (infra_error / error) must NOT be claimed as a
// red-test — it's inconclusive. This is the exact false-confidence the guardrail exists to kill (a run that
// broke for a reason OTHER than the monitor's assertion proves nothing about the assertion).
test('★ classify: verdict error/infra_error → INCONCLUSIVE (never red — the run failed for an unrelated reason)', () => {
  assert.equal(classifyRedTest('error').outcome, 'inconclusive');
  assert.equal(classifyRedTest('infra_error').outcome, 'inconclusive');
  // and it says WHY, so an operator can't mistake it for a proven red-test
  assert.match(classifyRedTest('infra_error').detail, /unrelated|NOT the monitor|Cannot conclude/i);
});

test('classify: verdict pass → NOT-RED (the fault did not make it red — a weak assertion, the #25/#26 bug)', () => {
  assert.equal(classifyRedTest('pass').outcome, 'not-red');
  assert.match(classifyRedTest('pass').detail, /weak|STAYED GREEN|assertion/i);
});

test('classify: an unknown verdict → INCONCLUSIVE (fail-closed, never red)', () => {
  assert.equal(classifyRedTest('running').outcome, 'inconclusive');
  assert.equal(classifyRedTest('').outcome, 'inconclusive');
});

// ── HTTP executed driver (injected runner — no network) ─────────────────────────────────────────────────────
const BAD_URL: Extract<Fault, { kind: 'bad-url' }> = { kind: 'bad-url', url: 'https://httpbin.org/status/500' };

test('★ HTTP driver: a known-bad url that makes the monitor\'s assertion fail → outcome RED', async () => {
  const r = await runHttpRedTest(check(), BAD_URL, async () => ({ verdict: 'fail' }));
  assert.equal(r.outcome, 'red');
  assert.equal(r.method, 'executed-red-fixture');
  assert.equal(r.verdict, 'fail');
  assert.match(r.fault, /bad-url → https:\/\/httpbin\.org\/status\/500/);
});

test('★ HTTP driver: the faulted run ERRORS (unreachable) → outcome INCONCLUSIVE, not red', async () => {
  const r = await runHttpRedTest(check(), BAD_URL, async () => ({ verdict: 'error' }));
  assert.equal(r.outcome, 'inconclusive');
  assert.equal(r.verdict, 'error');
});

test('HTTP driver: the monitor stays green under the fault → outcome NOT-RED (weak assertion)', async () => {
  const r = await runHttpRedTest(check(), BAD_URL, async () => ({ verdict: 'pass' }));
  assert.equal(r.outcome, 'not-red');
});

test('HTTP driver: the fault swaps target_url (the monitor\'s own assertions decide)', async () => {
  let seen = '';
  await runHttpRedTest(check({ target_url: 'https://real.example/' }), BAD_URL, async (c) => {
    seen = c.target_url;
    return { verdict: 'fail' };
  });
  assert.equal(seen, 'https://httpbin.org/status/500'); // the bad url was injected in place of the real target
});

// ── attested-manual (record-only, weaker tier) ──────────────────────────────────────────────────────────────
test('attested-manual: records the evidenced input WITHOUT executing, clearly labeled as the weaker tier', () => {
  const r = recordAttested(check(), { outcome: 'red', evidenceRef: 'trace://run/999', whatWasBroken: 'removed the cart button' });
  assert.equal(r.method, 'attested-manual');
  assert.equal(r.outcome, 'red');
  assert.equal(r.verdict, null); // nothing executed
  assert.match(r.detail, /MANUAL attestation \(weaker/i);
  assert.match(r.detail, /trace:\/\/run\/999/);
});
