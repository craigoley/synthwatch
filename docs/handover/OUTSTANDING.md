# SynthWatch — outstanding-items register (handover)

> **★ THE RULE: no item may be marked done on the strength of a report — only on the strength of its
> verification command's output.**
>
> This register exists because status was travelling as prose, and prose drifts. The plan has carried
> items marked *done* that were not, and items marked *to-do* that were. Every row below therefore ends
> in a **command whose output decides the status**. If you doubt a row, run its command — that is the
> point. If a row's status and its command's output disagree, **the output wins** and the row is wrong.

**Re-derive every status in one line:**

```bash
bash scripts/verify-handover-status.sh          # prints a status table; needs az + gh + psql
```

_Statuses below were re-derived on **2026-07-31** by running every command in this file. Ordered by
**blast radius, not age**. Owners in **[brackets]** are Wegmans placeholders. See
[`../../TRANSITION.md`](../../TRANSITION.md) · [`RACI.md`](RACI.md) · [`GATES.md`](GATES.md) ·
[`INVENTORY.md`](INVENTORY.md)._

**Status vocabulary** — deliberately small, because a rich vocabulary is how "done" gets fudged:

| | |
|---|---|
| **DONE** | The verification command's output satisfies the item. Nothing left to do. |
| **NOT DONE** | The command's output shows the work has not happened. |
| **PARTIAL** | Some legs verified, others not — the row names which. |
| **BLOCKED** | Cannot be verified or completed from here; the blocker is named. |

---

## ★ Highest blast radius — data loss / silent failure / incident response

### `CRED_ENC_KEY` escrow → Key Vault · **NOT DONE** · Craig → **[Wegmans secrets]**

The key lives only in `~/.synthwatch.env` on the Mac mini. It decrypts `checks.login_credentials`;
without it every authenticated monitor is unrecoverable. **Phase -1 gate — nothing moves until green.**

```bash
az keyvault list --query "length(@)" -o tsv      # DONE when ≥1 AND the secret is present
```
**Output 2026-07-31: `0`** — there is no Key Vault in the subscription at all.

---

### Rehearse a rollback · **NOT DONE — all four legs** · Craig → **[Wegmans on-call]**

Every rollback section is stamped *DRAFT · UNREHEARSED · NEVER EXECUTED*. An untested rollback is not a
rollback. ★ The 2026-07-25 Playwright outage (4h45m, 633 failed runs, 19 checks) was fixed **forward**,
not rolled back — the one moment it would have been exercised.

```bash
# A rollback = a deploy whose target commit is OLDER than the previously deployed commit.
gh run list --workflow deploy.yml --limit 40 --json createdAt,headSha,conclusion \
  -q '.[]|select(.conclusion=="success")|[.createdAt,.headSha]|@tsv' | sort | \
while IFS=$'\t' read -r ts sha; do
  cts=$(git show -s --format=%ct "$sha" 2>/dev/null || echo 0); [ "$cts" -eq 0 ] && continue
  [ -n "${p:-}" ] && [ "$cts" -lt "$p" ] && echo "ROLLBACK: $ts -> ${sha:0:8}"; p=$cts
done                                            # DONE when ≥1 ROLLBACK line
```
**Output 2026-07-31: no ROLLBACK lines** across **26** successful deploys. (Both `push` and
`workflow_dispatch` events appear — the absence of a rollback is the finding, not the trigger type.)

**The four legs, none rehearsed:** runner image · migrate job · dashboard (Vercel Instant Rollback) ·
api. Rehearse **one** in the shadow period, run by Wegmans with Craig watching.

---

### Gate B — prod↔replay drift detector · **NOT DONE** · **[Wegmans platform eng]**

The only thing that would catch `runs.location`-class drift (schema.sql/replay vs the actual prod
catalog). CI cannot reach prod; the runner's ACA env can.

```bash
az containerapp job list -g synthwatch-rg --query "[?contains(name,'drift')].name" -o tsv
```
**Output 2026-07-31: empty** (10 ACA jobs exist, none is a drift detector).

---

### DR / backup topology · **PARTIAL** · **[Wegmans platform]**

