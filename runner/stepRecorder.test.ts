// B10: a sensitive monitor must NOT persist raw per-step error text (it can echo DOM PII / a
// session-token URL) into run_steps — which the RCA AI also reads via the funnel. Verifies the
// per-step error_message is genericised for sensitive checks and untouched for non-sensitive ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { StepRecorder, type RecordedStep } from './stepRecorder.js';
import { ExpectationError } from './errors.js';

function recorder(sensitive: boolean): { rec: StepRecorder; steps: RecordedStep[] } {
  const steps: RecordedStep[] = [];
  const rec = new StepRecorder(
    1,
    null as unknown as Page,
    'about:blank',
    async (s) => {
      steps.push(s); // terminal sink: collect the finalized step
    },
    async () => {}, // running marker: no-op
    sensitive,
  );
  return { rec, steps };
}

test('B10: a sensitive monitor persists a GENERIC per-step error (no echoed PII)', async () => {
  const { rec, steps } = recorder(true);
  await assert.rejects(() =>
    rec.step('checkout', async () => {
      throw new ExpectationError('Received "Welcome back, john.doe@example.com — cart (3 items)"');
    }),
  );
  assert.equal(steps.length, 1);
  assert.equal(steps[0].status, 'fail');
  assert.equal(steps[0].errorMessage, 'fail — error details redacted (sensitive monitor)');
  assert.ok(!String(steps[0].errorMessage).includes('john.doe'), 'the echoed PII is NOT persisted');
});

test('a non-sensitive monitor persists the REAL per-step error (byte-for-byte unchanged)', async () => {
  const { rec, steps } = recorder(false);
  await assert.rejects(() =>
    rec.step('open', async () => {
      throw new ExpectationError('boom detail');
    }),
  );
  assert.equal(steps[0].errorMessage, 'boom detail');
});
