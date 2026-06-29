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
// expect() — the mini-matcher shim. lib/flow re-exports the REAL @playwright/test expect (all matchers)
// for local `playwright test`; this is the RUNTIME stand-in the runner substitutes. They can't be
// identical, so it must cover every matcher specs ACTUALLY use — and the matcher-coverage guard
// (scripts/check-expect-matchers.mjs, run by the "Lib-flow parity" job) fails CI if a spec uses one
// this shim doesn't implement, instead of letting it throw a TypeError in a LIVE run (the bug that
// took down meals2go: .toBe(200)/.toBeGreaterThan(0) on VALUE targets → ".toBe is not a function").
//
//   Locator|Page (async, web-first): toBeVisible, toHaveURL.
//   value (sync): toBe, toBeNull, toBeGreaterThan(OrEqual), toBeLessThan(OrEqual), toBeTruthy/Falsy,
//                 toBeDefined — each with a `.not` negation, and Playwright's optional 2-arg message
//                 form `expect(value, "message").toBe(x)` (the message is surfaced in the failure).
//   A miss throws ExpectationError => the run records 'fail' (a clean assertion miss), like Playwright.
// ---------------------------------------------------------------------------

// The matcher names this shim implements — the SINGLE SOURCE the coverage guard greps + diffs against
// the specs' usage. Keep in sync when adding a matcher to expect() below.
export const SUPPORTED_MATCHERS = [
  'toBeVisible',
  'toHaveURL',
  'toBe',
  'toBeNull',
  'toBeGreaterThan',
  'toBeGreaterThanOrEqual',
  'toBeLessThan',
  'toBeLessThanOrEqual',
  'toBeTruthy',
  'toBeFalsy',
  'toBeDefined',
] as const;

interface ValueMatchers {
  toBe(expected: unknown): void;
  toBeNull(): void;
  toBeGreaterThan(n: number): void;
  toBeGreaterThanOrEqual(n: number): void;
  toBeLessThan(n: number): void;
  toBeLessThanOrEqual(n: number): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toBeDefined(): void;
}

export interface SpecExpect extends ValueMatchers {
  toBeVisible(opts?: { timeout?: number }): Promise<void>;
  toHaveURL(pattern: RegExp | string, opts?: { timeout?: number }): Promise<void>;
  not: ValueMatchers;
}

