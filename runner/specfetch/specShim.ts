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
// The PREVIEW credential channel. Module-private to this shim by construction: a compiled spec can import
// only the lib/flow alias (compileSpec's single onResolve), so `credential()` is the sole reader a spec has.
import { lookupSpecCredential, specCredentialRoles } from './specCredentials.js';

// ---------------------------------------------------------------------------
// test() — capture registry. Shared because the compiled spec imports THIS module
// (esbuild aliases '../../lib/flow' -> this shim, external) so spec + runner see one instance.
// ---------------------------------------------------------------------------
export interface CapturedTest {
  name: string;
  fn: (args: { page: Page }) => Promise<void>;
  /** Set on EVERY returned test when a `test.only` was present and the set was narrowed to it. The
   *  caller MUST surface this: silently running a subset would misrepresent what a real check does. */
  onlyFiltered?: boolean;
}

interface Entry extends CapturedTest {
  only: boolean;
  /** beforeEach/afterEach in scope at declaration time, captured by value (Playwright scopes hooks
   *  to their describe block, and a later hook must not retro-apply to an earlier test). */
  before: Hook[];
  after: Hook[];
}
type Hook = () => Promise<void> | void;

const captured: Entry[] = [];

// ── Declaration-time scope. describe() pushes a frame, runs its body SYNCHRONOUSLY (so inner test()
//    calls land while the frame is live), then pops. Hooks and the name prefix are per-frame, so
//    nesting composes without a second registry. ──────────────────────────────────────────────────
interface Frame { prefix: string; before: Hook[]; after: Hook[]; }
const stack: Frame[] = [{ prefix: '', before: [], after: [] }];
const top = (): Frame => stack[stack.length - 1];
const scopedHooks = (pick: (f: Frame) => Hook[]): Hook[] => stack.flatMap(pick);

function register(name: string, fn: (args: { page: Page }) => Promise<void>, only: boolean): void {
  const before = scopedHooks((f) => f.before);
  const after = scopedHooks((f) => f.after);
  const qualified = top().prefix ? `${top().prefix} › ${name}` : name;
  captured.push({
    name: qualified,
    only,
    before,
    after,
    // Hooks run around the body HERE, so downstream (specToFlow, the step recorder, the runner) sees
    // one plain test fn and needs no knowledge of hooks — the single execution path is preserved.
    fn: async (args) => {
      for (const h of before) await h();
      try {
        await fn(args);
      } finally {
        for (const h of after) await h();
      }
    },
  });
}

/** `test(name, fn)` — the base form, unchanged. */
function testFn(name: string, fn: (args: { page: Page }) => Promise<void>): void {
  register(name, fn, false);
}

/** The Playwright surface a pasted spec most commonly uses. All of it feeds the ONE registry above. */
const MEMBERS: Record<string, unknown> = {
  /** `test.describe(name, body)` — body runs immediately; inner tests inherit the name prefix + hooks. */
  describe: (name: string, body: () => void): void => {
    stack.push({ prefix: top().prefix ? `${top().prefix} › ${name}` : name, before: [], after: [] });
    try {
      body();
    } finally {
      stack.pop();
    }
  },
  beforeEach: (fn: Hook): void => void top().before.push(fn),
  afterEach: (fn: Hook): void => void top().after.push(fn),
  /** ★ `test.only` RUNS A SUBSET — and the result says so (see onlyFiltered). In a preview "just this
   *  one" is genuinely useful while iterating, so it is honoured rather than rejected; but a preview
   *  that quietly ran 1 of 6 while the real check runs all 6 would misrepresent production, so the
   *  narrowing is reported, never silent. */
  only: (name: string, fn: (args: { page: Page }) => Promise<void>): void => register(name, fn, true),
  /** `test.skip(name, fn)` — declared and not run. Playwright's other skip forms (bare/conditional)
   *  are not supported and fall through to the unsupported-API throw below. */
  skip: (name: string, _fn?: (args: { page: Page }) => Promise<void>): void => {
    void name;
    void _fn;
  },
};

const SUPPORTED = ['test()', 'test.describe', 'test.beforeEach', 'test.afterEach', 'test.only', 'test.skip'];

/**
 * ★ UNSUPPORTED APIs FAIL BY NAME. Before this, `test.describe` was simply absent, so a pasted spec died
 * with a bare "test.describe is not a function" — and, worse, that throw produced no structured output at
 * all, so the operator saw a generic failure. Anything not in MEMBERS now throws a message that NAMES the
 * API it tried and lists what IS available, which is the difference between "fix your spec" and "guess".
 */
export const test = new Proxy(testFn, {
  get(target, prop, receiver) {
    if (typeof prop === 'symbol' || prop in target) return Reflect.get(target, prop, receiver);
    if (prop in MEMBERS) return MEMBERS[prop as string];
    return () => {
      throw new Error(
        `test.${String(prop)}() is not supported by the SynthWatch spec shim. Supported: ${SUPPORTED.join(', ')}. ` +
          `A preview runs through the same instrumented shim a real monitor uses, so unsupported Playwright ` +
          `runner APIs are refused rather than silently ignored.`,
      );
    };
  },
}) as typeof testFn & {
  describe: (name: string, body: () => void) => void;
  beforeEach: (fn: Hook) => void;
  afterEach: (fn: Hook) => void;
  only: (name: string, fn: (args: { page: Page }) => Promise<void>) => void;
  skip: (name: string, fn?: (args: { page: Page }) => Promise<void>) => void;
};

