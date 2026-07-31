# Why the gates exist — `craigoley/synthwatch` (runner)

**This file exists to stop a new team deleting the CI gates as friction.**

There are 20 workflows here and ~22 jobs. To someone who did not live the incidents they look like 22
things slowing down a PR. Every one of them exists because something broke — usually in a way that was
**invisible while every other check was green**. This document records, per gate: what it asserts, the
dated incident that motivated it, and how safe it is to relax.

> **The recurring shape.** Almost every gate below was added after a failure that *passed CI*. That is
> the pattern to internalise: these are not style checks. They are the residue of things that shipped
> green and broke in production.

Companion documents: [`INVENTORY.md`](INVENTORY.md) (what exists, generated) ·
[`OUTSTANDING.md`](OUTSTANDING.md) (what is unfinished) · [`RACI.md`](RACI.md) (who owns what).

---

## How to read the ranking

| Rank | Meaning | Safe to disable under pressure? |
|---|---|---|
| **P0 — LOAD-BEARING** | Removing it re-opens a **specific, dated production incident**. It is the *only* thing standing between a known failure mode and prod. | **No.** Not for one PR, not for one hour. |
| **P1 — LOAD-BEARING** | Guards a class that has bitten here, but the failure is slower or quieter (a silent gap rather than an outage). | Only with a named owner and a same-day re-enable. |
| **P2 — NICE-TO-HAVE** | Real value, but the failure it prevents is recoverable and visible. | Yes, temporarily, with the cost understood. |
| **ADVISORY** | Cannot block by design (`continue-on-error`). Reports only. | Already non-blocking — nothing to relax. |

★ **The ranking is about blast radius, not about how often the gate fires.** Several P0 gates have never
gone red since the day they were added. That is what success looks like for a gate; it is not evidence
the gate is unnecessary.

---

## Branch protection as it actually stands

Live at last inventory: **required status checks = `ci-gate` only**; required approving reviews = **0**.

That single name is doing all the work. `ci-gate` is an aggregator: it waits for the other checks and
fails if any of them failed. So "only one required check" is not laxity — it is a deliberate design that
routes every other gate through one always-reporting check. **Deleting a workflow does not just remove
that workflow's opinion; it silently removes it from `ci-gate`'s aggregate too.**

---

## The gates

### `ci-gate` — the aggregator · **P0**

**Asserts:** every other check on the PR reached a terminal state and none failed. Names in its
`REQUIRED` list must additionally **register** — a required check that never appears is a failure, not a
pass. 15-minute hard cap (`deadline = now + 900`), so a hung check is a visible timeout.

