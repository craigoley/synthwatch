# SynthWatch

[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/craigoley/synthwatch/badge)](https://scorecard.dev/viewer/?uri=github.com/craigoley/synthwatch)
[![CodeQL](https://github.com/craigoley/synthwatch/actions/workflows/codeql.yml/badge.svg)](https://github.com/craigoley/synthwatch/actions/workflows/codeql.yml)

> ### 🛠️ New here? **[DEVELOPMENT.md](DEVELOPMENT.md)** first.
> A one-command devcontainer builds **and tests both repos** (runner + `synthwatch-api`) against a real
> Postgres 16 — so nothing is push-and-pray and the schema gates are provable locally.

A self-hosted synthetic monitoring system. SynthWatch runs **HTTP** and
**real-browser (Playwright)** checks on a timer, records every run (and every
*step* of a browser flow), and opens/resolves debounced incidents with pluggable
alerting. The **data plane** (this repo's `runner/`) executes checks on **Azure
Container Apps Jobs**; the **dashboard** is a separate Next.js app on **Vercel**.

> ## ★★ Adding a migration? Read this FIRST — it is the day-one landmine
> Three unchecked couplings a newcomer trips, none of which a test will catch for you:
>
> 1. **Migrations apply BEFORE the new image rolls** (CD runs the migrate job, then rolls the runner —
>    `.github/workflows/deploy.yml`). So the **old image — and any ROLLBACK — meets the NEWER schema.**
>    Migrations are **forward-only**; *nothing checks backward-compatibility.* Make every migration
>    compatible with the **currently-deployed** code, not just the new code.
> 2. **It must be idempotent, in its own transaction** — `IF NOT EXISTS` / `CREATE OR REPLACE`, wrapped in
>    its own `BEGIN/COMMIT`. (A `CONCURRENTLY` index migration carries **no** transaction — different rule;
>    see `db/migrations/README.md`.)
> 3. **Hand-fold its end state into `db/schema.sql`, or Gate A reds.** `schema.sql` is the load-bearing base
>    a restore replays; a migration not mirrored there drifts it (that is exactly how the old `docs/SCHEMA.md`
>    rotted 52 migrations). The authoring contract lives in **`db/migrations/README.md`** — the good pattern.

> **Contributing & security:** see [CONTRIBUTING.md](CONTRIBUTING.md) (including
> the mandatory *“Writing a flow safely”* section), [SECURITY.md](SECURITY.md),
> and the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities
> **privately** — never via a public issue.

This repository contains the **data-plane runner**, the **database schema**, the
**container image**, and its **infrastructure-as-code** (`infra/main.bicep`). The
**dashboard** is a separate Next.js app in its own repo. The *why* behind the
runner's shape — ACA Jobs, cadence-in-DB, the two-repo split, and six other calls
— is the architecture decision record in **[docs/DECISIONS.md](docs/DECISIONS.md)**.

> _Verified 2026-07-14 — this README is prose with **no automated check**. Where it names a status, path, default, or behaviour, `db/schema.sql`, `scripts/deploy.sh`, `infra/main.bicep`, and the code are authoritative; distrust anything here they contradict._

---

## Data model

**Not documented here — `db/schema.sql` is canonical AND schema-parity-gated** (a hand-copy is precisely
how the old `docs/SCHEMA.md` drifted 52 migrations). In outline: `checks` (the catalogue), `runs` (one row
per execution, inserted `running` before it starts), `run_steps` (one per `StepRecorder.step()`), `incidents`
(open/resolved, linked to the runs that opened + resolved them). For the **run-status enum**
(`pass | warn | fail | error | infra_error | running`) see **[docs/STATUS-TAXONOMY.md](docs/STATUS-TAXONOMY.md)**
— tripwire-enforced against the code. Read `db/schema.sql` for the truth; do not trust a summary.

---

## Local development

See **[DEVELOPMENT.md](DEVELOPMENT.md)** for the one-command devcontainer (builds + tests both repos against
a real Postgres). A bare local runner tick:

```bash
# 1. Apply the schema and seed (Postgres 16)
psql "$DATABASE_URL" -f db/schema.sql
psql "$DATABASE_URL" -f db/seed.sql

# 2. Runner
cd runner
cp .env.example .env          # fill in DATABASE_URL (+ optional alert channels — see .env.example)
npm install
npm run typecheck             # tsc --noEmit, must be clean
npm run build                 # -> dist/
node dist/index.js            # one tick: due-filter -> claim -> execute -> evaluate
```

To exercise the browser tier locally, run the container so Chromium and its OS deps are present:

```bash
docker build -t synthwatch-runner ./runner
docker run --rm --ipc=host -e DATABASE_URL="$DATABASE_URL" synthwatch-runner
```

> _Verified 2026-07-14 — prose, no automated check; if the code disagrees, the code wins._

## Deploy (Azure — runner only)

> ### ★ NEVER hand-run `az` to deploy. Use **`scripts/deploy.sh`**.
> `deploy.sh` is the guardrail against two live hazards a raw `az deployment` walks straight into:
> - **The `:0.1.0` silent REVERT.** `infra/main.bicep`'s `runnerImage`/`migrateImage` params default to
>   `…:0.1.0` (`infra/main.bicep:51,54`) — *bootstrap* tags. A hand-run `az deployment group create` without
>   the current image reverts the live ACA jobs to the **ancient 0.1.0** image. `deploy.sh` always passes the
>   real image.
> - **The DB-ahead-of-code half-state.** `deploy.sh` deploys a fully-built runner **+** migrate pair for one
>   SHA, verifying that SHA exists in **both** ACR repos before applying (a one-sided deploy half-applies).

```bash
scripts/deploy.sh                 # pick the newest fully-built SHA, what-if, deploy, verify
scripts/deploy.sh --sha <sha>     # deploy a specific SHA pair (verified present in BOTH repos)
```

`infra/main.bicep` provisions the runner's Azure footprint into the **existing** `synthwatch-rg` /
`synthwatcholey0620.azurecr.io` — additive (it reuses the live stack, doesn't build a duplicate), pulling
its image via a managed identity with **AcrPull** (no registry password stored). Its `@secure` params
(`postgresAdminPassword`, `acsEmailConnectionString`) have **no defaults**, and `deploy.sh` passes them on
every deploy so a deploy can never **wipe** ACS email alerting (the recurring dark-email defect). First-time
DB init for a *fresh* database: `psql "$DATABASE_URL" -f db/schema.sql && psql "$DATABASE_URL" -f db/seed.sql`
from a host allowed through the Postgres firewall (Azure Cloud Shell, or your IP added under *Networking*).

> _Verified 2026-07-14 — prose, no automated check; `scripts/deploy.sh` + `infra/main.bicep` are authoritative._

## Rollback

> ### ★★ DRAFT · UNREHEARSED · NEVER EXECUTED
> Scaffolded from what the code *supports* — **not a verified procedure. No line here has been run.** Only
> Craig can rehearse it against the live stack; until then treat it as fiction with a delay fuse.

- **Roll the image (code path):** `scripts/deploy.sh --sha <old-sha>` points the runner **and** migrate jobs
  back to a prior image pair. It verifies `<old-sha>` exists in **both** ACR repos before applying (line ~351:
  *"even an explicit SHA must exist in BOTH repos, or the deploy half-applies"*).
- **★ The DATABASE does NOT roll back.** Migrations are **forward-only** — there are **no down-migrations**,
  and **nothing checks backward-compatibility.** Rolling the image back leaves the old code facing the
  **newer** schema. That is safe **only if** every intervening migration was backward-compatible with the old
  code. If one was breaking, an image rollback does **not** repair it — you are in the DB-ahead-of-code
  half-state, deliberately.
- **★ NEVER hand-run `az` to roll back** — the `:0.1.0` bicep default would revert to the ancient image
  instead of your target (same trap as a hand-run deploy, above).
- **Untested:** the SHA-pair roll has not been rehearsed against the live stack. Rehearse in a scratch
  environment before you rely on it during an incident.

## Database migrations on merge (CD)

DB migrations apply **automatically** in CD, **before** the new runner image rolls — so a runner expecting a
new column never meets a DB lacking it. The mechanism lives in the code, not here:

- **`.github/workflows/deploy.yml`** — builds the runner + migrate images, runs `synthwatch-migrate-job`,
  **polls until it succeeds, and STOPS the deploy (image NOT rolled) if it fails**, then rolls the runner.
- **`db/migrate.sh`** — the idempotent applier; tracks applied versions in `schema_migrations` and skips
  already-applied ones. It runs *inside* Azure (the ACA migrate job) so the DB password never leaves Azure.
- **`db/migrations/README.md`** — the migration-authoring contract (idempotency, own transaction, the
  `schema.sql` fold, `CONCURRENTLY` caveats). The source of truth; deliberately **not copied here**.

Manual fallback if CD is down (from a PG-firewall-allowed host):
`MIGRATIONS_DIR=db/migrations ./db/migrate.sh` — idempotent, safe to re-run.

> _Verified 2026-07-14 — prose, no automated check; `deploy.yml` + `db/migrate.sh` + `db/migrations/README.md` are authoritative._

## Writing a browser flow

See **[CONTRIBUTING.md](CONTRIBUTING.md)** (*"Writing a flow safely"*) and **[docs/AUTHORING.md](docs/AUTHORING.md)**,
which leads with the single-file monitors-repo spec constraint (the #1 day-one violation). In short: add
`runner/checks/<name>.ts` exporting a `flow` (name must match `/^[a-z0-9-]+$/`), keep every action inside a
`rec.step(...)` so it is timed and recorded, and use **verified selectors** — inspect the live DOM, never guess.

```ts
import type { Flow } from './index.js';

export const flow: Flow = async (rec) => {
  await rec.step('open homepage', async (page) => {
    await page.goto(rec.baseUrl, { waitUntil: 'domcontentloaded' });
  });
  // …more steps…
};
```

---

**Architecture decisions** (why ACA Jobs, cadence-in-DB, claim-by-conditional-`UPDATE`, the two-repo split,
and five more): **[docs/DECISIONS.md](docs/DECISIONS.md)**.