The *restore model* exists (`schema.sql` + migrations). The **posture** is now measured — and it is
thinner than "backups exist" implies:

```bash
az postgres flexible-server show -g synthwatch-rg -n synthwatch-pg-e2 \
  --query "{retentionDays:backup.backupRetentionDays,geo:backup.geoRedundantBackup,ha:highAvailability.mode}" -o json
```
**Output 2026-07-31:** `retentionDays: 7` · `geo: Disabled` · `ha: Disabled`.

So: **7 days of PITR, single region, no HA.** Blob artifacts have their own 90d lifecycle
(see `INVENTORY.md` §1.4) — **a 7d DB window against 90d artifacts is a mismatch worth a decision**, not
a bug. Still missing: a documented DR posture and a **rehearsed** restore.

---

### On-call roster (one inbox → routed) · **NOT DONE** · Craig → **[Wegmans SRE]**

```bash
psql "$DATABASE_URL" -c "SELECT id,name,type,enabled,config FROM channels WHERE enabled"
```
**Output 2026-07-31:** exactly **one** enabled channel — `default email list` (email) →
`craig.oley@wegmans.com`; 2 rows in `alert_routes`. Critical **and** warning reach the same personal
inbox. Alerts reach a person, not a team.

---

### Payment & order-placement monitoring · **NOT DONE** · **[Wegmans]**

Monitors cover reachability/search and add-to-cart, **not** the revenue path through checkout.

```bash
psql "$DATABASE_URL" -tAc "SELECT count(*) FROM checks WHERE enabled
  AND (name ILIKE '%checkout%' OR name ILIKE '%payment%' OR name ILIKE '%order%')"
```
**Output 2026-07-31: `0`.**

★ Note the deliberate ceiling: `full-shop-flow` reaches checkout and **never places the order** (the spec
logs *"a place-order control is present — NOT clicking it"*). Extending past that needs test cards and a
sensitive-flow decision, not just a selector.

---

## Medium blast radius — correctness gates & coverage

### ★ Monitor cart gates exist but **DO NOT RUN IN CI** · **NOT DONE** · **[Wegmans monitor authors]**

`synthwatch-monitors/package.json` defines a composite `npm run check` including
`check:clear-cart-gate`, `check:cart-count-gate` and `check:cart-identity-gate`. **`check.yml` never
calls it** — it invokes the individual scripts, so those three gates protect a local run only.

```bash
gh api repos/craigoley/synthwatch-monitors/contents/.github/workflows/check.yml \
  --jq '.content' | base64 -d | grep -cE "clear-cart-gate|cart-count-gate|cart-identity-gate"
```
**Output 2026-07-31: `0`.** (Beware `grep -c "npm run check"` — it false-positives on
`npm run check:matchers`. Match the gate names, not the prefix.)

**Fix:** one step in `check.yml`. Introduced across monitors #118/#119/#120 on the assumption CI ran the
composite. This is the exact class the gates exist to prevent — a check that looks present and asserts
nothing.

---

### ★ Check 355 `verify-cart-4` still failing — NEW failure mode · **NOT DONE** · **[Wegmans monitor authors]**

monitors #121 (read the cart body inside the add step) **is merged** and live (spec etag `2f9c3ce`), and
it **did** fix what it targeted — the *"no parseable cart body"* error is gone. A **different** GATE-2
branch now fires.

```bash
psql "$DATABASE_URL" -tAc "SELECT status||' | '||coalesce(failed_step,'-')||' | '||left(error_message,70)
  FROM runs WHERE check_id=355 ORDER BY started_at DESC LIMIT 1"
```
**Output 2026-07-31:** `error | verify-cart-4 | … no cart write was observed during the add steps.`

**What the evidence says.** All four `add-*` steps **pass** (~24s each — the ladder throws unless a rung
commits), and the teardown clear-cart takes 54s (so the cart *did* hold items). Yet the per-add listener
saw no cart write.

**Leading hypothesis, not yet proven:** the ladder returns as soon as the stepper transform appears,
which can be *before* the cart-write response lands — so `withCartBodyCapture` detaches its listener too
early. That would be a second-order defect in the #121 fix, traded from the first. **Do not treat this
row as fixed until the command above prints `pass`.**

