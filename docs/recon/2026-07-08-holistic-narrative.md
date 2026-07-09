# Holistic narrative + cost/deploy correlation — recon (2026-07-08)

**Recon first (this doc), then build the 3 layers.** Evidence = `file:line` + OBSERVED/INFERRED. The four
required outputs (fact-pack contents, deploy-marker reachability, reports-tab default, drivers-limit) are up
front; the layer plans + one flagged decision follow.

## The four required findings

### 1. Current fact pack contents (runner/narrative.ts) — OBSERVED
`FactPack` (`narrative.ts:43-58`) = `current`/`previous` `PeriodFacts` + `deltas` + `incidentList` + `anomalies`:
- `PeriodFacts` (`:18-31`): `up, down, availabilityPct, downtimeMin, incidents, p50, p95, p99, latencyN, lcpP75`.
- `deltas` (`:50-55`): `availabilityPts, downtimeMin, incidents, p95Pct` (WoW).
- `incidentList` (`IncidentFact` `:33-41`): check, severity, opened/resolved, durationMin, classification, summary.
- `anomalies[]` (`:189-222`): code-flagged strings (avail drop >1pt, p95 up >20%, incidents up, repeat-offender,
  fleet lowest-availability top-3).
- **NO cost dimension. NO deploy markers.** Confirms gaps (i) + (iii). Window = **7d** (`:15-16`).

### 2. Are deploy markers reachable to the narrative job? — OBSERVED: YES
`narrativeMain.ts:6` imports `pool` (full DB) and calls `runNarratives()`; `computeFactPack` already runs
arbitrary `pool.query` (incidents, rollup, repeat-offenders). The **`deploys` table** (`schema.sql`:
`target_host, sha, is_sha, source, deployed_at, detail`) is in the same DB — **directly queryable** by the job
for the `[curStart, end)` window. It is simply **not queried today**. So change #2 (deploy markers → fact pack)
is a new `pool.query` in `computeFactPack`, no plumbing. INFERRED: correlate incidents to `deployed_at` in-prose.

