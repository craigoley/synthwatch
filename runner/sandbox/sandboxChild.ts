// Spawned by runSandboxPreview with an ALLOWLIST env (sandboxEnv.buildSandboxEnv). EVERYTHING here runs with
// NO prod secrets in process.env, NO DATABASE_URL to reach a DB, and the sandbox identity's (nil) privileges.
//
// It loads + executes the uploaded compiled spec — the RCE moment (compileSpec.ts:loadCompiledSpec's import())
// happens HERE, in this isolated child, not in the parent runner — then runs the loaded test through the SAME
// shared trace producer a real check uses (browserFlow.runTracedFlow), capturing the REAL Playwright trace:
// run_steps + per-step timings, a trace.zip, a failure screenshot, and trace_signals (via the same
// extractTraceSignals, golden-fixture parity with the C# extractor). ONE producer → a preview's shape matches a
// real check's BY CONSTRUCTION, not a lookalike.
//
// ISOLATION HELD (do not weaken): the browser runs under this child's allowlist env (no secrets), against the
// public/non-prod SW_SANDBOX_TARGET_URL, writing artifacts as TEMP FILES in the parent-owned dir. The child
// holds NO blob credentials (AZURE_CLIENT_ID / SANDBOX_STORAGE_ACCOUNT are excluded from the allowlist) — only
// the trusted PARENT (sandboxMain) uploads. Step telemetry uses IN-MEMORY sinks, so no DB is touched. The
// spec's OWN stdout (e.g. a hostile `console.log(process.env)`) still lands on this child's stdout, which the
// parent captures — the isolation acceptance test asserts on it.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { chromium } from 'playwright';

import { runTracedFlow } from '../browserFlow.js';
import { loadCompiledSpec } from '../specfetch/compileSpec.js';
import { specToFlow } from '../specfetch/specShim.js';
import { StepRecorder, type RecordedStep } from '../stepRecorder.js';
import { extractTraceSignals } from '../traceSignals.js';

/** The child's stdout result line — the parent reads this (last stdout line) + the temp-file artifacts. */
interface ChildResult {
  ok: boolean;
  tests: string[];
  status: 'pass' | 'fail' | 'error';
  error: string | null;
  failedStep: string | null;
  steps: { index: number; name: string; status: string; durationMs: number; errorMessage: string | null }[];
  traceSignals: unknown | null;
  /** Absolute paths to the artifacts the child wrote into the parent-owned temp dir (parent reads + uploads). */
  tracePath: string | null;
  screenshotPath: string | null;
}

function emit(r: ChildResult): void {
  process.stdout.write(JSON.stringify(r) + '\n');
}

async function main(): Promise<void> {
  const compiledPath = process.argv[2];
  if (!compiledPath) {
    process.stderr.write('sandboxChild: missing compiled-spec path arg\n');
    process.exit(2);
  }
  const compiledJs = readFileSync(compiledPath, 'utf8');
  const outDir = path.dirname(compiledPath); // the parent-owned temp dir — artifacts land here for the parent
  const targetUrl = process.env.SW_SANDBOX_TARGET_URL ?? 'https://example.com';
  // Whole-flow deadline < the parent's hard-kill (SW_SANDBOX_TIMEOUT_MS), leaving headroom to stop the trace,
  // extract signals, and write the screenshot before the parent reaps the process group.
  const budgetMs = Number(process.env.SW_SANDBOX_TIMEOUT_MS ?? 120_000);
  const flowDeadlineMs = Math.max(30_000, budgetMs - 30_000);

  // ★ THE RCE MOMENT — arbitrary uploaded code executes on this import (runs the spec's top-level test() calls
  //   to register them). Contained by: this process's allowlist env (no secrets), no DB reachability, nil RBAC.
  const tests = await loadCompiledSpec(compiledJs);
  if (tests.length === 0) {
    emit({ ok: false, tests: [], status: 'error', error: 'spec defined no test()', failedStep: null, steps: [], traceSignals: null, tracePath: null, screenshotPath: null });
    return;
  }

  // In-memory step sinks — the SAME StepRecorder a real check uses, but steps accumulate in an array (no DB).
  const recorded: RecordedStep[] = [];
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(Math.min(flowDeadlineMs, 30_000)); // per-action bound (per-action ≠ whole-flow)
    // IDENTITY_REDACTOR default: a sandbox target is public/non-prod, so there are no secret values to scrub.
    const rec = new StepRecorder(
      0,
      page,
      targetUrl,
      async (s) => {
        recorded.push(s);
      },
      async () => {},
    );

    const traced = await runTracedFlow(
      context,
      page,
      // Build the flow from the FIRST registered test — the same specToFlow the real path uses.
      async () => specToFlow(tests[0].fn, page),
      rec,
      {
        traceId: process.env.SW_SANDBOX_RESULT_TOKEN ?? 'preview',
        keepTraceOnPass: true, // a preview always wants the trace — the SRE inspects a passing flow too
        deadlineMs: flowDeadlineMs,
        deadlineMsg: `preview flow budget (${flowDeadlineMs}ms) exhausted — the spec ran too long to trace`,
        traceDir: outDir,
      },
    );

    // trace_signals from the zip — the SAME extractor a real check uses (golden-fixture parity with the C# side).
    let traceSignals: unknown | null = null;
    if (traced.tracePath) {
      traceSignals = await extractTraceSignals(traced.tracePath, targetUrl).catch(() => null);
    }
    // Failure screenshot → a temp file the parent uploads.
    let screenshotPath: string | null = null;
    if (traced.screenshot) {
      screenshotPath = path.join(outDir, 'screenshot.png');
      writeFileSync(screenshotPath, traced.screenshot);
    }

    emit({
      ok: traced.status === 'pass',
      tests: tests.map((t) => t.name),
      status: traced.status,
      error: traced.error,
      failedStep: traced.failedStep,
      steps: recorded.map((s) => ({ index: s.index, name: s.name, status: s.status, durationMs: s.durationMs, errorMessage: s.errorMessage })),
      traceSignals,
      tracePath: traced.tracePath,
      screenshotPath,
    });

    await context.close().catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => {
  process.stderr.write(`sandboxChild: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
