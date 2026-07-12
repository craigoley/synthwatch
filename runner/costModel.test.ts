// The cost model's guarantees, as executable red-tests:
//   1. the OLD single scalar (0.00003) was the 1.0 vCPU / 2 GiB blend; at the LIVE 2.0 vCPU / 4 GiB shape
//      the two-meter model is EXACTLY 2× — so it re-prices the same run set at 2.0× the old figure;
//   2. the rate READS the live (deploy-stamped) allocation — change the stamp, the rate changes;
//   3. an explicit override wins; an unstamped env falls back (flagged) to the current shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VCPU_SECOND_RATE,
  GIB_SECOND_RATE,
  activeSecondRate,
  runnerAllocation,
  costRatePerActiveSecond,
  FALLBACK_RUNNER_CPU,
  FALLBACK_RUNNER_MEMORY_GIB,
} from './costModel.js';

const approx = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-12, `${a} ≈ ${b}`);

test('the meters match Azure ACA Consumption active usage (2026-07)', () => {
  approx(VCPU_SECOND_RATE, 0.000024);
  approx(GIB_SECOND_RATE, 0.000003);
});

test('MUST-GO-RED: the OLD scalar was the 1.0/2 blend; the LIVE 2.0/4 shape is EXACTLY 2×', () => {
  const oldRate = activeSecondRate(1.0, 2); // what 0.00003 secretly was
  approx(oldRate, 0.00003);
  const liveRate = activeSecondRate(2.0, 4); // the current allocation
  approx(liveRate, 0.00006);
  // Cost is linear in the rate for a fixed run set, so a 2× rate IS a 2× figure. Assert the ratio is
  // EXACTLY 2.0 — this is the "must-go-red" the whole PR turns on.
  approx(liveRate / oldRate, 2.0);
});

test('MUST-GO-RED: the rate reads the LIVE stamped allocation (change the stamp → the rate changes)', () => {
  approx(costRatePerActiveSecond({ SYNTHWATCH_RUNNER_CPU: '1.0', SYNTHWATCH_RUNNER_MEMORY_GIB: '2' } as NodeJS.ProcessEnv), 0.00003);
  approx(costRatePerActiveSecond({ SYNTHWATCH_RUNNER_CPU: '2.0', SYNTHWATCH_RUNNER_MEMORY_GIB: '4' } as NodeJS.ProcessEnv), 0.00006);
  approx(costRatePerActiveSecond({ SYNTHWATCH_RUNNER_CPU: '4.0', SYNTHWATCH_RUNNER_MEMORY_GIB: '8' } as NodeJS.ProcessEnv), 0.00012);
});

test('an explicit COST_RATE_PER_ACTIVE_SECOND override wins over the derivation', () => {
  const env = { SYNTHWATCH_RUNNER_CPU: '2.0', SYNTHWATCH_RUNNER_MEMORY_GIB: '4', COST_RATE_PER_ACTIVE_SECOND: '0.000099' } as NodeJS.ProcessEnv;
  approx(costRatePerActiveSecond(env), 0.000099);
});

test('unstamped env → the documented current-shape fallback, flagged stamped:false', () => {
  const a = runnerAllocation({} as NodeJS.ProcessEnv);
  assert.equal(a.stamped, false);
  assert.equal(a.cpu, FALLBACK_RUNNER_CPU);
  assert.equal(a.memoryGib, FALLBACK_RUNNER_MEMORY_GIB);
  approx(costRatePerActiveSecond({} as NodeJS.ProcessEnv), activeSecondRate(FALLBACK_RUNNER_CPU, FALLBACK_RUNNER_MEMORY_GIB));
  // a valid stamp is honored and marked stamped:true
  const s = runnerAllocation({ SYNTHWATCH_RUNNER_CPU: '2.0', SYNTHWATCH_RUNNER_MEMORY_GIB: '4' } as NodeJS.ProcessEnv);
  assert.equal(s.stamped, true);
});
