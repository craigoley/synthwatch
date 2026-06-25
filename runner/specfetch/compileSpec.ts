// Phase 6b Option C — SLICE 1 (SPIKE). Runtime compile of a fetched .spec.ts.
//
// esbuild transforms the TypeScript spec to a JS ESM module string, ALIASING the spec's
// `lib/flow` import to the runner's shim (specShim.js) and marking it EXTERNAL so the output
// imports the real shim module at runtime (the SAME instance the runner uses → shared test
// registry + ALS). `playwright` is external too (image-provided). ★ The alias resolving to the
// shim is the key uncertainty the spike must prove; loadCompiledSpec exercises it end to end.
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drainCapturedTests, type CapturedTest } from './specShim.js';

// Absolute path to the COMPILED shim (dist/specfetch/specShim.js at runtime). The compiled
// spec will `import { ... } from "<file://this>"`.
const SHIM_URL = new URL('./specShim.js', import.meta.url).href;

/** Match the spec's `'../../lib/flow'` (or any `…/lib/flow`) import. */
const LIB_FLOW_RE = /(^|\/)lib\/flow$/;

/**
 * Compile a fetched spec's TypeScript source to a JS ESM module string. The lib/flow import is
 * rewritten to the runner shim (external, so it loads the shared instance at runtime).
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
        setup(b) {
          b.onResolve({ filter: LIB_FLOW_RE }, () => ({ path: SHIM_URL, external: true }));
        },
      },
    ],
  });
  return result.outputFiles[0].text;
}

/**
 * Load a compiled spec module and return its captured tests. Writes the JS to a temp .mjs and
 * dynamic-imports it (which runs the spec's top-level test() calls → the shim registry), then
 * drains the registry. Caller runs the returned fn via specToFlow.
 */
export async function loadCompiledSpec(compiledJs: string): Promise<CapturedTest[]> {
  const dir = await mkdtemp(join(tmpdir(), 'sw-specfetch-'));
  const file = join(dir, 'spec.mjs');
  try {
    await writeFile(file, compiledJs, 'utf8');
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
