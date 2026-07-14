// B1 — the inverted-signal fix. perfBudgetVerdict is the pure verdict adjustment runOne delegates to.
// THE BUG it fixes: when metric capture failed, metrics fell back to EMPTY_METRICS (all-null), and
// perfBudgetBreach's `m.lcpMs != null` guards made every budget SKIP → the run recorded PASS. A monitor
// blind to a budget it was meant to enforce reported green. These tests prove a capture-failure on a
// perf-budgeted check now records ERROR, while every legitimate path (no budget / within budget / real
// breach / successful capture) is unchanged — no false positives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { perfBudgetVerdict, hasPerfBudget, perfBudgetBreach, budgetedMetricCaptureFailed, shouldConfirmByRerun, effectiveN, crossLocationDown } from './evaluate.js';
import { EMPTY_METRICS, type RunMetrics } from './metrics.js';
import type { Check } from './db.js';

const check = (over: Partial<Check> = {}): Check =>
  ({ perf_budget_lcp_ms: null, perf_budget_transfer_bytes: null, ...over }) as unknown as Check;

const metrics = (over: Partial<RunMetrics> = {}): RunMetrics => ({ ...EMPTY_METRICS, ...over });

test('hasPerfBudget: true iff any perf budget column is set', () => {
  assert.equal(hasPerfBudget(check()), false);
  assert.equal(hasPerfBudget(check({ perf_budget_lcp_ms: 2500 })), true);
  assert.equal(hasPerfBudget(check({ perf_budget_transfer_bytes: 1_000_000 })), true);
});

// ★ THE REGRESSION that would have caught B1 ---------------------------------------------------------
test('★ B1: metric capture FAILED + a perf budget IS configured → ERROR (not a blind pass)', () => {
  const v = perfBudgetVerdict(check({ perf_budget_lcp_ms: 2500 }), 'pass', EMPTY_METRICS, true);
  // before the fix: perfBudgetBreach(EMPTY_METRICS)=null → no warn → recorded PASS. The inversion.
  assert.equal(v.status, 'error');
  assert.notEqual(v.status, 'pass');
  assert.match(v.message ?? '', /metric capture failed/i);
});

test('★ B1: capture failed + transfer-bytes budget (the other budget) → also ERROR', () => {
  const v = perfBudgetVerdict(check({ perf_budget_transfer_bytes: 1_000_000 }), 'pass', EMPTY_METRICS, true);
  assert.equal(v.status, 'error');
});

// Legitimate paths — must NOT be falsely failed ------------------------------------------------------
test('legitimate: NO perf budget + capture failed → still PASS (no metrics were expected)', () => {
  const v = perfBudgetVerdict(check(), 'pass', EMPTY_METRICS, true);
  assert.equal(v.status, 'pass');
  assert.equal(v.message, null);
});

test('no false-positive: budget set + metric absent but capture SUCCEEDED → PASS (not blind)', () => {
  // a page that genuinely fired no LCP — capture did NOT fail, so this is not the B1 bug.
  const v = perfBudgetVerdict(check({ perf_budget_lcp_ms: 2500 }), 'pass', metrics({ lcpMs: null }), false);
  assert.equal(v.status, 'pass');
});

test('normal healthy run: budget + metric within budget → PASS', () => {
  const v = perfBudgetVerdict(check({ perf_budget_lcp_ms: 2500 }), 'pass', metrics({ lcpMs: 1200 }), false);
  assert.equal(v.status, 'pass');
});

test('a real breach (metric OVER budget) → WARN (unchanged behaviour)', () => {
  const v = perfBudgetVerdict(check({ perf_budget_lcp_ms: 2500 }), 'pass', metrics({ lcpMs: 4000 }), false);
  assert.equal(v.status, 'warn');
  assert.match(v.message ?? '', /perf budget breached/);
});

test('non-pass base status is never overridden (a fail stays fail, even with capture failure)', () => {
  const v = perfBudgetVerdict(check({ perf_budget_lcp_ms: 2500 }), 'fail', EMPTY_METRICS, true);
  assert.equal(v.status, 'fail');
});

