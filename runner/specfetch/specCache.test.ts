// Phase 6b Option C — SLICE 4 tests: the FALLBACK + FALSE-OUTAGE GUARD.
//
// ★★ The invariant under test: a fetch/compile FAILURE NEVER manufactures a monitor failure.
// Every degradation test asserts the SpecResolution is NOT a false-outage — either 'runnable'
// (the check runs the last-known-good → its real outcome) or 'infra-error' (a DISTINCT non-paging
// signal). It is NEVER a throw and NEVER something that routes to a monitor 'fail'/'error'.
// Offline + deterministic: fetcher/store/compile are injected; failure modes are mocked.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { StepRecorder, type RecordedStep } from '../stepRecorder.js';
import { loadCompiledSpec, compileSpec } from './compileSpec.js';
import { specToFlow } from './specShim.js';
import { assertValidSpecPath, type ConditionalFetch } from './fetchSpec.js';
import { specPathForSourceKey, type Monitor } from '../reconcile.js';
import {
  getCompiledSpec,
  probeSpec,
  sha256,
  type SpecResolution,
  type SpecCacheStore,
  type SpecCacheRow,
  type SpecCacheUpsert,
} from './specCache.js';

// The REAL repo spec, verbatim (proves a cached / last-good compiled_js still runs via the shim).
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

// --- in-memory SpecCacheStore mirroring the pg upsert (last_good <- the just-compiled output) ---
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

// Capture console.warn so we can assert each degradation is OBSERVABLE.
async function captureWarns<T>(fn: () => Promise<T>): Promise<{ result: T; warns: string[] }> {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => {
    warns.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' '));
  };
  try {
    const result = await fn();
    return { result, warns };
  } finally {
    console.warn = orig;
  }
}

const ok200 = (source: string, etag = '"v1"'): (() => Promise<ConditionalFetch>) =>
  async () => ({ kind: 'fetched', source, etag });
const throwsWith = (msg: string): (() => Promise<ConditionalFetch>) =>
  async () => {
    throw new Error(msg);
  };

// ★ The invariant guard: a degradation result is NEVER a false-outage.
function assertNotFalseOutage(res: SpecResolution): void {
  assert.ok(res.kind === 'runnable' || res.kind === 'infra-error', `unexpected kind ${JSON.stringify(res)}`);
  // 'runnable' => the check RUNS (real outcome); 'infra-error' => distinct non-paging signal.
  // Neither is a monitor 'fail'/'error', and getCompiledSpec never threw to get here.
}

// ===========================================================================================
// SLICE 2 — spec_path resolution + the shared path guard (regression).
// ===========================================================================================
const MONITORS: Monitor[] = [
  { id: 'wegmans-search-product', name: 'A', script: 'monitors/wegmans/search-product.spec.ts', kind: 'browser' },
  { id: 'synthwatch-self-homepage', name: 'B', script: 'monitors/synthwatch/dashboard-homepage.spec.ts', kind: 'browser' },
];

nodeTest('specPathForSourceKey resolves source_key -> manifest script path', () => {
  assert.equal(specPathForSourceKey(MONITORS, 'wegmans-search-product'), 'monitors/wegmans/search-product.spec.ts');
  assert.equal(specPathForSourceKey(MONITORS, 'not-a-monitor'), null);
});

nodeTest('spec path guard rejects traversal / non-monitors paths', () => {
  assert.doesNotThrow(() => assertValidSpecPath('monitors/wegmans/search-product.spec.ts'));
  assert.throws(() => assertValidSpecPath('monitors/../../../etc/passwd'), /invalid spec path/);
  assert.throws(() => assertValidSpecPath('flows/x.spec.ts'), /invalid spec path/);
});

// ===========================================================================================
// HAPPY PATHS (new SpecResolution shape) — no regression from #103.
// ===========================================================================================
nodeTest('200: compiles once, upserts, populates last_good, kind runnable/compiled-200', async () => {
  const store = memStore();
  let compiles = 0;
  const res = await getCompiledSpec('monitors/x.spec.ts', {
    store,
    fetcher: ok200('SRC', '"abc"'),
    compile: async (s) => {
      compiles++;
      return `COMPILED(${s})`;
    },
    hash: () => 'sha-of-src',
  });
  assert.ok(res.kind === 'runnable' && res.origin === 'compiled-200' && res.compiledJs === 'COMPILED(SRC)');
  assert.equal(compiles, 1);
  assert.equal(store.rows.get('monitors/x.spec.ts')!.last_good_compiled_js, 'COMPILED(SRC)');
});

nodeTest('304 + cache: reuses compiled_js, sends cached etag, no recompile/upsert', async () => {
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
  assert.ok(res.kind === 'runnable' && res.origin === 'cache-304' && res.compiledJs === 'CACHED_JS');
  assert.equal(compiles, 0);
  assert.equal(etagSent, '"abc"');
  assert.equal(store.upserts.length, 0);
});

