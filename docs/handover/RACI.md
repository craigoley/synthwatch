# SynthWatch — RACI (handover)

> _DRAFT · 2026-07-15 · prose with **no automated check**. The whole point of this table is to make **"only one
> person knows"** visible — the #1 handover risk. **Today, Craig (`cao825` / `CraigOley@gmail.com`) is in every
> cell.** Owners in **[brackets]** are Wegmans placeholders to be named. See
> [`../../TRANSITION.md`](../../TRANSITION.md)._

**R** = does the work · **A** = owns the outcome (exactly one) · **C** = consulted (two-way) · **I** = informed
(one-way). Every cell reading **Craig** is a **transfer item**.

| Function | Responsible (today → target) | Accountable (today → target) | Consulted | Informed |
|---|---|---|---|---|
| **Deploys** (runner/api auto-deploy via GitHub Actions + OIDC; dashboard via Vercel) | Craig → **[Wegmans platform eng]** | Craig → **[Wegmans platform lead]** | GitHub Actions / Vercel (automated) | **[Wegmans on-call]** |
| **On-call / paging** (respond to a synthetic page) | Craig → **[Wegmans on-call rota]** | Craig → **[Wegmans SRE lead]** | — | **[team channel]** |
| **Postgres DB** (schema owned by the runner; admin `synthadmin` + Entra AD) | Craig → **[Wegmans DBA / platform eng]** | Craig → **[Wegmans data owner]** | runner repo owners (schema) | **[Wegmans]** |
| **Secrets / Key Vault** (`CRED_ENC_KEY`, `synthadmin` pw, `ACS_CONN`, `CLAUDE_CODE_OAUTH_TOKEN`) | Craig → **[Wegmans secrets owner]** | Craig → **[Wegmans security]** | Wegmans security | **[Wegmans platform]** |
| **Cost / FinOps** (subscription `SynthWatch`, AOAI spend, ACA/Flex) | Craig → **[Wegmans FinOps]** | Craig → **[Wegmans budget owner]** | — | **[Wegmans finance]** |
| **`synthwatch` (runner) repo** | Craig → **[Wegmans backend eng]** | Craig → **[Wegmans platform lead]** | api owner (shared schema) | **[team]** |
| **`synthwatch-api` repo** | Craig → **[Wegmans backend eng]** | Craig → **[Wegmans platform lead]** | runner owner (schema-parity) | **[team]** |
| **`synthwatch-dashboard` repo** | Craig → **[Wegmans frontend eng]** | Craig → **[Wegmans platform lead]** | api owner (contract) | **[team]** |
| **`synthwatch-monitors` repo** (spec merge = prod admission) | Craig → **[Wegmans monitor authors]** | Craig → **[Wegmans platform lead]** | runner owner (lib/flow parity) | **[team]** |
| **Mac-mini crons the platform depends on** | **n/a — none** (SynthWatch runtime is 100% ACA; the Mac's cron/LaunchAgents belong to *other* projects — `health-monitors`, `fwgs-monitor`). Dev/deploy *tooling* (`az`/`gh`, `deploy.sh`, `CRED_ENC_KEY`) runs from the Mac → covered by **Secrets** + **Deploys** above. | — | — | — |

## What the table exposes

- **Bus factor 1.** Every Accountable cell is one person. The move is not done until each **[bracket]** is a
  real, distinct Wegmans name — ideally not the same person in every Accountable cell.
- **The Mac-mini row is intentionally a non-finding**: a prior handover worry (a hidden local cron the platform
  needs) does **not** exist — verified read-only on 2026-07-15. Don't spend the shadow period hunting for it.
- **Secrets is the highest-blast-radius Accountable cell** — it holds `CRED_ENC_KEY` (see the Phase -1
  pre-condition in `TRANSITION.md`; a lost key is unrecoverable).
