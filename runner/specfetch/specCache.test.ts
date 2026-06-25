// Phase 6b Option C — SLICES 2+3 tests. spec_path resolution + the spec_cache happy path
// (conditional GET / 304-reuse / 200-recompile + last_good), parity preserved via #101's shim,
// and the slice-4 error SEAM (a fetch failure propagates — no fallback yet). Offline: the
// fetcher/store/compile are injected, so no live GitHub or DB. (The real pg upsert's last_good
// SQL is proven separately against the live DB in the PR's validation.)
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { StepRecorder, type RecordedStep } from '../stepRecorder.js';
import { loadCompiledSpec, compileSpec } from './compileSpec.js';
import { specToFlow } from './specShim.js';
import { assertValidSpecPath } from './fetchSpec.js';
import { specPathForSourceKey, type Monitor } from '../reconcile.js';
import {
  getCompiledSpec,
  sha256,
  type SpecCacheStore,
  type SpecCacheRow,
  type SpecCacheUpsert,
} from './specCache.js';

// The REAL repo spec, verbatim (used to prove cached compiled_js still runs via the shim).
const DASHBOARD_SPEC = `
import { test, expect, step, assertLoaded } from '../../lib/flow';
test('SynthWatch dashboard loads', async ({ page }) => {
  await step('open the dashboard', async () => {
    await page.goto('https://synthwatch-dashboard.vercel.app', { waitUntil: 'domcontentloaded' });
  });
  await step('assert the monitor grid rendered', async () => {
    await assertLoaded(page, { urlPattern: /synthwatch-dashboard\\.vercel\\.app/i, timeoutMs: 15000 });
    await expect(page.locator('body')).toBeVisible({ timeout: 15000 });
  });
});
`;

// --- an in-memory SpecCacheStore that mirrors the pg upsert semantics (last_good <- compile) ---
function memStore(seed?: { spec_path: string } & Partial<SpecCacheRow>): SpecCacheStore & {
  rows: Map<string, SpecCacheRow>;
  upserts: SpecCacheUpsert[];
} {
  const rows = new Map<string, SpecCacheRow>();
  if (seed) {
    rows.set(seed.spec_path, {
      spec_path: seed.spec_path,
      etag: seed.etag ?? null,
      source_sha: seed.source_sha ?? null,
      compiled_js: seed.compiled_js ?? '',
      fetched_at: seed.fetched_at ?? new Date(0),
      last_good_compiled_js: seed.last_good_compiled_js ?? null,
      last_good_at: seed.last_good_at ?? null,
    });
  }
  const upserts: SpecCacheUpsert[] = [];
  return {
    rows,
    upserts,
    async read(p) {
      return rows.get(p) ?? null;
    },
    async upsert(row) {
      upserts.push(row);
      const now = new Date();
      // Mirror 0034's ON CONFLICT: every successful compile is the new known-good.
      rows.set(row.spec_path, {
        spec_path: row.spec_path,
        etag: row.etag,
        source_sha: row.source_sha,
        compiled_js: row.compiled_js,
        fetched_at: now,
        last_good_compiled_js: row.compiled_js,
        last_good_at: now,
      });
    },
  };
}

function fakePage(): Page {
  const loc = { async waitFor() {}, first() { return loc; }, async isVisible() { return false; }, async click() {} };
  return {
    async goto() {},
    async waitForURL() {},
    locator: () => loc,
    getByText: () => loc,
    getByRole: () => loc,
  } as unknown as Page;
}

// ===========================================================================================
// SLICE 2 — spec_path resolution + the shared path guard.
// ===========================================================================================
const MONITORS: Monitor[] = [
  { id: 'wegmans-search-product', name: 'A', script: 'monitors/wegmans/search-product.spec.ts', kind: 'browser' },
  { id: 'synthwatch-self-homepage', name: 'B', script: 'monitors/synthwatch/dashboard-homepage.spec.ts', kind: 'browser' },
];

nodeTest('specPathForSourceKey resolves source_key -> manifest script path', () => {
  assert.equal(specPathForSourceKey(MONITORS, 'wegmans-search-product'), 'monitors/wegmans/search-product.spec.ts');
  assert.equal(specPathForSourceKey(MONITORS, 'synthwatch-self-homepage'), 'monitors/synthwatch/dashboard-homepage.spec.ts');
});

nodeTest('specPathForSourceKey returns null for an unknown source_key', () => {
  assert.equal(specPathForSourceKey(MONITORS, 'not-a-monitor'), null);
});

nodeTest('spec path guard rejects traversal / non-monitors paths (reused from #101)', () => {
  assert.doesNotThrow(() => assertValidSpecPath('monitors/wegmans/search-product.spec.ts'));
  assert.throws(() => assertValidSpecPath('monitors/../../../etc/passwd'), /invalid spec path/);
  assert.throws(() => assertValidSpecPath('flows/x.spec.ts'), /invalid spec path/);
  assert.throws(() => assertValidSpecPath('monitors/x.ts'), /invalid spec path/);
});

