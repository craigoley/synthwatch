# SynthWatch AEO/GEO — Feasibility Recon (code-grounded)

_Recon pass for the admin-only AEO/GEO capability (visibility + crawlability). Confirms/refutes
`AEO-GEO-PLAN.md` against the actual code. **RECON ONLY — no code, no PRs.** Every claim is labeled
**OBSERVED** (read from code, file:line) or **INFERRED** (my assessment). Drafted 2026-07-25._

> ⚠️ **Note on the plan doc:** `AEO-GEO-PLAN.md` is **not committed** in any of the four repos
> (OBSERVED — absent from `synthwatch`, `-api`, `-dashboard`, `-monitors`). This recon treats the
> pasted plan as the framing to verify. If you want the plan itself version-controlled, it should be
> committed alongside this file.

---

## TL;DR for the decision-maker

- **Crawlability half reuse: ~65–75%** (refines the plan's "~60%" — it's a bit *more* reusable than
  claimed, if you accept raw HTML from a parallel HTTP fetch). The runner's dispatch, ACA tick,
  browser lifecycle, built-in-flow path, rendered-DOM capture, and UA header plumbing are all already
  present. **Net-new is narrow:** robots/schema/llms parsing + the render-gap diff. **OBSERVED.**
- **Visibility half: the AI call is NOT net-new plumbing** — the codebase already makes bounded,
  audited external AI calls in **three** places (`AoaiClient.cs`, `runner/aoai.ts`, `runner/rca.ts`).
  The transport pattern transfers verbatim; only endpoint/auth changes per engine. **OBSERVED.** It
  does **not** reuse the sandbox (the sandbox *forbids* the AI credential by design). **OBSERVED.**
- **Admin tier exists** above editor and both the API gate (`IsAdminOnlyRoute`/`RequireAdminAsync`)
  and the dashboard (`isAdmin`) already implement it. Admin-only area extends **cleanly**. **OBSERVED.**
- **Cost model does NOT track external AI spend** per-item; a cost ceiling is **net-new env config**
  in the established `CostRate.cs`/`costModel.ts` pattern. **OBSERVED + INFERRED.**
- **"Store raw evidence, derive score, re-score free" fits perfectly** — it's the exact
  `runs → countable_run/latency_sample` view/function idiom. **OBSERVED.**
- **Three items need Craig's decision** (not the agent's): the AI-query fork (API vs browser + ToS),
  the cost ceiling value, and prompt-set authorship. Surfaced at the end, **not resolved**.

---

## 1. The reuse question — crawlability half (the one that decides everything)

**The plan claims ~60% reuse on the crawl half. Verdict: refuted upward — ~65–75%. OBSERVED.**

### What's already there (reuse)

