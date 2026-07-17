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
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileSpec } from '../specfetch/compileSpec.js';
import { buildSandboxEnv, type SandboxRunVars } from './sandboxEnv.js';

const CHILD_ENTRY = fileURLToPath(new URL('./sandboxChild.js', import.meta.url));

/** Bounds (mirrored by the ACA replicaTimeout + the api-side per-user rate/concurrency caps). */
export const SANDBOX_DEFAULT_TIMEOUT_MS = 120_000;

export interface PreviewResult {
  /** True iff the spec compiled, loaded, and reported within the timeout. */
  ok: boolean;
  /** The captured test names (a real preview also returns the trace — see sandboxChild's seam). */
  tests: string[];
  /** Everything the child wrote — INCLUDING the spec's own output. The isolation test asserts on this. */
  stdout: string;
  stderr: string;
  timedOut: boolean;
  exitCode: number | null;
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
    const child = spawn(process.execPath, [CHILD_ENTRY, specFile], {
      env: buildSandboxEnv(vars), // ★ allowlist — the child NEVER inherits the parent's secrets
      cwd: tmpdir(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL'); // ★ hard kill — a runaway/infinite spec cannot outlive the budget
    }, vars.timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let tests: string[] = [];
      let reported = false;
      // The child's JSON report is its LAST stdout line; the spec's own output precedes it.
      const lastLine = stdout.trim().split('\n').pop() ?? '';
      try {
        const j = JSON.parse(lastLine) as { ok?: boolean; tests?: string[] };
        reported = j.ok === true;
        tests = j.tests ?? [];
      } catch {
        /* no valid report → ok stays false */
      }
      resolve({ ok: reported && !timedOut, tests, stdout, stderr, timedOut, exitCode: code });
    });
  });
}
