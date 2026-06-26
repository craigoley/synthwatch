// Phase 6b Option C — SLICE 1 (SPIKE) PROOF.
//
// Proves the recon inference: a monitors-repo spec runs UNMODIFIED via the runner shim +
// esbuild alias, producing the SAME run_steps + status classification as a native defineFlow.
// Offline + deterministic: a configurable FAKE page stands in for Playwright (the real
// Playwright integration already works in production executeBrowser; the spike's uncertainty is
// the shim/compile/classification wiring, which a fake page exercises faithfully). The live
// fetch+compile of the actual main spec is exercised separately (see the PR's validation).
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { StepRecorder, type RecordedStep } from '../stepRecorder.js';
import { isExpectationError, ExpectationError } from '../errors.js';
import { defineFlow } from '../checks/index.js';
import { compileAndLoad } from './compileSpec.js';
import { specToFlow, expect as shimExpect, recorderStore } from './specShim.js';

// The REAL repo spec, verbatim (synthwatch-monitors/monitors/synthwatch/dashboard-homepage.spec.ts).
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

// --- a recorder whose steps land in an array (real StepRecorder.step logic, no DB) ----------
function recordingRecorder(): { rec: StepRecorder; steps: RecordedStep[] } {
  const steps: RecordedStep[] = [];
  const rec = new StepRecorder(
    1,
    null as unknown as Page,
    'about:blank',
    async (s) => {
      steps.push(s); // terminal sink: collect the finalized step
    },
    async () => {}, // running marker: no-op (the live 'running' INSERT is DB-only; tests assert terminal steps)
  );
  return { rec, steps };
}

// --- a configurable fake Playwright page --------------------------------------------------
interface FakeOpts {
  visible?: boolean; // locator.waitFor (toBeVisible) succeeds?  (default true)
  urlOk?: boolean; // page.waitForURL (toHaveURL) succeeds?     (default true)
  gotoThrows?: boolean; // page.goto throws a non-assertion error?  (default false)
  gotoDelayMs?: number; // delay inside goto (for concurrency interleave)
}
function fakePage(opts: FakeOpts = {}): Page {
  const loc = {
    async waitFor() {
      if (opts.visible === false) throw new Error('locator timeout (not visible)');
    },
    first() {
      return loc;
    },
    async isVisible() {
      return false;
    },
    async click() {},
  };
  return {
    async goto() {
      if (opts.gotoDelayMs) await new Promise((r) => setTimeout(r, opts.gotoDelayMs));
      if (opts.gotoThrows) throw new Error('navigation crashed');
    },
    async waitForURL() {
      if (opts.urlOk === false) throw new Error('url timeout');
    },
    locator: () => loc,
    getByText: () => loc,
    getByRole: () => loc,
  } as unknown as Page;
}

const names = (s: RecordedStep[]) => s.map((x) => `${x.name}:${x.status}`);

// ===========================================================================================
// PROOF 1 — the real spec compiles, the esbuild alias resolves to the shim, test() is captured.
// ===========================================================================================
nodeTest('real repo spec compiles + alias resolves to shim + test() captured', async () => {
  const tests = await compileAndLoad(DASHBOARD_SPEC);
  assert.equal(tests.length, 1, 'exactly one captured test');
  assert.equal(tests[0].name, 'SynthWatch dashboard loads');
  assert.equal(typeof tests[0].fn, 'function');
});

