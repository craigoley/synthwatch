// B1 — the inverted-signal fix. perfBudgetVerdict is the pure verdict adjustment runOne delegates to.
// THE BUG it fixes: when metric capture failed, metrics fell back to EMPTY_METRICS (all-null), and
// perfBudgetBreach's `m.lcpMs != null` guards made every budget SKIP → the run recorded PASS. A monitor
// blind to a budget it was meant to enforce reported green. These tests prove a capture-failure on a
// perf-budgeted check now records ERROR, while every legitimate path (no budget / within budget / real
// breach / successful capture) is unchanged — no false positives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { perfBudgetVerdict, hasPerfBudget, perfBudgetBreach, budgetedMetricCaptureFailed, shouldConfirmByRerun } from './evaluate.js';
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

// ── confirm-by-rerun deferral decision (0077, pure) ─────────────────────────────────────────────
// A healthy browser/multistep failure DEFERS to a fresh-execution confirmation; everything else does not.
test('shouldConfirmByRerun: healthy browser/multistep fail or error → DEFER', () => {
  for (const kind of ['browser', 'multistep'] as const) {
    for (const status of ['fail', 'error']) {
      assert.equal(shouldConfirmByRerun(check({ kind }), status, false), true, `${kind}/${status}`);
    }
  }
});
test('shouldConfirmByRerun: NOT for pass/warn, NOT for http/ssl, NOT when already-failing (D2/D5)', () => {
  assert.equal(shouldConfirmByRerun(check({ kind: 'browser' }), 'pass', false), false);
  assert.equal(shouldConfirmByRerun(check({ kind: 'browser' }), 'warn', false), false);
  assert.equal(shouldConfirmByRerun(check({ kind: 'browser' }), 'infra_error', false), false);
  assert.equal(shouldConfirmByRerun(check({ kind: 'http' }), 'fail', false), false); // in-run retry keeps http
  assert.equal(shouldConfirmByRerun(check({ kind: 'browser' }), 'fail', true), false); // already-failing → immediate
});
