# SynthWatch

[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/craigoley/synthwatch/badge)](https://scorecard.dev/viewer/?uri=github.com/craigoley/synthwatch)
[![CodeQL](https://github.com/craigoley/synthwatch/actions/workflows/codeql.yml/badge.svg)](https://github.com/craigoley/synthwatch/actions/workflows/codeql.yml)

A self-hosted synthetic monitoring system. SynthWatch runs **HTTP** and
**real-browser (Playwright)** checks on a timer, records every run (and every
*step* of a browser flow), and opens/resolves debounced incidents with pluggable
alerting.

The **data plane** (this repo's `runner/`) executes checks on **Azure Container
Apps Jobs**; the **dashboard** is a separate Next.js app on **Vercel**. See
[Decision 8](#decision-8--two-repo-split-runner-here-dashboard-on-vercel) for why
the split exists.

> **Contributing & security:** see [CONTRIBUTING.md](CONTRIBUTING.md) (including
> the mandatory *“Writing a flow safely”* section), [SECURITY.md](SECURITY.md),
> and the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities
> **privately** — never via a public issue.

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

## Deploy (Azure — runner only)

`infra/main.bicep` provisions the **runner's** Azure footprint into the
**existing** resource group `synthwatch-rg` (eastus), referencing the
**existing** registry `synthwatcholey0620.azurecr.io`. It does **not** create the
resource group or the registry, and it does **not** provision the dashboard
(that's a separate Vercel app). The ACA Job pulls its image via a user-assigned
managed identity granted **AcrPull** — no registry password is stored.

```bash
# 0. Build and push the runner image to the existing ACR.
az acr login --name synthwatcholey0620
docker build -t synthwatcholey0620.azurecr.io/synthwatch-runner:0.1.0 ./runner
docker push synthwatcholey0620.azurecr.io/synthwatch-runner:0.1.0

# 1. Provision the runner footprint (PostgreSQL, Storage, Log Analytics, ACA
#    environment + scheduled Job).
az deployment group create \
  --resource-group synthwatch-rg \
  --name synthwatch-infra \
  --template-file infra/main.bicep \
  --parameters \
      postgresAdminPassword='<strong-password>' \
      runnerImage='synthwatcholey0620.azurecr.io/synthwatch-runner:0.1.0'

# 2. Grab the Postgres FQDN from the deployment outputs.
FQDN=$(az deployment group show -g synthwatch-rg -n synthwatch-infra \
        --query properties.outputs.postgresFqdn.value -o tsv)
export DATABASE_URL="postgresql://synthadmin:<strong-password>@${FQDN}:5432/synthwatch?sslmode=require"

# 3. Apply the schema and seed to the fresh database.
#    schema.sql is the full, converged schema for a NEW database — it already
#    includes the end state of every migration AND the schema_migrations tracker.
#    Migrations are idempotent (IF NOT EXISTS / CREATE OR REPLACE), so running the
#    migration runner afterwards is safe: each migration re-applies as a no-op and
#    registers its version. (On merge this is automatic — see "Database migrations
#    on merge" below.)
psql "$DATABASE_URL" -f db/schema.sql
psql "$DATABASE_URL" -f db/seed.sql

# 4. Smoke-test: fire one Job execution now instead of waiting for the cron tick.
az containerapp job start -g synthwatch-rg -n synthwatch-runner-job
```

> To run `psql` from your workstation you must also allow your client IP on the
> Postgres server (Portal → the server → *Networking*), or run these steps from
> **Azure Cloud Shell**. The Bicep opens the firewall to *Azure services* (so the
> Job can connect) but not to arbitrary public IPs.

> Alert channels (`ALERT_EMAIL_TO`, `TEAMS_WEBHOOK_URL`, `XMATTERS_*`) are added
> as Job env vars per deployment; an absent channel is simply disabled. The Bicep
> intentionally hardcodes none.

## Database migrations on merge (CD)

DB migrations apply **automatically** as part of CD, **before** the new runner
image rolls — so a runner that expects a new column never runs against a DB that
lacks it. On merge to `main` (touching `runner/**`, `db/**`, a Dockerfile, or the
workflow), `.github/workflows/deploy.yml` runs, in order:

1. **Build** the runner image (`az acr build`, context `runner/`).
2. **Build** the migration image (`az acr build`, context `db/`, from
   `db/Dockerfile.migrate` — a tiny `psql`-only image bundling `db/migrate.sh` +
   `db/migrations/`).
3. **Migrate** — point `synthwatch-migrate-job` at the new migration image, start
   a one-off execution, and **poll until it succeeds**. If it fails (or times
   out) the step exits non-zero and **the deploy stops here — the new runner
   image is NOT rolled.**
4. **Roll** the runner job to the new image.

### How migrations are tracked & kept safe

- **Tracking:** `schema_migrations(version, applied_at)` records which
  `db/migrations/*.sql` have run (`version` = filename without `.sql`). The runner
  applies, in lexical order, only versions not already recorded.
- **Idempotency is mandatory.** Every migration uses `IF NOT EXISTS` /
  `CREATE OR REPLACE`. That makes the record-after-apply gap safe (a re-run is a
  no-op) and lets an already-migrated DB **auto-baseline** under tracking with no
  manual step.
- **Convergence:** `db/schema.sql` contains the converged end state (incl. the
  `schema_migrations` table). Fresh install = `schema.sql` then the runner, where
  migrations no-op and self-register. No version list is duplicated.
- **Adding a migration:** drop `db/migrations/000N_name.sql` (idempotent, with its
  own `BEGIN/COMMIT`) **and** fold its end state into `db/schema.sql`. CD applies
  it on the next merge.

### Why migrations run *inside* Azure (DB-access path)

The Postgres firewall allows **Azure-internal** traffic (`AllowAllAzureServices`)
but **not** arbitrary GitHub-hosted runner IPs. Rather than open a firewall hole
for CI, the migration runs as the ACA **`synthwatch-migrate-job`** — inside Azure,
already permitted by that rule. It reuses the **same `database-url` ACA secret** as
the runner job, so **the DB password never leaves Azure** (it is never a GitHub
secret and never touches the workflow). CD only *triggers* the job via OIDC.

### Manual fallback (if CD is down)

Run the same runner yourself from a host allowed through the PG firewall (Azure
Cloud Shell, or your workstation IP added under the server's *Networking*):

```bash
export DATABASE_URL="postgresql://synthadmin:<password>@<pg-fqdn>:5432/synthwatch?sslmode=require"
MIGRATIONS_DIR=db/migrations ./db/migrate.sh
```

It is idempotent — safe to re-run; already-applied migrations are skipped.

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
