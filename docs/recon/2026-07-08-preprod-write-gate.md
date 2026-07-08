# Pre-prod write-gate — why the apply is gated + how to write environment/rewrite_from_origin (2026-07-08)

**Analysis only. Do NOT build. Do NOT un-gate.** Grounds *why* the reconcile field-split apply is gated
and what each write option does, so Craig decides with the blast radius known. Cites `file:line`;
OBSERVED vs INFERRED; each load-bearing claim carries a falsifier. Worktree at `synthwatch` origin/main
HEAD `732649f`; api reads pinned via `git show origin/main:`.

## TL;DR

- **The gate is structural + phased, not a flag.** `reconcileMain` computes+persists the apply *plan* but
  never executes it; the only write to `checks` is the B10 two-column UPDATE. The API *does* have an apply
  executor, behind manual approve→apply.
- **★ NEW BLOCKING FINDING:** my own #216 **desynced the cross-repo positional plan contract** — the
  API's `'new'` materialize reads plan `v[7]` as `interval.GetInt32()`, but post-#216 `v[7]` is the string
  `environment` → it **throws and rolls back**. So the S3 preview check **cannot** be materialized via the
  API apply today, and its INSERT lacks `environment`/`rewrite_from_origin` anyway. Masked by the gate; no
  test covers it.
- **The cross-cutting answer (Q4):** `environment`/`rewrite_from_origin` are **Git-authoritative** (#216).
  So the manifest is their only durable source — a SEED or UI value that **diverges** from the manifest is
  flagged `changed` and **reset on the next apply**. A value that **matches** the manifest survives.
- **Ranked:** (1) **SEED matching monitors #54's manifest values** (smallest, survives, dodges the #216
  bug), (2) fix the #216 materialize desync then apply via the manifest (durable, but an api fix + broad
  blast radius), (3) API/dashboard field (most work, redundant, clobber risk).

---

## 1. What EXACTLY gates the apply (OBSERVED)

**No flag / env var / boolean — the gate is the ABSENCE of an execution call.** `reconcileMain`
(`runner/reconcileMain.ts:185-213`):
- computes the plan and persists it to `reconcile_apply_plan`: `computeApplyPlan(...)` → `persistApplyPlan(plans)`
  (`:190-191`), logged "**NOTHING applied to checks/check_locations**" (`:187, :197`).
- the **only** thing it writes to `checks` is the B10 scoped sync — a hardcoded two-column UPDATE
  (`:206-213`): `UPDATE checks SET sensitive=$2, redact_patterns=$3 WHERE source_key=$1`. `buildApplyUpsert`
  is never called with `pool.query` here.

**Provenance (git log):** the gate is a **deliberate phased rollout**, not an accident:
- `#95` (`1ff0790`, 2026-06-25) — "monitors-as-code config reconcile — drift **DETECT-only** … the
  field-split apply upsert (buildApplyUpsert) is **gated off — a later PR enables it**" (`reconcileMain.ts:6-7`).
- `#152` (`cf8d2a5`, 2026-06-30) — "apply **Phase 0 — DRY-RUN plan** (computed + persisted, **ZERO config
  writes**)".
- `#153` (`d53904c`) — "apply **Phase 1 runner foundation** — decision cols, preserve approvals".

**The API side is NOT gated — it executes approved plans.** `synthwatch-api/Functions/ReconcileFunctions.cs`:
"Reconcile-apply **PHASE 1 — approve / reject / APPLY**" (`:119`), editor-gated + audited, `ApplyCap = 5`
per call (`:123`), executable drift types `{new, missing, changed}` (`:133`). So "gated" = **runner never
auto-applies** + **API applies only a manually-approved plan** (via `POST /api/reconcile/{approve,apply}`).

**Falsifier:** if a runtime flag gated it, `grep -iE "APPLY_ENABLED|gate|if \(.*apply"` in `reconcileMain.ts`
would show a conditional around the execution — there is none; the execution simply isn't written (only the
B10 UPDATE is).

## 2. What the gate protects + blast radius (OBSERVED + INFERRED)

The apply executor is **NOT scoped to environment/rewrite** — it covers the whole field-split:
`ApplyExecutableDriftTypes = {new, missing, changed}` (`ReconcileFunctions.cs:133`); `'new'` = materialize a
check, `'missing'` = soft-disable, `'changed'` = reconverge **every** `CHANGED_UPDATE_COLUMNS` field
(`name, kind, target_url, flow_name, environment, rewrite_from_origin` — `reconcile.ts` GIT_AUTHORITATIVE
minus the redaction pair).

**INFERRED blast radius:** routinely approving+applying (or auto-applying) makes **all** those columns
manifest-authoritative and auto-written for **every** monitor — the manifest could rewrite live
`target_url`/`name`/schedule intent, not just `environment`/`rewrite_from_origin`. That breadth is exactly
what the phased rollout is being cautious about. **Un-gating is broad, not a one-field switch.**

**★ NEW — the #216 materialize desync (OBSERVED, the decisive blast-radius fact).** The API `'new'`
materialize does **not** run the runner's SQL verbatim — it re-constructs its own INSERT from **positional**
plan values (`ReconcileFunctions.cs:225-253`): `v[5]=sensitive.GetBoolean()`, `v[6]=redact`,
`v[7]=interval.GetInt32()`, `v[9]=specPath.GetString()`, and its column list is the **old 10** (no
`environment`/`rewrite_from_origin`). But post-#216 the runner's values array is
(`reconcile.ts:451-464`): `[…sensitive(5), redact(6), environment(7), rewrite_from_origin(8), interval(9),
enabled(10), spec_path(11)]`. So:
- `v[7].GetInt32()` runs on the JSON **string** `'prod'`/`'staging'` → **`InvalidOperationException`** → the
  materialize txn **rolls back**; the plan stays `approved`, never `applied`. A `'new'` check **cannot
  materialize** post-#216.