test('HTTP run (null metrics) → unchanged PASS (no browser metrics expected)', () => {
  const v = perfBudgetVerdict(check({ perf_budget_lcp_ms: 2500 }), 'pass', null, false);
  assert.equal(v.status, 'pass');
});

// perfBudgetBreach itself still behaves (the underlying comparison) ----------------------------------
test('perfBudgetBreach: null on within-budget, message on over-budget, null on no-budget', () => {
  assert.equal(perfBudgetBreach(check({ perf_budget_lcp_ms: 2500 }), metrics({ lcpMs: 1000 })), null);
  assert.match(perfBudgetBreach(check({ perf_budget_lcp_ms: 2500 }), metrics({ lcpMs: 9999 })) ?? '', /LCP 9999/);
  assert.equal(perfBudgetBreach(check(), metrics({ lcpMs: 9999 })), null);
});

// ─── B1 SILENT-NULL sibling (the second "green that lies") ───────────────────────────────────────────
// collect() never throws; it returns null metrics + a `captureFailed` set naming fields whose section
// FAILED. budgetedMetricCaptureFailed draws the line: a budgeted metric that FAILED to capture is
// not-evaluable (→error via metricsCaptureFailed), but a budgeted metric that's null-but-CAPTURED
// (legitimately absent) still passes. Mirrors how runOne→executeBrowser feeds perfBudgetVerdict.
const failed = (...fields: (keyof RunMetrics)[]) => new Set<keyof RunMetrics>(fields);

test('budgetedMetricCaptureFailed: a budgeted metric whose capture FAILED → true', () => {
  assert.equal(budgetedMetricCaptureFailed(check({ perf_budget_lcp_ms: 2000 }), failed('lcpMs')), true);
  assert.equal(
    budgetedMetricCaptureFailed(check({ perf_budget_transfer_bytes: 1_000_000 }), failed('transferBytes')),
    true,
  );
});

test('★ budgetedMetricCaptureFailed: budgeted metric null but CAPTURED (legitimately absent) → false (the line)', () => {
  // lcp genuinely absent (no LCP on the page): the timings section SUCCEEDED, so 'lcpMs' is NOT in the set.
  assert.equal(budgetedMetricCaptureFailed(check({ perf_budget_lcp_ms: 2000 }), failed()), false);
});

test('budgetedMetricCaptureFailed: per-metric — a transfer-capture failure on an LCP-only budget → false', () => {
  // only transfer failed, but the check budgets only LCP → not a false error.
  assert.equal(budgetedMetricCaptureFailed(check({ perf_budget_lcp_ms: 2000 }), failed('transferBytes')), false);
});

test('budgetedMetricCaptureFailed: no budget at all → false (nothing to evaluate)', () => {
  assert.equal(budgetedMetricCaptureFailed(check(), failed('lcpMs', 'transferBytes')), false);
});

// End-to-end through the actual verdict (executeBrowser sets metricsCaptureFailed from the helper):
test('★ B1 silent-null: budgeted LCP capture FAILED (null, no throw) → ERROR, not a blind PASS', () => {
  const c = check({ perf_budget_lcp_ms: 2000 });
  const captureFailed = budgetedMetricCaptureFailed(c, failed('lcpMs')); // true
  const v = perfBudgetVerdict(c, 'pass', metrics({ lcpMs: null }), captureFailed, 'default');
  assert.equal(v.status, 'error');
  assert.notEqual(v.status, 'pass');
  assert.match(v.message ?? '', /capture failed/i);
});

test('★ B1 silent-null: budgeted LCP LEGITIMATELY ABSENT (null, captured) → still PASS (no false error)', () => {
  const c = check({ perf_budget_lcp_ms: 2000 });
  const captureFailed = budgetedMetricCaptureFailed(c, failed()); // false — captured, just absent
  const v = perfBudgetVerdict(c, 'pass', metrics({ lcpMs: null }), captureFailed, 'default');
  assert.equal(v.status, 'pass');
});

test('B1 silent-null: a healthy captured LCP within budget → PASS; over budget → WARN (#146 path intact)', () => {
  const c = check({ perf_budget_lcp_ms: 2000 });
  assert.equal(perfBudgetVerdict(c, 'pass', metrics({ lcpMs: 1200 }), false, 'default').status, 'pass');
  assert.equal(perfBudgetVerdict(c, 'pass', metrics({ lcpMs: 4000 }), false, 'default').status, 'warn');
});