**What went wrong (#102):** a required status check that gets **skipped** permanently deadlocks a merge.
`scan-pr / osv-scan` was required, but its workflow is `if:`-skipped on Dependabot PRs — so those PRs
could never satisfy it. Branch protection required only `ci-gate`, so a PR merged on a gate that had not
actually evaluated.

**Two traps encoded in it, both learned the hard way:**
- **`"Scan"` was REMOVED from `REQUIRED`.** It is `semgrep.yml`'s job, which is `continue-on-error: true`
  — it can *never* go red. Requiring it asserted **nothing** while looking like a gating SAST control.
  The real gate is the code-scanning check `Semgrep OSS`.
- **Never add a path-filtered check to `REQUIRED`.** `Will this freeze synthwatch-api?` and the mutation
  gate run only on some PRs. A required name that never registers is perpetually missing → timeout →
  *every* non-matching PR deadlocks. They still gate when they run, via the "unclassified check gates by
  default" rule.

**Relaxing it:** don't. It is the only required check; disabling it disables everything.

---

### `Playwright pairing (Dockerfile ⇄ npm)` + `Browser smoke` — **P0**

**Asserts:** (1) the npm `playwright` version and the `mcr.microsoft.com/playwright:vX.Y.Z-noble` base
image in `runner/Dockerfile` are the **matched pair**; (2) a browser actually **launches inside the built
image**.

**What went wrong — the 2026-07-25 outage.** PR #368, a Dependabot *group* bump, moved npm `playwright`
1.61.1 → 1.62.0 and did **not** touch `runner/Dockerfile`, which stayed on `v1.61.0-noble`. The base
image bundles the browsers (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`), and a minor bump moves the
`chrome-headless-shell` revision — so every browser check died at runtime with
`Executable doesn't exist at .../chromium_headless_shell-<rev>/...`.

**Measured blast radius** (from `runs`, re-queryable):

| | |
|---|---|
| First failure | `2026-07-25 14:45:21Z` |
| Last failure | `2026-07-25 19:30:38Z` |
| **Duration** | **4h 45m** |
| Failed runs | **633** |
| Checks affected | **19** — every browser monitor in the fleet |

**★ Three green gates missed it, and this is the point of the pair.** None of them launched a browser in
the built image:
- `npm ci` never downloads a browser (the base image supplies them).
- The `Test` job runs npm-installed Playwright **on the GitHub runner**, using *its own* browsers.
- Deploy `verify()` checks image-roll and env vars — not whether the image can open a page.

**A detail worth keeping:** the fix was *not* "re-land 1.62.0". `mcr` publishes **no stable
`v1.62.0-noble`** — only `-next-canary-*` pre-releases, which are not prod-appropriate. The newest stable
was `v1.61.1-noble`, so 1.61.1 was the only matched, launchable pairing that existed. A future bump can
be blocked by the base image simply not existing yet.

**Relaxing it:** never. This is the cheapest gate in the repo (~20s) against a 4h45m total fleet outage.

---

### `Lib-flow parity` — **P0**

**Asserts:** two things about `runner/specfetch/specShim.ts` (the `lib/flow` copy the runner actually
**executes**) versus `synthwatch-monitors`'s `lib/flow.ts` (the authoring copy, **dead at runtime**):
1. the vendored helper block has not drifted;
2. no monitor spec uses an `expect()` matcher the mini-shim does not implement.

**What went wrong:** the second one is the subtle failure. A spec using an unimplemented matcher **passes
local `playwright test`** — because locally it runs real Playwright — and then throws a `TypeError` in a
**live production run**, where the shim is what executes. The authoring copy and the executing copy are
different code, and only one of them is real.

**Deliberate design note:** it has **no path filter** — it always runs, so the required check is always
present. A path-filtered required check that skips can deadlock `ci-gate` (the #102 class above).

**Relaxing it:** no. It is ~20s and guards a divergence that is invisible locally by construction.

---

### `Test (Node + Postgres)` — **P0**

**Asserts:** the unit + DB-integration suite, against a real Postgres 16 service.

**Why the real Postgres matters:** DB integration tests are gated on `SKIP = !process.env.DATABASE_URL`.
Without the service they **skip silently and the suite still reports green**. (The same class cost
`synthwatch-api` 113 silently-skipping tests — see that repo's `GATES.md`.)

**Known flake, do not misread it:** `cadence.integration.test.ts` is wall-clock based (`TICK_MS = 2000`,
real `setTimeout`, asserts a realized gap of 3.4–4.6s). Under CI load it can land just outside — observed
`3.292s` on 2026-07-31 on a docs-only PR, passing on re-run with identical code. **Re-run before
believing it.** If it becomes frequent, fix the test's tolerance; do not disable the job.

**Relaxing it:** no.

---

### `Deploy-script tests` — **P0**

**Asserts:** `scripts/deploy.sh`'s logic — including that `deploy.yml` rolls **exactly** the
`RUNNER_IMAGE_JOBS` array, and the must-go-red cases for `verify()`'s comparators.

**What went wrong (multiple, dated):**
- **TD-3:** CD had drifted to rolling **2 of 6** jobs. The un-rolled jobs ran **stale code** until someone
  deployed by hand. Adding an ACA job requires edits in three places; a one-sided edit now fails CI.
- **2026-07-21:** the sandbox job ran `image: runnerImage` like every other job but was **never in the
  array** — so CD never rolled it and `verify()` never compared it. It silently sat on whatever image the
  last full bicep deployment left.
- **#279/#281 (the vacuous-CORS sweep):** `verify()` reported **PASS** while asserting nothing. Every
  comparator now fails on an empty expected side, and prints a distinct `SKIP` — never `PASS` — for a
  legitimately inapplicable check.

**Relaxing it:** no. This gate protects the gate that protects production.

---

### `verify_sandbox_least_privilege` (inside `deploy.sh` / `Deploy-script tests`) — **P0**

**Asserts, negatively:** the sandbox managed identity has **exactly** `{AcrPull, sandbox blob container}`
and *nothing else* — no DB, no Key Vault, no prod storage, not a Postgres Entra admin.

**Why it is negative:** the sandbox **executes uploaded, unmerged code** (an intentional RCE surface). Its
blast radius *is* its grant list. `verify_rbac()` proves the declared grants are live; this proves nothing
else is.

**What went wrong:** a bash-4-only expansion (`${var,,}`) hit `bad substitution` **mid-verify** on macOS,
which ships **bash 3.2** as `/bin/bash`. The deploy then printed **SUCCESS** while this security gate
**silently did not run**. Two defences now: the script is audited 3.2-portable, and it re-execs under a
modern bash if one exists.

**Relaxing it:** absolutely not. A gate that can silently not-run is worse than no gate — that is the
whole lesson.

---

### `Will this freeze synthwatch-api?` (schema-freeze pre-flight) — **P1**

**Asserts:** this PR's schema change will not freeze `synthwatch-api`'s required schema-parity gate.

**What went wrong — three times** (`countable_run`, `retry_count`, `audit_check_location_change`): the
api's parity gate reads runner `main` **live** (correct — liveness gives it teeth), so a runner schema
change merges green here and then **freezes the api's gate on someone else's unrelated PR**. The person
who broke it is not the person who finds out.

**An earlier version made it worse:** as "advisory, compares only vs api main" it could not *see* that the
paired api fixture PR existed, so it deadlocked #313 ⟷ #255 and cost an `--admin` bypass. It now searches
open api PRs and re-runs parity against each candidate's head — **a guard that tells you to do a thing
must be able to see that you did it.**

**Not in `REQUIRED`** (path-filtered — see the `ci-gate` trap), but it still blocks via the
unclassified-check rule.

**Relaxing it:** only if you accept freezing another repo's CI. Prefer opening the paired api PR.

---

### `Mutation gate (PR)` / `Mutation nightly` — **P1**

**Asserts:** per-module mutation score stays above a ratcheted, measured threshold — i.e. the tests can
actually *detect* a change, not merely execute one.

**What went wrong — it ran green at nothing.** The old nightly ran with **no flag**, so `incremental` was
false, so Stryker **never wrote the cache** (it only writes when `incremental: true`). Every saved CI
cache was a **~200-byte empty-dir tarball**; every PR restored empty and re-ran the full module
(`evaluate` = 55 min). The gate was simultaneously useless and expensive.

**★ A live trap, hit twice** (`5986f57`, then #378): `mutation.sh` mutates `rca.ts` by **fixed line
ranges**. Any insertion above those ranges slides them onto prompt text the gate is meant to exclude —
the score then drops with no test having gotten worse. **If you change `rca.ts` line counts, shift the
ranges by exactly the inserted line count.**

**Relaxing it:** P1 rather than P0 because a miss here degrades test quality slowly rather than breaking
prod. Do not delete it; if it is slow, fix the cache, which is what it was for.

---

### `Lint` (ESLint) · `Analyze (javascript-typescript)` · `Analyze (actions)` (CodeQL) — **P1**

**Assert:** lint cleanliness (`--max-warnings 0`) and CodeQL static analysis over both JS/TS and the
**Actions workflows themselves**.

`Analyze (actions)` is the non-obvious one: it analyses the workflow files, which is where injection and
over-permissioned-token bugs live in a repo that runs uploaded code.

**Relaxing it:** `Lint` is the most relaxable of the required set. CodeQL is not — it is required *and*
it is the only SAST that can block (see the `"Scan"` trap under `ci-gate`).

---

### `Semgrep OSS` (code scanning) — **P1** · `Scan` (semgrep.yml job) — **ADVISORY**

**The distinction matters and has already fooled this repo once.** `Scan` is `continue-on-error: true`
and can never go red; it was removed from `REQUIRED` precisely because requiring it asserted nothing. The
gating control is the code-scanning check **`Semgrep OSS`**.

**★ Handover trap:** `# nosemgrep` does **not** clear the `Semgrep OSS` check. Semgrep honours the
annotation and emits `suppressions:[{kind: inSource}]`, but GitHub code scanning **ignores that field**
and raises the alert anyway. Satisfy the rule for real, or dismiss the alert in the Security tab.

---

### `Review` (dependency-review) — **P1**

**Asserts:** no known-vulnerable dependency is introduced by the PR.

Its `continue-on-error` was **deliberately removed** so it gates like the api's and the dashboard's: this
repo is the Option-C *execute-at-runner-privilege* source, so its dependency gate must not be the weakest
of the three.

---

### `scan-pr / osv-scan` (OSV-Scanner) — **P2**

**Asserts:** OSV advisory scan of the lockfiles. Its check-run **name varies by PR type** (nested when
the reusable job runs, the caller name when skipped on Dependabot), so `ci-gate` requires any completed
`scan-pr*` rather than a fixed string — a direct consequence of the #102 class.

---

### `Will this freeze…`-style **doc-parity tripwires** — **P2**

**Asserts (`runner/statusTaxonomyDoc.test.ts`, runs in the unit suite):** the `STATUS-ENUM` block in
`docs/STATUS-TAXONOMY.md` lists **exactly** the `runs.status` enum — no more, no fewer, in **both**
directions. Three sources must agree, so "the doc matches the code" cannot be satisfied by a code enum
that has itself drifted from the DB constraint:

| Source | What it is |
|---|---|
| `RunStatus` in `runner/db.ts` | the TS enum the runner reflects |
| `runs_status_check` in `db/schema.sql` | the CHECK the DB enforces |
| the `STATUS-ENUM` block | the doc under test |

**Scope is deliberately narrow:** it gates the **structural** claim only, never the prose about what each
status *means* — that is semantic, unenforceable, and carries an honest "not enforced" stamp instead.

**Why P2 not P1:** a stale doc misleads a human; it does not break prod. But it is nearly free, and it is
the only thing keeping the taxonomy doc from becoming fiction.

---

### `Deploy runner to ACA Job` — **P0 (not a gate — the deployment itself)**

Listed because it appears in the same check list. It is not a PR gate; it rolls the runner image to all
ACA jobs on push to `main`. Its own safety comes from `Deploy-script tests` and `verify()`.

---

### `heal` (self-heal) · `automerge` · `reenable` (janitor) — **ORCHESTRATION**

Never waited for, never blocking — by explicit design in `ci-gate`'s `ORCHESTRATION` list.

**Why:** `self-heal`'s `heal` job polls *"waiting for ci-gate to conclude"*. If `ci-gate` waited for
`heal`, both spin to their timeouts and **every PR blocks**. And a *failed* remediation bot must not block
a good PR — self-heal reported FAILURE on every run while the #313 OIDC bug was live.

---

## ★ Holding a PR open — the only procedure that works

You will need this. `--auto` merges are armed aggressively here, and a PR you want to hold **will merge
itself** unless you disable the workflows.

```bash
# HOLD  (both, in this order — either one alone is insufficient)
gh workflow disable "Claude review"     -R craigoley/synthwatch
gh workflow disable "Auto-merge janitor" -R craigoley/synthwatch

# …do the thing…

# RELEASE (always re-enable, even if the PR was closed)
gh workflow enable "Claude review"      -R craigoley/synthwatch
gh workflow enable "Auto-merge janitor" -R craigoley/synthwatch
```

### Why both, and why checking `autoMergeRequest` is not enough

**`gh pr view --json autoMergeRequest` is POINT-IN-TIME, not durable.** It tells you auto-merge is off
*right now*. It does not stop it being re-armed a second later. Treat a `null` there as a snapshot, never
as a guarantee.

**The re-arm paths.** In this repo the `automerge` job lives in `claude-review.yml`, and the janitor is
separate — which is why disabling one is not enough:

| # | Path | Trigger |
|---|---|---|
| 1 | `claude-review.yml` → `automerge` | `pull_request: opened` |
| 2 | " | `pull_request: synchronize` — **any new commit re-arms it** |
| 3 | " | `pull_request: reopened` |
| 4 | " | `pull_request: ready_for_review` — taking a PR out of draft |
| 5 | `automerge-janitor.yml` → `reenable` | `schedule: */30` — **re-arms within 30 min, unattended** |
| 6 | " | `workflow_dispatch` |
| 7 | `auto_merge_disabled` event | *(dashboard repo)* — **disabling auto-merge re-triggers enabling it** |
| 8 | A human or agent running `gh pr merge --auto` | manual |

Path 5 is the one that catches people: you disable auto-merge by hand, walk away, and the janitor
re-enables it inside half an hour. Path 7 is the most counter-intuitive — in `synthwatch-dashboard` the
workflow listens for `auto_merge_disabled`, so *turning it off is itself a trigger to turn it back on*.

**GitHub also disables auto-merge on its own.** Observed 2026-07-18: PRs #340/#341 lost auto-merge at
14:37:24 during a burst of three sibling Dependabot merges (a mergeability-recompute churn). Nothing
re-ran the `automerge` job because there was no new commit, so both sat green-but-open for two days. The
janitor exists to recover exactly that — which is precisely why it also fights you when you want a hold.

### ★ The cost of disabling `Claude review`

**`Claude review` is in `ci-gate`'s `REQUIRED` list, and `ci-gate` is fail-closed on a check that never
registers.** Disabling the workflow means the check never appears, so `ci-gate` waits its full
**15-minute** deadline (`deadline = now + 900`) and then **fails**.

That is intended behaviour, not a bug — but it means:
- while held, every PR in the repo shows a **red `ci-gate` after ~15 minutes**;
- the red is a *timeout*, not a real failure — do not go debugging the PR;
- **re-enable, then re-run `ci-gate`** to clear it. It will not clear on its own.

If you only need to hold one PR and not stall the repo, prefer converting it to a **draft** — but note
that taking it out of draft is re-arm path 4.

---

## What is safe to relax under real pressure

In order of decreasing safety:

1. **`Scan`** — already advisory; nothing to relax.
2. **`scan-pr / osv-scan`** (P2) — a day without an advisory scan is recoverable.
3. **`Lint`** (P1) — style; the compiler and tests still gate.
4. **doc-parity tripwires** (P2) — a stale doc misleads a person, not prod.
5. **`Mutation gate`** (P1) — degrades test quality slowly. Fix the cache rather than delete it.

**Never, under any pressure:** `ci-gate`, `Playwright pairing`, `Browser smoke`, `Lib-flow parity`,
`Test (Node + Postgres)`, `Deploy-script tests`, `verify_sandbox_least_privilege`.

If you are about to disable one of those because it is "flaky", read its incident above first. Four of
the seven exist *specifically because* something looked green while being broken.
