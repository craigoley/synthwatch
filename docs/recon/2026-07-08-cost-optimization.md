# Cost-optimization recon — ACA runner (2026-07-08)

**Analysis only. No config changed.** Every lever below states the **coverage it trades for the saving**, so Craig picks. Evidence is `file:line` + live prod DB (read-only `BEGIN TRANSACTION READ ONLY`, queried 2026-07-08).

## TL;DR — ranked levers

| # | Lever | Est. saving | Coverage cost | Sign-off |
|---|-------|-------------|---------------|----------|
| 0 | **Retry "anomaly" — NOT a lever** | $0 | — | none — it's a bookkeeping artifact, no doubled executions (proven below) |
| 1 | **Fix the slow browser specs** (6 flows run 20–33 s each) | ~250–300 compute-min/day (~24%) | **ZERO** — same checks, same cadence, just faster | Low — it's a spec fix, no detection loss |
| 2 | **Regions 3→1 on external-site browser flows** (~15 checks) | ~740 compute-min/day (~60%) | Region-specific edge/CDN failures go undetected | **HIGH — the 23 h outage was region-related; needs explicit Craig sign-off** |
| 2b | *(softer variant)* Regions 3→2 on the same flows | ~370 min/day (~30%) | Keeps 2-region diversity | Medium |
| 3 | **Frequency halving on browse-tier browser flows** (iv 600→1200, 900→1800) | ~420 min/day (~34%) | 2× slower detection on those flows | Medium — per-flow, see tiering |
| 4 | **Retire / single-region the demo + orphan checks** (rca-demo #59) | trivial ($, it's http) | none (demo endpoint) | Low |
| 5 | **http / dns / ssl cuts** | **~$0 — do NOT bother** | (they're ~half the *runs* but ~5 % of *cost*) | n/a |

**Headline:** the 40× cost climb is **volume growth in browser checks**, not retries and not the http/dns run-count the volume table highlights. Browser runs are **94.6 % of compute** (query E). The zero-coverage lever (#1) plus a region decision (#2) covers most of the money.

---

## 0. The retry anomaly — RESOLVED, it is a bookkeeping artifact (no cost)

**Claim under test:** `avg_retries` stepped 0→1.0 on Jun 30 — possibly a retry-on-success bug doubling executions.

**Verdict: bookkeeping artifact. Zero execution doubling. Not a cost lever.**

Evidence:

1. **The retry core only re-runs on failure.** `runner/retry.ts:44` — the loop condition is `isRetryable(result.status)`, and `isRetryable` (`retry.ts:16-18`) is `status === 'error' || status === 'fail'`. A `pass`/`warn` never re-executes (`retry.ts:5`: "never retry a success"). There is no unconditional or on-success retry.

2. **`retry_count` stores `attempts` (1-based), where 1 = a single clean execution.** `runner/index.ts:517` destructures `{ attempts: retryCount }` from `runWithRetry`; `attempts` starts at 1 (`retry.ts:43`). So a clean first-try run persists `retry_count = 1`, **not 0**.

3. **The DB proves the "step" is a column turning ON, not executions doubling** (query A, daily):
   - Jun 24–28: `retry_count` is **100 % NULL** (column unpopulated).
   - Jun 29: transition day — 1156 NULL + 698 populated (a mid-day runner deploy; the migration-0048 telemetry began populating).
   - Jun 30 →: populated, and **`retry_count` is never 0** (`min = 1`, `rc0 = 0` every single day). `avg(retry_count)` reads ~1.00–1.05 because the counter went from *unpopulated* (a cost query reads NULL as 0) to *always-≥1*.

4. **Duration correlation confirms `retry_count=1` is one execution** (query B, pass/warn, ≥Jul 1):

   | retry_count | runs | p50 duration |
   |---|---|---|
   | 1 | 57,524 | 464 ms |
   | 2 | 60 | 25,412 ms |
   | 3 | 15 | 128 ms |

   `retry_count=1` is 57,524 runs at a low p50 — a single execution. Genuine re-executions (`≥2`) are **75 runs total = 0.13 %**, and they're the intended fail/error transient-absorption (p50 25 s = two timeout-bound browser attempts). Nothing is doubling.

**So:** the Jun-30 "step" is the retry_count telemetry deploy, not a regression. **No fix needed; no saving available here.** The real driver is volume — runs/day went **1,116 (Jun 24) → 12,236 (Jul 7)** (query A), ~11×, entirely from added checks × regions × frequency.

---

## Cost model (how ACA bills this, and why `sum(duration_ms)` is the right proxy)

- **3 runner jobs**, one per region — `job` (eastus2), `centralusJob`, `westus2Job` — each `cronExpression: '*/5 * * * *'`, `parallelism: 1`, `cpu: 1.0`, `memory: 2Gi`, `replicaTimeout: 240` (`infra/main.bicep:473-475, 528-529`, and the 660/844 mirrors).
- Each tick drains its location's due checks **serially** — `for (const candidate of due)` with an `await` per check (`runner/index.ts:198`), inside a **180 s work budget** (`index.ts:123`).
- Because execution is serial at `parallelism:1`, the replica's billed wall-clock per tick ≈ **the sum of the durations of the checks it ran**. Summed over the day, **billed vCPU-seconds ≈ `sum(duration_ms)` across all runs.** That's why the compute-min figures below map linearly to cost.
- **Region is a literal 3× multiplier:** a 3-region browser check runs its full spec in all three jobs.

**Compute by kind — Jul 7, `sum(duration_ms)` (query E):**

| kind | runs | avg | **compute-min/day** | share |
|---|---|---|---|---|
| **browser** | 4,720 | 14,966 ms | **1,177** | **94.6 %** |
| http | 4,259 | 914 ms | 65 | 5.2 % |
| dns | 3,160 | 55 ms | 2.9 | 0.2 % |
| ssl | 96 | 90 ms | 0.1 | ~0 % |

Total ≈ **1,245 compute-min/day ≈ 20.7 compute-hours/day at 1 vCPU / 2 GiB**.

**Rough $ (ACA Consumption, ~US rates — the Azure bill is the ground truth):** ~74,700 vCPU-s/day ⇒ ~2.24 M vCPU-s/mo. At ~\$0.000024/vCPU-s + 2 GiB × ~\$0.000003/GiB-s ⇒ **~\$65–75/mo compute** now (vs a few \$/mo at the old 263 runs/day — consistent with the reported ~40×). Every lever's saving below is quoted as a share of the 1,245 min/day so it converts to \$ directly.

**Secondary finding — the system is already partially saturated.** The one 5-min browser check (#81) lands only **258–273 runs/region/day vs 288 theoretical** (query L) — ticks are hitting the 180 s budget and *deferring* checks. So reducing browser load isn't only cost: it **restores scheduling headroom and cuts detection latency**.

---

## Lever 1 — fix the slow browser specs  ★ zero coverage cost, do this first

Six flows dominate because their **per-run duration** is huge, independent of frequency (query H):

| id | monitor | avg/run | iv | reg | compute-min/day |
|---|---|---|---|---|---|
| 77 | wegmans-recipe-nav | **33.4 s** | 900 | 3 | 159.7 |
| 197 | wegmans-shop-category-browse | 25.8 s | 900 | 3 | 123.8 |
| 220 | wegmans-recipe-search | 29.0 s | 1800 | 3 | 69.5 |
| 74 | wegmans-search-product | 22.1 s | 600 | 3 | 158.5 |
| 224 | wegmans-search-autocomplete | 22.3 s | 1800 | 3 | 53.5 |
| 80 | meals2go-cheese-pizza-cart | 21.8 s | 900 | 3 | 104.8 |

A 20–33 s browser run is almost always dominated by `waitForLoadState('networkidle')` on ad/analytics-heavy retail pages or over-long explicit waits — **not by the assertion the check exists to make**. Trimming these to ~8–12 s (scoped waits / `waitForSelector` on the asserted element instead of network-idle) is a **spec change with no coverage loss** — same check, same cadence, same regions, just faster. Estimated ~250–300 compute-min/day (~24 %).

**This is the retry-fix equivalent the task asked for: cost out, zero detection lost.** It's a follow-up in `synthwatch-monitors` (per-spec), not a config edit — flagged here as the top actionable lever. Recommend profiling the top 3 (77, 197, 220) first.

---

## Lever 2 — regions on external-site browser flows  ★ needs Craig sign-off

15 of 17 browser checks run in **all 3 regions** (query H; the 2-region ones are nextdoor #194/#195 and amore #192/#193). Their combined compute is ~1,115 min/day — **~90 % of all browser cost is 3-region external flows.**

**The question per monitor: does it need 3 regions?** These monitor **external customer sites** (`wegmans.com`, `meals2go.com`, etc.) whose CDN edge is geo-selected. Three *US* Azure regions hit largely the same Akamai edge tier, so for a functional flow ("does search→product work") the marginal detection from region 2 and 3 is low. Region diversity earns its keep only when a failure is **region-specific** (one bad edge/DNS POP).

| Option | Saving | Coverage traded |
|---|---|---|
| **3→1** (eastus2 only) on the 15 external flows | ~740 min/day (**~60 %**) | **Blind to region-specific edge/CDN/DNS-POP failures.** |
| **3→2** (drop westus2) on the same flows | ~370 min/day (~30 %) | Keeps a 2-region cross-check; loses only the third data point. |

**★ LOAD-BEARING — DO NOT blanket-cut. Keep multi-region on the self/infra monitors:** `synthwatch-self-homepage` (#222), `SynthWatch API health` (#4), `API CORS preflight` (#33). These watch **synthwatch's own Azure infra**, where a *regional* Azure incident is exactly the signal — and per project history the 23 h outage was region-related. Cutting regions here would blind the detector that matters most. (Note #222 is browser and only 18.8 min/day, #4/#33 are cheap http — keeping them 3-region costs almost nothing.)

**Recommendation to weigh:** 3→2 on the external Wegmans/meals2go flows (~30 %, retains diversity) as the low-regret default; 3→1 only on the flows Craig is confident are not region-differentiated. Either way this is the **explicit sign-off lever** — the coverage loss can hide a real (region-scoped) outage.

---

## Lever 3 — frequency on the browse-tier flows

Interval is per-check `interval_seconds` (`checks.interval_seconds`). Browser tiers (query I):

| iv | tier | # browser checks | compute-min/day |
|---|---|---|---|
| 300 (5 min) | #81 wegmans-meals2go-homepage only | 1 | 118 |
| 600 (10 min) | search-product, store-locator, self-homepage, nextdoor-home | 4 | 321 |
| 900 (15 min) | recipe-nav, shop-category, cart, homepage-load, recipe(amore), nextdoor-resv | 6 | **520** |
| 1800 (30 min) | recipe-search, autocomplete, wegmans-home, browse-menu, catering, amore-resv | 6 | 218 |

Group by **how much detection speed actually matters**:

- **Keep tight (transactional / revenue path):** `meals2go-cheese-pizza-cart` (#80) — a cart flow; a break costs orders, so fast detection is worth it. Leave at 900 or tighten.
- **Relax (content/browse pages, low blast radius):** `wegmans-recipe-nav` (#77), `wegmans-recipe-search` (#220), `wegmans-search-autocomplete` (#224), `shop-category-browse` (#197), `meals2go-browse-menu` (#221), `meals2go-catering-browse` (#352). A recipe/catering page being slow-to-detect is low-stakes. **900→1800 / 600→1200 halves each.** Halving the 600+900 browse flows ≈ **~420 min/day (~34 %)**, coverage cost = detection latency doubles (e.g. 15→30 min) on those specific low-stakes flows.
- **#81 homepage at 5 min** is the only browser at 300 s and it's already deferring (query L). Homepage-load at 5-min cadence buys little over 10-min; **300→600 saves ~59 min/day** with minor latency cost.

Frequency is per-flow — the table lets Craig dial each. **Flag:** none of these individually hides an outage the way a region cut can, but stacking Lever 2 (3→1) **and** aggressive frequency cuts on the *same* flow compounds the blind-spot (fewer samples, one vantage point) — decide them together per flow.

---

## Lever 4 — orphans & demo checks (trivial $, easy hygiene)

- **No orphaned disabled checks are consuming scheduled runs** (query J): the only disabled check with recent runs is `Wegmans login — on-demand` (#353, 4 runs since Jul 1) — those are the expected on-demand *sandbox* validations, not scheduled load.
- **`rca-demo` (#59)** → `https://httpbin.org/status/500`: a demo check hammering an external free service 3× region × 5-min (~718/day). It's `retry_count=1` uniformly (query K) — cheap http, **not** amplifying via retries. Cost is negligible (~11 min/day), but it's a **prod demo pointed at a third-party endpoint** — worth retiring or dropping to 1 region for hygiene, not for $.
- **New load landing today:** `wegmans-commerce PREVIEW` (#354, created Jul 08 08:41, enabled, 3 regions) will begin adding 3-region browser load; and #353/#354 are the pre-prod/B2C pair. Not a cut — just noting incremental cost as they ramp.

---

## Lever 5 — http / dns / ssl:  do NOT cut for cost

The volume table makes http (~3 k/day) + dns (~1.8 k/day) look like "half the load," and by **run count** they are — but by **cost** they're **~5.4 % combined** (65 + 2.9 + 0.1 min/day, query E). They're sub-second checks. Cutting their frequency or regions saves cents and removes cheap, fast outage/DNS/cert detection. **Leave them.** (If anything, the 4 DNS + 4 SSL checks could consolidate to 1 region since DNS/cert results aren't region-specific — but the saving is ~3 min/day, not worth the coverage conversation.)

---

## Suggested decision order

1. **Lever 1 (slow specs)** — schedule the `synthwatch-monitors` spec profiling; ~24 % for zero coverage loss. No sign-off needed beyond "do it."
2. **Lever 3 (frequency)** on the browse-tier list — ~34 %, per-flow, low individual risk.
3. **Lever 2 (regions)** — the big one (~30–60 %) **and** the one that can hide a region-scoped outage. **Explicit Craig sign-off**, and keep the self/infra monitors (#222/#4/#33) multi-region.
4. Lever 4 hygiene (rca-demo) whenever convenient.

Levers 1+3 alone (~58 % of browser compute, all low/zero coverage cost) would roughly halve the bill **without** touching the region posture that the 23 h outage says is load-bearing.

---

### Appendix — queries (all read-only)
- A: daily `count(*)`, `avg/min/max(retry_count)`, retry-bucket mix, `runs` Jun 24–Jul 8.
- B: `count`, `avg/p50 duration_ms` grouped by `retry_count` (pass/warn, ≥Jul 1).
- E: `count`, `avg`, `sum(duration_ms)` by `checks.kind`, Jul 7.
- H: per browser check — `interval_seconds`, region count, runs, `avg`, `sum(duration_ms)/60000` compute-min, Jul 7.
- I: browser compute-min by `interval_seconds` tier, Jul 7.
- J: disabled checks with runs since Jul 1. K: `retry_count` dist for #59. L: per-region runs for #81, Jul 7.

*Figures are one representative full day (Jul 7). The Azure Cost Management bill is the $ ground truth; compute-min/day here is the linear proxy for ranking, validated by the serial `parallelism:1` execution model.*
