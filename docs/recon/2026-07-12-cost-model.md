# Cost-model recon — the model lies twice (2026-07-12)

Two independent defects in the ESTIMATED-cost feature (`cost_projection` 0069 → `/reports/cost` + the
narrative fact pack + the dashboard cost UI). Both reduce to "the cost model lies". Every claim below is
OBSERVED in code (`git show origin/main:<path>`) unless tagged INFERRED.

## Files (the whole chain)

- runner `db/migrations/0069_cost_projection.sql` + `db/schema.sql:1018` — the shared SQL model `cost_projection(p_rate)`.
- runner `runner/narrative.ts` — `costRate()` read `COST_RATE_PER_VCPU_SECOND`, default `0.00003`.
- runner `infra/main.bicep` — the 3 browser-runner jobs at `cpu: json('2.0') / memory: '4Gi'` (was 1.0/2Gi).
- runner `scripts/deploy.sh` `verify()` — data-driven config-value asserts (cpu/memory/replicaTimeout vs the template).
- api `Infrastructure/CostRate.cs` — `PerVcpuSecond`, default `0.00003m`; `Functions/ReportsFunctions.cs:250` calls `cost_projection`.
- api `infra/main.bicep:74` — `param costRatePerVcpuSecond = '0.00003'` (a THIRD copy of the scalar).
- dashboard `src/components/cost.tsx:44,190` — the divergence warning copy: "check for retries/failures".

## Bug A — the rate constant is a BLENDED rate calibrated to a shape that no longer exists

OBSERVED: ACA Consumption (jobs bill ACTIVE seconds) has TWO meters — `$0.000024/vCPU-s + $0.000003/GiB-s`
(verified 2026-07 against Azure's ACA Consumption pricing page; a monthly free grant of 180,000 vCPU-s +
360,000 GiB-s per subscription applies before billing — a subscription-level credit, not attributable
per-check, so the figure is a GROSS active-usage estimate).

OBSERVED: `COST_RATE_PER_VCPU_SECOND = 0.00003` was **never a vCPU rate**. At the runner's FORMER 1.0 vCPU /
2 GiB shape, `1×0.000024 + 2×0.000003 = 0.00003` — it was the BLENDED per-second rate for that shape, with
memory folded in and the NAME hiding it. The api's own comment admits it (`CostRate.cs:7`, api
`main.bicep:73`: "cpu=1/mem=2GiB are already folded in").

