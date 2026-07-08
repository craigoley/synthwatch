# On-demand run when paused — current mechanism, the block, and the scoped fix (2026-07-08)

**Analysis only.** Grounds how "Run Now" works today, the exact reason it's blocked for a paused
monitor, and the scoped fix — so on-demand-when-paused is build-ready. Immediate driver: the S3 check
`wegmans-search-product-preview` ships `enabled=false` and must be fire-able on-demand to validate it.
Cites `file:line`; OBSERVED vs INFERRED. Worktree at `synthwatch` origin/main HEAD `83a50b8`.

## TL;DR

- **On-demand today** = `POST /api/checks/{id}/run` → the API writes a `run_requests` row + kicks the
  runner ARM job; the runner's `drainRunRequests` picks it up and force-runs it through the **normal
  `runOne`** path (full run + trace + evaluate/alert/incident/SLO).
- **Blocked when paused at THREE gates, all keyed on `checks.enabled`** — (a) API policy 409, and (b)
  two runner data-query filters (`drainRunRequests` + `forceClaim`). **Not** a UI gate (there is no
  dashboard Run Now control at all). So the fix is **backend + data-query**, at all three gates.
- **"Paused" == `enabled=false`** — not a `maintenance_windows` row (that's separate planned downtime).
- **The red-test already proves** out-of-band, side-effect-free execution of a *disabled* check is
  architecturally solved (`loadCheck` has no `enabled` filter; it writes only a `red_tests` row). So the
  fix is "add a sandbox mode + relax the three `enabled` gates," **not net-new execution machinery**.
- **★ Craig's decision:** does a paused on-demand run write a visible `runs` row but **skip `evaluate()`**
  (no alert/incident/SLO) — my lean — or run fully, or be fully ephemeral? See §4.

---

## 1. What is "on-demand run" today (OBSERVED, end to end)

**API — `POST /api/checks/{id}/run`** (`synthwatch-api/Functions/ChecksRunFunctions.cs`, `RunCheckNow`):
1. loads `{ Id, Enabled }` for the check; 404 if unknown, **409 if `!Enabled`** (`:49`).
2. inserts a `run_requests` row `status='pending'` (`:52` `_db.RunRequests.Add`); idempotent via the
   partial unique index (one pending per check) → a duplicate coalesces onto the existing pending id.
3. kicks the runner ARM job (`:71` `_runnerJob.StartAsync`) — best-effort; a failed start leaves the row
   `pending` for the next cron tick. Returns `202 { requestId }`.

**Runner — `drainRunRequests`** (`runner/index.ts:340`), run BEFORE the due-loop each tick (`:189`):
- selects pending requests whose check is enabled + assigned here (`:347-352`), atomically claims each
  (`UPDATE … SET status='done' WHERE status='pending'`, `:360`), dedups against an in-flight run, then
  `forceClaim`s (`:380`) and runs it through **the normal `runOne`** (`:389`) — "so trace / signals /
  verdict / RCA flow identically" (`:337`). So an on-demand run is a **full, side-effecting run**
  (writes `runs` + `run_metrics` + trace, and `runOne`→`evaluate` does alerts/incidents/SLO), the same
  as a cron run — there is **no sandbox mode** (both cron `:213` and on-demand `:389` call the same
  `runOne(check)`).

## 2. ★ Why it's unavailable when paused — THREE gates, all on `checks.enabled` (OBSERVED)

| Gate | Type | Location | Effect |
|------|------|----------|--------|
| (a) API 409 | **POLICY** | `ChecksRunFunctions.cs:49` `if (!check.Enabled) return Conflict("Monitor is paused …")` | No `run_requests` row is even created for a disabled check. |
| (b) drain filter | **DATA** | `index.ts:350` `JOIN checks c ON c.id = rr.check_id AND c.enabled` | Even if a request existed, the drain **never selects** a disabled check's request (the comment `:341-345` is explicit: a disabled check would else "CONSUME the request without running it — a lost on-demand run"). |
| (b) forceClaim filter | **DATA** | `index.ts:415` `WHERE … AND c.enabled` | Even past the drain, `forceClaim` returns `null` for a disabled check → the run never starts. |
| (c) UI | **N/A** | — | There is **no dashboard Run Now control** for *any* check (`grep -rniE "run now|/run" synthwatch-dashboard/{app,components,lib}` → empty). So the UI isn't *hiding* it — it doesn't exist. |

**Conclusion:** the block is **(a) POLICY + (b) DATA at two runner queries** — a three-place backend
change. Removing only the API 409 would NOT work: the drain (`:350`) and `forceClaim` (`:415`) would
still skip the disabled check. (The cron due-loop's own `enabled` filters — `:289`, `:317` — are
correct and out of scope; a paused monitor should stay off the schedule.)

## 3. ★ What is "paused" (OBSERVED)

**`paused` == `checks.enabled = false`** (`db/schema.sql:106` `enabled BOOLEAN NOT NULL DEFAULT TRUE`).
The API's own 409 text ("Monitor is **paused** — resume it") maps pause↔`enabled`. `maintenance_windows`
(`schema.sql:405-416`) is a **separate** table — planned-downtime spans (`starts_at`/`ends_at`) that
suppress alerting/SLA (LEFT-JOINed in the SLA math, `:777`), **not** the pause state. So the on-demand
path must gate on the `enabled` flag (which all three gates already do) — there is no separate "paused"
status column to consult.

## 4. Design — the minimal on-demand-when-paused path (scoped, not built)

Three layers must change; the persistence question is Craig's.

**Layer 1 — API (`RunCheckNow`).** Replace the blanket 409 with an allowed path for a disabled check.
Recommended: keep the 409 as the *default* but honor an explicit intent — a `?sandbox=true` (or body
`{ sandbox: true }`) that creates the request for a disabled check and **marks it** so the runner treats
it as a paused/sandbox run. (Explicit intent avoids "resume it" being the only feedback while not
silently running paused monitors on every accidental call.)

**Layer 2 — Runner pickup (`drainRunRequests:350` + `forceClaim:415`).** Relax the `c.enabled` filter
for a flagged request. Options: (i) carry the flag on `run_requests` (a new `sandbox`/`run_when_paused`
boolean column — `run_requests` today is `{id, check_id, status, requested_at, completed_at}`, no flag
room) and gate the enabled-bypass on it; or (ii) drop the enabled filter on the on-demand drain entirely
and let the API be the sole gate (simpler, but a stale request for a since-disabled check would then
run — the flag (i) is safer). **Both** `drainRunRequests` and `forceClaim` need the same relaxation.

**Layer 3 — Side-effects (`runOne` → `evaluate`).** `evaluate()` (`runner/evaluate.ts:131`) opens
incidents + dispatches alerts + SLO-burn and is **NOT** `enabled`-gated (the env-based S1 exclude is
api-report-side only, `#188`). So a paused check's on-demand run would today **page + open an incident**.
A sandbox/paused run must **skip `evaluate()`** (no incident, no alert, no SLO burn). `runOne` currently
takes no sandbox flag — one must be threaded from the flagged request.

### ★ THE PERSISTENCE DECISION (Craig's — flag, don't assume)

Craig's S3 use case is *"prove it works without turning it on"* — argues for a run that is **visible but
counts against nothing** and does **not** flip `enabled`. Three shapes:

- **(A) VISIBLE-BUT-INERT** *(my lean)*: write the `runs` row + trace (so the dashboard shows the verdict
  + trace for validation) but **skip `evaluate()`** — no incident/alert/SLO. Doesn't flip `enabled`. For
  the S3 check specifically it *also* stays out of the prod slo/mttr/trust reports because it's
  `environment='staging'` (#188) — so no new `runs` mark is needed for S3. For a *prod* paused monitor, a
  marked run (a `runs.on_demand`/`sandbox` boolean the nightly rollup + SLA views exclude — a small
  schema touch) keeps its own rollup clean. **Sub-decision:** rely on evaluate-skip alone, or also mark
  the row.
- **(B) FULLY EPHEMERAL** (mirror the red-test): run out-of-band, write **nothing** to `runs`; surface
  the verdict transiently. Zero pollution, but the trace/screenshot aren't persisted for review — weaker
  for "let me see why it failed."
- **(C) FULL RUN** (just allow `runOne` for disabled checks): simplest, but writes + **evaluates** → a
  paused monitor can page/incident on a failed on-demand run. **Not recommended** — defeats "paused."

**Recommendation:** **(A)** — skip `evaluate()`, write the visible `runs` row + trace, don't flip
`enabled`. Minimal for S3 (staging already excludes it from prod aggregates); for prod paused monitors,
add the `runs` exclusion mark as a follow-up. Persistence + the mark are Craig's call.

## 5. Does the existing machinery already do most of this? (OBSERVED — YES, partially)

The **red-test** already runs a *disabled* check's spec **out-of-band and sandboxed**: `redTestMain`'s
`loadCheck` is `SELECT * FROM checks WHERE id=$1` — **no `enabled` filter** (`runner/redTestMain.ts:48`);
it uses an ephemeral recorder that writes **nothing** to `run_steps` (`runner/redTest.ts:118`) and
persists **only** a `red_tests` row (`persistRedTest`, `:169-172`) — no `runs`, no incident, no alert.
So *"execute a paused check's spec out-of-band with no side-effects"* is **already architecturally
solved**. BUT the red-test **injects a fault** (route-block/bad-url) and asserts the monitor goes *red* —
it proves it *can* fail, not that it *passes green* against the target, which is what S3 validation
needs.

**INFERRED:** the fix is therefore **not net-new machinery** — it's "add a sandbox mode to the normal
on-demand `runOne` path (skip `evaluate`, optionally mark/omit the `runs` row) + relax the three
`enabled` gates for a flagged request." The red-test proves the sandbox model works; the on-demand path
reuses `runOne` (real verdict, real trace) instead of the fault-injecting red-test harness.

## Method note

Traced `POST /checks/{id}/run` → `run_requests` → `drainRunRequests`/`forceClaim` → `runOne`/`evaluate`
across `synthwatch-api`, `synthwatch` runner, and `synthwatch-dashboard` (no Run Now UI found). Gates and
"paused"==`enabled` verified against `ChecksRunFunctions.cs`, `runner/index.ts`, and `db/schema.sql`. No
code, schema, deploy, or remote DB — analysis only. The persistence/side-effect shape (§4) is flagged as
Craig's decision.