// ── confirm-by-rerun deferral decision (0077, extended, pure) ─────────────────────────────────────
// A healthy failure of ANY confirm-eligible kind DEFERS to a confirmation; everything else does not.
test('shouldConfirmByRerun: healthy fail/error of EVERY kind → DEFER (http/ssl/dns no longer excluded)', () => {
  for (const kind of ['browser', 'multistep', 'http', 'ssl', 'dns', 'tcp', 'ping'] as const) {
    for (const status of ['fail', 'error']) {
      assert.equal(shouldConfirmByRerun(check({ kind }), status, false), true, `${kind}/${status} must DEFER`);
    }
  }
});
test('shouldConfirmByRerun: NOT for pass/warn/infra_error, NOT when already-failing (D5) — for http too', () => {
  assert.equal(shouldConfirmByRerun(check({ kind: 'browser' }), 'pass', false), false);
  assert.equal(shouldConfirmByRerun(check({ kind: 'http' }), 'warn', false), false);
  assert.equal(shouldConfirmByRerun(check({ kind: 'http' }), 'infra_error', false), false); // not a site outage
  assert.equal(shouldConfirmByRerun(check({ kind: 'http' }), 'fail', true), false); // ★ D5: already-failing http → immediate, no confirm
  assert.equal(shouldConfirmByRerun(check({ kind: 'browser' }), 'fail', true), false); // D5 browser unchanged
});

// ── ★ effectiveN + crossLocationDown: the cross-location quorum that gates paging. The mutation sweep found
//    it almost entirely unpinned — the quorum VALUE (floor(n/2)+1), the min/max clamp, the null-vs-explicit
//    branch, and the `failing >= 1 &&` floor coupling ALL survived. These are the must-go-red for each. This
//    is also the documented gap: a COMPLETE single-region outage (1 of 3 failing) is deliberately NOT paged
//    under majority quorum — that decision is now a TEST, so a regression in either direction is caught. ────
test('effectiveN: null minFailLocations → MAJORITY quorum floor(n/2)+1 (1→1, 2→2, 3→2, 4→3, 5→3)', () => {
  assert.equal(effectiveN(1, null), 1);
  assert.equal(effectiveN(2, null), 2);
  assert.equal(effectiveN(3, null), 2, '★ 2-of-3 majority — kills the +1 → -1 quorum-arithmetic mutant');
  assert.equal(effectiveN(4, null), 3);
  assert.equal(effectiveN(5, null), 3);
});

test('effectiveN: explicit minFailLocations → min(minFail, reporting) — a CLAMP, not max', () => {
  assert.equal(effectiveN(5, 2), 2, 'ask 2 of 5 reporting → 2');
  assert.equal(effectiveN(2, 5), 2, '★ ask 5 but only 2 reporting → clamp to 2 (min), NOT 5 (max) — kills min→max');
  assert.equal(effectiveN(3, 1), 1, '★ explicit 1 overrides the majority (would be 2) — kills the null-branch flip');
});

test('★ crossLocationDown: one failing region of three is NOT down under majority quorum (the #4 gap, now pinned)', () => {
  // failing>=1 is TRUE but failing>=effectiveN(3,null)=2 is FALSE → && ⇒ false. `&& → ||` would page here.
  assert.equal(crossLocationDown(1, 3, null), false, '★ one of three failing → NOT paged (majority) — kills && → ||');
  assert.equal(crossLocationDown(2, 3, null), true, 'two of three failing → down');
  assert.equal(crossLocationDown(3, 3, null), true, 'all three failing → down');
});

test('crossLocationDown: the `failing >= 1` floor keeps a 0-failing check UP even with minFailLocations=0', () => {
  assert.equal(crossLocationDown(0, 3, 0), false, '★ nothing failing → UP even when minFail=0 (the floor) — kills a `>= 1 → true` mutant');
  assert.equal(crossLocationDown(0, 0, null), false, 'a fully silent check (reporting=0) is not down');
  assert.equal(crossLocationDown(1, 3, 1), true, 'explicit minFail=1 → a single failing region DOES page (overrides majority)');
});
