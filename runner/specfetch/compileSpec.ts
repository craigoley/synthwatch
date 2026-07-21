// Phase 6b Option C — runtime compile of a fetched .spec.ts.
//
// esbuild transforms the TypeScript spec to a JS ESM module string, ALIASING the spec's
// `lib/flow` import to the runner's shim (specShim.js) and marking it EXTERNAL so the output
// imports the real shim module at runtime (the SAME instance the runner uses → shared test
// registry + ALS). `playwright` is external too (image-provided).
//
// ★ MACHINE-INDEPENDENT OUTPUT (the spec_cache portability fix): the compiled JS is CACHED in
// Postgres and SHARED across machines (the Mac mini that warms the cache, and the Azure runners
// at /app). Baking the COMPILING machine's absolute specShim path into the output (the old
// `new URL('./specShim.js', import.meta.url)` alias) produced JS that only resolves on THAT
// machine — a cache warmed locally imported `/Users/.../runner/dist/specfetch/specShim.js`,
// which does not exist in the Azure container → every Option C run errored with "Cannot find
// module". So compileSpec emits a STABLE PLACEHOLDER, and loadCompiledSpec substitutes the
// EXECUTING machine's real shim URL at load time. The cached JS is portable; each runner
// resolves the shim against ITS OWN install path.
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drainCapturedTests, type CapturedTest } from './specShim.js';

// A machine-independent sentinel emitted into compiled_js in place of the shim's absolute path;
// loadCompiledSpec replaces it with the executing machine's specShim.js URL at load time.
const SHIM_PLACEHOLDER = '__SW_SPEC_SHIM__';

// The EXECUTING machine's compiled shim (dist/specfetch/specShim.js next to THIS module).
// Resolved per-process, so it's correct on whatever host runs the spec (Azure /app, dev /Users).
const SHIM_URL = new URL('./specShim.js', import.meta.url).href;

/** Match the spec's `'../../lib/flow'` (or any `…/lib/flow`) import. */
const LIB_FLOW_RE = /(^|\/)lib\/flow$/;

/**
 * ★ `@playwright/test` resolves to the SAME shim as lib/flow.
 *
 * WHY THIS EXISTS. Every spec in synthwatch-monitors imports `'../../lib/flow'`, so the alias above was
 * the only form that had ever been compiled — by EITHER path. The Tests area, though, invites an operator
 * to paste an ORDINARY Playwright spec, and those open with
 * `import { test, expect, type Page } from '@playwright/test'`. Nothing handled that name: `external:
 * ['playwright']` below is a DIFFERENT package, and `resolveDir` is the OS temp dir (no node_modules), so
 * esbuild failed with `Could not resolve "@playwright/test"` and the preview never ran. That was not a
 * sandbox-vs-production divergence — both paths call THIS function — it was a form this compiler had never
 * supported. (The one monitor that mentions the package does so in a type position,
 * `import('@playwright/test').Request`, which the ts loader ERASES — hence prod was never affected.)
 *
 * ★ ALIASED TO THE SHIM, NOT MARKED EXTERNAL. Making it external would let the child load the real
 * Playwright test runner, which bypasses the shim entirely: no step recording, no captured-test registry,
 * none of the platform's instrumentation. The preview would then execute under different semantics than
 * production — a preview that lies. Routing it to the shim means a pasted spec gets the SAME instrumented
 * `test`/`expect` a real monitor gets.
 *
 * ★ CAVEAT worth knowing: the shim implements `SUPPORTED_MATCHERS`, not all of Playwright's. A pasted spec
 * using an exotic matcher compiles and then fails at RUNTIME with the shim's own message. That is the
 * honest failure — better than silently running uninstrumented.
 */
const PLAYWRIGHT_TEST_RE = /^@playwright\/test$/;

/**
 * Compile a fetched spec's TypeScript source to a JS ESM module string. The lib/flow import is
 * rewritten to a machine-independent placeholder (resolved to the real shim at load time), so
 * the output is safe to cache + share across machines.
 */
export async function compileSpec(source: string, sourcefile = 'monitor.spec.ts'): Promise<string> {
  const result = await build({
    stdin: { contents: source, sourcefile, loader: 'ts', resolveDir: tmpdir() },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    write: false,
    external: ['playwright'],
    plugins: [
      {
        name: 'specfetch-libflow-alias',
        // External + the placeholder path (NOT the absolute SHIM_URL) -> the output imports
        // from "__SW_SPEC_SHIM__"; loadCompiledSpec swaps it for the local shim at load time.
        setup(b) {
          b.onResolve({ filter: LIB_FLOW_RE }, () => ({ path: SHIM_PLACEHOLDER, external: true }));
          // Same target, same placeholder — one shim, so a pasted Playwright spec and a real monitor spec
          // run under identical instrumentation. See PLAYWRIGHT_TEST_RE for why this is not `external`.
          b.onResolve({ filter: PLAYWRIGHT_TEST_RE }, () => ({ path: SHIM_PLACEHOLDER, external: true }));
        },
      },
    ],
  });
  return result.outputFiles[0].text;
}

/**
 * Load a compiled spec module and return its captured tests. Substitutes the shim placeholder
 * with THIS machine's specShim.js URL (so cross-machine-cached JS resolves locally), writes the
 * JS to a temp .mjs, dynamic-imports it (which runs the spec's top-level test() calls → the
 * shared shim registry), then drains the registry. Caller runs the returned fn via specToFlow.
 */
export async function loadCompiledSpec(compiledJs: string): Promise<CapturedTest[]> {
  const resolved = compiledJs.replaceAll(SHIM_PLACEHOLDER, SHIM_URL);
  const dir = await mkdtemp(join(tmpdir(), 'sw-specfetch-'));
  const file = join(dir, 'spec.mjs');
  try {
    await writeFile(file, resolved, 'utf8');
    // ★ SECURITY BOUNDARY — this import() EXECUTES esbuild-compiled spec JS AT RUNNER PRIVILEGE, so a
    //   spec_cache write == RCE as the runner. What defends it: spec_cache is write-locked to the runner
    //   (0041 revokes the API role's write); the source is a pinned, traversal-guarded fetch from
    //   synthwatch-monitors; and that repo's MERGE GATE is the admission control (a spec compiles only
    //   through the single lib/flow alias — no arbitrary import). See SECURITY.md. Do NOT widen this.
    await import(pathToFileURL(file).href); // triggers test() capture in the shared shim
    return drainCapturedTests();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Convenience: compile + load in one call. */
export async function compileAndLoad(source: string, sourcefile?: string): Promise<CapturedTest[]> {
  return loadCompiledSpec(await compileSpec(source, sourcefile));
}
