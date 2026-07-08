# Per-monitor login credentials — storage, the consumption fork, redaction, and the ordered chain (2026-07-08)

**Design recon. Docs-only — do NOT build from this without review.** Evidence is `file:line` + OBSERVED/INFERRED.

> **Relationship to PR #232 (`feat/per-monitor-login-creds`, open, off origin/main).** #232 already *built* the
> runner side of this model (schema `checks.login_credentials`, `loginCredentials.ts` resolve + `SW_CRED_<ROLE>`
> publish/clear, a `specShim.credential()` accessor). This recon is the design that should have preceded it, and
> it finds **two things #232 got wrong or skipped**: (a) it put `credential()` **outside** the parity-hashed
> block (so the gate can't catch authoring↔runtime drift), and (b) it does **no redaction registration** of the
> resolved value. Treat this doc as the corrected design; #232 should be revised to match (§2, §3) before merge.

## TL;DR

- **Storage** mirrors `secret_headers` (a `{ref→ENV_VAR}` JSONB column, migration-added). **DTO** must apply the
  #197 gate: `secret_headers` is **not mapped at all**; `auth` **is** mapped **because write-validation
  guarantees it's value-free**. Login creds are reconcile-written (not api-write-validated), so project only a
  **read-only, derived ref-status** (roles + env-var-names), gated on a manifest value-freeness guarantee.
- **The fork** is real: `secret_headers` never touches spec JS; a login cred must reach `.fill()`. The value
  crosses the `lib/flow↔specShim` seam via a `credential(role)` accessor. **The parity gate requires that
  accessor to live in the SHARED block** (else authoring and runtime copies can silently diverge — the exact
  drift class the gate exists to stop). #232 dodged this by placing it outside the block.
- **Redaction is the sharp gap.** `makeRedactor(declaredPatterns)` takes **no values** (redact.ts:37). The b2c
  patterns scrub session tokens + `password=VALUE` (form-encoded), **not the bare typed value**. A generic
  per-monitor cred inherits **nothing** unless its author declares a matching pattern — impossible for a secret
  value. Fix: **auto-register the resolved cred values as escaped-literal rules**. This becomes load-bearing the
  moment PR 1b flips sensitive capture (a raw trace embeds the DOM-typed value; screenshots can't be text-scrubbed).
- **Chain order** (deps below): schema → runner(resolve+consume+**redact**, parity-locked w/ lib/flow) →
  manifest+reconcile(scoped-sync) → api DTO(refs-only) → spec migration → dashboard. Two ordering traps to avoid:
  spec-migration must **deploy after** the runner accessor (else `credential()` throws), and the dashboard must
  consume the **real** DTO, not a mock (mock-before-contract).

---

## 1. Storage / reference model (point 1)

**`secret_headers` precedent (OBSERVED):**
- Column: `checks.secret_headers JSONB` (`db/schema.sql:49`), migration `db/migrations/0061_checks_secret_headers.sql`.
- Runner resolves at request time (`secretHeaders.ts`), **network-layer inject only**.
- **DTO: NOT mapped.** `grep -ri secret_headers synthwatch-api/**/*.cs` → **empty** (only redaction tests). The
  header names + env-var names are withheld from the api entirely (`secretHeaders.ts:7` "NEVER in a DTO").
- Contrast `auth`, which **is** mapped: `CheckDtos.cs:61` `IReadOnlyDictionary<string,string>? Auth`, with the
  justification at `:56-57` — *"auth is references-only (type + \*\_env names); **write validation forbids inline
  credential values**, so nothing secret is ever stored/echoed."*

**The #197 gate principle (OBSERVED, `docs/recon/2026-07-08-preprod-write-gate.md:29,44-46`):** the reconcile
apply is gated because the **runner writes the plan but the api executes it, editor-gated + audited**. Generalized
to DTO projection: **a column is safe to project iff the api can guarantee it is value-free** — `auth` earns
projection via its validated write path; a column written **out-of-band** (runner/reconcile) cannot, so it is
gated (withheld, or reduced to a derived read-only status — cf. the redaction status `hasRedactPatterns`/
`redactionHealth` at `CheckDtos.cs:76-77`, which shows *state*, never the patterns).

**Design for `login_credentials`:**
- **Column:** `checks.login_credentials JSONB` = `{ credentialRole → ENV_VAR_NAME }`, `DEFAULT NULL`. Mirrors
  `secret_headers` storage exactly. (#232's migration 0067 already does this.)
- **Value-freeness guarantee:** the manifest schema + `validate-manifest` + reconcile MUST enforce each value
  matches an **env-var-name shape** (`^[A-Z][A-Z0-9_]*$`) — no inline secret. This is what lets the api treat it
  as value-free (the `auth` bargain, but enforced at the *manifest* layer since login_credentials is
  reconcile-written, not api-written).
- **DTO:** project a **read-only, derived ref-status** — the roles and their env-var-names (both non-secret) —
  NOT an editable/echoed field. Gated per #197: it's GitOps-owned (like `sensitive`/`secret_headers`), so the
  dashboard shows it read-only. Do **not** map it as a writable `Auth`-style dictionary (login_creds has no
  api-side validated write path). *(INFERRED design; the value-free guarantee is the load-bearing precondition.)*

## 2. The consumption fork — how the value reaches `.fill()` (point 2, the hard part)

**Why `secret_headers`' mechanism can't be reused (OBSERVED):** `secret_headers` resolves and injects at the
network layer (`index.ts` `context.route` path) — the value never enters spec JS. The b2c login **types** the
value: `b2c-login-test.spec.ts:403-404` `requireSecret('B2C_TEST_USER'/'B2C_TEST_PASS')` → `:521`
`page.locator('#signInName').first().fill(username)`. So the value **must** be in spec scope.

**The seam (OBSERVED):** the runner esbuild-aliases every spec's `lib/flow` import to
`runner/specfetch/specShim.ts` and marks it external (`compileSpec.ts`), and runs the captured test fn via
`specToFlow(fn, page)` (`specShim.ts:70`). So a spec-reachable helper must be **exported from both**
`monitors/lib/flow.ts` (authoring / local `playwright test`) **and** `specShim.ts` (runtime).

**★ What the parity gate REQUIRES of a new spec-reachable value (OBSERVED, `scripts/check-libflow-parity.mjs`):**
the gate hashes ONLY the block delimited by `>>> / <<< SHARED-WITH-RUNNER-SPECSHIM` in `lib/flow.ts` and compares
it to `LIBFLOW-VENDOR-SHA` in `specShim.ts`; **mismatch = FAIL CLOSED**, source-missing = SKIP. Its entire reason
for existing: a `lib/flow.ts` change is **dead at runtime until mirrored into specShim** and "CI was silent"
(cost 3 wasted traces). Therefore:

- **A security-relevant, spec-reachable accessor whose authoring and runtime copies must agree belongs INSIDE
  the shared block**, with the SHA bumped — so the gate *guarantees* they never drift. If they drift, a login
  spec could resolve creds one way locally and another (or fail-open vs fail-closed) in prod — precisely the
  silent-divergence the gate prevents.

**Two options (design fork):**

| | (A) `credential()` OUTSIDE the block — *what #232 did* | (B) INSIDE the shared block — *recommended* |
|---|---|---|
| Parity churn | none (no SHA bump, no lockstep) | SHA bump; monitors `lib/flow.ts`@main must carry the identical block *before* the runner PR's CI passes (fail-closed) |
| Drift protection | **none** — authoring vs runtime can silently diverge | **gate-enforced** — copies can't drift |
| Fit | ok only if the impl is trivially identical + unit-tested on both sides | correct home for a fail-closed secret accessor |

**Recommendation: (B).** The accessor is a self-contained env read (no `page`/`expect` dep), so it sits cleanly
in the shared block: `credential(role)` reads `process.env['SW_CRED_' + role.toUpperCase()]`, **fail-closed** (an
undeclared/unresolved role throws — a mis-wired login monitor must go red, never submit an empty credential).
The value is **published per-run and cleared**: the runner resolves `{role→ENV_VAR}` → sets
`process.env[SW_CRED_<ROLE>]` right before the flow, deletes it in the `executeBrowser` finally (so a resolved
secret can't linger or bleed across the tick's serially-run checks). Boundaries the value must NOT cross: it goes
`process.env → credential() → .fill()` and nowhere else — never a log, never a return through the recorder,
never a persisted field (see §3). *(INFERRED design; #232 chose (A) — revise to (B), inlining the key derivation
so `lib/flow.ts` needs no runner import.)*

## 3. Redaction — the gap and the fix (point 3)

**OBSERVED: the resolved value is NOT auto-scrubbed.** `makeRedactor(declaredPatterns)` (`redact.ts:37`) builds
rules from the BUILTIN token/JWT/Bearer denylist + the monitor's **declared** patterns only — it takes **no
values**. The b2c patterns (`manifest.json` b2c entry) are session-shaped:
`Bearer …`, `eyJ…` (JWT), OAuth params, `x-ms-cpim/AADB2C/csrf`, and `(password|signInName)=[^&\s]+` — the last
scrubs the **form-encoded** `password=VALUE`, **not the bare typed value**. So:

- A **generic** per-monitor cred inherits **nothing** — its author would have to declare a pattern matching the
  value, which for a secret is impossible without embedding the secret in the pattern.
- Where can the bare value surface? `trace_signals` captures network **method/url/status** + console text — **no
  request bodies/headers** (audit #219, security-invariants doc) — so the POST'd password never reaches
  `trace_signals`. The residual TEXT surface is **console text** (if the site echoes it) and **`error_message`**
  (a Playwright assertion/timeout embedding the value) — both scrubbed by `scrubError`/the extractor **only if a
  declared pattern matches** (it won't, for a bare value). Today `sensitive` also skips the raw zip + screenshot
  (`tracePersistPlan`), so the DOM-embedded value isn't persisted.

**★ Fix: register the resolved values as redaction rules.** Give `makeRedactor` a second argument
`knownValues: string[]` (the run's resolved cred values) and add each as an **escaped-literal** rule
(`escapeRegExp(v) → <redacted>`). Then the exact typed value is scrubbed anywhere in text — console,
`error_message`, `trace_signals` — **independent of declared patterns**. Wire it where the redactor is built in
`executeBrowser` (right after `applyLoginCredentials` resolves them). Defense-in-depth: declared patterns stay
for session tokens; the value-literals cover the credential itself.

**★ The PR 1b interaction (load-bearing).** The moment 1b flips `tracePersistPlan` to persist the raw trace +
screenshot for `sensitive`, the DOM-embedded typed value is captured. **Text redaction cannot scrub a
screenshot or a trace DOM snapshot** — a password field renders masked, but the trace's DOM/`fill()` value holds
the real string. So: (i) the value-literal registration above closes the *text* surface, but (ii) the *raw
trace/screenshot* surface is unclosable by redaction — 1b's safety rests **entirely** on the view-layer gate
(PR 3) + the accepted-non-exposure test account. This recon reaffirms PR #231's conclusion: **1b must not deploy
before the view-gate.**

## 4. The full chain, sequenced (point 4)

Dependencies and the two traps (capture-before-gate, mock-before-contract) made explicit:

| # | PR (repo) | Delivers | Depends on | Notes / trap avoided |
|---|---|---|---|---|
| 1 | **schema migration** (synthwatch) | `checks.login_credentials JSONB` | — | #232 has this (0067). `checks` is SHARED → reds the api schema-parity gate until step 4's fixture bump. |
| 2 | **runner resolve+consume+redact** (synthwatch **+** monitors `lib/flow.ts`, lockstep) | `resolveLoginCredentials`, per-run `SW_CRED_<ROLE>` publish/clear, `credential()` **in the shared block** (SHA bump), **value-literal redaction registration** | 1 | #232 built a version but must be revised: move `credential()` into the parity block (§2-B) **and** add redaction registration (§3). Parity-lockstep: monitors `lib/flow.ts`@main must carry the matching block or runner CI fails-closed. |
| 3 | **manifest + reconcile scoped-sync** (monitors `manifest.schema.json` + runner `reconcile.ts`) | declare `login_credentials` with **env-var-name-shape** validation (the value-free guarantee); **scoped-synced** like `redtestAnchorUpdates`/`sensitive` (`reconcile.ts:45,63-65`), **NOT** the positional Git-authoritative tuple | 1 | ★ #216 lesson: scoped-sync, never positional — a login_credentials in the apply tuple would shift indices and desync the materialize. |
| 4 | **api DTO refs-only** (synthwatch-api) | read-only derived ref-status (roles→env-var-names, value-free by step 3) + schema-parity **fixture bump** (`tests/fixtures/schema.sql`) | 1, 3 | Contract-FIRST: define the DTO before the dashboard mocks it (mock-before-contract trap). Gate per #197 — read-only, not a writable `Auth`-style field. |
| 5 | **spec migration** (monitors) | b2c `requireSecret('B2C_TEST_USER')` → `credential('username')` (`.spec.ts:403-404`); declare its `login_credentials`; generalize to any future authenticated flow | 2 (deployed), 3 | ★ Deploy-order trap: the spec's `credential()` throws (fail-closed) until step 2's runtime accessor is **deployed** — migrate specs only after the runner accessor is live. |
| 6 | **dashboard UI** (synthwatch-dashboard) | show the declared cred refs (read-only) | 4 | Consume the real DTO (step 4), not a mock. |

**Ordering summary:** 1 → 2 (with its monitors-`lib/flow` lockstep) → 3 → 4 → 5 → 6. Merge-order and
deploy-order differ in two places: step 2's parity means monitors `lib/flow.ts` merges *with/just-before* the
runner SHA bump; step 5's specs must not *deploy* before step 2's runner is live. Neither the capture-before-gate
nor the mock-before-contract mistake recurs if 4 precedes 6 and 1b (separate) stays behind its view-gate.

**Re: "shopping-flow" (OBSERVED):** every current shopping flow in `manifest.json`
(`meals2go-cheese-pizza-cart`, `browse-menu`, `catering-browse`) is explicitly **anonymous/accountless — no
login** (`sensitive:false`). So today **only b2c** consumes login creds; "shopping-flow moves to the model" is
the *generalization target* (a future authenticated cart), not a present migration. Step 5 should migrate b2c
now and leave the model ready for that flow.

---
### Appendix — evidence index
- Storage: `db/schema.sql:49`, `db/migrations/0061_checks_secret_headers.sql`; `secretHeaders.ts:7` (not-DTO'd).
- DTO precedent: `synthwatch-api/Dtos/CheckDtos.cs:56-61` (`Auth` mapped, value-free-by-write-validation),
  `:76-77` (redaction status = derived read-only); `grep secret_headers **/*.cs` → empty.
- #197 gate: `docs/recon/2026-07-08-preprod-write-gate.md:29,44-46`.
- Fork/seam: `b2c-login-test.spec.ts:82,403-404,521`; `specShim.ts:70` (`specToFlow`); parity guard
  `scripts/check-libflow-parity.mjs` (hashes the `SHARED-WITH-RUNNER-SPECSHIM` block, fail-closed on mismatch).
- Redaction: `redact.ts:37` (`makeRedactor` — no values arg), b2c `manifest.json` `redact_patterns`
  (session-shaped + `password=VALUE`, not the bare value); tracePersistPlan skips zip/screenshot for sensitive.
- Sync model: `reconcile.ts:45` (scoped-sync, NOT apply-tuple), `:63-65` (sensitive/redact scoped divergence).
- Prior recon: `docs/recon/2026-07-08-sensitive-trace.md` (1b must stay behind the view-gate).
