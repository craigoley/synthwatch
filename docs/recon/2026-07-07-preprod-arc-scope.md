# Pre-prod-regression arc — build-order scope (2026-07-07)

**Analysis only.** Scopes the arc (run the same monitor against dev/staging/prod) into one-concern
PRs with per-step **repo / blast-radius / schema-gate** flags. No code, no schema change, no deploy.

**Evidence contract:** every claim cites `file:line` / command output; OBSERVED vs INFERRED separated;
Postgres/schema behavior checked against the actual `db/schema.sql` and the live `synthwatch-api`
handlers, not memory. Repos read: `synthwatch` (runner + schema, primary), `synthwatch-api` (.NET),
`synthwatch-monitors` (specs). Worktree at `origin/main` HEAD `44195c7`.

## Build order at a glance

| # | Step | Repo | Schema? | Deploy | Blast radius |
|---|------|------|---------|--------|--------------|
| S1a | `checks.environment` column, DEFAULT `'prod'` | runner (`db/`) | **YES — migration** | **manual (serializes)** | additive; existing checks → `'prod'` |
| S1b | default-exclude in `sla_availability()` fn + rollup | runner (`db/` + `rollup.ts`) | **YES — view/fn** | **manual (serializes)** | covers `/sla` + public `/status` in one place |
| S1c | default-exclude in the direct-table API reports | synthwatch-api | no | auto (api CD) | 6 endpoints; per-query `WHERE` |
| S2 | host re-point via runtime page-proxy at `specToFlow` | runner | no | manual (runner) | 1 injection point; **zero spec churn** |
| S3 | first pre-prod check row (env=`staging`) | data (no code) | no | — | one row; safe once S1 lands |
| S4 | dashboard env filter | dashboard | no | auto | near-free (env already a tag dimension) |
| S5 | CI gate-mode (run→verdict→block) | runner+api | **YES — `run_requests`** | manual+auto | new endpoints + auth; see §4 |

**The load-bearing ordering rule:** S1 (protect prod aggregations) must land **before** S3 (any
pre-prod check exists), or pre-prod runs silently corrupt every fleet report. Details in §3.

---

## 1. Host parameterization (S2 primitive) — the cleanest re-point mechanism

### ANSWER: a **runtime `page.goto` origin-rewrite proxy injected at `specToFlow`** — runner-only, zero spec churn. NOT compile/fetch-time substitution (breaks the shared cache), NOT an env-var (rewrites 22 literals).

**OBSERVED — the spec contract is `{ page }`-only.** A fetched Option-C spec is captured as
`CapturedTest.fn: (args: { page: Page }) => Promise<void>` (`runner/specfetch/specShim.ts:35-37,41`)
and run via `specToFlow(fn, page) = (rec) => recorderStore.run(rec, () => fn({ page }))`
(`specShim.ts:70-72`). **The spec receives ONLY `page`** — no `baseUrl`, no context, no env. The host
is a literal inside `page.goto(...)` in the spec body (recon ground truth: ~22 literals / 16 specs).
So the *only* surface the runner can use to re-point a spec **without editing the spec** is the `page`
object it injects.

**This eliminates options (a) and (b) as "least churn":**
- **(b) env-var the spec reads** — requires rewriting every `goto()` literal to `process.env.X + path`
  across 16 specs; and the spec fn has no env handle anyway. Highest churn. ✗
- **(a) manifest `baseUrl` field the spec consumes** — the spec fn signature is `{ page }`; it cannot
  receive a `baseUrl` without changing the shim contract AND every spec to use it. ✗ (A manifest
  `environment→host` *map* is still useful as the runner's SOURCE of the target host — see below — but
  the spec never reads it.)

