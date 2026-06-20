# SynthWatch

A self-hosted synthetic monitoring system. SynthWatch runs **HTTP** and
**real-browser (Playwright)** checks on a timer, records every run (and every
*step* of a browser flow), and opens/resolves debounced incidents with pluggable
alerting.

This repository currently contains the **data-plane runner**, the **database
schema**, and the **container image**. No dashboard and no infrastructure-as-code
yet — those land in later PRs. This document is an **architecture decision
record**: it explains *why* the runner is shaped the way it is.

---

## What's in this PR

```
db/
  schema.sql              Postgres 16 schema (checks, runs, run_steps, incidents)
  seed.sql                One HTTP check + one browser check
runner/
  index.ts                due-filter -> claim -> execute -> evaluate
  db.ts                   Postgres pool + row types
  httpCheck.ts            Cheap HTTP tier (plain fetch, no browser)
  stepRecorder.ts         Mandatory funnel instrumentation
  evaluate.ts             Debounced incident open/resolve
  alerts.ts               Email (ACS) / Teams / xMatters — env-driven
  artifacts.ts            Failure screenshot -> Azure Blob (no-op if unconfigured)
  checks/
    index.ts              Dynamic flow loader (validates flow name)
    homepage-search.ts    TEMPLATE flow (placeholder selectors)
  Dockerfile              Built on the official Playwright image
  package.json            Pinned dependencies
  tsconfig.json           NodeNext / ES2022, strict
  .env.example            Every env var, documented
```

---

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

Three pluggable channels ship in `alerts.ts`:

| Channel | Env vars | Disabled when… |
| --- | --- | --- |
| Email (Azure Communication Services) | `ACS_EMAIL_CONNECTION_STRING`, `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO` | any unset |
| Microsoft Teams | `TEAMS_WEBHOOK_URL` | unset |
| xMatters inbound | `XMATTERS_INBOUND_URL` (+ optional `XMATTERS_AUTH_HEADER`) | unset |

An absent env var means that channel is **disabled** — no errors, it simply
doesn't fire. There is **nothing tenant-specific in source**: no addresses, URLs,
or secrets. Channels dispatch concurrently and failures are isolated, so one dead
webhook never blocks the others. Failure **screenshots** follow the same rule
(`artifacts.ts`): if `AZURE_STORAGE_CONNECTION_STRING` is unset, the upload
silently no-ops.

## Decision 7 — Debounce incidents to suppress flapping

`evaluate.ts` opens an incident only after **`failure_threshold` consecutive
failures** (default 3) and resolves it on the **first** subsequent pass. A single
transient blip never pages anyone. A partial unique index
(`one_open_incident_per_check WHERE status = 'open'`) keeps incident state
coherent in the database; because each check is claimed by exactly one replica
per tick, that index is a backstop rather than the primary guard.

---

## Data model

- **checks** — the catalogue (target, kind, cadence, thresholds, severity).
- **runs** — one row per execution. Inserted pessimistically as `fail` *before*
  execution so a crashed/OOM-killed runner leaves an honest record, then flipped
  to `pass` on success. Indexed by `(check_id, started_at DESC)`.
- **run_steps** — one row per `StepRecorder.step()` (browser flows).
- **incidents** — open/resolved lifecycle with severity, linked to the runs that
  opened and resolved them.

Primary keys use `BIGINT GENERATED ALWAYS AS IDENTITY`.

---

## Local development

```bash
# 1. Apply the schema and seed (Postgres 16)
psql "$DATABASE_URL" -f db/schema.sql
psql "$DATABASE_URL" -f db/seed.sql

# 2. Runner
cd runner
cp .env.example .env          # fill in DATABASE_URL (+ optional alert channels)
npm install
npm run typecheck             # tsc --noEmit, must be clean
npm run build                 # -> dist/
node dist/index.js            # one tick: due-filter -> claim -> execute -> evaluate
```

To exercise the browser tier locally, run the container so Chromium and its OS
deps are present:

```bash
docker build -t synthwatch-runner ./runner
docker run --rm --ipc=host -e DATABASE_URL="$DATABASE_URL" synthwatch-runner
```

## Writing a browser flow

Add `runner/checks/<name>.ts` exporting a `flow`, then point a check's
`flow_name` at `<name>` (must match `/^[a-z0-9-]+$/`). Keep every action inside a
`rec.step(...)`:

```ts
import type { Flow } from './index.js';

export const flow: Flow = async (rec) => {
  await rec.step('open homepage', async (page) => {
    await page.goto(rec.baseUrl, { waitUntil: 'domcontentloaded' });
  });
  // …more steps…
};
```

`checks/homepage-search.ts` is a **template** with **placeholder selectors** —
inspect the real DOM and replace them before trusting it.
