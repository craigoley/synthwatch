// Unit tests for runWithRetry (fast-retry core, mechanism 1). Covers the Phase 4-MLACT Option B
// change: retry on 'fail' as well as 'error', up to `retries` attempts, the FINAL attempt is the
// verdict, and onBeforeRetry (the discard hook) fires once per NON-FINAL attempt — including 'fail',
// so a retried-away 'fail' is discarded identically to a retried-away 'error'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWithRetry } from './retry.js';

type R = { status: string; attempt: number };

// A scripted executor: returns the status from `script` for each attempt (1-indexed); the last entry
// repeats if attempts exceed the script. `calls` records the attempt numbers actually executed.
function scripted(script: string[]): { execute: (attempt: number) => Promise<R>; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    execute: async (attempt: number) => {
      calls.push(attempt);
      return { status: script[attempt - 1] ?? script[script.length - 1], attempt };
    },
  };
}

// (a) a 'fail' now RETRIES up to `retries` times (was: never retried) and recovers to the final verdict.
test("(a) a 'fail' retries up to `retries` times, final attempt is the verdict", async () => {
  const { execute, calls } = scripted(['fail', 'fail', 'pass']); // fail, fail, then pass on attempt 3
  const result = await runWithRetry(execute, 2);
  assert.deepEqual(calls, [1, 2, 3], 'ran 3 attempts (1 + 2 retries) — the fail WAS retried');
  assert.equal(result.status, 'pass', 'recovered on retry → final verdict is pass');
});

// (a') a persistent 'fail' exhausts retries; the final 'fail' is the confirmed verdict.
test("(a') a persistent 'fail' exhausts retries → confirmed 'fail'", async () => {
  const { execute, calls } = scripted(['fail', 'fail', 'fail']);
  const result = await runWithRetry(execute, 2);
  assert.deepEqual(calls, [1, 2, 3], 'exactly maxAttempts = retries + 1 = 3');
  assert.equal(result.status, 'fail', 'confirmed failure after all retries exhausted');
});

// regression: 'error' still retries (unchanged from 0021).
test("'error' still retries (regression)", async () => {
  const { execute, calls } = scripted(['error', 'pass']);
  const result = await runWithRetry(execute, 2);
  assert.deepEqual(calls, [1, 2]);
  assert.equal(result.status, 'pass');
});

// pass/warn are NEVER retried — don't waste a (60–90s browser) run on a success; warn = degraded-but-up.
test('pass is final immediately (no retry of a success)', async () => {
  const { execute, calls } = scripted(['pass', 'fail']);
  const result = await runWithRetry(execute, 2);
  assert.deepEqual(calls, [1], 'stopped after the first pass');
  assert.equal(result.status, 'pass');
});
test('warn is final immediately (available-but-degraded, not a failure)', async () => {
  const { execute, calls } = scripted(['warn', 'pass']);
  const result = await runWithRetry(execute, 2);
  assert.deepEqual(calls, [1]);
  assert.equal(result.status, 'warn');
});

// retries=0 disables retry even for a fail (pre-0021 behaviour preserved).
test('retries=0 disables retry (a fail is final)', async () => {
  const { execute, calls } = scripted(['fail', 'pass']);
  const result = await runWithRetry(execute, 0);
  assert.deepEqual(calls, [1]);
  assert.equal(result.status, 'fail');
});

// (b) the DISCARD hook fires once per NON-FINAL attempt — for 'fail' too. In production onBeforeRetry
// DELETEs run_steps/run_metrics + unlinks the temp trace for that runId regardless of status, so a
// retried-away 'fail' leaves NO phantom intermediate metrics/steps/trace; only the final attempt persists.
test("(b) the discard hook fires once per retried-away attempt, including 'fail'", async () => {
  const { execute } = scripted(['fail', 'error', 'fail']); // 3 attempts (2 retries): fail → error → fail
  const discarded: Array<{ status: string; attempt: number }> = [];
  const result = await runWithRetry(execute, 2, async (prev, attempt) => {
    discarded.push({ status: prev.status, attempt });
  });
  // attempt-1 'fail' discarded before attempt 2; attempt-2 'error' discarded before attempt 3; the
  // final attempt-3 'fail' is the verdict and is NOT discarded.
  assert.deepEqual(
    discarded,
    [
      { status: 'fail', attempt: 2 },
      { status: 'error', attempt: 3 },
    ],
    'every non-final attempt (fail AND error) is handed to the discard hook exactly once',
  );
  assert.equal(result.status, 'fail');
});
