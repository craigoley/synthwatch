// §D1 v2 — the red-test HARNESS (PR 1 of 2; the load-bearing piece). Side-effect-free + importable by tests;
// the entry point is redTestMain.ts (mirrors rollup/reconcile/narrative).
//
// A red-test = a DELIBERATE per-monitor proof that the monitor's assertion goes RED on a KNOWN-BAD input. This
// is the project's established meaning of "red-tested" (it has found real bugs — meals2go-cart #25,
// search-product #26: assertions that matched always-present chrome and could never go red). This harness
// EXECUTES the proof: it re-runs a monitor with a fault injected and reads the resulting status.
//
// ★★ THE HONESTY GUARDRAIL (why this exists): a red-test is confirmed 'red' ONLY when the run's verdict is
// 'fail' — the monitor's OWN assertion fired on the known-bad input. It is NEVER inferred from a real fail run
// or RCA (those are already represented — incidents taxonomy, the proven-live chip; reusing them is the
// unbacked confidence D1 kills). A run that ends 'error'/'infra_error' (Playwright timeout / nav crash / IP
// block / spec-load) failed for an UNRELATED reason → 'inconclusive', NOT red. A run that STAYS 'pass' despite
// the fault → 'not-red' (the assertion is too weak to go red — the exact bug red-testing catches). PR 1 PRINTS
// the result; PR 2 adds the red_tests table + the INSERT + the API read.
import { chromium } from 'playwright';
import type { Check } from './db.js';
import { runHttpCheck } from './httpCheck.js';
import { getCompiledSpecFromPool } from './specfetch/specCache.js';
import { loadCompiledSpec } from './specfetch/compileSpec.js';
import { specToFlow } from './specfetch/specShim.js';
import { StepRecorder } from './stepRecorder.js';
import { isExpectationError } from './errors.js';
import { IDENTITY_REDACTOR, makeRedactor } from './redact.js';

export type RedTestMethod = 'executed-red-fixture' | 'attested-manual';
export type RedTestOutcome = 'red' | 'not-red' | 'inconclusive';

export interface RedTestResult {
  checkId: number;
  method: RedTestMethod;
  outcome: RedTestOutcome;
  /** What known-bad input was injected (the fault), for the audit trail. */
  fault: string;
  /** The observed run verdict for an executed test ('fail'|'pass'|'error'|'infra_error'); null for attested. */
  verdict: string | null;
  detail: string;
}

/** A known-bad input to inject. bad-url is the HTTP fault (point target_url at a wrong URL); route-block is the
 *  browser fault (abort the anchor request the monitor's red-condition names → its assertion fails). */
export type Fault =
  | { kind: 'bad-url'; url: string }
  | { kind: 'route-block'; pattern: string };

/**
 * ★ THE HONESTY CLASSIFIER (pure — the load-bearing must-go-red). Map a run verdict, observed AFTER a known-bad
 * fault was injected, to a red-test outcome. Only 'fail' (the monitor's assertion fired) is a proven red-test;
 * 'error'/'infra_error' (an unrelated failure) is inconclusive and must NEVER be reported as red.
 */
export function classifyRedTest(verdict: string): { outcome: RedTestOutcome; detail: string } {
  switch (verdict) {
    case 'fail':
      return { outcome: 'red', detail: 'the monitor went RED on the known-bad input (its own assertion fired) — red-test PASSED.' };
    case 'pass':
      return {
        outcome: 'not-red',
        detail: 'the monitor STAYED GREEN despite the known-bad input — its assertion is too weak to go red (red-test FAILED; the assertion needs fixing, cf. #25/#26).',
      };
    case 'error':
    case 'infra_error':
      return {
        outcome: 'inconclusive',
        detail: `the run ended '${verdict}' — an UNRELATED failure (Playwright timeout / nav crash / IP block / spec-load), NOT the monitor's assertion. Cannot conclude a red-test.`,
      };
    default:
      return { outcome: 'inconclusive', detail: `unexpected run verdict '${verdict}'. Cannot conclude a red-test.` };
  }
}

/** The minimal run signature the HTTP driver needs (runHttpCheck satisfies it) — injectable so the driver is
 *  testable without the network. */