export function expect(target: unknown, message?: string): SpecExpect {
  const lead = message ? `${message} — ` : '';
  const show = (v: unknown): string => {
    try {
      return JSON.stringify(v) ?? String(v);
    } catch {
      return String(v);
    }
  };
  // Sync value matchers. `negate` flips the pass condition (the `.not` chain). A non-number target
  // makes the numeric comparisons false (NaN), so `expect('x').toBeGreaterThan(0)` fails honestly.
  const valueMatchers = (negate: boolean): ValueMatchers => {
    const check = (pass: boolean, detail: string): void => {
      if (negate ? pass : !pass) {
        throw new ExpectationError(`${lead}expected ${show(target)} ${negate ? 'not ' : ''}${detail}`);
      }
    };
    const n = typeof target === 'number' ? target : NaN;
    return {
      toBe: (expected) => check(target === expected, `to be ${show(expected)}`),
      toBeNull: () => check(target === null, `to be null`),
      toBeGreaterThan: (x) => check(n > x, `to be greater than ${x}`),
      toBeGreaterThanOrEqual: (x) => check(n >= x, `to be >= ${x}`),
      toBeLessThan: (x) => check(n < x, `to be less than ${x}`),
      toBeLessThanOrEqual: (x) => check(n <= x, `to be <= ${x}`),
      toBeTruthy: () => check(Boolean(target), `to be truthy`),
      toBeFalsy: () => check(!target, `to be falsy`),
      toBeDefined: () => check(target !== undefined, `to be defined`),
    };
  };
  return {
    ...valueMatchers(false),
    not: valueMatchers(true),
    async toBeVisible(opts) {
      const timeout = opts?.timeout ?? 15000;
      try {
        await (target as Locator).waitFor({ state: 'visible', timeout });
      } catch {
        throw new ExpectationError(`${lead}expected element to be visible within ${timeout}ms`);
      }
    },
    async toHaveURL(pattern, opts) {
      const timeout = opts?.timeout ?? 15000;
      try {
        await (target as Page).waitForURL(pattern, { timeout });
      } catch {
        throw new ExpectationError(`${lead}expected URL to match ${String(pattern)} within ${timeout}ms`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Vendored from synthwatch-monitors/lib/flow.ts (pure; page + expect only).
//
// ★★ KEEP IN SYNC with monitors/lib/flow.ts. THIS is the copy the RUNNER EXECUTES: the spec's
// `lib/flow` import is esbuild-aliased to this shim + marked external (compileSpec.ts), so
// monitors/lib/flow.ts is a LOCAL-DEV/authoring shim ONLY — never run by the runner. A fix made
// there is DEAD at runtime until mirrored HERE (that's exactly why #10's flow-modal exclusion never
// took effect until this port).
//
// ★ ENFORCED by CI: the "Lib-flow parity" check (scripts/check-libflow-parity.mjs, wired into ci-gate)
// hashes lib/flow.ts's SHARED block and compares it to LIBFLOW-VENDOR-SHA below. When lib/flow.ts's
// shared helpers change, that check FAILS until you mirror the change into the functions below AND
// update this sha to the value the check prints. (Single-source refactor — option b — is a follow-up.)
// LIBFLOW-VENDOR-SHA: c28d4f84d56d329ae91e5ee0f204251855b55bc23ff6a9ac1400a59b4463a539
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

// ★ Flow-modal exclusion (ported from #10's monitors/lib/flow.ts — mirror, NOT a redesign). A
// spec-driven modal (e.g. meals2go's fulfillment-type-change store modal) must NOT be auto-closed by
// the generic dismisser — its close button matches /^close$/. Exclude by BOTH the modal CONTAINER
// selector AND the close-button CLASS: the class check makes this robust to the mount-timing race —
// the dismisser fires between steps and may run BEFORE the app-fulfillment-type-change wrapper has
// mounted (so closest() finds no ancestor), but the close button itself always carries the excluded
// class. Both guards live in isInsideFlowModal, so either path catches it.
const FLOW_MODAL_EXCLUDE_SELECTOR =
  'app-fulfillment-type-change, app-modal-form, [role="dialog"].weg-modal-outer';
const FLOW_MODAL_EXCLUDE_CLASSES = ['store-modal-close-button'];

/** True if `el` belongs to a flow-driven modal the spec controls itself. */
async function isInsideFlowModal(el: Locator): Promise<boolean> {
  try {
    return await el.evaluate(
      (node, { sel, classes }) => {
        const e = node as Element;
        if (e.closest(sel)) return true;
        return classes.some((c) => e.classList.contains(c));
      },
      { sel: FLOW_MODAL_EXCLUDE_SELECTOR, classes: FLOW_MODAL_EXCLUDE_CLASSES },
    );
  } catch {
    // If we can't introspect (detached, etc.), be conservative and do NOT skip: a missed flow
    // modal is rare; not dismissing a real nuisance popup is worse.
    return false;
  }
}

export async function dismissInterstitials(page: Page): Promise<void> {
  // Cookie/newsletter/consent matchers UNCHANGED — the exclusion is scoped, not a gutting.
  const candidates: Array<{ role: 'button'; name: RegExp }> = [
    { role: 'button', name: /accept( all)?( cookies)?/i },
    { role: 'button', name: /^(close|no thanks|not now|dismiss)$/i },
    { role: 'button', name: /continue/i },
  ];
  for (const c of candidates) {
    const matches = page.getByRole(c.role, { name: c.name });
    // Declared without an initializer (the runner's eslint flags the dead `= 0`); the catch's
    // `continue` means count is always assigned by the time the loop below reads it.
    let count: number;
    try {
      count = await matches.count();
    } catch {
      continue;
    }
    // Iterate REAL matches (not just .first()) so a flow-modal close button can't shadow a genuine
    // cookie/newsletter button of the same accessible name.
    for (let i = 0; i < count; i++) {
      const el = matches.nth(i);
      try {
        if (!(await el.isVisible({ timeout: 1000 }))) continue;
        if (await isInsideFlowModal(el)) continue; // never close a modal the active flow is driving
        await el.click({ timeout: 2000 });
        break; // one genuine dismissal per candidate is enough
      } catch {
        // best-effort; ignore
      }
    }
  }
}