| Component | Reuse | Evidence (OBSERVED) |
|---|---|---|
| Kind dispatch | ~90% | `runner/index.ts:578-583` — an **if-ladder** (`if check.kind === 'http' … else executeBrowser`); add one branch |
| ACA tick / scheduling / budget | 100% | `main()` `index.ts:161`, sequential due-loop `index.ts:230-248`, `MAX_FLOW_MS=600_000` `:132`, `replicaTimeout=660s` `:141` |
| Browser launch/context/page/trace/screenshot/artifact persist | ~95% | `runTracedFlow` `browserFlow.ts:62`, `getBrowser()` reuse `index.ts:156`, `executeBrowser` `index.ts:931` |
| Built-in fixed flow (no user spec) | 100% | `loadFlow(check.flow_name)` `index.ts:1091`, `defineFlow` registry `runner/checks/index.ts:38,46`; existing built-ins `checks/homepage-load.ts`, `wegmans-homepage.ts`, `wegmans-search.ts` |
| **Bot user-agent** | ~90% | `newContext()` is called with **no options** `index.ts:1002` → add `{ userAgent }`; or route-merge `check.request_headers` via `browserHeaderAdditions` `vercelBypass.ts:77`, `index.ts:1032-1037` |
| Rendered DOM capture | 100% | `page.content()` already called `index.ts:1107`, main-doc filter `browserMarker.ts:29` |
| Raw HTML (HTTP path) | 100% | `runHttpCheck` does `res.text()` `httpCheck.ts:119`, merges `request_headers` `:78-81` |
| Raw HTML (browser path) | ~30% | net-new: `response.body()` capture on main-doc response (filter reusable `browserMarker.ts:29`) |
| Render-gap **diff** | ~0% | no existing diff seam — net-new |
| robots.txt / schema.org / llms.txt parsing | ~0% | **none exists** (OBSERVED — grep returns only zod's `json-schema`, no robots/JSON-LD/llms handling) |

### The three decisive sub-answers (item 1)

1. **Fetch AS a specific bot UA today?** *Almost* — it's a **config change, not new plumbing.**
   OBSERVED: no custom UA is set anywhere (`newContext()` has no options `index.ts:1002`;
   `extraHTTPHeaders` is deliberately avoided to prevent secret-header spray `vercelBypass.ts:11`).
   But the per-request header-merge seam already exists (`index.ts:1032-1037`), and the **HTTP path is
   nearly free**: set `user-agent` in `request_headers`, read `res.text()` — a bot-UA raw fetch works
   on `httpCheck.ts` today with zero new plumbing. INFERRED: the clean browser-path version adds
   `{ userAgent }` to `newContext()` (~1 line).

2. **Raw HTML vs rendered DOM for a render-gap diff?** **Seam is partial.** Rendered DOM is free
   (`page.content()` `index.ts:1107`). Raw pre-JS HTML on the *browser* path is net-new
   (`response.body()` is never read today — the response listener only reads `sizes()` `metrics.ts:172-189`).
   The cleaner route: get raw HTML from a **parallel plain fetch** (`runHttpCheck` with the same bot UA)
   and diff against the browser's rendered DOM. The **diff computation itself is 100% net-new.** OBSERVED.

3. **Does `kind` extend, or is it closed?** **Closed enum — adding a kind ripples across repos.**
   OBSERVED: `checks.kind` is a CHECK constraint `db/schema.sql:25-26`
   (`IN ('http','browser','ssl','dns','tcp','ping','multistep')`); the dashboard mirrors it as a union
   `synthwatch-dashboard/src/lib/types.ts:14`; the runner if-ladder dispatches on it `index.ts:578-583`.
   Adding `aeo_crawl` / `aeo_visibility` touches: the CHECK constraint (migration + schema.sql), a new
   runner executor + one dispatch branch, and — because `checks` is an API-mapped shared table — the
   **api schema-parity fixture** (freeze-guard class). The API DTO itself treats kind leniently
   (`string?` `Dtos/RunDtos.cs:114`), and `checks.kind` is **not** in the dashboard enum-coverage gate
   (OBSERVED — absent from `enum-coverage.json`), so the ripple is real but bounded.

   > ★ **INFERRED design caution:** an AEO crawl *result* (robots posture, schema found, render-gap,
   > per-bot status) has **almost nothing in common with a `runs` row** (status/duration/http_status).
   > Forcing AEO into the `checks`/`runs` tables would strain both. The reuse is at the **execution
   > layer** (dispatch, browser lifecycle, ACA tick, `defineFlow`), **not** the `checks`/`runs` **data
   > layer.** Recommend AEO gets its **own tables** (§4) and — optionally — runs as a `defineFlow`
   > built-in under a thin new kind, or even as a separate scheduled path, rather than overloading `runs`.

**Reuse verdict:** the plan's 60% is honest-to-conservative for the crawl half. The heavy infra
(scheduling, browser, trace/artifact, built-in flows, UA) is all present; net-new is the **domain
logic** (robots/schema/llms parsers + render-gap diff), which is small and well-bounded.

---

## 2. The visibility half — the AI-query fork (biggest design decision)

### The AI call is not new plumbing (OBSERVED)

The codebase **already calls an external AI API in three places**, same pattern each time — bounded
`fetch` + `AbortController` timeout + retry-once + token-usage logging + JSON extraction + never-throws
+ feature-gated on env:

- **`synthwatch-api/Infrastructure/AoaiClient.cs`** — cleanest. Azure OpenAI `chat/completions`
  (`:106`), **AAD managed-identity auth, no API key** (`:58,105`), 30s timeout (`:59,123`), retry-once
  on transient (`:60,91-98`), token usage logged (`:137-144`). Fronted by the cost-gating
  `POST /api/runs/{id}/ai-insights` (editor/admin session = "natural cost control"
  `AiInsightsFunctions.cs:11-17`).
- **`runner/aoai.ts`** — the runner's shared transport (`chatCompletionContent()` `:71-124`), MI via
  `AZURE_CLIENT_ID` (`:29-32`), 30s abort (`:81-82`), returns `null` on failure.
- **`runner/rca.ts`** — the fullest worked example and closest analog to an "AI engine call":
  **multimodal** (sends screenshots as `image_url` `:526-535`), `gpt-5-mini`, token budget
  (`RCA_MAX_TOKENS` `:32`), a **24h pattern cache to avoid re-spending** (`:38,509-511`), and an
  **abstain-if-evidence-thin** short-circuit that skips the call entirely (`:519-522`).

**INFERRED:** for the API-call flavor, reuse `AoaiClient.cs`/`aoai.ts` directly. If the engine is
Anthropic/OpenAI/Google rather than Azure, only the endpoint + auth header change (API-key header vs
AAD bearer); the response parsers (`extractJson` `aoai.ts:46-54`) are already provider-agnostic. The
`rca.ts` cache + abstain patterns are directly applicable cost controls.

### The sandbox is the wrong tool for the API flavor (OBSERVED)

The sandbox is a **containment box for untrusted uploaded specs**, not a "make a safe external call"
harness. It is a **separate ACA job** (`synthwatch-sandbox`, `sandboxMain.ts:1`) whose env is
allowlist-built to exclude prod secrets — and its denylist **explicitly includes `AZURE_OPENAI_API_KEY`**
(`sandboxEnv.ts:86-92`). Routing an AI call through the sandbox fights the design. **Reuse the RCA/
ai-insights transport instead.**

The **one** sandbox piece worth reusing — only for the *browser* flavor (driving consumer ChatGPT/Claude
UIs logged in) — is the **split-secret per-run credential channel** (`sandboxPayload.ts`: a per-run AES
key in ARM env + ciphertext in a delete-on-read blob `:173-210`). But it's hard-limited to exactly
`{username,password,bypassToken}` (`:59-63,120-133`), so carrying "an API key + a prompt" would require
extending that interface + its redaction registration. And trusted first-party automation belongs in the
main runner's `runTracedFlow`, not the untrusted-spec sandbox. **INFERRED.**

### ★ The fork — surfaced, NOT decided (Craig's call; item 2)

| | **API-based** (Anthropic/OpenAI/Google APIs) | **Browser-based** (drive consumer surfaces via Playwright) |
|---|---|---|
| Fidelity | Proxy — API model + retrieval **≠** consumer ChatGPT/Gemini answer | True-to-user — the actual answer a customer sees |
| Scale/cost | Clean, batchable, per-token metered | Brittle, slow, one-at-a-time |
| ToS/legal | Within vendor API terms (a supported product) | **ToS-sensitive** — automating consumer web UIs may violate terms; login/session fragility |
| Reuse | High — `AoaiClient.cs`/`aoai.ts`/`rca.ts` transport | Partial — `runTracedFlow` + (extended) sandbox cred channel |
| Auditability | Clean (store request+response+tokens) | Harder (UI scrape, captchas, layout drift) |

**The likely answer** (the plan's own hypothesis, and mine): **API for scale + periodic browser
spot-checks for calibration.** But **this is a judgment call with a legal/ToS dimension that Craig must
make** — see Open Questions. I am **not** picking it.

---

## 3. Cost — this spends real money (item 3)

### What exists (OBSERVED)

Two layers, fused by `GET /api/reports/cost` (`ReportsFunctions.cs:240-280`):
- **Modeled compute** — `cost_projection()` SQL function; models **ONLY ACA compute active-seconds**
  ("half the bill", `runner/azureCost.ts:1-6`), rates `VCPU_SECOND_RATE`/`GIB_SECOND_RATE`
  (`costModel.ts:22-28`). Tracks **no external spend.**
- **Azure actual** — `azure_cost` singleton (`0090:23-34`), the runner pulls Cost Management `mtd_actual`
  = **all meters** for `synthwatch-rg` (`azureCost.ts:134-140`) — a single scalar, no per-service or
  per-item breakdown.

### The AI-spend gap (INFERRED)

- If AEO uses **Azure OpenAI in the same RG**, that spend is *already inside* `mtd_actual` — but
  **un-attributed** (no per-prompt/per-engine line). The existing `ai-insights` feature already spends
  AOAI tokens and records **no token spend anywhere** (`AiInsightsFunctions.cs:14`) — precedent for AI
  calls, zero precedent for AI-cost *tracking*.
- If AEO uses an **off-Azure vendor** (Anthropic/OpenAI/Google direct), the cost model sees it
  **nowhere** — net-new mechanism required.

### Phase-1 cost model (INFERRED, order-of-magnitude)

Plan Phase-1 = ~20 prompts × 3 engines × daily. **60 queries/day ≈ 1,800/month.** At a rough
$0.005–$0.02 per query (short answer, mid-tier model; grading adds a second call ≈ doubles it):
**~$18–$72/month** for querying + grading at Phase-1 scale. Trivial in isolation — **but unbounded by
default**, and it scales linearly with prompts × engines × cadence, so Phase-2 (5 engines, larger
prompt set, sentiment+accuracy scoring = more calls each) could be 5–10×.

### Where the ceiling lives (INFERRED)

- **Bound #1 (reuse today):** the `rca.ts` patterns — a **result cache** (don't re-query identical
  prompt×engine within a window `:509-511`) and **abstain short-circuits** (`:519-522`).
- **Bound #2 (net-new):** a monthly budget as **env config in the established `CostRate.cs` /
  `costModel.ts` deploy-free-tunable pattern** (e.g. `AEO_MONTHLY_BUDGET_USD`, `AEO_MAX_QUERIES_PER_RUN`),
  enforced runner-side in the query loop — stop querying when the month's budget is spent, mark runs
  skipped-for-budget (never silently). **An AI-query capability with no ceiling is a runaway-bill risk;
  this is where it must live.**
- **Bound #3 (governance):** per the ai-insights precedent, the whole area being **admin-gated** is
  itself a cost control (only admins can trigger spend).

---

## 4. Data model + the store-raw-derive principle (items 4, 5)

### The pattern fits perfectly (OBSERVED)

"Store raw evidence, derive the metric, re-derive without re-collecting" is a **first-class pattern**
here: `latency_sample` (`0092:32-36`) and `countable_run` (`0081:37-50`) are **VIEWS over raw `runs`**;
`sla_availability()`/`slo_status()` are **STABLE SQL functions** over those views. Change the predicate
once → all history re-derives, zero re-collection. Rollups (`daily_check_rollup` `0028:34-73`) are an
idempotent nightly `INSERT … ON CONFLICT DO UPDATE` recompute-from-raw (`rollup.ts:38-128`).

**INFERRED:** the plan's core principle — *store the raw answer, derive the score; a rubric change
re-scores history without re-querying (re-query costs money, re-score is free)* — maps **exactly** onto
this idiom. The raw `aeo_visibility_run.answer` is the evidence (like `runs`); the visibility score is a
VIEW/STABLE-function over it (like `countable_run`).

### Schema sketch (INFERRED — recon confirms it's idiomatic)

```
aeo_prompt          (id, text, intent, competitor_set jsonb, active, created_at)         -- git-authored config
aeo_engine          (id, name, kind[api|browser], endpoint, cost_per_query_usd, enabled)
aeo_rubric          (id, version, definition jsonb, created_at)                          -- ★ versioned scorer
aeo_visibility_run  (id, prompt_id, engine_id, started_at,
                     answer_ref  /* blob pointer, NOT inline */,                         -- ★ raw evidence
                     citations jsonb, competitors_named jsonb,
                     rubric_version, model_used, tokens_used, cost_usd)                  -- ★ cost attribution
aeo_crawl_target    (id, url, page_type, active)                                         -- ★ Wegmans URLs only
aeo_crawl_run       (id, target_id, bot_ua, started_at, http_status,
                     schema_found jsonb, llms_txt jsonb, robots_posture jsonb,
                     render_gap jsonb, raw_html_ref, rendered_dom_ref)                   -- refs, not inline
-- derived (VIEWS / STABLE functions, re-derivable):
aeo_visibility_score(run)   -- presence/position/sentiment from answer + rubric_version
aeo_share_of_voice(window)  -- % prompts where Wegmans appears vs each competitor
aeo_crawl_score(run)        -- AI-accessibility composite
```

**Two OBSERVED constraints that shape this:**
- **Large answer text → blob, not a wide TEXT column.** Retention keys off `runs.started_at` + CASCADE
  (`retention.ts:73-88`); a new table is *outside* that family, so it needs its own batched-DELETE pass
  **aligned to the same 90d `artifactRetentionDays` clock** (`retention.ts:11-12,30`). The codebase's
  established idiom for large payloads is **blob storage with a lifecycle policy** (artifacts), DB holding
  only the reference — so store `answer`/`raw_html`/`rendered_dom` as **blobs** (lifecycle-expired at 90d)
  and keep only refs + derived score in Postgres. This preserves *both* re-derivability and the
  rows+blobs-expire-together invariant. **INFERRED.**
- Views must use an **explicit column list, never `SELECT *`** (`0083`, `0092:24-26`) or they freeze the
  schema-parity contract.

### Auditable scoring — LLM grading an LLM (item 5, INFERRED)

- **Raw answer stored** (as a blob ref) → the score is always reproducible from evidence.
- **Rubric is versioned** (`aeo_rubric.version`, stamped on each run as `rubric_version`). This is the
  **same-concept-same-predicate discipline** the codebase already lives by (e.g. `STOPPED_CHECK_PREDICATE`
  exported so a test drives the shipped string; `countable_run`'s predicate is the one definition). A
  score change is then **distinguishable from a real-world change**: if `rubric_version` moved, it's a
  scoring change; if the raw answer moved under a fixed rubric, it's reality moving.
- **Human-spot-checkable:** the dashboard drill-down shows the raw answer next to the derived score, so a
  human can re-grade by eye — mirrors how the incident timeline shows raw runs behind a derived verdict.
- **Re-score is free:** bump the rubric, re-run the derivation function over stored answers — no
  re-querying, no spend. This is the single most important cost+integrity property and it's **fully
  supported** by the view/function idiom.

---

## 5. Auth + surface (items 6, 7)

### Admin tier exists above editor — extends cleanly (OBSERVED)

- Roles: `Roles.Admin = "admin"` (`AuthTokens.cs:9`); `CanWrite => Admin or Editor`,
  `IsAdmin => Role == Admin` (`AuthPrincipalService.cs:10-11`). **A real three-tier model**
  (anonymous/viewer → editor → admin).
- **Admin-only routing already implemented:** `IsAdminOnlyRoute` gates `/editors` + `/access-requests`
  (`AuthGate.cs:58-66`); the gate denies an editor hitting an admin route with 403 (`:88-89`); handlers
  add defense-in-depth via `RequireAdminAsync` (`EditorsFunctions.cs:43-51`, `if (!principal.IsAdmin)`).
- **Dashboard already exposes it:** `auth-provider.tsx:44` surfaces `isAdmin` (live-validated via
  `GET /auth/me` on mount `:66-77`, role kept live). `authMe()` returns `{email, role}`
  (`api-client.ts:2765-2767`).

**Verdict:** an admin-only AEO area is a **clean reuse**, not net-new auth. API side: add the AEO routes
to `IsAdminOnlyRoute` (or a sibling matcher) + `RequireAdminAsync` in the handlers. Dashboard side: gate
the area/nav on `isAdmin` (the same one-line pattern `CredentialsPanel` uses for `canWrite`). **OBSERVED
+ INFERRED.**

### Dashboard surface (item 7, INFERRED — partial; the dashboard agent hit a usage limit)

OBSERVED patterns that apply directly (from this and prior sessions): the reconcile-style config editor
(`components/reconcile-drift.tsx`), the credentials-style admin editor (`components/credentials-panel.tsx`,
already `canWrite`/`isAdmin`-gateable), status cards/badges (`components/status-badge.tsx`), and the
report cards/trends used across `/reports`. INFERRED: the AEO area is a new `src/app/aeo/` route gated on
`isAdmin`, reusing: **cards** (scoreboard tiles), **trend/sparkline** (share-of-voice over time),
**freshness stamps** ("updated N ago"), the **drift indicator** (share-of-voice drop = the same "went
red" affordance), and a **reconcile-style editor** for the prompt set + competitor set. The prompt set
lives in **monitors** as git-versioned config (the prompt set *is* the test definition — same as monitor
specs). *This sub-item is INFERRED and lighter than the others because the dedicated dashboard agent
failed on a usage limit; the auth-gating half is OBSERVED and solid.*

---

## 6. Scope boundary — never crawl competitors (item 8, OBSERVED-against-sketch)

**The design as sketched respects the boundary.** The only fetch targets are `aeo_crawl_target` rows,
which are **Wegmans-owned URLs** (homepage, store locator, product/category, recipes, Meals2Go, careers).
Competitor *visibility* comes exclusively from **`aeo_visibility_run`** — i.e. from **asking the engines**
("who sells organic groceries near Rochester?") and parsing which competitors the engine names, **never**
from fetching competitor sites.

**Guardrails to enforce this in build (INFERRED):**
- `aeo_crawl_target` should carry an **allowlist constraint** (Wegmans domains only) — a CHECK or a
  validated-on-write domain gate, so a competitor URL cannot be added as a crawl target.
- The crawl executor must fetch **only** `aeo_crawl_target` rows — never a URL derived from a visibility
  answer's citations. **Flag:** the tempting-but-forbidden move is "the engine cited competitor X, let's
  go crawl X to see why" — the design must **not** do that. Citations are *recorded*, never *fetched*.

Nothing in the sketch crosses the line today; the allowlist constraint makes it structurally enforced.

---

## 7. Phase-1 build proposal (scoped to provably-reusable + smallest net-new)

**Goal: prove the loop, admin-only, minimal spend, maximum reuse.**

**Crawlability first** (it's the most reusable and produces day-one value — a bot-block or missing-schema
finding is immediately actionable):
1. New tables `aeo_crawl_target` + `aeo_crawl_run` (runner-owned migration; **not** yet API-mapped → does
   **not** trip the schema-parity freeze-guard, so it lands runner-first cleanly). Blob refs for
   raw_html/rendered_dom, 90d-aligned retention pass.
2. A crawl executor reusing the **HTTP path** for the bot-UA raw fetch (`httpCheck.ts` + UA in
   `request_headers` — near-zero net-new) and, where render-gap matters, `page.content()` from a browser
   run. Net-new domain logic: robots.txt parser, schema.org/JSON-LD extractor, llms.txt check, render-gap
   diff. ~6 Wegmans page types × the major bots.
3. Reuse the ACA tick + `defineFlow` built-in path; no new job unless cadence differs.

**Visibility second** (small, bounded):
4. New tables `aeo_prompt` (config in monitors), `aeo_engine`, `aeo_rubric`, `aeo_visibility_run`.
5. Query loop reusing the **`aoai.ts`/`rca.ts` transport** (API flavor), with the `rca.ts` **cache +
   abstain** cost controls and a **net-new `AEO_MONTHLY_BUDGET_USD` ceiling** (CostRate-pattern env),
   enforced runner-side. ~20 prompts × 3 engines (ChatGPT/Gemini/Claude) daily.
6. Scoring as a **VIEW/STABLE function** over stored answers, stamped with `rubric_version` (re-score
   free).

**Surface:**
7. API: read endpoints under `IsAdminOnlyRoute` + `RequireAdminAsync`; a paired `fixtures/schema.sql`
   patch **only when** the API first maps an AEO table (defer until the read endpoint ships).
8. Dashboard: `src/app/aeo/` gated on `isAdmin` — scoreboard cards + crawlability report + raw-answer
   drill-down, reusing existing card/trend/freshness/drift components.

**What Phase-1 deliberately excludes:** Perplexity + Google AI Overviews, sentiment/accuracy scoring, the
render-gap diff engine (Phase-2), the visibility↔crawlability correlation join (Phase-3), any
content-generation, any competitor crawling.

---

## ★ OPEN QUESTIONS — need Craig's decision (NOT resolved here)

1. **The AI-query fork + ToS (the biggest one).** API-based (scalable, but a proxy for the real consumer
   answer) vs browser-based (true-to-user, but ToS-sensitive and brittle). My recon supports the
   hypothesis "**API for scale + periodic browser spot-checks for calibration**," and the API transport is
   ready to reuse — **but the ToS/legal question on driving consumer AI surfaces is a judgment call for
   Craig (and possibly legal), not the agent.** Decide the fork before build.

2. **The cost ceiling value.** Where does `AEO_MONTHLY_BUDGET_USD` (and per-run cap) get set? Phase-1 is
   ~$18–$72/mo, but the mechanism must exist *before* the first scheduled run or it's a runaway-bill risk.
   **What monthly number is acceptable, and what happens at the ceiling** (skip-and-alert vs hard-stop)?

3. **Prompt-set authorship.** Who writes the ~20 category questions, and how do we keep them
   representative of **real** customer intent (Razorfish input? real search-query data? the Wegmans
   category taxonomy?) rather than what we wish people asked? This decides whether the headline
   Share-of-Voice number means anything.

_(Also worth a nod, not blocking: whether AEO engine spend bills to the synthwatch Azure RG — if so it's
already inside `mtd_actual` un-attributed — or to an off-Azure vendor, which the cost model can't see at
all. That informs whether cost tracking is "attribute the existing scalar" or "net-new meter.")_

---

## Cross-repo gotchas the build must respect (OBSERVED, from CLAUDE.md + migrations)

- **Runner owns all schema**; API/dashboard are read-mostly consumers (`CLAUDE.md:3`).
- Migration ceremony: numbered file + `schema.sql` entry + **role-guarded** `GRANT SELECT TO
  "synthwatch-api"`; `CREATE INDEX CONCURRENTLY` in a **separate non-transactional** migration.
- **Shared-table freeze-guard:** touching an API-mapped table REDS the api's required schema-parity gate
  until the paired `fixtures/schema.sql` lands — so keep AEO tables **runner-owned + API-unmapped** until
  the read endpoint is ready, then ship the fixture in the same/next api PR.
- A new ACA job (if AEO needs its own cadence) must be wired in **three** places (`RUNNER_IMAGE_JOBS`,
  `deploy.yml`, `infra/main.bicep`) or CI fails.
- Retention window is pinned to `artifactRetentionDays=90`; AEO evidence blobs + rows must expire on that
  same clock.
```
