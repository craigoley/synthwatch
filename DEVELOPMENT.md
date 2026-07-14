# Local development — start here

**Bus factor was one.** A new engineer could clone this repo and *not build it*: there is no `dotnet`
or `psql` on a stock machine, so `synthwatch-api` was push-and-pray (its tests, mutation gate, and
schema-parity ran only in CI) and **both schema gates (A and B) were untestable locally**. An agent — or
a human — who cannot run the tests they write will ship a gate they have never seen fail.

This devcontainer fixes that: one image that builds **and tests** both repos, against a **real Postgres**,
before anything is pushed.

## Prerequisites

- **Docker** (Desktop, or any engine with Compose v2).
- **Both repos cloned as siblings** — the api build needs the api source:
  ```
  ~/dev/
    ├── synthwatch/          ← this repo
    └── synthwatch-api/      ← git clone the api beside it
  ```

## Start it

**VS Code / Codespaces:** open the `synthwatch` folder → *"Reopen in Container"*. The devcontainer
(`.devcontainer/`) builds the image, starts Postgres 16, and runs `postCreate.sh` (installs both repos'
deps). It mounts the **parent** dir, so `synthwatch-api` is available at `/workspaces/synthwatch-api`.

**Plain Docker (no VS Code):**
```bash
cd synthwatch
docker compose -f .devcontainer/docker-compose.yml up -d
docker compose -f .devcontainer/docker-compose.yml exec app bash .devcontainer/postCreate.sh
docker compose -f .devcontainer/docker-compose.yml exec app bash .devcontainer/verify.sh
```

## The acceptance test

`.devcontainer/verify.sh` **is** the acceptance test — the same commands CI runs, locally:

| Step | What it proves | Underlying command |
|------|----------------|--------------------|
| **a** | runner full suite (unit + DB integration) against real Postgres | `npm test` with `DATABASE_URL` → the `db` service |
| **b** | `synthwatch-api` builds + tests | `dotnet test` (Testcontainers → host Docker socket) |
| **c** | BOTH mutation gates run | runner `scripts/mutation.sh`, api `dotnet-stryker` |
| **d** | **schema.sql + migrations replay into a scratch DB** — exactly what **Gate A** needs | `scripts/check-migration-replay.sh` |

```bash
bash .devcontainer/verify.sh            # all four
bash .devcontainer/verify.sh a d        # runner suite + replay only (fast — the Gate A path)
```

If **(d)** passes, Gate A is locally provable and its must-go-red is honest: reintroduce a
`cost_projection` drift into `db/schema.sql`, run step **d**, watch it red, revert.

## Toolchain (pinned to prod / CI)

| Tool | Version | Why that pin |
|------|---------|--------------|
| Postgres | **16** | prod `infra/main.bicep` (`flexibleServers` version `'16'`) + all CI jobs |
| .NET SDK | **10.0** | `synthwatch-api` targets `net10.0` |
| Node | **22** | `runner/package.json` `engines: node>=22`; CI `setup-node@22` |
| psql client | **16** | byte-compatible with the prod major the gates diff |
| Stryker | StrykerJS (runner, via `npm ci`) + `dotnet-stryker` (api) | the two mutation gates |

## What is NOT in the container — and why (honest limits, not green checkmarks)

- **Prod database access.** Deliberately absent. Prod is a firewalled Azure Flexible Server; a devcontainer
  must never hold prod credentials. **Gate B** (prod↔replay) is by design a *scheduled ACA job* that runs
  inside the runner's own Azure environment — it cannot and should not be reproduced here. The container
  proves the *replay* half (step d); the *prod* half is Gate B's job in Azure.
- **Azure auth / deploy.** No `az` login, no service principal. `scripts/deploy.sh`, Bicep `what-if`, and
  anything touching Azure run on a developer's own authenticated `az`, not here.
- **The ACA runtime.** There is no local Azure Container Apps emulator; the runner's *cron/ACA execution
  model* (replicaTimeout, `jobs/start`, secretRef env) can't be exercised locally. Unit + integration tests
  cover the *logic*; the execution model is validated in a real ACA job.
- **Live browser checks.** `postCreate.sh` skips Playwright browser downloads (the test suites are unit +
  DB-integration, no live browser). Run `npx playwright install --with-deps` in `runner/` if you need to
  drive a real browser flow locally.
- **`dotnet test` / api Stryker need the host Docker socket** (Testcontainers spins sibling Postgres
  containers). The compose file bind-mounts `/var/run/docker.sock`; on a host without Docker access those
  two steps can't run (the runner suite + replay still can — they use the `db` service directly).
