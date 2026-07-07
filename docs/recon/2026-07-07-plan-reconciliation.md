# Plan reconciliation — tracked-open vs origin/main ground truth (2026-07-07)

**Analysis only.** Reconciles items tracked as "outstanding / to-build / deferred" against what's
actually merged on each repo's `origin/main`, after the plan-marker-rot class bit repeatedly this
session (things reported "not built" that were already shipped). **No issues are closed here** — the
stale set + close commands are listed for Craig.

**Sources.** There is **no `MASTER-PLAN.md`** in any repo and **zero open GitHub issues** across all
four (`gh issue list --state open` → empty ×4). So "tracked-open" is reconstructed from this session's
recon docs (the `2026-07-07-*.md` set) + the task's named examples, reconciled against merged PRs
(`gh pr list --state merged`, last ~22/repo) and live `origin/main`.

## Reconciliation table

| Item (tracked as…) | Reality | Evidence | Class |
|---|---|---|---|
| S3 monitors preview check — "not built, needs Craig's domain input" (my #216 session summary) | **DONE** | monitors **#54** merged 2026-07-07T20:25Z — `wegmans-search-product-preview`, DISABLED, reuses search-product, `rewrite_from_origin: www.wegmans.com`, `target: preview.commerce.wegmans.com`, `environment: staging`, `sensitive: false`; resolves every domain Q I flagged incl. the route-mismatch caveat | **DONE-BUT-TRACKED-OPEN** |
| manifest ajv can't declare `environment`/`rewrite_from_origin` (my wired-audit #217 §3) | **DONE** (my doc is stale) | monitors **#54** added both properties + the rewrite-requires-target guard to `manifest.schema.json`; my #217 grep hit a **stale monitors checkout** → §3 needs correction | **DONE-BUT-TRACKED-OPEN** |
| B2C login monitor — "design doc, not shipped" (#214 header recon) | **DONE** | monitors **#52** merged 2026-07-07T18:50Z (InfoSec B2C login instrument, DISABLED, sensitive) — **shipped 37 min BEFORE #214 merged (19:27Z)**: intra-session marker-rot | **DONE-BUT-TRACKED-OPEN** |
| "Part B" trust consumer (api trust scorecard read) | **DONE** | api **#149** `GET /reports/trust` (live on origin/main: 6 refs in `ReportsFunctions.cs`); #156/#188 extended it | **DONE-BUT-TRACKED-OPEN** |
| "3 api issues stale-open with merged resolving PRs" (task) | **already CLOSED** | api issues **#172** (auth-enforcement default), **#169** (failure_threshold divergence), **#158** (parse-intent drops fields) — all `state=CLOSED, reason=COMPLETED` (resolved by #173/#174, #176, and the parse-intent fix). **Nothing to close.** | **STALE→already-resolved** |
| D1-v2 red-test **cron** (PR2) | **GENUINELY OPEN** (deferred by design) | synthwatch **#210** — deferred: the harness is single-check, not fleet-sweepable (http auto-testable, browser needs per-monitor anchors, ssl/dns have no fault path). Intentional, not rot | **GENUINELY-OPEN** |
| Per-monitor **secret** headers | **GENUINELY OPEN** | #214 recon = scoped design only; `request_headers` (plaintext) + `auth` (`*_env` secret-ref) exist, but a per-check secret **header** needs the browser-path secret-injection (unbuilt) | **GENUINELY-OPEN** |
| Pre-prod arc **WRITE path** (materialize a non-prod / re-pointed check) | **GENUINELY OPEN** — the real remaining blocker | The reconcile field-split **apply is GATED OFF** (`reconcileMain.ts:186`, `reconcile.ts:8`), and no api/dashboard field sets `environment`/`rewrite_from_origin`. So monitors #54's preview check is **declared but can't materialize into `checks`** — it'll be detected as `new` drift and not applied. See wired-audit #217 §2 | **GENUINELY-OPEN** |

## Findings

**Marker-rot (DONE but was tracked-open): 4 items** — the S3 preview check (#54), the manifest ajv
fields (#54), the B2C monitor (#52), and the trust consumer (#149). Two of these (#52, #54) shipped
**during this very session**, and one of them (#54's manifest fields) stales a doc I wrote **minutes
earlier** (#217 §3). That's the fastest marker-rot yet: recon → ship → recon-of-recon, all same day.

**Genuinely open: 3 items** — D1-v2 cron (deferred by design), per-monitor secret headers (design
only), and the **pre-prod arc write path** (the reconcile-apply gate). The last is the one that
matters: monitors #54 + runner #215/#216 + api #188 mean the arc is **fully declared and read-wired**,
but a pre-prod check still **cannot become a live `checks` row** until the apply is un-gated (or a row
is seeded / an api-dashboard field is added). Cross-ref: wired-audit #217 §2.

**Stale issues to close: NONE.** All four repos have zero open issues; the three api issues the task
named are already `CLOSED/COMPLETED`. No close commands needed. (If any reopen, the pattern is
`gh issue close <n> -R craigoley/synthwatch-api -c "resolved by #<pr>"`.)

## In-flight PRs (not stale, for context)

- synthwatch **#217** (draft) — the merged-not-wired audit; **its §3 is now stale** (monitors #54).
  A one-line correction is queued (the manifest CAN now declare the fields; the WRITE gate is the live
  finding). This reconciliation IS the catch.
- synthwatch-dashboard **#212** (draft) — mock-vs-prod divergence recon.

## Method note

`gh issue list`/`gh pr list` across all four `craigoley/*` repos; merged-PR titles + live `origin/main`
grep (`git show origin/main:<file>`) as ground truth. No `MASTER-PLAN.md` exists — tracked-open was
reconstructed from the session's recon docs. Nothing closed; no code/schema/deploy — analysis only.