nodeTest('304 + NO cache row (etag desync): forces a full fetch (cache-miss), warns', async () => {
  const store = memStore(); // empty
  let calls = 0;
  const { result, warns } = await captureWarns(() =>
    getCompiledSpec('monitors/x.spec.ts', {
      store,
      // first call returns 304, forcing the unconditional re-fetch which 200s.
      fetcher: async () => {
        calls++;
        return calls === 1 ? { kind: 'unchanged' } : { kind: 'fetched', source: 'SRC', etag: '"new"' };
      },
      compile: async (s) => `C(${s})`,
      hash: () => 'h',
    }),
  );
  assert.ok(result.kind === 'runnable' && result.origin === 'compiled-200');
  assert.equal(calls, 2, 'forced a second unconditional fetch');
  assert.ok(warns.some((w) => /etag desync/.test(w)));
});

// ===========================================================================================
// ★★ DEGRADATION MATRIX — each proves NO false-outage.
// ===========================================================================================
const LAST_GOOD = 'LAST_GOOD_JS';
const withLastGood = (): ReturnType<typeof memStore> =>
  memStore({
    spec_path: 'monitors/x.spec.ts',
    etag: '"old"',
    compiled_js: LAST_GOOD,
    last_good_compiled_js: LAST_GOOD,
    last_good_at: new Date('2026-06-01T00:00:00Z'),
  });

for (const [label, fetcher] of [
  ['network error (connection refused)', throwsWith('connect ECONNREFUSED 140.82.0.1:443')],
  ['5xx from raw.githubusercontent', throwsWith('spec fetch failed: 503 Service Unavailable')],
  ['timeout', throwsWith('The operation was aborted due to timeout')],
] as const) {
  nodeTest(`degrade: ${label} + last_good -> runs LAST-GOOD, NOT a fail, warns`, async () => {
    const store = withLastGood();
    const { result, warns } = await captureWarns(() =>
      getCompiledSpec('monitors/x.spec.ts', { store, fetcher, compile: compileSpec, hash: sha256 }),
    );
    assertNotFalseOutage(result);
    assert.ok(result.kind === 'runnable', 'fell back, did not fail the monitor');
    assert.ok(result.kind === 'runnable' && result.origin === 'fallback-last-good');
    assert.ok(result.kind === 'runnable' && result.compiledJs === LAST_GOOD, 'ran the last-known-good');
    assert.equal(store.upserts.length, 0, 'no cache write on a failed fetch');
    assert.ok(warns.some((w) => /DEGRADED/.test(w) && /Monitor NOT failed/.test(w)), 'WARN observability');
  });
}

nodeTest('degrade: 200 but COMPILE fails + last_good -> runs LAST-GOOD (not the broken spec), warns', async () => {
  const store = withLastGood();
  const { result, warns } = await captureWarns(() =>
    getCompiledSpec('monitors/x.spec.ts', {
      store,
      fetcher: ok200('this is not valid typescript {{{', '"v2"'),
      compile: async () => {
        throw new Error('esbuild: Unexpected "{"');
      },
      hash: sha256,
    }),
  );
  assertNotFalseOutage(result);
  assert.ok(result.kind === 'runnable' && result.origin === 'fallback-last-good');
  assert.ok(result.kind === 'runnable' && result.compiledJs === LAST_GOOD, 'ran last-good, NOT the broken spec');
  assert.equal(store.upserts.length, 0, 'a broken compile is NOT cached');
  assert.ok(warns.some((w) => /compile failed/.test(w)));
});

// ★ THE NIGHTMARE: fetch fails AND no last_good (brand-new spec, first run, GitHub down).
nodeTest('★ nightmare: fetch fails + NO last_good -> DISTINCT infra-error (NOT fail/error/throw)', async () => {
  const store = memStore(); // no row at all -> no last_good
  const { result, warns } = await captureWarns(() =>
    getCompiledSpec('monitors/brand-new.spec.ts', {
      store,
      fetcher: throwsWith('getaddrinfo ENOTFOUND raw.githubusercontent.com'),
      compile: compileSpec,
      hash: sha256,
    }),
  );
  assertNotFalseOutage(result);
  assert.equal(result.kind, 'infra-error', 'a distinct signal, not runnable');
  assert.ok(result.kind === 'infra-error' && /ENOTFOUND/.test(result.reason));
  assert.ok(warns.some((w) => /INFRA-ERROR/.test(w) && /MUST NOT page/.test(w)), 'WARN says it must not page');
});

nodeTest('nightmare variant: 200 + compile fails + NO last_good -> infra-error (no broken run)', async () => {
  const store = memStore();
  const res = await getCompiledSpec('monitors/brand-new.spec.ts', {
    store,
    fetcher: ok200('broken {{{'),
    compile: async () => {
      throw new Error('esbuild parse error');
    },
    hash: sha256,
  });
  assert.equal(res.kind, 'infra-error');
  assert.equal(store.upserts.length, 0);
});