- Even if it didn't throw, the INSERT omits `environment`/`rewrite_from_origin` → the row would get DB
  defaults (`'prod'`, NULL) → **the S3 re-point is lost.**
- The `'changed'` path is **fine** (`ApplyChangedAsync` executes the runner text **verbatim**, binding
  `$1..$n` as strings — `:200-225`), so this desync is scoped to `'new'` materialize.
- **No test catches it:** the only api integration test (`IntegrationTests.cs`) uses hand-crafted plan JSON,
  not runner-emitted values, so the cross-repo positional contract is untested.

**Falsifier:** if the API executed the runner's rendered SQL text for `'new'` (like `'changed'` does), the
column set + positions would auto-track — but `:248` shows a **hand-written** `INSERT INTO checks
(source_key, name, kind, target_url, flow_name, sensitive, redact_patterns, interval_seconds, enabled,
spec_path)`, 10 columns, positional reads. Confirmed desync.

## 3–4. The three write options × survive-reconcile (the crux)

**Ground truth for Q4 (OBSERVED):** `environment` + `rewrite_from_origin` are **Git-authoritative** — in
`GIT_AUTHORITATIVE_COLUMNS`, compared in `computeDrift` (`reconcile.ts` — flags `changed` when
`existing.environment !== (m.environment ?? 'prod')`), in `CHANGED_UPDATE_COLUMNS`, and mapped in
`buildChangedUpdate.columnValue` (`environment: monitor.environment ?? 'prod'`). **Consequence:** the
manifest is their source of truth; **an out-of-band write that diverges from the manifest is drift and gets
reset to the manifest value on the next `changed` apply.**

| Option | Survives reconcile? | Blast radius / cost | Verdict |
|--------|--------------------|---------------------|---------|
| **(b) SEED** (direct INSERT/UPDATE) | **YES iff it mirrors monitors #54** (`environment='staging'`, `rewrite_from_origin='https://www.wegmans.com'`, `target=preview…`): live == manifest → **no drift** → `changed` never fires. A seed that **diverges** → perpetual `changed` drift → **reset when apply runs**. | Smallest. **Dodges the #216 `'new'`-materialize bug** — a hand INSERT can list `environment`/`rewrite_from_origin` directly. `enabled=false` first. | **★ #1 (stopgap)** |
| **(a) UN-GATE** apply | The durable path — the manifest (#54) IS the source, so materialized values **survive + self-heal** via `changed`. | **NOT smallest — currently BROKEN.** Requires **first** fixing the #216 `'new'`-materialize desync (api: add `environment`/`rewrite_from_origin` to the INSERT + correct positions or switch to verbatim SQL). Then broad blast radius (all git-auth fields, all monitors). | **#2 (durable, later)** |
| **(c) API / dashboard field** | Same Git-authoritative clobber: a UI value that **diverges** from the manifest is reset on apply; one that matches is **redundant** with the manifest. | Most work (endpoint/DTO/UI + the "never a secret… wait, it's not a secret" is fine, but it duplicates the manifest as source). | **#3 (not recommended)** |

**The decisive falsifier for SEED (RESOLVED):** *"Does reconcile overwrite a seeded value back to
default?"* — **Only if the manifest doesn't declare it.** Because monitors **#54** *does* declare
`environment: staging` + `rewrite_from_origin` for `wegmans-search-product-preview`, a seed **matching**
those values sits at zero drift and is never reset. A seed of a value the manifest omits **is** clobbered.
So seed is safe **specifically because #54 shipped the manifest declaration** — verify the seed equals #54
byte-for-byte.

## Recommendation

1. **SEED the S3 check to match monitors #54** (`enabled=false`, `environment='staging'`,
   `rewrite_from_origin='https://www.wegmans.com'`, `target='https://preview.commerce.wegmans.com'`,
   `spec_path` = the search-product spec). It survives reconcile (zero drift vs #54), lets Craig fire the
   on-demand validation now, and **avoids the broken `'new'`-materialize path** entirely. This is the
   pragmatic unblock.
2. **Fix the #216 `'new'`-materialize desync** (api `ReconcileFunctions.cs` INSERT + positions) regardless —
   it's a latent crash for *any* post-#216 `'new'` apply, not just S3. Then, if/when Craig wants
   monitors-as-code to auto-materialize, un-gate with the broad-apply blast radius understood.
3. Skip the API/dashboard field for this Git-managed check — it would duplicate the manifest as source and
   invite the divergence-clobber.

**Why the apply was gated (ground truth):** deliberate phased rollout (#95→#152→#153) of a **broad,
cross-repo, positional-contract** apply engine — precisely the kind of blast radius that shouldn't ship
"dark," and (as the #216 desync shows) exactly the kind that silently breaks when one repo's field layout
changes. The gate is doing its job.

## Method note

Read `reconcileMain.ts` (the gate), `reconcile.ts` (field-split + values order), and
`synthwatch-api/Functions/ReconcileFunctions.cs` (the apply executor) at origin/main; git-logged the gate's
provenance. The #216 desync is OBSERVED (values array `:451-464` vs api positional reads `:225-253`). No
code, schema, deploy, or remote DB — analysis only. Do NOT un-gate.
