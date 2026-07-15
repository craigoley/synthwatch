# SynthWatch — transition & handover

> _DRAFT · 2026-07-15 · prose with **no automated check**. The transfer-asset facts below were pulled read-only
> from `az` / `gh` on 2026-07-15; re-verify against the live tenant before acting. Owners in **[brackets]** are
> placeholders for the Wegmans RACI ([`docs/handover/RACI.md`](docs/handover/RACI.md))._

The definition of done: **a competent new team can set up, run, deploy, and extend without contacting Craig.**
Everything in this set serves that test. Start at the per-repo **`ONBOARDING.md`** (each repo has one).

## The 4-repo system

```
                          ┌───────────────────────────┐
   authors specs ───────► │  synthwatch-monitors      │  Playwright specs + manifest.
   (merge = admission)    │  (specs, merge-gated)     │  The runner FETCHES these at main's HEAD SHA.
                          └────────────┬──────────────┘
                                       │ fetch @ HEAD (contents API, single-file)
                          ┌────────────▼──────────────┐        ┌──────────────────────────┐
   OWNS the Postgres ───► │  synthwatch (runner)      │◄──────►│  synthwatch-api (C#)     │
   schema + migrations    │  ACA cron Jobs, data plane │  reads │  read-mostly HTTP API on  │
                          │  → Postgres (writes runs) │  DB    │  Azure Functions          │
                          └────────────┬──────────────┘        └────────────┬─────────────┘
                                       │ Postgres (runner-owned schema)      │ HTTP (JSON)
                                       ▼                                      ▼
                              ┌──────────────────┐            ┌──────────────────────────┐
                              │   Azure Postgres  │            │  synthwatch-dashboard    │
                              │   (flexible srv)  │            │  Next.js on Vercel        │
                              └──────────────────┘            │  (thin client over the API)│
                                                              └──────────────────────────┘
```

- **`synthwatch` (runner)** — the data plane. ACA cron Jobs run HTTP + browser (Playwright) checks, write to
  Postgres, open/resolve incidents, alert. **Owns ALL Postgres schema + migrations.** Auto-deploys via
  `.github/workflows/deploy.yml` (migrations first, then the image rolls).
- **`synthwatch-api`** — a C# Azure Functions read-mostly API over the runner-owned DB (managed-identity auth,
  no password). Auto-deploys on merge. The dashboard's only backend.
- **`synthwatch-dashboard`** — a Next.js operator console on Vercel, a thin client over the API. Auto-deploys
  on merge (Vercel).
- **`synthwatch-monitors`** — the Playwright specs the runner fetches at `main`'s HEAD SHA. A spec "reaches
  prod" by **merging** (the merge gate is the admission control — see SECURITY.md's execution boundary).

## Transfer-asset inventory (read-only recon, 2026-07-15)

Subscription `SynthWatch` (`505a01eb…`) sits in a **personal tenant** (`087ee734…`), Owner
`CraigOley@gmail.com`. GitHub org `craigoley` — **sole member `cao825`**. Ranked by blast radius:

| # | Asset | Owner today | Bound to | Breaks if Craig gone? | Rebuild on tenant move? |
|---|---|---|---|---|---|
| 1 | **`CRED_ENC_KEY`** (DB-cred encryption) | `~/.synthwatch.env`, Mac mini — **no Key Vault exists** | machine | ★★ **YES — encrypted data unrecoverable** | must be escrowed to a KV first |
| 2 | Azure subscription + `synthwatch-rg` (ACR, Postgres, storage, ~10 ACA jobs, Function App, AOAI, ACS) | personal-gmail Owner | tenant | ★★ YES (sole Owner) | RBAC + MI object IDs all rebuild |
| 3 | **RBAC** (Owner, deployer, 3 MIs) — no custom roles | subscription | tenant | — | ★★ **deleted on move; export first** |
| 4 | 3 managed identities (`synthwatch-runner-id`; api system MI; `synthwatch-gha-deployer` app+OIDC) | Azure | tenant + org-path | data/CI stops | ★ new object IDs → every grant rebuilds |
| 5 | Postgres (`synthadmin` password **+** Entra AD, tenant-bound) | Azure | tenant/password | with sub | ★ Entra roles rebuild; password survives if escrowed |
| 6 | GitHub org `craigoley` + 4 repos; `CLAUDE_CODE_OAUTH_TOKEN` (Craig's Claude) | org, sole member `cao825` | org/account | ★★ YES | n/a |
| 7 | Vercel dashboard project (not inventoriable from this host) | Craig's Vercel | account | ★ YES | n/a |
| 8 | Sole alert channel `craig.oley@wegmans.com` (*prior recon; DB firewalled*) | `channels` row | data | ★ YES | n/a |

_Not found (good): no Key Vault entanglement, **no custom roles**, **no SynthWatch LaunchAgent/cron on the Mac**
(runtime is 100% ACA), no custom DNS._

## The plan

**Phase -1 · Pre-conditions (Craig, each verified before the next):**
1. ★★ Escrow `CRED_ENC_KEY` into Wegmans' Key Vault + a second independent escrow; **verify a decrypt
   round-trips from the vault copy. Nothing moves until this is green** — a lost key is unrecoverable.
2. Re-issue `CLAUDE_CODE_OAUTH_TOKEN` under a Wegmans service account (not Craig's personal Anthropic).
3. Export RBAC + custom roles + the 3 managed-identity mappings (`roleassignments.json`, `customroles.json`,
   `identity-map.md`) — **the move deletes these; the export is the only rebuild source.**

**Phase 0 · Handover artifacts (agent-doable):** 4 READMEs ✅ · 4 `ONBOARDING.md` · this `TRANSITION.md` ·
`docs/handover/RACI.md` · `docs/handover/OUTSTANDING.md`. ★ **Rehearse ONE rollback**, scheduled into the
shadow period so **Wegmans** runs it with Craig watching.

**Phase 1 · The move (Wegmans-led, Craig shadowing, planned window — the platform is BLIND during it):**
billing/tenant transfer → rebuild identity from the exports → re-federate the GitHub OIDC subjects to the new
org → repoint the deploy identity → Vercel project to a Wegmans team → Postgres per-user accounts. ★ A second
pair of eyes watches Wegmans' live surface while SynthWatch is dark.

**Phase 2 · Verify (definition of done):** a Wegmans engineer, **without Craig**, must clone → devcontainer
build → make a change → watch it deploy → **roll it back** → respond to a synthetic page. **All four verbs, by
them, or the handover isn't done.**

**Phase 3 · Shadow (30/60/90):** Wegmans owns; Craig on-call-for-questions only, then fully off.

## The rest of the set
- **[`docs/handover/RACI.md`](docs/handover/RACI.md)** — who is Responsible/Accountable/Consulted/Informed per
  function. Every "Craig" cell is a transfer item.
- **[`docs/handover/OUTSTANDING.md`](docs/handover/OUTSTANDING.md)** — the live register of open items (by
  blast radius).
- **`ONBOARDING.md`** in each of the 4 repos — the cold-clone first-hour guide.