// ===========================================================================================
// PARITY — the degraded LAST-GOOD compiled_js still runs via #101's shim with a NORMAL outcome
// (proves the degraded path yields a real monitor result, not a synthetic failure).
// ===========================================================================================
nodeTest('degraded last-good runs via the shim -> normal pass (real outcome, not a false fail)', async () => {
  const realCompiled = await compileSpec(DASHBOARD_SPEC, 'dashboard-homepage.spec.ts');
  const store = memStore({
    spec_path: 'monitors/synthwatch/dashboard-homepage.spec.ts',
    etag: '"old"',
    compiled_js: realCompiled,
    last_good_compiled_js: realCompiled,
    last_good_at: new Date('2026-06-01T00:00:00Z'),
  });

  const res = await getCompiledSpec('monitors/synthwatch/dashboard-homepage.spec.ts', {
    store,
    fetcher: throwsWith('503 Service Unavailable'), // GitHub down -> must degrade
    compile: compileSpec,
    hash: sha256,
  });
  assert.ok(res.kind === 'runnable' && res.origin === 'fallback-last-good');

  // The degraded spec RUNS and produces a normal pass — not a false failure.
  const [t] = await loadCompiledSpec(res.compiledJs);
  const steps: RecordedStep[] = [];
  const rec = new StepRecorder(
    1,
    null as unknown as Page,
    'about:blank',
    async (s) => {
      steps.push(s);
    },
    async () => {}, // running marker: no-op (keep this unit test off the real DB pool)
  );
  await specToFlow(t.fn, fakePage())(rec);
  assert.deepEqual(
    steps.map((s) => `${s.name}:${s.status}`),
    ['open the dashboard:pass', 'assert the monitor grid rendered:pass'],
  );
});

// ===========================================================================================
// SLICE 6 — probeSpec: orphan-detection (fetchable+compilable?) that ALSO warms the cache.
// Unlike getCompiledSpec (runtime), the probe REPORTS failures (404/won't-compile) instead of
// falling back to last-good — it answers "is the Git spec runnable from main right now?".
// ===========================================================================================
nodeTest('probeSpec: 200 + compiles -> runnable + WARMS the cache (upsert)', async () => {
  const store = memStore();
  const res = await probeSpec('monitors/x.spec.ts', {
    store,
    fetcher: ok200('SRC', '"v1"'),
    compile: async (s) => `C(${s})`,
    hash: () => 'sha',
  });
  assert.deepEqual(res, { runnable: true });
  assert.equal(store.upserts.length, 1, 'a runnable probe warms the cache');
  assert.equal(store.rows.get('monitors/x.spec.ts')!.last_good_compiled_js, 'C(SRC)');
});

nodeTest('probeSpec: a 404 / fetch failure -> NOT runnable (reason: not fetchable), no warm', async () => {
  const store = memStore();
  const res = await probeSpec('monitors/missing.spec.ts', {
    store,
    fetcher: throwsWith('spec fetch failed: 404 Not Found (…/missing.spec.ts)'),
    compile: compileSpec,
    hash: sha256,
  });
  assert.equal(res.runnable, false);
  assert.match(res.reason!, /not fetchable/);
  assert.match(res.reason!, /404/);
  assert.equal(store.upserts.length, 0, 'a 404 does not warm');
});

nodeTest("probeSpec: 200 but won't compile -> NOT runnable (reason: won't compile), no warm", async () => {
  const store = memStore();
  const res = await probeSpec('monitors/broken.spec.ts', {
    store,
    fetcher: ok200('not valid typescript {{{'),
    compile: async () => {
      throw new Error('esbuild: Unexpected "{"');
    },
    hash: sha256,
  });
  assert.equal(res.runnable, false);
  assert.match(res.reason!, /won't compile/);
  assert.equal(store.upserts.length, 0, 'a broken spec is not cached');
});

nodeTest('probeSpec: 304 with an existing cache row -> runnable (already compiled), no upsert', async () => {
  const store = memStore({ spec_path: 'monitors/x.spec.ts', etag: '"v1"', compiled_js: 'CACHED' });
  const res = await probeSpec('monitors/x.spec.ts', {
    store,
    fetcher: async () => ({ kind: 'unchanged' }),
    compile: compileSpec,
    hash: sha256,
  });
  assert.deepEqual(res, { runnable: true });
  assert.equal(store.upserts.length, 0);
});

// The REAL repo specs (verbatim) compile through esbuild -> runnable. Proves the 3 manifest
// specs flip to NOT-orphan (the live reconcile run confirms it against actual main).
nodeTest('★ slice 6: the real dashboard spec probes as RUNNABLE (compiles via esbuild)', async () => {
  const store = memStore();
  const res = await probeSpec('monitors/synthwatch/dashboard-homepage.spec.ts', {
    store,
    fetcher: ok200(DASHBOARD_SPEC, '"v1"'),
    compile: compileSpec,
    hash: sha256,
  });
  assert.deepEqual(res, { runnable: true }, 'a real, valid spec is runnable -> not orphan');
  assert.equal(store.upserts.length, 1, 'and it warmed the cache');
});
