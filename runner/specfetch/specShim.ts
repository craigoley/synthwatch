// Phase 6b Option C — SLICE 1 (SPIKE). The runner-side `lib/flow` SHIM.
//
// The monitors-repo specs import `{ test, expect, step, assertLoaded, dismissInterstitials }`
// from '../../lib/flow' and are written for Playwright's test-runner. The runner has no
// test-runner — it drives Playwright directly via StepRecorder. The design inference (recon)
// was: the runner can ship its OWN lib/flow and esbuild-ALIAS the spec's import to it, so the
// SAME spec runs UNMODIFIED. This module is that shim; the spike proves the inference.
//
// How each symbol is provided WITHOUT a test-runner:
//   test(name, fn) — CAPTURE: the spec calls test() at import-eval; we record {name, fn} in a
//                    module registry. The runner imports the compiled spec, then drains the
//                    registry and runs the captured fn with ITS page (specToFlow).
//   step(name,body)— routes to the ACTIVE StepRecorder via AsyncLocalStorage (NOT a module
//                    global — the runner may run checks concurrently; ALS scopes per-run).
//   expect(x)      — a MINI-matcher shim implementing only the matchers the real specs use
//                    (toBeVisible, toHaveURL). A matcher MISS throws ExpectationError so the
//                    runner's existing isExpectationError => 'fail' classification works
//                    unchanged; a raw Playwright timeout (a non-assertion throw) stays 'error'.
//   assertLoaded / dismissInterstitials — vendored VERBATIM from the repo's lib/flow.ts (pure;
//                    take page + expect).
//
// ★ SCOPE: spike only. Not wired into the live executeBrowser path (no cache/fallback yet).
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Page, Locator } from 'playwright';
import type { StepRecorder } from '../stepRecorder.js';
import type { Flow } from '../checks/index.js';
// Runtime import (a value): the SAME class the runner classifies on. isExpectationError also
// matches by `.name`, so classification survives the esbuild bundle boundary regardless.
import { ExpectationError } from '../errors.js';

// ---------------------------------------------------------------------------
// test() — capture registry. Shared because the compiled spec imports THIS module
// (esbuild aliases '../../lib/flow' -> this shim, external) so spec + runner see one instance.
// ---------------------------------------------------------------------------
export interface CapturedTest {
  name: string;
  fn: (args: { page: Page }) => Promise<void>;
}
const captured: CapturedTest[] = [];

export function test(name: string, fn: (args: { page: Page }) => Promise<void>): void {
  captured.push({ name, fn });
}

/** Return and CLEAR the captured tests (call right after importing a compiled spec). */
export function drainCapturedTests(): CapturedTest[] {
  const out = captured.slice();
  captured.length = 0;
  return out;
}

// ---------------------------------------------------------------------------
// step() — routes to the active StepRecorder via ALS (concurrency-safe).
// ---------------------------------------------------------------------------
export const recorderStore = new AsyncLocalStorage<StepRecorder>();

export async function step<T>(name: string, body: () => Promise<T>): Promise<T> {
  const rec = recorderStore.getStore();
  if (!rec) {
    // A shim bug, not a monitor failure — the harness must als.run() around the fn.
    throw new Error('specfetch: step() called outside a recorder context (harness must als.run)');
  }
  return rec.step(name, body);
}

/**
 * Adapt a captured spec fn into the runner's `Flow = (rec) => Promise<void>` contract: run the
 * fn inside als.run(rec, …) so the shim's step() lands on THIS rec, handing it the runner's page.
 */
export function specToFlow(fn: (args: { page: Page }) => Promise<void>, page: Page): Flow {
  return (rec) => recorderStore.run(rec, () => fn({ page }));
}

// ---------------------------------------------------------------------------
// expect() — mini-matcher shim. ONLY the matchers the real specs use:
//   - toBeVisible  (7 direct uses + assertLoaded)  -> locator.waitFor({state:'visible'})
//   - toHaveURL    (assertLoaded)                  -> page.waitForURL(pattern)
// A miss throws ExpectationError => the run records 'fail' (a clean assertion miss), exactly
// like Playwright's web-first expect. ★ FLAG: any OTHER matcher a spec adds is UNMAPPED and
// will throw "unmapped matcher" — the monitors-repo CI lint should keep specs to this surface.
// ---------------------------------------------------------------------------
export interface SpecExpect {
  toBeVisible(opts?: { timeout?: number }): Promise<void>;
  toHaveURL(pattern: RegExp | string, opts?: { timeout?: number }): Promise<void>;
}

export function expect(target: Locator | Page): SpecExpect {
  return {
    async toBeVisible(opts) {
      const timeout = opts?.timeout ?? 15000;
      try {
        await (target as Locator).waitFor({ state: 'visible', timeout });
      } catch {
        throw new ExpectationError(`expected element to be visible within ${timeout}ms`);
      }
    },
    async toHaveURL(pattern, opts) {
      const timeout = opts?.timeout ?? 15000;
      try {
        await (target as Page).waitForURL(pattern, { timeout });
      } catch {
        throw new ExpectationError(`expected URL to match ${String(pattern)} within ${timeout}ms`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Vendored verbatim from synthwatch-monitors/lib/flow.ts (pure; page + expect only).
// ---------------------------------------------------------------------------
export async function assertLoaded(
  page: Page,
  opts: { urlPattern?: RegExp; visibleText?: string | RegExp; timeoutMs?: number },
): Promise<void> {
  const timeout = opts.timeoutMs ?? 15000;
  if (opts.urlPattern) {
    await expect(page).toHaveURL(opts.urlPattern, { timeout });
  }
  if (opts.visibleText) {
    await expect(page.getByText(opts.visibleText).first()).toBeVisible({ timeout });
  }
}

export async function dismissInterstitials(page: Page): Promise<void> {
  const candidates: Array<{ role: 'button'; name: RegExp }> = [
    { role: 'button', name: /accept( all)?( cookies)?/i },
    { role: 'button', name: /^(close|no thanks|not now|dismiss)$/i },
    { role: 'button', name: /continue/i },
  ];
  for (const c of candidates) {
    const el = page.getByRole(c.role, { name: c.name }).first();
    try {
      if (await el.isVisible({ timeout: 1000 })) {
        await el.click({ timeout: 2000 });
      }
    } catch {
      // best-effort; ignore
    }
  }
}