// ===========================================================================================
// SLICE 3 — the cache flow.
// ===========================================================================================
nodeTest('200: compiles once, upserts {etag,source_sha,compiled_js}, populates last_good_*', async () => {
  const store = memStore();
  let compiles = 0;
  const res = await getCompiledSpec('monitors/x.spec.ts', {
    store,
    fetcher: async () => ({ kind: 'fetched', source: 'SRC', etag: '"abc"' }),
    compile: async (s) => {
      compiles++;
      return `COMPILED(${s})`;
    },
    hash: () => 'sha-of-src',
  });

  assert.equal(res.origin, 'compiled-200');
  assert.equal(res.compiledJs, 'COMPILED(SRC)');
  assert.equal(compiles, 1);
  assert.equal(store.upserts.length, 1);
  assert.deepEqual(store.upserts[0], {
    spec_path: 'monitors/x.spec.ts',
    etag: '"abc"',
    source_sha: 'sha-of-src',
    compiled_js: 'COMPILED(SRC)',
  });
  // ★ slice-4 prerequisite: last_good_* is populated by a successful compile.
  const row = store.rows.get('monitors/x.spec.ts')!;
  assert.equal(row.last_good_compiled_js, 'COMPILED(SRC)', 'last_good populated for slice 4 fallback');
  assert.ok(row.last_good_at instanceof Date);
});

nodeTest('304: reuses cached compiled_js, sends the cached etag, NO recompile, NO upsert', async () => {
  const store = memStore({ spec_path: 'monitors/x.spec.ts', etag: '"abc"', compiled_js: 'CACHED_JS' });
  let compiles = 0;
  let etagSent: string | null | undefined;
  const res = await getCompiledSpec('monitors/x.spec.ts', {
    store,
    fetcher: async (_p, etag) => {
      etagSent = etag;
      return { kind: 'unchanged' };
    },
    compile: async () => {
      compiles++;
      return 'X';
    },
    hash: () => 'h',
  });

  assert.equal(res.origin, 'cache-304');
  assert.equal(res.compiledJs, 'CACHED_JS');
  assert.equal(compiles, 0, 'no recompile on 304');
  assert.equal(etagSent, '"abc"', 'conditional GET carried the cached etag (If-None-Match)');
  assert.equal(store.upserts.length, 0, 'no upsert on 304');
});

nodeTest('304 with no cached row throws (etag desync — should not happen)', async () => {
  const store = memStore();
  await assert.rejects(
    () =>
      getCompiledSpec('monitors/x.spec.ts', {
        store,
        fetcher: async () => ({ kind: 'unchanged' }),
        compile: async () => 'x',
        hash: () => 'h',
      }),
    /no cached row/,
  );
});

nodeTest('★ fetch error PROPAGATES (the slice-4 seam — no fallback yet)', async () => {
  // A cached last-good EXISTS, but slice 3 must NOT use it — that graceful degradation is
  // slice 4's job, added deliberately with its own tests. Slice 3 propagates.
  const store = memStore({
    spec_path: 'monitors/x.spec.ts',
    compiled_js: 'CACHED_JS',
    last_good_compiled_js: 'CACHED_JS',
  });
  await assert.rejects(
    () =>
      getCompiledSpec('monitors/x.spec.ts', {
        store,
        fetcher: async () => {
          throw new Error('github 503 Service Unavailable');
        },
        compile: async () => 'x',
        hash: () => 'h',
      }),
    /github 503/,
  );
  assert.equal(store.upserts.length, 0, 'nothing written on a fetch failure');
});

// ===========================================================================================
// PARITY — the cached compiled_js (reused on 304) still runs via #101's shim with identical
// run_steps. This proves the cache preserves the slice-1 execution contract.
// ===========================================================================================
nodeTest('cached compiled_js (304 reuse) runs via the shim with the same run_steps', async () => {
  const store = memStore();
  // 200: real fetch+compile populates the cache with real compiled_js.
  const first = await getCompiledSpec('monitors/synthwatch/dashboard-homepage.spec.ts', {
    store,
    fetcher: async () => ({ kind: 'fetched', source: DASHBOARD_SPEC, etag: '"v1"' }),
    compile: compileSpec,
    hash: sha256,
  });
  assert.equal(first.origin, 'compiled-200');

  // 304: reuse the cached compiled_js (no recompile).
  const second = await getCompiledSpec('monitors/synthwatch/dashboard-homepage.spec.ts', {
    store,
    fetcher: async () => ({ kind: 'unchanged' }),
    compile: compileSpec,
    hash: sha256,
  });
  assert.equal(second.origin, 'cache-304');
  assert.equal(second.compiledJs, first.compiledJs, 'cache returns the same compiled output');

  // Run the cached compiled_js through the shim — identical run_steps to slice 1.
  const [t] = await loadCompiledSpec(second.compiledJs);
  assert.equal(t.name, 'SynthWatch dashboard loads');
  const steps: RecordedStep[] = [];
  const rec = new StepRecorder(1, null as unknown as Page, 'about:blank', async (s) => {
    steps.push(s);
  });
  await specToFlow(t.fn, fakePage())(rec);
  assert.deepEqual(
    steps.map((s) => `${s.name}:${s.status}`),
    ['open the dashboard:pass', 'assert the monitor grid rendered:pass'],
  );
});