OBSERVED: after the resize to 2.0 vCPU / 4 GiB (#253/#268, `infra/main.bicep`), the true blend is
`2×0.000024 + 4×0.000003 = 0.00006` — **EXACTLY 2×** — so the old constant under-prices every tracked
second by 2.0×. The model read NO allocation anywhere (not the template, not env) → it silently drifts on
every future resize (the #256/#268 latent-trap class). Arithmetic vs Craig's Azure actuals: correctly-priced
tracked runtime ≈ $105/mo vs SynthWatch's $52.59/mo (the 2.0×); residual to Azure's ~$142/mo is untracked
compute (disabled-check sandbox, stranded runs, non-duration overhead — see "Filed" below).

### Fix (this PR + the api PR)

- `runner/costModel.ts` (new) — the ONE place the rate is derived: `activeSecondRate(cpu, mem) = cpu×0.000024
  + mem×0.000003`, from the LIVE allocation read out of deploy-stamped env `SYNTHWATCH_RUNNER_CPU/MEMORY_GIB`.
  Renamed the tunable `COST_RATE_PER_VCPU_SECOND` → `COST_RATE_PER_ACTIVE_SECOND` (an explicit override; the
  default is now DERIVED). `cost_projection(p_rate)` still takes the computed rate — it stays "not a second
  rate source" (0069's discipline).
- `infra/main.bicep` — stamps `SYNTHWATCH_RUNNER_CPU='2.0' / SYNTHWATCH_RUNNER_MEMORY_GIB='4'` onto the 3
  runner jobs (== their own resources) AND the narrative job (which PRICES the runner workload), mirroring
  `SYNTHWATCH_DEPLOYED`. A resize re-prices automatically.
- `scripts/deploy.sh` `verify()` — asserts the stamped env == the LIVE container resources on every
  cost-computing job (two independent `az` reads). **This is the guard that makes the stamp trustworthy**:
  stamp a wrong value → the deploy FAILS (the #268/#271 config-value-verify lesson, applied to the new vars).
- api `CostRate.cs` — mirrors the same derivation from env; api `main.bicep` replaces the `0.00003` scalar
  param with the runner cpu/mem (+ the two meters). Kills the 3-way hardcoded duplication.

## Bug B — the divergence warning names a cause the metric CANNOT SEE

Trigger: `divergence = measured/projected > 1.5` (0069). Copy: "⚠ costing {x}× projected — check for
retries/failures".

OBSERVED ALGEBRA: `measured = Σsec × rate × 30/7`, `projected = avg_s × (2,592,000/interval) × region × rate`.
Since `Σsec = avg_s × N` over the SAME 7d run set, duration cancels EXACTLY:

    divergence = N × (30/7) ÷ (scheduled_runs_month × region_count)   [ = run_count_7d / expected ]

It is a **pure RUN-COUNT ratio**. Therefore:
- retries create no extra rows (one verdict row per run) and no extra duration (only the final attempt
  persists) → **retry amplification is STRUCTURALLY INVISIBLE** to this metric;
- slow/failing runs cannot move it (slowness inflates measured AND projected identically);
- ONLY extra ROWS move it: a config (interval) change straddling the 7d window, confirmation runs
  (`confirmation_of_run_id`, 0077), or sandbox/on-demand fires (`runs.sandbox`, 0065).

OBSERVED (damning): the flagged monitors (amore-menu 1.9×, nextdoor-home 1.6×, nextdoor-reservations 1.9×,
meals2go 2.0×) match `docs/recon/2026-07-08-cost-optimization.md`'s Lever-3 interval-doubling list
monitor-for-monitor, at ratios ≈ the halving. **The warning fires BECAUSE the recommended cost tuning was
applied** — measured still holds the old faster cadence, projected uses the new interval — while blaming
retries the Trust panel shows at 0/1401. Flags self-clear ~7d after each config change.

### Fix (0078 + the api + dashboard PRs)

- `0078_cost_projection_run_counts.sql` — adds `run_count_7d, confirmation_count_7d, sandbox_count_7d,
  run_count_recent, run_count_prior` (recent/prior split the window at 3.5d to detect a cadence step). DROP +
  recreate (return-type change); re-GRANT. The $ model is byte-identical to 0069.
- api surfaces the counts on `CostCheckDto`; dashboard `cost.tsx` rewrites the copy to attribute from data
  (config-change straddle / confirmation / sandbox) and shows expected-vs-actual counts. **"retries" removed.**
- Structural fix (per-day divergence / window reset at a config change, spec P5) is **FILED, not shipped**
  here — it reworks the window semantics and is larger than one PR.

## Must-go-reds

- `runner/costModel.test.ts` — `activeSecondRate(2.0,4)/activeSecondRate(1.0,2) === 2.0` EXACTLY; changing the
  stamped cpu/mem changes the rate (proves it reads the live allocation).
- `verify()` — stamped `SYNTHWATCH_RUNNER_CPU/MEMORY_GIB` must equal the live resources (stamp wrong → deploy fails).
- dashboard e2e — the string "retries" must not appear in the divergence copy.

## Filed, not fixed (BUILD C — visibility)

- `cost_projection` filters `WHERE c.enabled` → disabled-check sandbox/validation runs (e.g. shop-flow #355,
  ~5-min flow) are in NO SynthWatch figure despite real billed compute. Surface a "beyond schedule" bucket.
- Stranded runs (`duration_ms IS NULL`, replicaTimeout-killed) are excluded from `measured` yet billed up to
  660s each; and the duration clock excludes spec fetch/compile, chromium launch, trace redact/upload, DB
  persist — so billed replica-seconds strictly EXCEED Σduration_ms.

## Craig verification (paste-able)

    psql "$DATABASE_URL" -c "SELECT c.name, c.interval_seconds, date_trunc('day', r.started_at) AS day, count(*) AS runs, count(*) FILTER (WHERE r.confirmation_of_run_id IS NOT NULL) AS confirmations, count(*) FILTER (WHERE r.sandbox) AS sandbox FROM runs r JOIN checks c ON c.id=r.check_id WHERE c.name ILIKE '%amore%menu%' AND r.started_at > now() - interval '10 days' GROUP BY 1,2,3 ORDER BY 3;"

→ expect Amore's runs/day to step DOWN mid-window (the interval doubling) with ~0 confirmations — proving the
flag is a config-change artifact, not retries.
