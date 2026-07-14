# SynthWatch — architecture decision record

> _Verified 2026-07-14 — prose with **no automated check**. These are design rationale; where one names a
> file, behaviour, or default, the code is authoritative. Moved out of `README.md` so nine decisions don't
> sit between a newcomer and the first runnable step._

Why the runner is shaped the way it is.

## Decision 1 — Azure Container Apps Jobs, not Vercel (or any serverless function)

A browser check needs a **real Chromium** — around 150–300 MB of binary plus all
its OS dependencies (fonts, `libnss`, `libatk`, …). Vercel (and comparable
function platforms) cap a deployment bundle at roughly **50 MB**. Chromium does
not fit, full stop. You cannot ship a real browser into that box.

ACA **Jobs** give us:

- A container we fully control, so we use
  `mcr.microsoft.com/playwright:v1.61.0-noble` as the base — Chromium and every
  OS dependency are already baked in and known-good.
- A **scheduled** execution model (cron) that matches "run checks on a timer".
- **Parallel replicas** for throughput, which we lean on (and guard against — see
  Decision 3).

The HTTP tier could run almost anywhere; the browser tier is what forces a real
container. Running both in one runner keeps the system simple.

> Runtime note: ACA (and local `docker run`) should pass **`--ipc=host`**.
> Chromium uses a lot of shared memory; the default 64 MB `/dev/shm` triggers
> renderer crashes under load.

## Decision 2 — Cadence lives in the database, not in cron

Each check carries its own `interval_seconds` and `last_run_at` **columns**. The
Job is scheduled on the **finest tier only** (`*/5` UTC). On each tick the runner
self-filters to checks that are actually due:

```
now() - last_run_at >= interval_seconds
```

Why not encode cadence in cron? Because you'd need one cron entry — and one
deployment concern — per distinct interval (5 m, 30 m, 1 h, …), and changing a
single check's cadence would mean editing infrastructure. With cadence in data,
adding a check or retuning its interval is a single `UPDATE`; the schedule never
changes. The cron tier just needs to be **at least as fine** as the smallest
interval you want to support.

## Decision 3 — Claim each check with a conditional UPDATE (parallel-safe)

ACA runs Job replicas **in parallel by default**. If two replicas both saw the
same due check, it would run twice per tick. We prevent that without locks or a
queue: each replica *claims* a check with a conditional `UPDATE` that advances
`last_run_at` **only if the check is still due**, and `RETURNING` the row:

```sql
UPDATE checks
   SET last_run_at = now()
 WHERE id = $1
   AND enabled
   AND (last_run_at IS NULL
        OR now() - last_run_at >= make_interval(secs => interval_seconds))
RETURNING *;
```

The single-statement `UPDATE` is atomic, so exactly one replica's claim returns a
row — that replica owns the check. Every other replica's `UPDATE` matches zero
rows (the row is no longer due) and it moves on. No double execution, no extra
infrastructure.

## Decision 4 — Funnel telemetry is structural, not optional

Every browser flow runs through a **`StepRecorder`**. Each logical action is
wrapped in `rec.step('<name>', async (page) => { … })`, which:

1. times the step,
2. writes a `run_steps` row (pass **or** fail) before returning, and
3. on failure, records the row, remembers the step name, and **rethrows** so the
   flow stops exactly where it broke.

The result: a failed run shows **which step it died at**, with timings for every
step before it — without re-running anything.

This is enforced by *design*, not by convention. The `StepRecorder` holds the
Playwright `Page` **privately** and only hands it to the callback *inside*
`step()`. A flow receives the recorder and nothing else, so there is no way to
drive the browser without being timed and recorded. You cannot write a flow that
skips instrumentation.

## Decision 5 — Pin the Playwright npm package to the base image version

The Dockerfile's base image is `mcr.microsoft.com/playwright:v1.61.0-noble` and
the `playwright` npm dependency is pinned to the **same** `1.61.0`. Playwright
resolves browser binaries by a version-specific path; if the library and the
image drift, the npm package looks for a Chromium build that isn't in the image
and launches fail. **Bump both together, never one alone.**

## Decision 6 — Alerting is 100% env-config driven (this repo is public OSS)

Two vendor-neutral channels ship in `alerts.ts` — email (Azure Communication
Services) and a generic webhook (PagerDuty / Slack / any HTTP endpoint). **The
env vars are documented in `runner/.env.example` (the source of truth — not
re-copied here, so this can't drift from it).** An absent env var means that
channel is **disabled** — no errors, it simply doesn't fire.

Vendor-specific channels are intentionally kept out of this open-source engine.
Wire one either (1) via the generic webhook — point the webhook env at the
vendor's inbound endpoint — or (2) in a fork, by implementing the `AlertChannel`
interface in `runner/alerts.ts` and adding it to `CHANNELS`.

There is **nothing tenant-specific in source**: no addresses, URLs, or secrets.
Channels dispatch concurrently and failures are isolated, so one dead webhook
never blocks the others. Failure **screenshots** follow the same rule
(`artifacts.ts`): if `AZURE_STORAGE_CONNECTION_STRING` is unset, the upload
silently no-ops.

## Decision 7 — Debounce incidents to suppress flapping

`evaluate.ts` opens an incident only after **`failure_threshold` consecutive
failures** (default 3) and resolves it on the **first** subsequent pass. A single
transient blip never pages anyone. A partial unique index
(`one_open_incident_per_check WHERE status = 'open'`) keeps incident state
coherent in the database; because each check is claimed by exactly one replica
per tick, that index is a backstop rather than the primary guard.

## Decision 8 — Two-repo split: runner here, dashboard on Vercel

The runner needs a **full container with Chromium** and runs on ACA Jobs
(Decision 1). The dashboard is a Next.js app that deploys best on Vercel. These
have different runtimes, deploy cadences, and scaling models, so they live in
**separate repositories** rather than a monorepo:

- The runner can be rebuilt/redeployed (and its Playwright/base-image pair bumped
  together — Decision 5) without touching the dashboard, and vice versa.
- Each repo gets a focused CI/security surface (this repo's scanners target a
  Node/TS **backend**, not a React/Next frontend).
- The shared contract between them is the **database schema** (`db/schema.sql`),
  not shared application code.

## Decision 9 — Generated DB types are committed, not built on demand

Types that mirror the schema are **generated at commit time and checked in**,
rather than regenerated during every build or at runtime. Committing them means
`tsc` type-checks against a concrete, reviewed artifact; schema changes show up as
a **visible diff** in the PR (easy to review and to catch drift); and neither CI
nor the dashboard needs a live database connection just to type-check. The
trade-off — remembering to regenerate after a schema change — is enforced by
review and the schema/migration convergence check.
