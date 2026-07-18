// Direct unit tests for the SHARED trace producer (runTracedFlow) — the code BOTH the live check path
// (executeBrowser) and the sandbox preview run. These PIN the ordering + classification the extraction claims
// to preserve, with fakes (no browser, no DB): trace start → flow → (onPass, pass-only) → classify → failure
// screenshot → trace stop. The ordering assertions are prove-can-fail: perturb runTracedFlow (move/drop a
// step) and the deepEqual on the call-order log REDS — a test that passed on both orderings would assert
// nothing about the refactor.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BrowserContext, Page } from 'playwright';

import { runTracedFlow, TRACE_START_OPTIONS, type RunTracedFlowOptions } from './browserFlow.js';
import { ExpectationError } from './errors.js';
import type { StepRecorder } from './stepRecorder.js';

/** A fake context/page/rec that logs the producer's call order. runTracedFlow only touches
 *  context.tracing.{start,stop}, page.screenshot, rec.failedStep, and the flow it builds. */
function harness(opts: { flow: (order: string[]) => Promise<void>; failedStep?: string | null }) {
  const order: string[] = [];
  let startOpts: unknown;
  const stopArgs: unknown[] = [];
  const context = {
    tracing: {
      start: async (o: unknown) => {
        order.push('trace.start');
        startOpts = o;
      },
      stop: async (a?: unknown) => {
        order.push('trace.stop');
        stopArgs.push(a ?? null);
      },
    },
  } as unknown as BrowserContext;
  const page = {
    screenshot: async () => {
      order.push('screenshot');
      return Buffer.from('png');
    },
  } as unknown as Page;
  const rec = { failedStep: opts.failedStep ?? null } as unknown as StepRecorder;
  const buildFlow = async () => {
    order.push('buildFlow');
    return async () => {
      await opts.flow(order);
    };
  };
  return { order, startOpts: () => startOpts, stopArgs, page, context, rec, buildFlow };
}

const OPTS = (over: Partial<RunTracedFlowOptions> = {}): RunTracedFlowOptions => ({
  traceId: 'test',
  keepTraceOnPass: false,
  deadlineMs: 5_000,
  deadlineMsg: 'deadline',
  ...over,
});

test('runTracedFlow PASS: start → flow → onPass → stop; no screenshot; trace discarded when !keepTraceOnPass', async () => {
  const h = harness({ flow: async (o) => { o.push('flow'); } });
  let onPassCalls = 0;
  const r = await runTracedFlow(h.context, h.page, h.buildFlow, h.rec, OPTS(), async () => {
    h.order.push('onPass');
    onPassCalls++;
  });

  assert.equal(r.status, 'pass');
  assert.equal(r.screenshot, null, 'no failure screenshot on pass');
  assert.equal(r.tracePath, null, 'trace discarded when keepTraceOnPass=false');
  assert.equal(onPassCalls, 1, 'onPass runs exactly once on pass');
  assert.deepEqual(h.startOpts(), { ...TRACE_START_OPTIONS }, 'trace started with the SHARED options');
  // ★ THE ORDERING the refactor preserves — onPass (baseline+deploy) runs INSIDE the trace window, after the
  //   flow, before stop. Prove-can-fail: any reorder in runTracedFlow reds this deepEqual.
  assert.deepEqual(h.order, ['trace.start', 'buildFlow', 'flow', 'onPass', 'trace.stop']);
  assert.deepEqual(h.stopArgs, [null], 'stop called WITHOUT a path (trace discarded on pass)');
});

test('runTracedFlow PASS + keepTraceOnPass: the trace.zip is WRITTEN (stop with {path})', async () => {
  const h = harness({ flow: async (o) => { o.push('flow'); } });
  const r = await runTracedFlow(h.context, h.page, h.buildFlow, h.rec, OPTS({ keepTraceOnPass: true }));

  assert.equal(r.status, 'pass');
  assert.ok(r.tracePath && r.tracePath.endsWith('.zip'), 'a trace.zip path is set');
  assert.ok(h.stopArgs[0] && typeof h.stopArgs[0] === 'object', 'stop called WITH {path}');
});

test('runTracedFlow FAIL (ExpectationError): screenshot taken, onPass SKIPPED, trace kept, failedStep surfaced', async () => {
  const h = harness({
    flow: async (o) => {
      o.push('flow');
      throw new ExpectationError('nope');
    },
    failedStep: 'the assert step',
  });
  let onPassCalls = 0;
  const r = await runTracedFlow(h.context, h.page, h.buildFlow, h.rec, OPTS(), async () => {
    onPassCalls++;
  });

  assert.equal(r.status, 'fail', 'an ExpectationError → fail');
  assert.equal(onPassCalls, 0, 'onPass is SKIPPED on failure (pass-only — the reorder concern)');
  assert.ok(r.screenshot, 'a failure screenshot is captured');
  assert.equal(r.failedStep, 'the assert step', 'the failing step is surfaced from rec');
  assert.ok(r.tracePath, 'the trace is ALWAYS kept on failure');
  // ordering on failure: no onPass; screenshot before the trace stops.
  assert.deepEqual(h.order, ['trace.start', 'buildFlow', 'flow', 'screenshot', 'trace.stop']);
});

test('runTracedFlow ERROR (a non-expectation throw) → error, still screenshots + keeps the trace', async () => {
  const h = harness({
    flow: async (o) => {
      o.push('flow');
      throw new Error('boom');
    },
  });
  const r = await runTracedFlow(h.context, h.page, h.buildFlow, h.rec, OPTS());

  assert.equal(r.status, 'error', 'a plain throw → error, not fail');
  assert.ok(r.screenshot);
  assert.ok(r.tracePath);
});
