// Spawned by runSandboxPreview with an ALLOWLIST env (sandboxEnv.buildSandboxEnv). EVERYTHING here runs with
// NO prod secrets in process.env, NO DATABASE_URL to reach a DB, and the sandbox identity's (nil) privileges.
//
// It loads + executes the uploaded compiled spec — the RCE moment (compileSpec.ts:loadCompiledSpec's import())
// happens HERE, in this isolated child, not in the parent runner. It then drains the captured tests and prints
// a single JSON result line. The spec's OWN output (e.g. a hostile `console.log(process.env)`) also lands on
// this child's stdout, which the parent captures — that is exactly what the isolation acceptance test asserts.
//
// ★ SEAM (tier-1 real trace, not built pass-1): a real preview runs each captured test via specToFlow with a
//   Playwright page against SW_SANDBOX_TARGET_URL and captures the SAME trace shape a real check produces
//   (steps, timings, screenshots, trace_signals). The isolation proof only needs the spec's code to execute
//   here under this env, so pass-1 reports the loaded tests + honest "trace: seam" and stops before the browser.
import { readFileSync } from 'node:fs';

import { loadCompiledSpec } from '../specfetch/compileSpec.js';

async function main(): Promise<void> {
  const compiledPath = process.argv[2];
  if (!compiledPath) {
    process.stderr.write('sandboxChild: missing compiled-spec path arg\n');
    process.exit(2);
  }
  const compiledJs = readFileSync(compiledPath, 'utf8');
  // ★ THE RCE MOMENT — arbitrary uploaded code executes on this import. It is contained by: (1) this process's
  //   allowlist env (no secrets), (2) no DATABASE_URL/DB reachability, (3) the sandbox ACA identity's nil RBAC.
  const tests = await loadCompiledSpec(compiledJs);
  process.stdout.write(JSON.stringify({ ok: true, tests: tests.map((t) => t.name), trace: 'seam' }) + '\n');
}

main().catch((e) => {
  process.stderr.write(`sandboxChild: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
