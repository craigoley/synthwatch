// The ACA Consumption cost model — the ONE place the runner DERIVES the $/active-second rate it passes
// to cost_projection(p_rate). The SQL fn stays "not a second rate source" (0069): it takes the rate,
// this module computes it.
//
// ACA Consumption (jobs bill ACTIVE seconds only) has TWO meters, not one:
//   $0.000024 / vCPU-second  +  $0.000003 / GiB-second
// (verified against Azure's ACA Consumption pricing page, 2026-07. A monthly FREE grant of
//  180,000 vCPU-s + 360,000 GiB-s per SUBSCRIPTION applies before billing — a subscription-level
//  credit we do NOT attribute per-check, so these figures are GROSS active-usage estimates, not billed
//  truth. GET /reports/cost already labels itself an estimate.)
//
// ★ THE BUG THIS FIXES: the old single scalar COST_RATE_PER_VCPU_SECOND = 0.00003 was NEVER a vCPU
// rate. At the runner's FORMER 1.0 vCPU / 2 GiB shape, 1×0.000024 + 2×0.000003 = 0.00003 — it was the
// BLENDED per-second rate for that shape, with memory folded in and the NAME hiding it. After the
// resize to 2.0 vCPU / 4 GiB (#253/#268), the blend is 2×0.000024 + 4×0.000003 = 0.00006 — EXACTLY 2× —
// so the old constant under-priced every tracked second by 2.0×, and read NO allocation anywhere so it
// would silently drift on every future resize. The rate is now DERIVED from the LIVE (deploy-stamped)
// allocation, so a resize re-prices automatically. See docs/recon/2026-07-12-cost-model.md.

/** ACA Consumption ACTIVE-usage meters ($/second). Both must be priced — the whole bug was folding
 *  memory into a single "vCPU" scalar calibrated to one shape. */
export const VCPU_SECOND_RATE = 0.000024;
export const GIB_SECOND_RATE = 0.000003;

/** Derived $/active-second for a container allocation — the two meters blended against THIS shape.
 *  Linear in each meter, so 2.0 vCPU / 4 GiB yields exactly 2× the 1.0 vCPU / 2 GiB blend. */
export function activeSecondRate(cpuCores: number, memoryGib: number): number {
  return cpuCores * VCPU_SECOND_RATE + memoryGib * GIB_SECOND_RATE;
}

// The runner (browser) job allocation being PRICED — deploy-stamped from infra/main.bicep into every
// cost-computing job's env (SYNTHWATCH_RUNNER_CPU / SYNTHWATCH_RUNNER_MEMORY_GIB), mirroring
// SYNTHWATCH_DEPLOYED. verify() asserts the stamped values match the live container resources, so a
// resize can't silently drift the cost model. The FALLBACK shape is the CURRENT allocation — only
// reached in a local shell or a mis-stamped deploy (which verify() fails loudly), and logged as such.
export const FALLBACK_RUNNER_CPU = 2.0;
export const FALLBACK_RUNNER_MEMORY_GIB = 4;

export interface RunnerAllocation {
  cpu: number;
  memoryGib: number;
  stamped: boolean; // true = read from the deploy-stamped env; false = the documented fallback
}

/** The runner allocation the cost model prices, from the deploy-stamped env. Falls back to the current
 *  shape (flagged stamped:false) when the env is absent/invalid so a local run still produces a figure. */
export function runnerAllocation(env: NodeJS.ProcessEnv = process.env): RunnerAllocation {
  const cpu = Number(env.SYNTHWATCH_RUNNER_CPU);
  const mem = Number(env.SYNTHWATCH_RUNNER_MEMORY_GIB);
  if (Number.isFinite(cpu) && cpu > 0 && Number.isFinite(mem) && mem > 0) {
    return { cpu, memoryGib: mem, stamped: true };
  }
  return { cpu: FALLBACK_RUNNER_CPU, memoryGib: FALLBACK_RUNNER_MEMORY_GIB, stamped: false };
}

function override(env: NodeJS.ProcessEnv): number | null {
  const n = Number(env.COST_RATE_PER_ACTIVE_SECOND);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The $/active-second rate the cost model uses. An explicit COST_RATE_PER_ACTIVE_SECOND override wins
 *  (deploy-free re-price, as #229 valued); otherwise DERIVE from the live deploy-stamped allocation.
 *  This replaces the misleadingly-named COST_RATE_PER_VCPU_SECOND blended scalar. */
export function costRatePerActiveSecond(env: NodeJS.ProcessEnv = process.env): number {
  const o = override(env);
  if (o != null) return o;
  const a = runnerAllocation(env);
  return activeSecondRate(a.cpu, a.memoryGib);
}

// The per-SUBSCRIPTION monthly free grant (ACA Consumption): 180,000 vCPU-s + 360,000 GiB-s, consumed by the
// WHOLE FLEET collectively before billing. It is a FLEET-level discount, so it applies to the fleet TOTAL,
// not per-check: its $ value (at the meters) is subtracted from the from-zero fleet total, and that
// grant-corrected total is allocated across monitors BY their compute share (spreading the discount
// proportionally — a monitor that runs keeps an attributable share of the paid compute ABOVE the grant, so a
// cheap high-frequency check is discounted, never zeroed). This is the "get the estimates closer to Azure"
// correction: the old from-zero Σ (~$85) over-priced by pricing every second from zero.
export const FREE_GRANT_VCPU_SECONDS = 180_000;
export const FREE_GRANT_GIB_SECONDS = 360_000;

/** The $ value of the per-subscription free grant at the two meters — a flat monthly discount to the FLEET
 *  total. Valid as a flat subtraction because the fleet's monthly vCPU-s AND GiB-s both far exceed the grant
 *  (so both meters bill above zero); then (FV−free_v)·rv + (FG−free_g)·rg = FZ − freeGrantDollars exactly.
 *  Independent of the container SHAPE (the grant is in seconds, priced at the meter rates). */
export function freeGrantDollars(): number {
  return FREE_GRANT_VCPU_SECONDS * VCPU_SECOND_RATE + FREE_GRANT_GIB_SECONDS * GIB_SECOND_RATE;
}

/** The fleet $ the per-monitor estimates reconcile to (Σ estimated ≈ this). null ⇒ use the DERIVED
 *  grant-corrected fleet total (from-zero Σ − freeGrantDollars), which tracks the fleet with no magic number.
 *  Set COST_RECONCILE_TARGET_MONTHLY to PIN Σ to Azure's steady-state figure instead — forecast (~76) or MTD
 *  (~47) — a one-line, deploy-free change (the estimate is an "est.", so pinning it to Azure's own number is
 *  the honest amount of confidence). */
export function reconcileTargetMonthly(env: NodeJS.ProcessEnv = process.env): number | null {
  const n = Number(env.COST_RECONCILE_TARGET_MONTHLY);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Human basis of the rate, for logs / the self-describing cost report. */
export function costRateSource(env: NodeJS.ProcessEnv = process.env): string {
  const o = override(env);
  if (o != null) return `override COST_RATE_PER_ACTIVE_SECOND=${o} ($/active-second)`;
  const a = runnerAllocation(env);
  return (
    `ACA Consumption active meters: ${a.cpu} vCPU × ${VCPU_SECOND_RATE} + ${a.memoryGib} GiB × ${GIB_SECOND_RATE} ` +
    `= ${activeSecondRate(a.cpu, a.memoryGib)} $/active-second` +
    (a.stamped ? '' : ' (FALLBACK allocation — SYNTHWATCH_RUNNER_CPU/MEMORY_GIB not stamped)')
  );
}
