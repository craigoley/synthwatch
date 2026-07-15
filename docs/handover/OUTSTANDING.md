# SynthWatch — outstanding-items register (handover)

> _DRAFT · 2026-07-15 · a live register, not a status report. Ordered by **blast radius, not age**. Each item
> carries **why it's unresolved** and **the next logical step** (a comment on *why* is what cuts onboarding
> friction). Owners in **[brackets]** are Wegmans placeholders. See
> [`../../TRANSITION.md`](../../TRANSITION.md) + [`RACI.md`](RACI.md)._

## ★ Highest blast radius — data loss / silent failure / incident response

| Item | Bucket | Why unresolved | Next step | Owner |
|---|---|---|---|---|
| **`CRED_ENC_KEY` → Key Vault** | Wegmans | It lives only in `~/.synthwatch.env` on the Mac mini; **no Key Vault exists**. Encryption-at-rest deps on a transferred resource can be **unrecoverable**. | Escrow to Wegmans KV **+ a second independent escrow**; verify a decrypt round-trips. **Phase -1 gate — nothing moves until green.** | Craig → **[Wegmans secrets]** |
| **Gate B — prod↔replay drift detector** | Proof-gated build | Not built. It's the **only** thing that would catch `runs.location`-class drift (schema.sql/replay vs the actual prod catalog); today that class is caught only by hand. CI can't reach prod, but the runner's ACA env can. | Build as a scheduled ACA job (sibling of rollup/retention): dump prod catalog, diff vs the deployed image's schema.sql+migrations, write a `runner_errors` row + alert on divergence. Prove-can-fail. **Three-place ACA wiring** (CLAUDE.md). | **[Wegmans platform eng]** |
| **DR / backup topology** | Wegmans | Undocumented. The *restore model* exists (`schema.sql` + migrations), but Postgres backup cadence, blob-artifact backup, and a DR-region plan are not defined. | Define backup cadence + a rehearsed restore + a DR posture; document in TRANSITION set. | **[Wegmans platform]** |
| **Rehearse a rollback** | Craig-only | Every rollback section is stamped **DRAFT · UNREHEARSED · NEVER EXECUTED** — no image or Vercel rollback has ever been run against the live stack. An untested rollback is not a rollback. | Rehearse ONE (runner image via `deploy.sh --sha`, or dashboard via Vercel Instant Rollback) **in the shadow period, run by Wegmans, Craig watching** (Phase 2 requires it). | Craig → **[Wegmans on-call]** |
| **On-call roster (one inbox → routed)** | Craig-only | The alert `channels` table is a single row → `craig.oley@wegmans.com`, with critical **and** warning to the same inbox (*prior recon; DB firewalled — re-verify*). Alerts reach a person, not a team. | Add a Wegmans on-call channel/rota + severity routing; retire the sole personal inbox. | Craig → **[Wegmans SRE]** |
| **Payment & order-placement monitoring** | Wegmans | The seed monitors cover reachability/search, **not** the revenue path (add-to-cart → checkout → order). Deferred: needs test accounts, test cards, and sensitive-flow handling. | Scope a payment/checkout monitor with test credentials + the sensitive-trace redaction rule (`docs/proposals/spec-auth-and-secrets.md`). | **[Wegmans]** |

## Medium blast radius — correctness gates & coverage

| Item | Bucket | Why unresolved | Next step | Owner |
|---|---|---|---|---|
| **Gate A — schema.sql↔replay** | Proof-gated build | The `--schema-vs-replay` mode is built + committed (`feat/gate-a` branches) but its **cost_projection must-go-red proof was interrupted when Docker Desktop's daemon dropped**. A gate nobody has seen fail must not merge. | Bring the daemon up, run the red→green proof in the #318 devcontainer, paste the output, open the PR. | Craig → **[Wegmans platform eng]** |
| **OpenAPI spec (api)** | Proof-gated build | The api has **no** machine-readable API spec; the only shape source is the dashboard's contract fixtures. A blocker for any team integrating with it. | Generate from the C# (Swashbuckle) and CI-verify it against the actual `[Function]` routes — same tripwire pattern as `auth-gates.md`. | **[Wegmans api eng]** |
| **Narrative — holistic build** | Proof-gated build | The holistic-brief design was delivered as **recon only** (correlation pass, cite/abstain, sample-size honesty). The build is deferred. | Build the read-time correlation pass (shared-host clustering, deploy-marker correlation) reusing RCA's cite/abstain machinery; do not re-invent it. | **[Wegmans runner eng]** |
| **PR-b — 2nd golden canonicalize fixture** | Proof-gated build | The runner↔C# canonicalize golden-parity gate ships with one fixture; a second (adversarial) fixture was queued to widen coverage. | Add the 2nd shared golden fixture; keep both implementations byte-parity. | **[Wegmans eng]** |
| **`evaluate.ts` mutation coverage (31.8%)** | Proof-gated build | The mutation gate's `evaluate` module baseline is the lowest of the six (paging logic is under-pinned). Ratcheted, not raised. | Add targeted tests to kill the surviving mutants, then raise the module's break threshold. | **[Wegmans runner eng]** |
| **Rate-based trigger** | Proof-gated build | A rate-based alert trigger (fire on a rate-of-change, not just a threshold) was scoped but not built. ★ **Scope to confirm with Craig** before building. | Confirm the exact signal + threshold, then build with a prove-can-fail replay (like the 0085 WARNING debounce). | **[Wegmans eng]** |
| **Cart-DOM snapshot** | Craig-only | A checkout/cart monitor needs a DOM snapshot that Craig captured manually; the selectors depend on it and it's not committed/documented. | Capture + commit the snapshot (or the selector set) with provenance; hand off the capture procedure. | Craig → **[Wegmans monitor authors]** |

## Lower blast radius — access model

| Item | Bucket | Why unresolved | Next step | Owner |
|---|---|---|---|---|
| **Postgres per-user accounts** | Wegmans | Access today is `synthadmin` (shared) + managed identities; no per-engineer accounts, so actions aren't attributable. | Create per-user Postgres roles (least-privilege) during Phase 1. | **[Wegmans DBA]** |

> _This register is a snapshot. As items close, move them out — a register that only grows is a status report,
> not a tracker._