---

### Gate A — schema.sql ↔ replay · **NOT DONE** · Craig → **[Wegmans platform eng]**

Built on a branch; its `cost_projection` must-go-red proof was interrupted when Docker Desktop's daemon
dropped. **A gate nobody has seen fail must not merge.**

```bash
grep -rl "schema-vs-replay" scripts/ 2>/dev/null | head -1   # DONE when non-empty on main
```
**Output 2026-07-31: empty** — not on `main`.

---

### OpenAPI spec (api) · **NOT DONE** · **[Wegmans api eng]**

No machine-readable API spec; the only shape source is the dashboard's contract fixtures. A blocker for
any team integrating.

```bash
cd ../synthwatch-api && { find . -iname "*openapi*" -o -iname "*swagger*" | grep -v obj/ | head -1; \
  grep -rl "AddSwaggerGen" --include="*.cs" . | head -1; }
```
**Output 2026-07-31: empty** — no spec file, no Swashbuckle.

---

### Narrative — holistic build · **NOT DONE** · **[Wegmans runner eng]**

Delivered as **recon only**. `narrative.ts` mentions correlation, but ★ **only as a prompt instruction to
the model** — there is no read-time correlation/clustering pass in code.

```bash
grep -nE "^(export )?(async )?function .*(cluster|correlat)" runner/narrative.ts
```
**Output 2026-07-31: empty** — instruction text only. (Grepping for the *word* `correlation` returns 5
hits and would wrongly read as done; match the **function definition**.)

---

### PR-b — 2nd golden canonicalize fixture · **NOT DONE** · **[Wegmans eng]**

The runner↔C# canonicalize parity gate ships with one fixture; an adversarial second was queued.

```bash
ls runner/test-fixtures/trace-signals-golden/ | grep -c canonicalize   # DONE when ≥2
```
**Output 2026-07-31: `1`.**

---

### `evaluate.ts` mutation coverage · **NOT DONE (open by design)** · **[Wegmans runner eng]**

Lowest of the six modules; paging logic under-pinned. Ratcheted, not raised.

```bash
grep -A1 "^  evaluate)" runner/scripts/mutation.sh | grep -o "BREAK=[0-9]*"
```
**Output 2026-07-31: `BREAK=28`** (measured 31.8%). Raise the threshold *after* killing survivors —
raising it first just reds the gate.

---

### esbuild arm64 native binary · **NOT DONE** · **[Wegmans runner eng]**

One root, two symptoms: 8 spec-compile tests are "red locally, green in CI" on an arm64 Mac, and local
sandbox-preview testing is blocked. Both are the wrong native binary, not broken tests. **A Wegmans
engineer hits this on day one.**

```bash
python3 -c "import json;print(json.load(open('runner/package.json'))['scripts'].get('postinstall','(none)'))"
```
**Output 2026-07-31: `(none)`.** Workaround that works today:
`npm i --no-save @esbuild/darwin-arm64@<matching-version>`.

---

### Rate-based alert trigger · **NOT DONE (scope unconfirmed)** · **[Wegmans eng]**

Scoped, never built. ★ **Confirm the signal + threshold with Craig before building.**

```bash
grep -rln "rateTrigger\|rate-based" runner/*.ts | head -1
```
**Output 2026-07-31: empty.**

★ **Build it on the shared per-check aggregate, not a second one.** The monitor-defect discriminator
(`narrative.ts`, `monitorDefectCandidates`) already reads `countable_run` for "what does this check's
recent history say" — the rate trigger needs the same primitive.

---

### Cart-DOM snapshot · **PARTIAL / largely superseded** · Craig → **[Wegmans monitor authors]**

Originally: the cart selectors depended on a DOM snapshot Craig captured by hand and never committed.
Monitors #118–#120 have since committed **synthetic HTML fixtures** reproducing the real shapes, with
provenance in comments.

```bash
ls ../synthwatch-monitors/scripts/redtest-*.mjs | wc -l   # committed fixture-bearing red-tests
```
**Output 2026-07-31: `4`.**

