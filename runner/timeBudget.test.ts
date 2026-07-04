// Unit tests for withDeadline — the browser family's whole-flow wall-clock ceiling (the mirror of
// multistep's MAX_CHAIN_MS). The properties that matter:
//   • in-time work passes its value through untouched;
//   • an overdue flow rejects with the HONEST budget message (a plain Error → 'error', never 'fail');
//   • a work rejection in time propagates unchanged (classification unaffected);
//   • a LATE loser rejection (Playwright aborting after context.close()) is marked handled — it must
//     not become an unhandledRejection that kills the tick (the exact class #149 made visible).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withDeadline } from './timeBudget.js';
import { isExpectationError } from './errors.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('withDeadline: in-time work resolves with its value', async () => {
  const v = await withDeadline(Promise.resolve(42), 1000, 'unused');
  assert.equal(v, 42);
});

test('withDeadline: overdue work rejects with the budget message, as a PLAIN Error (classifies as error, not fail)', async () => {
  const never = new Promise<void>(() => {});
  await assert.rejects(
    withDeadline(never, 30, 'browser flow wall-clock budget (30ms) exhausted'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /wall-clock budget \(30ms\) exhausted/);
      assert.ok(!isExpectationError(err), 'a budget breach is infra, never an assertion miss');
      return true;
    },
  );
});

test('withDeadline: an in-time work REJECTION propagates unchanged', async () => {
  const boom = new Error('selector timeout');
  await assert.rejects(withDeadline(Promise.reject(boom), 1000, 'unused'), (err: unknown) => err === boom);
});

test('withDeadline: a LATE loser rejection is marked handled — no unhandledRejection escapes', async () => {
  let sawUnhandled: unknown = null;
  const spy = (reason: unknown): void => {
    sawUnhandled = reason;
  };
  process.on('unhandledRejection', spy);
  try {
    const lateFail = sleep(60).then(() => {
      throw new Error('aborted by context.close() after the deadline won');
    });
    await assert.rejects(withDeadline(lateFail, 10, 'budget exhausted'), /budget exhausted/);
    await sleep(120); // let the loser reject + the unhandledRejection window pass
    assert.equal(sawUnhandled, null, 'the abandoned flow rejection must be pre-handled');
  } finally {
    process.removeListener('unhandledRejection', spy);
  }
});
