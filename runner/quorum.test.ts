// Cross-location QUORUM (2-of-3) — the incident-firing threshold. effectiveN + crossLocationDown are the
// shared deciders for both the incident verdict and the burn path. The default (min_fail_locations NULL)
// is a MAJORITY of REPORTING locations: a lone regional blip is suppressed, but ≥2 failing still pages.
// ★ GUARDRAIL proof: a real 2-region outage MUST still page; quorum only quiets 1-region blips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveN, crossLocationDown, perfBudgetBreach, latencyToleranceFor } from './evaluate.js';
import type { Check } from './db.js';
import type { RunMetrics } from './metrics.js';

const check = (over: Partial<Check> = {}): Check =>
  ({ perf_budget_lcp_ms: null, perf_budget_transfer_bytes: null, ...over }) as unknown as Check;
const metrics = (over: Partial<RunMetrics> = {}): RunMetrics =>
  ({ lcpMs: null, transferBytes: null, ...over }) as RunMetrics;

test('effectiveN default (NULL) = majority quorum floor(n/2)+1', () => {
  assert.equal(effectiveN(1, null), 1); // single region — unchanged
  assert.equal(effectiveN(2, null), 2); // both — IDENTICAL to old N-of-N (no live-fleet change)
  assert.equal(effectiveN(3, null), 2); // ★ 2-of-3 quorum
  assert.equal(effectiveN(4, null), 3);
  assert.equal(effectiveN(5, null), 3);
});

test('effectiveN explicit override = absolute threshold, capped at reporting', () => {
  assert.equal(effectiveN(3, 2), 2); // explicit 2-of-3
  assert.equal(effectiveN(3, 1), 1); // explicit any-of-3 (loud)
  assert.equal(effectiveN(3, 9), 3); // capped at reporting (can't block-forever)
});

// ★ THE GUARDRAIL — the quorum must NOT make a real multi-region outage stop paging.
test('★ 3 locations: 1-of-3 SUPPRESSED (transient/regional), 2-of-3 and 3-of-3 PAGE', () => {
  assert.equal(crossLocationDown(1, 3, null), false, '1-of-3 is a single-region blip — must NOT page');
  assert.equal(crossLocationDown(2, 3, null), true, '★ 2-of-3 is a real outage — MUST page');
  assert.equal(crossLocationDown(3, 3, null), true, '3-of-3 — pages');
});

test('★ no regression: 2 locations still require 2-of-2 (1-of-2 suppressed, 2-of-2 pages)', () => {
  assert.equal(crossLocationDown(1, 2, null), false, '1-of-2 — single-region, suppressed (as before)');
  assert.equal(crossLocationDown(2, 2, null), true, '2-of-2 — a real 2-region outage still pages');
});

test('single reporting location → N=1 → exactly the pre-multi-location behaviour', () => {
  assert.equal(crossLocationDown(1, 1, null), true, '1-of-1 pages');
  assert.equal(crossLocationDown(0, 1, null), false, 'nothing failing → no page');
});

test('zero failing never pages, whatever the reporting count', () => {
  for (const reporting of [0, 1, 2, 3, 4]) {
    assert.equal(crossLocationDown(0, reporting, null), false);
  }
});

test('explicit 2-of-3 override behaves identically to the new default at 3 reporting', () => {
  assert.equal(crossLocationDown(1, 3, 2), false);
  assert.equal(crossLocationDown(2, 3, 2), true);
});

// ★ LOCATION-AWARE perf budgets — the distant 3rd region must not red on physics (normal latency).
test('latencyToleranceFor: distant region has headroom, primary/central = 1.0, unknown = 1.0', () => {
  assert.equal(latencyToleranceFor('default'), 1.0);
  assert.equal(latencyToleranceFor('eastus2'), 1.0);
  assert.equal(latencyToleranceFor('centralus'), 1.0);
  assert.equal(latencyToleranceFor('westus2'), 1.3);
  assert.equal(latencyToleranceFor('mars'), 1.0); // unknown never tightens
});

test('★ a distant region does NOT breach on latency within its tolerance (no physics false-alarm)', () => {
  const c = check({ perf_budget_lcp_ms: 2000 });
  // 2400ms LCP: a breach in eastus2 (>2000), but WITHIN westus2 budget (2000×1.3 = 2600).
  assert.ok(perfBudgetBreach(c, metrics({ lcpMs: 2400 }), 'eastus2'), 'eastus2 breaches at 2400 > 2000');
  assert.equal(perfBudgetBreach(c, metrics({ lcpMs: 2400 }), 'westus2'), null, 'westus2 tolerated (2400 < 2600)');
});

test('★ a distant region STILL breaches when genuinely over its tolerated budget', () => {
  const c = check({ perf_budget_lcp_ms: 2000 });
  // 3000ms LCP: over even westus2's 2600 tolerated budget → real breach.
  assert.match(perfBudgetBreach(c, metrics({ lcpMs: 3000 }), 'westus2') ?? '', /LCP 3000ms > budget 2600ms/);
});

test('page weight (transferBytes) is region-independent — NOT scaled by location', () => {
  const c = check({ perf_budget_transfer_bytes: 1_000_000 });
  // same over-budget transfer breaches in BOTH regions (no latency headroom for page weight).
  assert.ok(perfBudgetBreach(c, metrics({ transferBytes: 1_500_000 }), 'eastus2'));
  assert.ok(perfBudgetBreach(c, metrics({ transferBytes: 1_500_000 }), 'westus2'), 'weight is not tolerated by region');
});