/** Return and CLEAR the captured tests (call right after importing a compiled spec).
 *  ★ If ANY test.only was declared, the set is narrowed to those and every returned test carries
 *  onlyFiltered — the caller surfaces it so a subset run is never mistaken for a full one. */
export function drainCapturedTests(): CapturedTest[] {
  const all = captured.slice();
  captured.length = 0;
  stack.length = 0;
  stack.push({ prefix: '', before: [], after: [] });

  const only = all.filter((e) => e.only);
  const chosen = only.length > 0 ? only : all;
  return chosen.map(({ name, fn }) => (only.length > 0 ? { name, fn, onlyFiltered: true } : { name, fn }));
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

/**
 * Per-monitor LOGIN CREDENTIAL accessor (model B). A spec reads `credential('username')` instead of hardcoding
 * a secret. It resolves from TWO channels, one per execution context, and they never overlap:
 *
 *   LIVE (fleet) — process.env[SW_CRED_<ROLE>]. The check's `login_credentials` stores { role -> ENCRYPTED
 *     VALUE }; an operator sets the plaintext in the dashboard Credentials panel, the api encrypts it under
 *     CRED_ENC_KEY, and at RUN time the runner decrypts + publishes it for the life of that run (cleared
 *     after — runner/loginCredentials.ts). There is NO operator env-var step. ★ UNCHANGED by the preview work.
 *
 *   PREVIEW (sandbox) — the IN-PROCESS store (specCredentials.ts), populated by sandboxChild from the user's
 *     per-run typed credentials before the spec is imported. ★ These are deliberately NOT env vars: the
 *     sandbox executes uploaded code, so anything in `process.env` is one `console.log` away from the UI.
 *     See specCredentials.ts for the full argument. This is what lets the Tests area preview the fleet's
 *     AUTHENTICATED monitors — previously `credential()` could not resolve in a preview at all, which made
 *     the area unusable for exactly the specs it was built for.
 *
 * ★ ENV IS CHECKED FIRST so the live path is byte-for-byte what it always was: the sandbox never receives
 *   SW_CRED_*, and the fleet never populates the store, so the order can only matter if an invariant has
 *   already broken — and in that case the STORED, operator-configured credential is the right winner.
 *
 * Fail-CLOSED: an unset role throws, so a mis-configured login monitor fails loudly instead of submitting an
 * empty credential. The throw NAMES the role and never echoes a value.
 *
 * IN THE PARITY-HASHED BLOCK on purpose — a security-relevant, spec-reachable accessor whose authoring
 * (synthwatch-monitors lib/flow.ts) and runtime (specShim) copies must never silently drift. The env-var
 * format `SW_CRED_<ROLE>` must stay in lockstep with runner/loginCredentials.ts credentialEnvKey.
 * ★ THE IN-PROCESS BRANCH IS A DELIBERATE, RUNTIME-ONLY DIVERGENCE from monitors/lib/flow.ts. That copy is
 *   the LOCAL-DEV authoring shim, run by `playwright test` on a developer's machine where env vars are the
 *   only channel and no sandbox child exists — the branch would be dead code there. The SHARED contract that
 *   must not drift is the SIGNATURE and the env format, both unchanged.
 */
export function credential(role: string): string {
  const value = process.env[`SW_CRED_${role.toUpperCase()}`] || lookupSpecCredential(role);
  if (value === undefined || value.length === 0) {
    // Message-only branch (the THROW condition is unchanged). Three distinct misses, three distinct fixes:
    const inSandbox = process.env.SW_SANDBOX === '1';
    const supplied = specCredentialRoles(); // ROLE NAMES only — never values
    throw new Error(
      !inSandbox
        ? `credential("${role}") is not available — set login_credentials.${role} on this check via the ` +
            `dashboard Credentials panel (check detail page). The runner publishes SW_CRED_${role.toUpperCase()} ` +
            `automatically from the stored, encrypted value at run time; there is no runner env-var step.`
        : supplied.length === 0
          ? `credential("${role}") is not available in a preview/sandbox run — no credentials were supplied ` +
            `for this preview. Type them into the Credentials panel of the Tests area and re-run; they are ` +
            `delivered to the spec for this run only, and are never stored.`
          : `credential("${role}") is not available in a preview/sandbox run — this preview supplied ` +
            `[${supplied.join(', ')}], which does not include "${role.toLowerCase()}". The Tests area collects ` +
            `the roles "username", "password" and "bypassToken"; a spec needing any other role can only be ` +
            `run LIVE, against a check whose login_credentials define it.`,
    );
  }
  return value;
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
// LIBFLOW-VENDOR-SHA: 42d59fcae352c910ecf32af99787ba575431dc4ac2aac17ef8675ecbc007fce5
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

/**
 * Dismiss the common interstitials production e-comm sites throw up (cookie
 * banners, location/store pickers, newsletter modals) that otherwise intercept
 * clicks. Best-effort: never fails the flow if a given interstitial isn't
 * present. Add site-specific dismissals here as flows discover them.
 *
 * IMPORTANT: skips any candidate inside a FLOW-DRIVEN modal (see
 * FLOW_MODAL_EXCLUDE_SELECTOR) so it never closes a modal a spec is actively
 * driving. Iterates real matches (not just .first()) so a flow-modal close
 * button never shadows a genuine nuisance-popup button of the same name.
 *
 * ★★ DO NOT ADD A "THIS MUST NOT NAVIGATE" GUARD HERE. One was added and REVERTED the same day; it
 *    took three green checks down (355 login, 77 twice) within one tick of shipping.
 *
 *    WHY IT CANNOT WORK IN THAT FORM: a guard comparing the URL before/after cannot distinguish
 *      (a) a control IT clicked navigating, from
 *      (b) a navigation ALREADY IN FLIGHT completing while it was looking,
 *    and (b) is COMMON — every deliberate click that kicks off an async route change or an OAuth
 *    redirect near a dismissInterstitials call trips it. Observed, all on etag 083d854d:
 *      • 355 login  "Clicked an unidentified control; wegmans.com/ -> myaccount.wegmans.com/.../authorize"
 *                   — the spec clicked Sign In itself; the B2C redirect landed during this call.
 *      • 77         "Clicked an unidentified control; /recipes/search -> /recipes/main-dishes/..."
 *                   — a recipe-tile click the spec had already issued.
 *    "Clicked an unidentified control" is the guard ADMITTING it had no click to attribute — it was
 *    reporting a navigation it did not cause.
 *
 *    AND ATTRIBUTION ALONE IS NOT ENOUGH. The third failure was
 *      • 77         'Clicked "Close"; wegmans.com/ -> wegmans.com/recipes'
 *    a genuinely self-navigating control this helper DID click — but the spec's very next step is
 *    /recipes, so the navigation was WANTED. A correct guard would have to attribute the navigation
 *    to a click it issued AND know whether the flow wanted it, and only the caller knows the second.
 *
 *    ★ A fixed settle does not rescue it either (and is banned fleet-wide): waiting WIDENS the window
 *      in which an unrelated redirect can land, making misattribution more likely, not less.
 *
 *    What actually removed the known cause is the ANCHORED /^continue$/i candidate below — the loose
 *    /continue/i was clicking Wegmans' "Continue Shopping". Keep that. If a self-navigating control is
 *    found again, exclude it by NAME here; do not re-add a global URL guard.
 */

export async function dismissInterstitials(page: Page): Promise<void> {
  const candidates: Array<{ role: 'button'; name: RegExp }> = [
    { role: 'button', name: /accept( all)?( cookies)?/i },
    { role: 'button', name: /^(close|no thanks|not now|dismiss)$/i },
    // ★★ ANCHORED (was /continue/i). An interstitial's button is named exactly "Continue"; an
    //    UNANCHORED match also hits every app control whose label merely CONTAINS the word — and
    //    Wegmans' /cart carries `<button class="…component--cart-continue-shopping-button…">Continue
    //    Shopping</button>`, 4 of 6 instances not xl:hidden, so one is visible at 1280x720 and was
    //    being clicked. That NAVIGATED the run off /cart (a Next.js client-side route change — no
    //    document request, which is why it never showed up in the network trace), and every assertion
    //    after the call then ran on a page the flow did not choose. Candidate 2 was already anchored;
    //    this one being loose was the inconsistency, and the bug. "Continue to checkout" would have
    //    been the next one.
    { role: 'button', name: /^continue$/i },
  ];
  for (const c of candidates) {
    const matches = page.getByRole(c.role, { name: c.name });
    // Declared without an initializer (the runner's eslint flags the dead `= 0`); the catch's
    // `continue` means count is always assigned by the time the loop below reads it.
    // ★ A DELIBERATE, RUNNER-LOCAL DIVERGENCE from lib/flow.ts, which keeps `let count = 0` — the
    //   parity gate hashes lib/flow.ts's block rather than byte-comparing the copies precisely so
    //   lint-driven differences like this one are allowed. Do not "restore" the initializer here.
    let count: number;
    try {
      count = await matches.count();
    } catch {
      continue;
    }
    for (let i = 0; i < count; i++) {
      const el = matches.nth(i);
      try {
        if (!(await el.isVisible({ timeout: 1000 }))) continue;
        // Never dismiss a button the active flow is driving (e.g. the meals2go
        // fulfillment modal's close button) -- that would close it on the flow.
        if (await isInsideFlowModal(el)) continue;
        await el.click({ timeout: 2000 });
        break; // one genuine dismissal per candidate is enough
        // ★ THIS break IS UNCONDITIONAL, and must stay so. A draft of the (now-reverted) navigation
        //   guard made it conditional on "did the page move?", which quietly turned the loop into
        //   "click EVERY visible match for this candidate" — widening the click surface in the very
        //   change whose purpose was to narrow it.
      } catch {
        // best-effort; ignore
      }
    }
  }
}
