// browserFlow — THE shared browser-flow trace producer, called by BOTH the real check path
// (index.ts executeBrowser) and the sandbox preview (sandbox/sandboxChild.ts). ONE producer so a preview's
// steps / trace.zip / screenshot are the SAME shape a real check produces — the reconcilePlan() rule: two
// producers drift into a lookalike, and a preview that shows a different shape than a real check is exactly
// the lookalike we refused to fake.
//
// It is PURE — it starts/stops a Playwright trace, runs the flow under a StepRecorder with a whole-flow
// deadline, classifies the outcome, and captures a failure screenshot. It writes NOTHING to a database: the
// StepRecorder's SINKS decide where steps land (real path → run_steps rows; sandbox → an in-memory array).
// Persistence, metrics, login-credentials, and per-request headers stay in the CALLERS, around this call.
import os from 'node:os';
import path from 'node:path';

import type { BrowserContext, Page } from 'playwright';

import type { Flow } from './checks/index.js';
import { isExpectationError } from './errors.js';
import type { StepRecorder } from './stepRecorder.js';
import { withDeadline } from './timeBudget.js';

// ★ Playwright trace-capture options — SHARED so the sandbox zip is byte-shape-identical to a real check's
//   (same screenshots+snapshots, no embedded sources). Changing these changes BOTH producers at once.
export const TRACE_START_OPTIONS = { screenshots: true, snapshots: true, sources: false } as const;

export interface TracedFlowResult {
  /** The flow outcome, classified the same way the real path classifies it. */
  status: 'pass' | 'fail' | 'error';
  error: string | null;
  /** The step that threw, or null if the flow completed. */
  failedStep: string | null;
  /** Failure screenshot (a PNG Buffer), or null on pass / capture failure. */
  screenshot: Buffer | null;
  /** Path to the written trace.zip temp file, or null (not kept, or stop failed). The CALLER uploads + cleans up. */
  tracePath: string | null;
}

export interface RunTracedFlowOptions {
  /** Identifies the trace temp file (a runId or a preview token). */
  traceId: string | number;
  /** Keep+write the trace.zip even when the flow PASSES (a failure ALWAYS writes it). */
  keepTraceOnPass: boolean;
  /** Whole-flow wall-clock budget (ms) — a breach rejects and classifies 'error'. */
  deadlineMs: number;
  /** Message for a deadline breach. */
  deadlineMsg: string;
  /** Directory for the trace temp file. Defaults to os.tmpdir(); the sandbox passes its OWN temp dir so the
   *  parent process (which holds the blob credentials) can read the zip before the dir is cleaned up. */
  traceDir?: string;
}

/**
 * Start a Playwright trace, build+run `buildFlow()` under `rec` (with a whole-flow deadline), classify the
 * outcome (ExpectationError → 'fail'; any other throw → 'error'), capture a failure screenshot, and stop the
 * trace — writing trace.zip to a temp file when kept (always on failure; on pass only when keepTraceOnPass).
 *
 * `buildFlow` runs INSIDE the traced region, so a spec-load error is traced and classified exactly like the
 * real path. This does NOT close the context (the caller owns teardown) and writes NOTHING to a DB.
 */
export async function runTracedFlow(
  context: BrowserContext,
  page: Page,
  buildFlow: () => Promise<Flow>,
  rec: StepRecorder,
  opts: RunTracedFlowOptions,
): Promise<TracedFlowResult> {
  let status: TracedFlowResult['status'];
  let error: string | null = null;
  let failedStep: string | null = null;
  let screenshot: Buffer | null = null;
  let tracePath: string | null = null;
  let failed = false;

  // Non-fatal: a swallowed trace-start would mean no trace to debug from — log it (same [trace] channel as stop).
  let tracingOn = false;
  await context.tracing
    .start({ ...TRACE_START_OPTIONS })
    .then(() => {
      tracingOn = true;
    })
    .catch((err) => {
      console.warn(`[trace] ${opts.traceId} tracing.start failed (non-fatal; no trace will be captured):`, err);
    });

  try {
    const flow = await buildFlow();
    // The whole-flow deadline: per-action timeouts never bound the WHOLE flow. A breach rejects with a plain
    // Error → classified 'error' below (not an ExpectationError).
    await withDeadline(flow(rec), opts.deadlineMs, opts.deadlineMsg);
    status = 'pass';
  } catch (err) {
    failed = true;
    status = isExpectationError(err) ? 'fail' : 'error';
    error = err instanceof Error ? err.message : String(err);
    failedStep = rec.failedStep;
    screenshot = await page.screenshot().catch(() => null);
  } finally {
    if (tracingOn) {
      try {
        if (failed || opts.keepTraceOnPass) {
          tracePath = path.join(opts.traceDir ?? os.tmpdir(), `sw-trace-${opts.traceId}-${Date.now()}.zip`);
          await context.tracing.stop({ path: tracePath });
        } else {
          await context.tracing.stop();
        }
      } catch (err) {
        console.warn(`[trace] ${opts.traceId} trace stop failed:`, err);
        tracePath = null;
      }
    }
  }

  return { status, error, failedStep, screenshot, tracePath };
}