**Still open:** those fixtures are *reconstructions*, not Craig's original capture, and no capture
**procedure** is documented for the next selector change.

---

### api CI gotchas (`# nosemgrep`, TRX skip-counting) · **DONE (documented)** · **[Wegmans api eng]**

Two traps that each cost a push→CI round-trip. Written up, and the real guard exists.

```bash
cd ../synthwatch-api && grep -c "Lessons from 2026-07-20" CLAUDE.md && ls scripts/assert-tests-ran.py
```
**Output 2026-07-31:** `1` and the file exists. See [`GATES.md`](GATES.md) for the full incident.

---

## Lower blast radius — access model

### Postgres per-user accounts · **NOT DONE** · **[Wegmans DBA]**

```bash
psql "$DATABASE_URL" -tAc "SELECT string_agg(rolname,', ' ORDER BY rolname)
  FROM pg_roles WHERE rolcanlogin AND rolname NOT LIKE 'pg_%'"
```
**Output 2026-07-31:** `CraigOley@gmail.com, azuresu, replication, synthadmin, synthwatch-api,
synthwatch-runner-id` — service principals plus one personal Entra admin. **No per-engineer roles**, so
actions are not attributable.

---

## Inventory gaps that block a clean migration

### GitHub **organization-level** secrets are not enumerable · **BLOCKED** · Craig / **[org owner]**

★ **Highest-risk gap in the handover set.** `craigoley` is an **Organization**. Org secrets **do not
transfer with a repo** — and they are invisible to the current token, so a migration that accounts only
for repo secrets loses them **silently**.

```bash
gh api orgs/craigoley/actions/secrets --jq '.secrets[].name'
```
**Output 2026-07-31: HTTP 403** (`admin:org` scope missing). Resolve with
`gh auth refresh -h github.com -s admin:org`, then re-run `scripts/generate-handover-inventory.sh`.

---

### Vercel project / env vars / domains not enumerated · **BLOCKED** · **[Wegmans dashboard eng]**

```bash
command -v vercel >/dev/null && vercel project ls || echo "NO VERCEL CLI/TOKEN"
```
**Output 2026-07-31: `NO VERCEL CLI/TOKEN`.**

★ **Do not fill this in from memory** — that is the failure this register exists to end. When resolved,
capture env-var **names** per environment, which are `NEXT_PUBLIC_*` (**inlined at build time — changing
one needs a rebuild, and its value is publicly readable**), custom domains, and the protection-bypass
setting.

---

## ✅ Closed since the last revision — verified, not asserted

### `synthwatch-sandbox` is rolled AND image-verified · **DONE** (#351/#353)

Previously the register's **top** item, described as *"neither ROLLED nor VERIFIED — worse than
unverified"*. It is now closed on both halves — an example of the exact drift this rewrite exists to
prevent, since the register still carried it as outstanding.

```bash
bash -c 'source scripts/lib/deploy-lib.sh; printf "%s\n" "${RUNNER_IMAGE_JOBS[@]}"' | grep -c synthwatch-sandbox
grep -n 'pass "all ${#RUNNER_IMAGE_JOBS\[@\]}+1 jobs' scripts/deploy.sh
```
**Output 2026-07-31:** `1`, and the pass line prints **`all 8+1 jobs on image <sha> (<derived list>)`** —
the list is now **derived from the array**, so the stale-parenthetical half of the item cannot recur.

---

### Azure cost headline is live · **DONE**

```bash
curl -s https://synthwatch-api.azurewebsites.net/api/reports/cost | jq -e '.azure.mtdActual != null'
```
**Output 2026-07-31: `true`** — `mtdActual: 117.60`, `forecastMonth: 125.63`, `fetchedAt: 2026-07-30`.

★ Verify on `.azure.mtdActual`, **not** on `.azure != null`: the object is present but its fields can be
null, so the coarse check reports done while the headline shows nothing. (That mistake was made and
caught while writing this file — which is the argument for commands over prose in one line.)

---

> _A register that only grows is a status report. As an item closes, move it to **Closed** with its
> verification output — then delete it once the migration no longer needs the evidence._
