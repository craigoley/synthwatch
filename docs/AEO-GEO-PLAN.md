# SynthWatch AEO/GEO — Capability Plan

_A new admin-only area of SynthWatch measuring how the Wegmans brand performs in answer
engines (ChatGPT, Gemini, Claude, Perplexity, Google AI Overviews) and how well those
engines can crawl and extract from Wegmans properties._

_Drafted 2026-07-25. Inspired by the Retailgentic / Kartik Hosanagar episode ("AI is a new
customer category") and paralleling the Razorfish brand-measurement engagement — this gives
Wegmans an in-house, continuously-running instrument alongside the consultancy's periodic reads._

> **Status:** framing/vision doc. Feasibility against the actual code is assessed in
> [`AEO-GEO-RECON.md`](AEO-GEO-RECON.md) (the code-grounded recon that confirms/refutes the
> assumptions below). Read that for the reuse %, the cost model, the schema fit, and the open
> questions that need a decision before any build.

---

## ★ The thesis, in one line

**Answer engines are a new distribution channel, and right now Wegmans has no instrument
measuring its position in that channel or its readiness to compete in it.** The commercial
AEO tools (Writesonic, Scrunch, Frase, Qwairy) measure the *visibility* half well and the
*crawlability* half barely — and SynthWatch already owns the infrastructure that makes the
crawlability half strong. So this is not "rebuild Writesonic"; it's "build the half we're
uniquely positioned for, and cover the other half well enough to correlate the two."

★ **Why in-house, not just the tool or the consultancy:**
- **Razorfish** gives periodic, expert, strategic reads — but not a daily-cadence instrument
  you own and can query on demand.
- **Commercial AEO tools** give visibility tracking — but treat your site as a black box and
  can't see *why* an engine failed to cite you (blocked crawler? no schema? JS-rendered content
  a bot can't reach?). ★ SynthWatch can, because it already drives real browsers and can fetch
  as a specific bot user-agent.
- ★ **The correlation is the prize:** "we rank poorly for `where to buy organic groceries near
  Rochester` AND GPTBot gets a 403 on our store-locator" is a causal story neither the tool nor
  the consultancy can hand you. Owning both halves is what produces it.

---

## The field splits cleanly into two halves

### Half 1 — VISIBILITY (are we in the answer, and how?)
The question the marketing tools answer. For a set of category questions a real Wegmans customer
would ask, query each answer engine and measure:
- **Presence** — does Wegmans appear in the answer at all?
- **Position / prominence** — first-named, listed, or a footnote?
- **Share of voice vs. competitors** — Wegmans vs. Whole Foods, Trader Joe's, Giant Eagle, Kroger,
  Instacart, local chains — across the same prompts.
- **Sentiment / framing** — is Wegmans described positively, neutrally, or with a caveat?
- **Citations** — *which sources* did the engine pull from to answer? (Wegmans.com? A third-party
  listicle? A review site? A competitor's page?) ★ This is the actionable one — it tells you
  where to invest.
- **Accuracy** — is what the engine says about Wegmans (hours, offerings, locations, policies)
  actually correct? A confidently-wrong answer is a brand risk, not just a visibility gap.

### Half 2 — CRAWLABILITY (can the engines read and extract from us?)
★ **The half SynthWatch is built for and the commercial tools skip.** For key Wegmans page types
(homepage, store locator, a product/category page, recipes, Meals2Go, careers):
- **Bot access** — fetch each page AS GPTBot / OAI-SearchBot / ClaudeBot / Claude-SearchBot /
  PerplexityBot / Google-Extended and record the actual response (200 / 403 / 302-to-login /
  soft-block). ★ The research is explicit that these are DISTINCT bots with distinct jobs
  (training vs. search-index vs. live-fetch) and blocking the wrong one silently removes you from
  that engine's answers — e.g. blocking OAI-SearchBot removes you from ChatGPT search even if
  GPTBot is allowed.
- **robots.txt posture** — parse Wegmans robots.txt and report, per AI bot, allowed/blocked, and
  flag the dangerous cases (accidentally blocking a *search* bot while intending to block a
  *training* bot — the most common self-inflicted wound in the research).
- **llms.txt presence** — is there a `/llms.txt` / `/llms-full.txt`? Is it valid? (Proposed
  standard; low cost, signals intent, increasingly referenced.)
- **Structured data / schema** — does each page type carry valid schema.org markup
  (Organization, LocalBusiness, Product, Recipe, FAQ, BreadcrumbList)? ★ This is the single
  biggest extractability lever in the research — a model lifts a clean quote far more easily from
  marked-up content.
- **Extractability** — is the answer content in server-rendered HTML a bot sees, or JS-injected
  content it may not? ★ SynthWatch's Playwright can render-vs-raw diff this directly — fetch the
  raw HTML (what a bot gets) vs. the rendered DOM (what a browser gets) and flag content that
  only exists after JS. This is a class of finding the marketing tools cannot produce.
- **Answer-readiness** — are key facts (hours, locations, return policy) in scannable,
  passage-level form a model can extract, or buried in prose/images?

★ **The two halves correlate.** A visibility gap (Half 1) plus a crawlability defect on the
relevant page (Half 2) is a *diagnosed* problem with a fix, not just a symptom. That join is the
capability's reason to exist.

---

## What SynthWatch already has that this reuses

★ This is why it's a SynthWatch feature and not a greenfield app:
- **Playwright + the ACA runner** — real-browser fetches, render-vs-raw diffing, per-region
  execution, custom user-agents. The Half-2 engine is *mostly already built* as monitoring infra.
- **The scheduled-check cadence** — AEO/GEO is a track-over-time problem (did last month's schema
  fix move our share of voice?), and SynthWatch's scheduler + Postgres history is exactly that
  shape. Every measurement becomes a time series for free.
- **The sandbox** — isolated execution for the AI-query calls (which cost money and hit external
  APIs), with the bounds/audit already built.
- **The cost model** — AI queries across 5 engines × N prompts × daily cadence is a real spend;
  the cost panel already tracks and forecasts, and this plugs into it.
- **The reporting + dashboard surface** — cards, trends, freshness stamps, the drift-indicator
  pattern. A "share of voice dropped 12% this week" alert is the same machinery as a check going
  red.
- **The admin/editor auth model** — admin-only gating reuses the existing role check.

★ **The honest build estimate:** Half 2 is ~60% existing infrastructure repurposed. Half 1 is
mostly new (the AI-query orchestration, response parsing, the scoring rubric) but small and
well-bounded. The dashboard/reporting is the existing patterns applied to new data.

> **Recon note:** the code-grounded read refines these estimates — the crawl half is ~65–75%
> reusable (a bit *more* than claimed), and two plan assumptions are corrected: the AI-query path
> does **not** reuse the sandbox (the sandbox forbids the AI credential by design; reuse the
> RCA/ai-insights transport instead), and the cost model does **not** track external AI spend
> per-item (a ceiling is net-new env config). See `AEO-GEO-RECON.md`.

---

## Proposed architecture (to be confirmed in recon)

★ Reuses the 4-repo split; nothing new structurally:
- **runner** — two new check *kinds*: `aeo_visibility` (query engines, parse, score) and
  `aeo_crawl` (bot-UA fetch, schema/robots/llms parse, render-diff). Owns new schema tables.
- **api** — read endpoints for the AEO dashboard; the admin gate; the prompt-set CRUD.
- **dashboard** — the admin-only AEO area: visibility scoreboard, crawlability report, trends,
  the prompt-set editor, the competitor set.
- **monitors** — the AEO prompt sets and crawl targets as declared config (git-versioned, same
  as monitor specs — the prompt set IS the test definition).

### Data model (sketch — recon confirms)
- `aeo_prompt` — a category question, its intent, its competitor set, active/archived.
- `aeo_engine` — chatgpt / gemini / claude / perplexity / google-ai (endpoint, cost-per-query).
- `aeo_visibility_run` — (prompt × engine × timestamp) → presence, position, sentiment, the raw
  answer, the citations extracted, the competitors named. ★ Store the RAW answer (it's the
  evidence; scoring is derived and re-runnable).
- `aeo_crawl_target` — a Wegmans URL + page type.
- `aeo_crawl_run` — (target × bot-UA × timestamp) → status, schema found, llms.txt, render-diff,
  answer-readiness score.
- ★ Every scored value stores its raw evidence alongside, so a rubric change re-scores history
  without re-querying (re-querying costs money; re-scoring is free). Same "store the evidence,
  derive the metric" discipline as the rest of SynthWatch.

---

## Metrics that matter (the scoreboard)

**Visibility side:**
- ★ **Share of Voice** — % of category prompts where Wegmans appears, vs. each competitor. The
  headline number.
- **Average position** when present.
- **Citation share** — of sources engines pull from, what % are Wegmans-owned. ★ The lever you
  can most directly act on.
- **Sentiment index** — positive/neutral/negative framing when mentioned.
- **Accuracy rate** — % of factual claims about Wegmans that are correct. ★ A brand-risk metric,
  not just visibility.
- **Answer volatility** — how much do answers change run-to-run? (High volatility = an unstable
  position you can influence; stable = entrenched, harder to move.)

**Crawlability side:**
- ★ **AI-Accessibility Score** — per page type, per bot: can it be fetched, is it marked up, is
  the content extractable. The composite health number.
- **Schema coverage** — % of key pages with valid, relevant schema.
- **Bot-block audit** — the count of *unintended* AI-bot blocks (the self-inflicted-wound metric).
- **Render-gap** — pages where important content is JS-only and a bot can't see it.

---

## Phasing

**Phase 1 (admin-only, prove the loop):**
- Half 2 crawlability for ~6 Wegmans page types across the major AI bots — ★ *this is the
  fastest to stand up because it's mostly existing Playwright infra*, and it produces value on
  day one (a bot-block or missing-schema finding is immediately actionable).
- Half 1 visibility for a starter set of ~20 category prompts across 3 engines (ChatGPT, Gemini,
  Claude) — presence, position, share of voice, citations.
- The admin dashboard: scoreboard + the crawlability report + raw-answer drill-down.

**Phase 2:**
- Expand to Perplexity + Google AI Overviews; grow the prompt set; add sentiment + accuracy
  scoring; trend lines and week-over-week deltas; alerting on share-of-voice drops.
- ★ The render-vs-raw diff engine (the differentiated crawlability finding).

**Phase 3:**
- The correlation join (visibility gap ↔ crawlability defect on the cited page type).
- Competitor deep-dives; a "recommended actions" surface; export for the Razorfish syncs.
- Possible: MCP-driven agentic-shopping simulation (the Hosanagar "levels 0–5" framing — can an
  AI agent actually complete a Wegmans pickup order? That's a SynthWatch browser flow already).

---

## ★ Open questions for recon (these decide feasibility, don't guess them)

1. **AI-query mechanism.** Do we query engines via their APIs (clean, but the API answer ≠ the
   consumer ChatGPT answer — different model, different retrieval), or drive the actual consumer
   surfaces via Playwright (true-to-user, but ToS-sensitive and brittle)? ★ This is the single
   biggest design fork and it has legal/ToS dimensions — recon must surface the tradeoff, not
   pick blindly. The commercial tools mostly use APIs + their own retrieval; the honest answer
   may be "API for scale, periodic browser-based spot-checks for ground-truth calibration."
2. **Cost envelope.** 5 engines × N prompts × daily = real money. What's the monthly spend at
   Phase-1 scale, and does it fit the existing cost model's tracking?
3. **Bot-UA fetching legality/ethics.** Fetching Wegmans' OWN site as GPTBot is fine (it's your
   site). Confirm nothing here fetches anyone else's property in a way that's problematic —
   competitor visibility comes from *asking the engine*, never from crawling competitors.
4. **Scoring rubric.** Presence is binary and easy; position/sentiment/accuracy need an LLM to
   score the answer. ★ That means an LLM grading an LLM — recon should design the rubric so it's
   auditable (store the raw answer, make the score reproducible, spot-checkable by a human).
5. **Prompt-set authorship.** Who writes the category questions, and how do we keep them
   representative of real customer intent rather than what we wish people asked? (Razorfish input?
   Real search-query data? The Wegmans category taxonomy?)
6. **Reuse vs. new.** How much of the crawl side genuinely reuses `executeBrowser` / the runner
   vs. needs a new path? (Recon reads the code — don't assume.)

> All six are answered in `AEO-GEO-RECON.md`; #1, #2 (the ceiling value), and #5 remain
> **decisions for Craig**, not the recon's to resolve.

---

## What this is NOT (scope discipline)

- ★ NOT a content-generation tool. The commercial platforms bundle "AI writes the fix" — out of
  scope. This MEASURES and DIAGNOSES; humans (and Razorfish) decide the fix. Keeps it honest and
  keeps us out of the "AI-generated SEO spam" business.
- NOT public or customer-facing. Admin-only, internal instrument.
- NOT a Razorfish replacement. It's the continuous instrument *between* their strategic reads.
- NOT crawling competitors. Competitor data comes from asking engines, never from scraping.
