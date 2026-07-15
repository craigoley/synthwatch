# Onboarding — `synthwatch` (the runner)

> _2026-07-15 · prose with **no automated check**. This doc **points**; it does not copy. Where it names a
> path, gate, or behaviour, the code and the gate are authoritative — if they disagree, the code wins._

## 1. What this repo is

The **data plane**: an Azure Container Apps **cron Job** (TypeScript/Node) that runs HTTP + real-browser
(Playwright) checks on a timer, records every run and every *step*, opens/resolves debounced incidents, and
alerts. **It OWNS all Postgres schema + migrations**; the api and dashboard are read-mostly consumers. Its
place in the 4-repo system and the handover plan: **[`TRANSITION.md`](TRANSITION.md)**.

## 2. First hour (from a clean clone)

Verified against the #318 devcontainer (builds + tests **both** the runner and the api against a real Postgres):

```bash
git clone https://github.com/craigoley/synthwatch && cd synthwatch
# clone synthwatch-api as a sibling too (the devcontainer builds both)
docker compose -f .devcontainer/docker-compose.yml up -d
docker compose -f .devcontainer/docker-compose.yml exec app bash .devcontainer/postCreate.sh
docker compose -f .devcontainer/docker-compose.yml exec app bash .devcontainer/verify.sh   # (a) runner suite (b) api tests (c) mutation (d) schema replay
```

Then: make a trivial change → `git checkout -b my-change && git commit && git push` → **open a PR** → watch
CI go green → it **auto-merges** (the trusted-author auto-merge lands it on green). See §4 for the gates.

## 3. ★ The one thing that will bite you day one

**Adding a migration.** Read the **“Adding a migration” landmine box at the top of the [README](README.md)**
before you touch `db/`. In one line: migrations apply *before* the image rolls (so the old image **and any
rollback** meets the newer schema — forward-only, nothing checks backward-compat), must be idempotent in their
own transaction, and must be hand-folded into `db/schema.sql`. The authoring contract is
**[`db/migrations/README.md`](db/migrations/README.md)** — the good pattern.

## 4. How a change reaches prod

- **CI gates** (all aggregated by the required `ci-gate` check): `Test (Node + Postgres)`, `Lint`, `Scan`,
  `Claude review`, `Lib-flow parity`, `Deploy-script tests`, the `mutation` gate, and the
  `schema-freeze-preflight` (which reds if a shared-schema change lacks its paired api-fixture PR).
- **Auto-deploy on merge to `main`**: `.github/workflows/deploy.yml` — **migrations first** (via
  `synthwatch-migrate-job`; if they fail the deploy STOPS and the image is NOT rolled), **then** the runner
  image rolls to the new SHA.
- **★ Roll back:** the runner README's **[Rollback](README.md#rollback)** section — carried forward with its
  **DRAFT · UNREHEARSED · NEVER EXECUTED** stamp, because that is still true. `deploy.sh --sha <old>` rolls the
  image (SHA verified in both ACR repos); **the DB does not roll back** (forward-only). Rehearse before trusting
  it (see [`docs/handover/OUTSTANDING.md`](docs/handover/OUTSTANDING.md)).

## 5. Where the gated truth lives

*If a doc and the code disagree, the code wins and the gate proves it.*

- **`db/schema.sql`** — the canonical schema; the api's schema-parity CI gate enforces the fixture against it.
- **[`docs/STATUS-TAXONOMY.md`](docs/STATUS-TAXONOMY.md)** — the `runs.status` enum, **tripwire-enforced**
  against `RunStatus` (`runner/statusTaxonomyDoc.test.ts`). Prose there is stamped; the enum block is checked.
- **[`db/migrations/README.md`](db/migrations/README.md)** — the migration-authoring contract.
- **`CLAUDE.md`** — hard-won lessons for anyone (human or agent) changing this repo.

## 6. Who to ask

Post-handover: **[Wegmans runner owner — see the RACI](docs/handover/RACI.md)**, **not Craig**. During the
30/60/90 shadow, Craig is on-call-for-questions only (`TRANSITION.md` Phase 3).