**Why NOT compile/fetch-time substitution — it breaks the shared cache (OBSERVED, decisive).** The
compiled JS is **content-addressed and shared across every machine and every check**: `spec_cache` is
keyed by `spec_path` alone (`db/schema.sql` PK + `ON CONFLICT (spec_path)`;
`runner/specfetch/specCache.ts:202-214`), and `compileSpec.ts:8-16` documents that the compiled output
is deliberately **machine-independent and portable** (the placeholder/`loadCompiledSpec` swap exists
precisely so one cached `compiled_js` runs everywhere). Substituting the host into the source at
fetch/compile time (the task's option (c)) would make `compiled_js` **env-specific**, forcing a
per-env cache fork and breaking the "one portable artifact per spec" invariant. ✗ So the host must be
applied at **run time**, downstream of the cache — i.e. on the `page`.

### The mechanism (smallest blast radius)

Inject a thin `Page` wrapper at the `specToFlow` boundary whose `goto(url)` **rewrites the origin**
when `url`'s host equals the monitor's canonical (prod) host → the check's target host; every other
navigation (cross-origin redirects, OAuth, third-party) passes through untouched (host-allowlisted, so
it can't silently mis-route). The target host comes from the **check row** (`checks.target_url`, which
already exists) — a pre-prod check of the same spec simply carries the staging `target_url`; the proxy
rewrites the spec's hardcoded prod origin to it.

- **Repo:** `synthwatch` (runner) only. **Monitors repo untouched** (16 specs, 22 literals unchanged).
- **Schema:** none for the primitive (host is `checks.target_url`). *(S1a's `environment` column is
  the label; the host is `target_url`.)*
- **Injection point:** one — wrap `page` before/inside `specToFlow` (`specShim.ts:70`). Baked
  `flow_name` flows already re-point via `FlowContext.baseUrl = check.target_url`
  (StepRecorder) — this closes the *same* gap for the Option-C `spec_path` path.
- **Deploy:** manual (runner CD is Craig-gated). Inert until deployed.

**Falsifier (to run when built):** a spec whose `goto` host ≠ canonical host must NOT be rewritten
(assert an OAuth/third-party `goto` is left intact); a prod-host `goto` on a staging check must land on
the staging origin. **Caveat:** the "canonical host" the proxy matches on must be sourced explicitly
(a per-monitor `canonical_host`, or "the host of the spec's first `goto`") — pick one when building;
do not infer silently.

---

## 2. Environment dimension (S1 data model)

### ANSWER: a runner-owned `checks.environment TEXT NOT NULL DEFAULT 'prod'` column, plus a default-exclude that lives in **two layers** — one runner-owned SQL function (covers `/sla` + the public `/status` page) and six direct-table API endpoints. The recon's 4-endpoint list **undercounts**; the real set is below.

### The column (OBSERVED placement + migration shape)

Lives on `checks` (`db/schema.sql:16`, alongside `target_url:26`). Migration follows the 0054/0045
column-add pattern (transactional `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, schema.sql mirror, "new
installs converge from schema.sql"):

```sql
BEGIN;
ALTER TABLE checks ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT 'prod'
  CHECK (environment IN ('prod','staging','dev'));   -- CHECK optional; mirrors the kind/status CHECK style
COMMIT;
```
- **DEFAULT `'prod'` is load-bearing:** adding a `NOT NULL … DEFAULT 'prod'` column backfills every
  existing row to `'prod'` in one statement (Postgres metadata-only default; no rewrite), so **every
  current check stays in the prod fleet** with zero backfill script. OBSERVED-safe against schema.sql.
- **Grant:** `checks` is already API-SELECT-readable (per CLAUDE.md the SELECT-all grant is out-of-band
  ops, not per-migration), so a new column needs **no** new grant. *(Confirm provenance before assuming
  otherwise — CLAUDE.md's split-provenance rule.)*
- **Why a column, not a tag (OBSERVED):** `check_tags` is used **include-only** — every fleet query
  filters with `ft.key||':'||ft.value = ANY({tags}) … HAVING count(...) = cardinality({tags})`
  (`ReportsFunctions.cs:196-197, 238-239, 275-276`; availability `:507-514`). There is no
  default-EXCLUDE-by-tag path; a tag can't make prod-only the default. A first-class column + a
  `coalesce(environment,'prod')='prod'` default that each aggregation must opt out of is the sound
  model. (`coalesce` also makes the exclude correct against any row a pre-column API build reads as
  NULL.)

### The default-exclude — full enumerated set (corrects the recon's 4)

**Layer A — runner-owned SQL (ONE edit covers the SLA/uptime surface):**
- **`sla_availability(p_from, p_to)` function** (`db/schema.sql:715`) — the single availability
  aggregation. Its views `sla_availability_{24h,7d,30d,90d}` (`:764-775`) feed **`GET /sla`** (all
  windows — `SlaFunctions.cs:32-42`) **and the public `GET /status` page** (`StatusFunctions.cs:47`
  joins `sla_availability_30d`). Add `WHERE coalesce(c.environment,'prod')='prod'` **inside the
  function** → both surfaces are covered at once. ★ A staging check leaking onto the **public status
  page** (via an `area:` tag) is the sharpest failure mode; this is the fix.
- **`daily_check_rollup`** (`db/schema.sql:~789`) — computed by the runner's nightly `rollup.ts`. Decide:
  exclude at rollup-write (pre-prod never rolled up) **or** at read. Write-side is cleaner (keeps the
  table prod-only), but pre-prod loses its own rollup history — a build decision.

**Layer B — synthwatch-api, direct-table endpoints (each needs its own `WHERE`, join `checks` where absent):**
| Endpoint | Handler | Aggregates | Recon named? |
|----------|---------|-----------|--------------|
| `GET /reports/slo` | `ReportsFunctions.cs:170` | `FROM checks c WHERE c.slo_target IS NOT NULL` | ✅ |
| `GET /reports/mttr` | `:216` | `FROM incidents i JOIN checks c` | ✅ |
| `GET /reports/incident-breakdown` | `:256` | `FROM incidents` (no checks join — **must add one** to exclude) | ✅ |
| `GET /reports/trust` | `:307` | `FROM checks c` | ✅ |
| `GET /reports/availability` | `:493` | `daily_check_rollup JOIN checks c` | ❌ **MISSED** |
| `GET /reports/performance` | `:566` | `runs r JOIN checks c` (p95) | ❌ **MISSED** |

**Layer C — CONSIDER (judgment, likely exclude):**
- `GET /reports/region-health` (`:119`) + `GET /reports/egress` (`:80`) — aggregate `runs` per region;
  pre-prod runs would inflate region run counts / egress samples. Probably exclude, but they're infra
  liveness not fleet SLA — Craig's call.
- `GET /reports/narrative` (`:728`) reads precomputed `report_narratives` — the **runner** generates
  those (fleet narrative); the exclude belongs in the runner's narrative rollup, not the API read.

**EXEMPT:** `GET /reports/deploys` (`:40`, keyed on `target_host`, not the check fleet);
`GET /reports/trust/{checkId}` (`:331`) and other single-`check_id` detail endpoints (a caller asking
for one check already scoped it).

**Net:** the exclude touches **1 runner-owned function** (+ rollup decision) and **6 API endpoints**
(+ 3 to adjudicate) — not the 4 the recon listed. Two of the six (`availability`, `performance`) and
the entire `/status` + `/sla` surface were unnamed.

---

## 3. Sequencing — build order + dependency edges

The one hard rule: **prod must be protected before any pre-prod check can exist.** A pre-prod check
row starts producing `runs`/`incidents` the moment it's enabled; if the aggregations don't yet exclude
it, every fleet report (SLO, MTTR, availability, the public status page) is silently polluted. So the
exclude (S1) is a **hard predecessor** of the first pre-prod check (S3).

**Dependency edges (→ = must land first):**

```
S1a checks.environment column ──► S1b sla_available() + rollup exclude ──►┐
        │                    └──► S1c API direct-table excludes ──────────►├──► S3 first pre-prod check ──► S4 dashboard filter
        └────────────────────────────────────────────────────────────────┘                 │
S2 host page-proxy ─────────────────────────────────────────────────────────────────────────┘  (also required before S3 RUNS meaningfully)
S3 ──► S5 CI gate-mode
```

- **S1a → S1b, S1a → S1c:** the column must exist before any query can reference
  `coalesce(environment,'prod')`. (S1b and S1c can proceed in parallel once S1a lands; different repos.)
- **S1a needs a migration ⇒ it SERIALIZES + a manual deploy** before S1b/S1c reference the column. Note
  the shared-table gate: `checks` is a shared table, so S1a's migration also **reds synthwatch-api's
  schema-parity gate** until the api's fixture is patched (CLAUDE.md rule — plan the api fixture bump
  in the same window as S1c).
- **{S1b, S1c} → S3:** do NOT create a pre-prod check until BOTH exclude layers are live, or prod
  reports are corrupted in the gap. This is the load-bearing edge.
- **S2 → S3 (functional):** a pre-prod check can be *created* without S2, but it can't *run the shared
  spec against staging* until the host proxy exists — without S2 it would hit the spec's hardcoded prod
  host (running prod, mislabeled staging). So S2 must land before S3 is *useful*. S2 is
  schema-free/runner-only, so it can develop in parallel with S1 and just needs to be **deployed before
  S3 runs**.
- **S3 → S4:** the dashboard env filter is near-free (recon: env is already a first-class tag
  dimension in the dashboard) and only matters once ≥1 pre-prod check exists. Auto-deploys.
- **S3 → S5:** the CI gate builds on a working pre-prod check (§4).

**Recommended PR sequence (one concern each):**
1. **S1a** — `checks.environment` migration + schema.sql mirror (runner). *Schema; manual deploy;
   reds the api parity gate.*
2. **S1c** — api parity-fixture bump + the 6 direct-table excludes (synthwatch-api). *Auto-deploys;
   unblocks the api queue from S1a.*
3. **S1b** — `sla_availability()` + rollup exclude (runner). *Schema (view/fn); manual deploy.*
4. **S2** — host page-proxy at `specToFlow` (runner). *No schema; manual deploy.* (Parallel with 1–3.)
5. **S3** — first `staging` check row (data/config; a create call — no code).
6. **S4** — dashboard env filter.
7. **S5** — CI gate-mode (§4), last.

Every **runner schema step (S1a, S1b) serializes and needs a Craig-gated manual deploy**; **S1c and S4
auto-deploy** (api / dashboard CD); **S2 is runner, manual, no schema**.

---

## 4. Gate-mode (S5) — what's missing to make "Run now" a pre-deploy gate

### ANSWER: run-now today is **fire-and-forget (202, no verdict)** — the ~20% missing for a CI gate is (a) a request→run→verdict linkage, (b) a machine verdict/poll endpoint, (c) CI-caller auth, (d) a documented verdict→gate policy. Scoped, not built.

**OBSERVED — what exists.** `POST /api/checks/{id}/run` (`ChecksRunFunctions.cs:40-73`) enqueues a
`run_requests` row and returns **`202 Accepted { requestId }`** — asynchronous. `run_requests`
(`db/schema.sql:505-515`) carries only `status IN ('pending','done')` + `completed_at` — it records
**whether** the request was serviced, **not which run it produced nor that run's verdict**. Re-clicks
coalesce (one-pending-per-check partial unique index `:515`). The dashboard's "live progress" arc then
polls `runs`/`run_steps` for display. So the primitive = **trigger + observe-by-polling**; there is no
synchronous verdict and no request→run handle.

**Missing for `CI → run-now → block on verdict → gate promotion`:**

1. **Request→run→verdict linkage (schema).** `run_requests` has no `run_id` and no verdict. A CI caller
   can't tell *which* `runs` row its request produced (it would have to poll `runs` by `check_id` and
   guess — racy against the scheduled cron tick). **Scope:** add `run_requests.run_id` (FK) + surface
   the run's terminal `status` — a schema touch (serializes + manual deploy).
2. **A machine verdict endpoint (api).** `GET /api/checks/{id}/run/{requestId}` returning
   `{ state: pending|done, runId, verdict: pass|warn|fail|error }` when terminal — so CI can poll one
   URL to a decision. (Long-poll optional; simple poll suffices.) Auto-deploys.
3. **CI-caller auth.** Endpoints are session/`Anonymous`-gated for the dashboard; a pipeline needs a
   **scoped service token / API key**, not the OTP→session flow (`AuthFunctions`). New auth path.
4. **A verdict→gate policy (contract).** CI needs stable semantics: does `warn` (perf-budget breach)
   block a promotion? is `error` (infra) a gate-fail or a retry? Document the mapping; expose a single
   boolean/exit-code the pipeline keys on.
5. **A dedicated-run guarantee.** The coalescing index means a gate trigger can attach to an *already
   pending* scheduled run it didn't fully control. For a gate you want "run THIS spec against THIS env
   NOW and give me THAT verdict" — either bypass coalescing for gate requests or correlate the returned
   `run_id` strictly (ties back to #1).
6. **Depends on S1+S2:** a *pre-prod* gate ("run against staging, block promotion") needs the host
   proxy (S2) + env column (S1) already live — hence S5 is last.

**Net S5 scope:** 1 schema change (`run_requests.run_id` + verdict surface), 1–2 api endpoints
(verdict poll + token auth), a documented verdict→gate policy. Runner logic is already ~80% there
(enqueue + execute + live progress); the gap is *closing the loop back to the caller with a verdict*,
not new run mechanics. **Do not build yet** — greenlight S1–S4 first.

---

## Method note

Read `synthwatch` (runner + `db/schema.sql`), `synthwatch-api` (`Functions/*.cs`), and confirmed the
spec contract in `runner/specfetch/*`. Postgres behavior (DEFAULT backfill, view/function aggregation)
checked against `db/schema.sql`, not memory. The recon's aggregation list was corrected against the
live `ReportsFunctions.cs`/`SlaFunctions.cs`/`StatusFunctions.cs` handlers. No code, schema, deploy, or
remote DB access — analysis only.