export type HttpRunner = (check: Check) => Promise<{ verdict: string }>;

/**
 * HTTP executed red-test: re-run the monitor with target_url pointed at a KNOWN-BAD url, keeping the monitor's
 * OWN assertions — so the monitor's assertion is what we test. A reachable-but-wrong url (404 / wrong content)
 * → 'fail' (red); an unreachable one → 'error' (correctly inconclusive, NOT a red-test).
 */
export async function runHttpRedTest(
  check: Check,
  fault: Extract<Fault, { kind: 'bad-url' }>,
  run: HttpRunner = runHttpCheck,
): Promise<RedTestResult> {
  const res = await run({ ...check, target_url: fault.url });
  const { outcome, detail } = classifyRedTest(res.verdict);
  return { checkId: check.id, method: 'executed-red-fixture', outcome, fault: `bad-url → ${fault.url}`, verdict: res.verdict, detail };
}

/**
 * Browser executed red-test: run the monitor's REAL spec but ABORT the anchor request (route-block) the
 * red-condition names → the assertion depending on it fails (red). Composes the same pieces executeBrowser uses
 * (spec fetch → flow → fail-vs-error classify). Ephemeral: NO-OP step sinks → nothing is written to run_steps
 * (PR 1 is print-only). An infra failure (spec fetch / launch / nav crash) → inconclusive, never red.
 */
export async function runBrowserRedTest(check: Check, fault: Extract<Fault, { kind: 'route-block' }>): Promise<RedTestResult> {
  const faultLabel = `route-block ${fault.pattern}`;
  const inconclusive = (verdict: string, why: string): RedTestResult => ({
    checkId: check.id, method: 'executed-red-fixture', outcome: 'inconclusive', fault: faultLabel, verdict, detail: why,
  });

  if (!check.spec_path) return inconclusive('error', 'browser red-test needs a spec_path (a Git-managed monitor).');
  const resolution = await getCompiledSpecFromPool(check.spec_path);
  if (resolution.kind === 'infra-error') {
    return inconclusive('infra_error', `could not fetch/compile the spec (${resolution.reason}) — inconclusive, not the monitor's assertion.`);
  }

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    // ★ The fault: abort ONLY the anchor request → the assertion that depends on it fails, everything else loads.
    await context.route(fault.pattern, (route) => route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(check.timeout_ms || 30_000);
    const redact = check.sensitive ? makeRedactor(check.redact_patterns) : IDENTITY_REDACTOR;
    // Ephemeral recorder: no-op sinks → the red-test writes NOTHING to run_steps.
    const rec = new StepRecorder(0, page, check.target_url, async () => {}, async () => {}, redact);

    let verdict: string;
    try {
      const tests = await loadCompiledSpec(resolution.compiledJs);
      if (tests.length === 0) {
        verdict = 'error';
      } else {
        await specToFlow(tests[0].fn, page)(rec);
        verdict = 'pass';
      }
    } catch (err) {
      // ★ THE honesty split: a clean assertion miss (ExpectationError) = the monitor's assertion fired = 'fail'
      // (red). Any other throw (Playwright timeout, nav crash, loader) = 'error' (unrelated → inconclusive).
      verdict = isExpectationError(err) ? 'fail' : 'error';
    }
    const { outcome, detail } = classifyRedTest(verdict);
    return { checkId: check.id, method: 'executed-red-fixture', outcome, fault: faultLabel, verdict, detail };
  } finally {
    await browser.close();
  }
}

/** An evidenced manual red-test — the WEAKER tier: a human ran it and supplies the outcome + an evidence ref.
 *  Record-only (no execution). Clearly labeled so the scorecard can render method='attested-manual' distinctly
 *  from an executed proof. */
export interface Attestation {
  outcome: 'red' | 'not-red';
  evidenceRef: string;
  whatWasBroken: string;
}
export function recordAttested(check: Check, att: Attestation): RedTestResult {
  return {
    checkId: check.id,
    method: 'attested-manual',
    outcome: att.outcome,
    fault: `attested: ${att.whatWasBroken}`,
    verdict: null,
    detail: `MANUAL attestation (weaker than an executed red-test): a human ran the red-test and observed '${att.outcome}'. Evidence: ${att.evidenceRef}.`,
  };
}