// ★ Regression: the compiled_js is CACHED in Postgres and shared across machines (a Mac-mini
// warm + the Azure runners at /app). It must NOT bake any ABSOLUTE filesystem path — a
// machine path baked into the shim import is unresolvable on a different host ("Cannot find
// module '/Users/.../specShim.js'"). compileSpec emits a placeholder; loadCompiledSpec resolves
// it to THIS machine's shim at load time.
nodeTest('compiled spec is machine-independent (placeholder, no absolute fs path)', async () => {
  const { compileSpec } = await import('./compileSpec.js');
  const js = await compileSpec(DASHBOARD_SPEC, 'dashboard.spec.ts');
  assert.match(js, /from\s+"__SW_SPEC_SHIM__"/, 'shim import is the machine-independent placeholder');
  assert.ok(!js.includes('/Users/'), 'no dev absolute path baked in');
  assert.ok(!js.includes('/app/dist'), 'no container absolute path baked in');
  assert.ok(!/from\s+"file:\/\//.test(js), 'no absolute file:// URL baked into the cached output');
});

// ===========================================================================================
// PROOF 2 (a) — passing spec → run_steps + pass, MATCHING a native defineFlow equivalent.
// ===========================================================================================
nodeTest('(a) passing spec matches native run_steps + pass', async () => {
  // Fetched-via-shim path.
  const [t] = await compileAndLoad(DASHBOARD_SPEC);
  const { rec: r1, steps: fetched } = recordingRecorder();
  await specToFlow(t.fn, fakePage({ visible: true, urlOk: true }))(r1);

  // Native defineFlow equivalent (same two step names, same shape).
  const native = defineFlow(async ({ page, step }) => {
    await step('open the dashboard', async () => {
      await page.goto('about:blank');
    });
    await step('assert the monitor grid rendered', async () => {
      /* asserts pass */
    });
  });
  // defineFlow body reads page from rec.context(); give the recorder a fake page.
  const nat: RecordedStep[] = [];
  const r2WithPage = new StepRecorder(1, fakePage(), 'about:blank', async (s) => { nat.push(s); });
  await native(r2WithPage);

  assert.deepEqual(names(fetched), ['open the dashboard:pass', 'assert the monitor grid rendered:pass']);
  assert.deepEqual(names(nat), ['open the dashboard:pass', 'assert the monitor grid rendered:pass']);
  assert.deepEqual(names(fetched), names(nat), 'fetched-via-shim == native run_steps');
});

// ===========================================================================================
// PROOF 2 (b) — a failing ASSERTION → ExpectationError → 'fail' (NOT 'error'), like native.
// ===========================================================================================
nodeTest("(b) failing assertion classifies 'fail' (matches native expect)", async () => {
  const [t] = await compileAndLoad(DASHBOARD_SPEC);
  const { rec, steps } = recordingRecorder();
  // body never becomes visible -> assertLoaded/expect.toBeVisible throws ExpectationError.
  let thrown: unknown;
  try {
    await specToFlow(t.fn, fakePage({ visible: false, urlOk: true }))(rec);
  } catch (e) {
    thrown = e;
  }
  assert.ok(isExpectationError(thrown), 'shim assertion miss is an ExpectationError');
  const assertStep = steps.find((s) => s.name === 'assert the monitor grid rendered');
  assert.equal(assertStep?.status, 'fail', "assertion miss recorded as 'fail'");

  // Native equivalent: a defineFlow whose assert step uses expect(false,'msg') -> 'fail'.
  const native = defineFlow(async ({ page, step, expect }) => {
    await step('assert the monitor grid rendered', async () => {
      void page;
      expect(false, 'grid not visible');
    });
  });
  const natSteps: RecordedStep[] = [];
  const r2 = new StepRecorder(1, fakePage(), 'about:blank', async (s) => { natSteps.push(s); });
  await assert.rejects(() => native(r2));
  assert.equal(natSteps[0].status, 'fail', 'native assertion also fail');
});

// ===========================================================================================
// PROOF 2 (c) — a non-assertion throw → 'error' (NOT 'fail'), like native.
// ===========================================================================================
nodeTest("(c) non-assertion throw classifies 'error'", async () => {
  const [t] = await compileAndLoad(DASHBOARD_SPEC);
  const { rec, steps } = recordingRecorder();
  // goto throws a plain Error (a Playwright-style crash), not an ExpectationError.
  let thrown: unknown;
  try {
    await specToFlow(t.fn, fakePage({ gotoThrows: true }))(rec);
  } catch (e) {
    thrown = e;
  }
  assert.ok(!isExpectationError(thrown), 'a navigation crash is NOT an ExpectationError');
  const openStep = steps.find((s) => s.name === 'open the dashboard');
  assert.equal(openStep?.status, 'error', "non-assertion throw recorded as 'error'");
});

// ===========================================================================================
// PROOF 2 (d) — CONCURRENCY: ALS routes each spec's steps to its OWN recorder.
// ===========================================================================================
nodeTest('(d) concurrent specs: ALS isolates steps to the right recorder', async () => {
  const [t] = await compileAndLoad(DASHBOARD_SPEC);

  const { rec: rA, steps: stepsA } = recordingRecorder();
  const { rec: rB, steps: stepsB } = recordingRecorder();

  // Stagger goto delays so the two runs interleave across awaits (the case a module-global
  // "current recorder" would corrupt — ALS must keep them separate).
  const runA = specToFlow(t.fn, fakePage({ gotoDelayMs: 30, visible: true, urlOk: true }))(rA);
  const runB = specToFlow(t.fn, fakePage({ gotoDelayMs: 5, visible: true, urlOk: true }))(rB);
  await Promise.all([runA, runB]);

  // Each recorder must have EXACTLY its own two steps — no cross-contamination.
  assert.deepEqual(names(stepsA), ['open the dashboard:pass', 'assert the monitor grid rendered:pass']);
  assert.deepEqual(names(stepsB), ['open the dashboard:pass', 'assert the monitor grid rendered:pass']);
  assert.equal(stepsA.length, 2);
  assert.equal(stepsB.length, 2);
});

// ===========================================================================================
// PROOF 3 — mini-expect matcher classification (unit): a miss IS an ExpectationError.
// ===========================================================================================
nodeTest('mini-expect.toBeVisible miss throws ExpectationError (name-classified)', async () => {
  const notVisible = {
    async waitFor() {
      throw new Error('timeout');
    },
  } as unknown as import('playwright').Locator;
  let err: unknown;
  try {
    await shimExpect(notVisible).toBeVisible({ timeout: 10 });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof ExpectationError);
  assert.ok(isExpectationError(err), 'classifies as fail via name even across bundle realms');
});

// ===========================================================================================
// PROOF 4 — step() outside a recorder context is a clear harness error (not a silent misroute).
// ===========================================================================================
nodeTest('step() outside als.run throws a harness error', async () => {
  assert.equal(recorderStore.getStore(), undefined);
  const { step: shimStep } = await import('./specShim.js');
  await assert.rejects(() => shimStep('x', async () => {}), /outside a recorder context/);
});
