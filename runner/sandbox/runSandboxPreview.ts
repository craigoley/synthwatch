// runSandboxPreview — the ONE preview entry point, callable from BOTH the dashboard "Tests" area (via the
// api → the synthwatch-sandbox ACA job) AND a monitors-repo PR check (same api, posts the trace as a comment).
// It NEVER writes a check, NEVER persists to the fleet, NEVER touches spec_cache — the only path to a real
// monitor stays the repo PR.
//
// Flow: STATIC GATE (compile through the single lib/flow alias — the same admission rule the merge/runtime
// path enforces) → execute the spec in a CHILD PROCESS under an ALLOWLIST env (no inherited secrets) with a
// HARD timeout → capture output → return. The infra layer (infra/main.bicep: a separate identity, secret-free
// env, no DB) is the authoritative boundary; the child-process allowlist here is defense-in-depth AND what
// makes the "no secret leaks" acceptance test runnable off-Azure.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileSpec } from '../specfetch/compileSpec.js';
import { buildSandboxEnv, type SandboxRunVars } from './sandboxEnv.js';

const CHILD_ENTRY = fileURLToPath(new URL('./sandboxChild.js', import.meta.url));

/** Bounds (mirrored by the ACA replicaTimeout + the api-side per-user rate/concurrency caps). */
export const SANDBOX_DEFAULT_TIMEOUT_MS = 120_000;

/** One recorded step of the preview flow — the RecordedStep shape, sans runId (a preview has no run). */
export interface PreviewStep {
  index: number;
  name: string;
  status: string;
  durationMs: number;
  errorMessage: string | null;
}

export interface PreviewResult {
  /** True iff the spec compiled, loaded, and the flow reported 'pass' within the timeout. */
  ok: boolean;
  /** The captured test names. */
  tests: string[];
  /** Everything the child wrote — INCLUDING the spec's own output. The isolation test asserts on this. */
  stdout: string;
  stderr: string;
  timedOut: boolean;
  exitCode: number | null;
  // ── B2: the REAL trace, produced by the SAME browserFlow.runTracedFlow a real check uses ──
  /** The flow verdict (undefined if the browser run never reported — e.g. compile/load failure). */
  status?: 'pass' | 'fail' | 'error';
  /** The flow error message (e.g. a selector-not-found), or null. */
  error?: string | null;
  /** The step that failed, or null. */
  failedStep?: string | null;
  /** Per-step name/status/timing (the run_steps shape). */
  steps?: PreviewStep[];
  /** trace_signals (extractTraceSignals output), or null if no trace was produced. */
  traceSignals?: unknown | null;
  /** The trace.zip bytes (read from the child's temp file), or null. The caller uploads them under the MI. */
  trace?: Buffer | null;
  /** The failure screenshot bytes, or null (pass runs have no failure screenshot). */
  screenshot?: Buffer | null;
}

/**
 * Preview-run an uploaded spec. `specSource` is untrusted; `vars.targetUrl` is a non-prod / public target.
 * Throws only if the STATIC GATE (compile) rejects the spec — that is the same "can this even be admitted?"
 * check the merge path applies. A spec that runs but misbehaves is reported in the result, not thrown.
 */
export async function runSandboxPreview(
  specSource: string,
  vars: Partial<SandboxRunVars> & { targetUrl: string },
): Promise<PreviewResult> {
  const runVars: SandboxRunVars = { targetUrl: vars.targetUrl, timeoutMs: vars.timeoutMs ?? SANDBOX_DEFAULT_TIMEOUT_MS };
  // ★ STATIC GATE: esbuild compiles ONLY through the single lib/flow alias — a spec importing arbitrary npm
  //   (a Postgres client, an exfil lib) fails to compile and never runs. Same admission rule as merge/runtime.
  const compiledJs = await compileSpec(specSource);

  const dir = await mkdtemp(join(tmpdir(), 'sw-sandbox-'));
  const specFile = join(dir, 'spec.compiled.mjs');
  try {
    await writeFile(specFile, compiledJs, 'utf8');
    return await runChild(specFile, runVars);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function runChild(specFile: string, vars: SandboxRunVars): Promise<PreviewResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    // ★ detached — the child leads its OWN process group, so the timeout kill reaps grandchildren too
    //   (a hostile spec that spawns a detached grandchild cannot outlive the budget by escaping its parent).
    const child = spawn(process.execPath, [CHILD_ENTRY, specFile], {
      env: buildSandboxEnv(vars), // ★ allowlist — the child NEVER inherits the parent's secrets
      cwd: tmpdir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    // ★ hard kill the whole process GROUP — a runaway/infinite spec (or a detached grandchild it spawned)
    //   cannot outlive the budget. `-pid` targets the group; fall back to the direct child if pid is unset.
    const hardKill = (): void => {
      if (typeof child.pid === 'number') {
        try {
          process.kill(-child.pid, 'SIGKILL');
          return;
        } catch {
          /* group already gone (ESRCH) or unsupported — fall through to the direct-child kill */
        }
      }
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      timedOut = true;
      hardKill();
    }, vars.timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    // ★ spawn failure (EMFILE/ENOMEM under load, a bad CHILD_ENTRY path) emits 'error' — WITHOUT this listener
    //   Node re-throws it as uncaught, 'close' never fires, and the promise (plus the temp dir) hangs forever.
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, tests: [], stdout, stderr: stderr + `sandbox spawn error: ${e.message}\n`, timedOut, exitCode: null });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // Read the child's report + its temp-file artifacts (before runSandboxPreview's finally rm's the dir).
      void (async () => {
        let tests: string[] = [];
        let reported = false;
        let status: PreviewResult['status'];
        let error: string | null = null;
        let failedStep: string | null = null;
        let steps: PreviewStep[] = [];
        let traceSignals: unknown | null = null;
        let trace: Buffer | null = null;
        let screenshot: Buffer | null = null;
        // The child's JSON report is its LAST stdout line; the spec's own output precedes it.
        const lastLine = stdout.trim().split('\n').pop() ?? '';
        try {
          const j = JSON.parse(lastLine) as {
            ok?: boolean; tests?: string[]; status?: PreviewResult['status']; error?: string | null;
            failedStep?: string | null; steps?: PreviewStep[]; traceSignals?: unknown | null;
            tracePath?: string | null; screenshotPath?: string | null;
          };
          reported = j.ok === true;
          tests = j.tests ?? [];
          status = j.status;
          error = j.error ?? null;
          failedStep = j.failedStep ?? null;
          steps = j.steps ?? [];
          traceSignals = j.traceSignals ?? null;
          // The child holds no blob creds — it wrote the trace/screenshot as temp files; the PARENT uploads.
          if (j.tracePath) trace = await readFile(j.tracePath).catch(() => null);
          if (j.screenshotPath) screenshot = await readFile(j.screenshotPath).catch(() => null);
        } catch {
          /* no valid report → ok stays false */
        }
        resolve({ ok: reported && !timedOut, tests, stdout, stderr, timedOut, exitCode: code, status, error, failedStep, steps, traceSignals, trace, screenshot });
      })();
    });
  });
}