### 3. Reports-tab default mechanism (dashboard) — OBSERVED
- Tabs: `TABS: TabDef[]` = `performance, reliability, monitors, trust, cost` (`src/app/reports/page.tsx:26-32`;
  the "Cost" tab #222 added at `:31`, imported `:15`, rendered `:299-303`).
- **Default is the fallback arg, NOT array[0]:** `useTab(TAB_IDS, "performance")` (`page.tsx:60`); `useTab`
  (`src/components/tabs.tsx:15-29`) seeds `useState(fallback)`, overridden only by a valid `?tab=` param.
- **The AI narrative is NOT a tab today** — `NarrativeCard` (`src/components/narrative-card.tsx:81-167`) renders
  **page-level above the TabBar** (`page.tsx:172`, hidden when a tag filter is active), i.e. across all tabs.
- To make it its own DEFAULT tab: add a `TabDef` (e.g. `{id:'summary', label:'AI summary'}`), move the
  `NarrativeCard` into a `tab === 'summary'` block, and change the fallback `"performance"` → `"summary"`.

### 4. Drivers-limit location — OBSERVED: SERVER-side (api), top-10
- `/reports/cost` (`synthwatch-api/Functions/ReportsFunctions.cs:229-255`) returns the **full** `Checks` array
  UNBOUNDED (all enabled; SQL `ORDER BY c.name`, no LIMIT — `:248`), but the pre-ranked **`TopCostDrivers` is
  `checks.Take(topN)`** with **`topN = 10`** (`Infrastructure/CostReportProjection.cs:18,30`).
- Dashboard prefers `data.top_cost_drivers` verbatim; a **client fallback** `.slice(0,5)` only when that array
  is empty (`src/components/cost.tsx:76-78`).
- **Fix for top-50:** bump `topN` `10 → 50` in `CostReportProjection.cs:18` (server-side; the dashboard then
  gets 50). "or all if <50" is automatic (Take caps, never pads).

## ★ The flagged decision: cost model divergence ("same model as /reports/cost")

**There is NO shared cost SQL** (grep of `db/` for a cost function/view → empty). The cost model is **api-only
C#** — `CostReportProjection.cs`: `projected = avgDurationS × (2,592,000/interval) × regionCount × rate`
(`:38-40`), `measured = Σsec_7d × rate × 30/7` (`:42`), `divergence = measured/projected` flagged `>1.5`
(`:43,46`); inputs are one SQL (`ReportsFunctions.cs:236-248`: `region_count, avg_duration_s, sum_duration_s_7d`).
The `rate` is the api appsetting `COST_RATE_PER_VCPU_SECOND` (#198).

The runner (TS) adding cost to the fact pack must produce **byte-identical** figures. Two options:
- **(A) Extract cost into a shared SQL function** (runner owns schema): a `cost_projection(rate, from, to)` SQL
  function both `/reports/cost` (api swaps its C# math to call it) and the narrative job query. **Single model,
  can't drift** — the "no second cost model" invariant enforced structurally. Cost: a runner migration + an api
  refactor of `CostReportProjection` to call it. **Recommended.**
- **(B) Replicate the formulas + rate in the runner.** Lighter (no api change), but it IS a second copy of the
  math + the rate constant → drift risk the task explicitly warns against. Only acceptable with a shared
  golden-fixture test pinning runner-figures == api-figures (the extractor-parity discipline from #170-172).

**Recommendation: (A).** It's the honest reading of "no second cost model," and the rate/formulas live once.

## Layer plans (contract-first, in deploy order)

### Layer 1 — runner (the core; deploy first)
- **1a cost → fact pack:** via the shared SQL fn (decision A). Add to `FactPack`: `cost: { fleetProjected,
  fleetMeasured, fleetDivergence, perCheck: [{name, projected, measured, divergence}] for notable monitors,
  topDrivers }`. Figures MATCH /reports/cost by construction.
- **1b deploy markers → fact pack:** `deploys` rows in `[curStart,end)` → `deployMarkers: [{deployedAt,
  targetHost, source, sha}]`. Enables "incident began N min after deploy X" instead of "check deployments".
- **1c prompt rewrite (`SYSTEM_PROMPT` `:243-249`):** section-by-section → **cross-signal synthesis** —
  unreliable∩expensive∩recently-changed intersection; cost-divergence as leading indicator; correlate incident
  timing to `deployMarkers` (or "no correlated deploy → external/regional"); lead with the top item; WoW
  deviations; ban filler. **★ Reinforce the cited-numbers guard:** `missingFigures`/`spotCheck` (`:302-319`)
  currently only check availability + incidents — EXTEND to cover the new cost/deploy figures so the bigger pack
  can't invite invented numbers. Keep the structured output + What-Changed/Anomalous/Actionable spine, now
  cross-referencing. Update `buildFallback` (`:253+`) to cite cost too.

### Layer 2 — api (thin; nearly a no-op) — OBSERVED
- `NarrativeDto.FactPack` is an **opaque `JsonElement`** (`Dtos/NarrativeDto.cs:21`), re-emitted verbatim
  (`ReportsFunctions.cs:815`). **The expanded fact pack (cost + deploy keys) flows through with NO DTO change.**
- `fact_pack` is `jsonb` in the fixture (`tests/fixtures/schema.sql:892`) — unchanged type → **no fixture bump**.
  (`ReportNarrativeRow.cs:8-9` carries a "reconcile if the migration differs" note — confirm it still matches;
  it does today.)
- Only real api change: **`topN` 10→50** for the cost drivers (decision-4). If decision (A), also the
  `CostReportProjection`→shared-SQL refactor. **No AOAI, no generation** (architecture invariant held).

### Layer 3 — dashboard
- **AI summary → own tab, DEFAULT:** add `{id:'summary'}` to `TABS` (`page.tsx:26-32`), move `NarrativeCard`
  into its block, change `useTab` fallback → `'summary'` (`page.tsx:60`). Mirror the #222 Cost-tab pattern.
- **Cost top-50:** automatic once the api `topN=50` lands (dashboard reads `top_cost_drivers` verbatim).
- **Cost chips:** `FactChips` (`narrative-card.tsx:55-73`) already renders `data.factPack` as `NarrativeFact[]`
  (`label/value/delta`). ★ **Open wiring detail:** the api serves the runner's `fact_pack` **verbatim** as an
  opaque object, but `FactChips` expects a `NarrativeFact[]`. Confirm during build whether a chip array is
  derived (api or dashboard) from the structured pack, and ensure the **cost citations are included** in that
  chip list (consistent with the latency-delta chips). This is the one place the passthrough ≠ the chip shape.

## Build order + gates
**runner (Layer 1, manual deploy — regenerates the narrative) → api (Layer 2: topN=50 + shared-SQL if A;
confirm opaque passthrough) → dashboard (Layer 3: default AI tab, top-50, cost chips).** Each layer's fact-pack
contract feeds the next. The narrative only changes after the runner deploys + the nightly narrative job runs.

---
### Appendix — evidence index
- Fact pack: `narrative.ts:18-58` (shape), `:144-240` (compute), `:243-249` (prompt), `:253-273` (fallback),
  `:302-319` (cited-numbers guard). Job DB reach: `narrativeMain.ts:6`.
- Deploys: `db/schema.sql` deploys table (`deployed_at/target_host/source/sha`).
- Cost model: api `Functions/ReportsFunctions.cs:229-255`, `Infrastructure/CostReportProjection.cs:12,18,24-30,
  38-46`. No shared cost SQL (grep empty).
- Narrative serve: api `ReportsFunctions.cs:782-816`, `Dtos/NarrativeDto.cs:11-21` (opaque `factPack`),
  fixture `tests/fixtures/schema.sql:883-895`, `Data/Entities/ReportNarrativeRow.cs:8-9`.
- Dashboard: `src/app/reports/page.tsx:26-32,60,172,299-303`, `src/components/tabs.tsx:15-29`,
  `src/components/narrative-card.tsx:55-73,81-167`, `src/components/cost.tsx:76-78,104-115`.
