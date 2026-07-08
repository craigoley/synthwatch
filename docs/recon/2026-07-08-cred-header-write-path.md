# secret_headers / login_credentials write path — clobber check + ownership design (2026-07-08)

**Design recon. Docs-only — do NOT build until Craig picks the ownership model.** Evidence is `file:line` +
OBSERVED/INFERRED.

## TL;DR — the premise is REFUTED

The task assumes these columns are "almost certainly in `GIT_AUTHORITATIVE_COLUMNS` → a naive UI/DB write gets
reverted by reconcile." **That is false (OBSERVED).** `secret_headers` and `login_credentials` are in **no**
reconcile path — not Git-authoritative, not scoped-synced, not in the api apply. **A DB write to them survives
reconcile today.** So a UI DB-write is **not** dead-on-arrival (unlike `environment`, which genuinely is
Git-authoritative). The clobber trap does not apply — which makes the DB-owned option (b) nearly free and the
recommended lean, with a hybrid (c) available if credential *structure* should stay in git.

## 1. Clobber confirmation (point 1) — OBSERVED

**`GIT_AUTHORITATIVE_COLUMNS`** (`runner/reconcile.ts:406-417`):
```
name, kind, target_url, flow_name, sensitive, redact_patterns, environment, rewrite_from_origin
```
`secret_headers` and `login_credentials` are **NOT** in it. And:

- **`secret_headers` appears NOWHERE in `runner/reconcile.ts`** (grep → empty) — it is not a `ManifestEntry`
  field (`reconcile.ts:31-47` lists sensitive/redact_patterns/environment/rewrite_from_origin/redtest_anchor,
  **no** secret_headers), so `validateManifest` never sees it and reconcile never writes it.
- **The scoped-sync CLOBBERS only three columns** (`runner/reconcileMain.ts`): `b10FieldUpdates` →
  `UPDATE checks SET sensitive=$2, redact_patterns=$3 …` (`:209`), and `redtestAnchorUpdates` →
  `UPDATE checks SET redtest_anchor=$2 …` (`:242`). Both force DB = manifest. **Neither touches
  secret_headers/login_credentials.**
- **The api owns no write of them either** — grep `secret_headers|login_cred` over `synthwatch-api/**/*.cs`
  → empty. The reconcile apply executes only `GIT_AUTHORITATIVE`/redaction/anchor columns.
- `login_credentials` doesn't exist on origin/main yet (#232 unmerged); when added it inherits this same
  not-reconciled status **unless a future PR wires it in** (recon #233 *proposed* scoped-syncing it — see the
  tension below).

**Contrast — why `environment` WAS dead-on-arrival:** `environment` **is** in `GIT_AUTHORITATIVE_COLUMNS`
(`:414`) and in `CHANGED_UPDATE_COLUMNS` (`:432`, git-auth minus the redaction pair), so a DB value diverging
from the manifest is **drift** that the reconcile apply corrects (editor-approved). That is the exact mechanism
that reverts a naive `environment` write — and it is **absent** for secret_headers/login_credentials.

**Verdict:** a DB-write UI for these two columns is **safe from reconcile today**. The design question is not
"how to survive the clobber" (there is none) but "**where should the source of truth live**" — which trades
GitOps auditability against UI ergonomics.

## 2. The three ownership options (point 2)

Shared invariant across all three (load-bearing, from #233 / `secretHeaders.ts:3-7`): **references-only, never
values.** Any write path stores `{name → ENV_VAR_NAME}`; the runner resolves `process.env[ENV_VAR_NAME]` at run
time; the secret VALUE is an ACA job env var, provisioned separately (the B2C-secrets path), never in the write
payload/DB/DTO. Every option below must enforce an **env-var-name shape** on write (`^[A-Z][A-Z0-9_]*$`) so an
inline value is rejected — this is the value-freeness guarantee that also lets the DTO project the refs safely.

### (a) UI-writes-to-manifest (full GitOps)
The UI/api generates a `manifest.json` edit and opens a PR against synthwatch-monitors; on merge, reconcile
writes it. **Survives reconcile because the manifest IS the source.**
- **Needs:** git-write plumbing the api does not have today — a GitHub App / token to commit + open a PR, a
  branch/PR flow, and the change only lands **after merge + next reconcile** (not immediate). Also requires
  first wiring `secret_headers`/`login_credentials` INTO the manifest schema + reconcile (they aren't today).
- **Tradeoff:** best auditability (every cred-ref change is a reviewed commit), worst latency + most plumbing.
  Heaviest option; justified only if these refs MUST be under version control with PR review.

### (b) DB-owned (move/keep OUT of Git-authoritative) — ★ recommended default
DB is the source of truth; a UI write endpoint sets the refs directly on `checks`. **Survives reconcile because
reconcile doesn't own them** — which for `secret_headers` is **already the case** (this is the status quo, just
missing an endpoint), and for `login_credentials` means simply *not* wiring it into the scoped-sync.
- **"What breaks if reconcile no longer owns them?"** For `secret_headers`: **nothing** — reconcile never owned
  it. For `login_credentials`: it diverges from recon #233's proposal to scoped-sync it from the manifest, so
  you lose (i) the manifest audit trail of which env-var a monitor's creds resolve from, and (ii) the
  manifest-declared value-freeness gate — both must be re-provided at the **write endpoint** (env-var-name-shape
  validation + an audit-log row). No reconcile behavior breaks because reconcile has no stake in these columns.
- **Tradeoff:** immediate, minimal plumbing (one editor-gated endpoint), consistent with today's secret_headers
  reality; cost is the cred-ref wiring leaves version control (audit shifts from git-PR to an api audit log).

### (c) Hybrid — manifest owns STRUCTURE, DB/UI owns the REF mapping
The manifest declares the **set of roles/headers** a monitor needs (structure — e.g. b2c needs `username` +
`password`; a monitor sends header `X-Api-Key`); the DB/UI sets **which env-var each maps to** (the ref value).
Reconcile scoped-syncs the *role/header SET* (adds/removes keys to match the manifest) but **never overwrites the
env-var a key maps to**, so a UI ref-change survives.
- **Split:** manifest (git, reviewed) = "this monitor has username+password creds" — auditable existence;
  DB/UI (editor, ergonomic) = "username → B2C_TEST_USER" — the wiring Craig tweaks without a commit.
- **Needs:** a reconcile scoped-sync that reconciles KEYS only (structure) and leaves VALUES (refs) alone — a
  key-set merge, not a whole-column clobber; plus the write endpoint for the ref values.
- **Tradeoff:** best of both (git audit of *what creds a monitor needs* + UI ergonomics for *the wiring*),
  preserves refs-only; cost is the most nuanced reconcile logic (partial-column ownership) and it's the only
  option that resolves the #233-vs-this-task tension cleanly.

**The #233 tension to surface:** recon #233 recommended `login_credentials` be manifest-declared + scoped-synced
(GitOps, manifest-validated value-freeness). This task wants a UI write path. Those pull opposite directions:
(b) drops the GitOps ownership #233 wanted; (a) keeps it but is heavy; **(c) reconciles them** (structure in git,
refs in DB). If Craig valued #233's manifest ownership, (c) is the honest answer; if he values ergonomics +
consistency with secret_headers, (b).

## 3. The write path for the recommended lean (b), with (c) delta (point 3)

Designed for **(b)** (evidence-supported default); the (c) delta is noted inline.

- **Endpoint:** extend the existing **`PATCH /api/checks/{id}`** (`UpdateCheck`, `ChecksFunctions.cs:266-268`)
  to accept an optional `secretHeaders` / `loginCredentials` object (a `{name → ENV_VAR_NAME}` map), OR a
  dedicated `PUT /api/checks/{id}/credentials` if you want it isolated from the general check patch. Either
  writes `checks.secret_headers` / `checks.login_credentials`.
- **Auth = editor+ (already enforced):** writes go through the **`AuthorizationMiddleware` verb-gate** which
  requires an editor/admin session for mutating verbs — a removed editor resolves to `Anonymous` and is denied
  (`ArtifactsFunctions.cs:42-46`, `AuthGate.Decide`). PATCH is already behind it; a new PUT inherits it. No new
  auth mechanism needed.
- **Refs-only-never-values (enforced at write):** validate every map VALUE against `^[A-Z][A-Z0-9_]*$`
  (env-var-name shape) and **reject** anything that looks like an inline secret (contains lowercase/spaces/
  punctuation/length-heuristics). This is the same value-freeness guarantee `auth` gets from write-validation
  (`CheckDtos.cs:56-57`), applied here — so the projected DTO stays value-free. The endpoint NEVER accepts or
  echoes a secret value; provisioning the ACA env var is out-of-band (the B2C-secrets flow).
- **Survives reconcile:** **yes** — `secret_headers`/`login_credentials` are in no reconcile path (§1), so the
  write is never detected as drift nor clobbered. (For (c): reconcile would key-set-merge structure but leave
  the written ref values untouched — also survives.)
- **Audit:** since the git-PR trail is gone under (b), the endpoint should write an **audit row** (who/when/
  which monitor/which refs changed — never values) to preserve accountability for a security control.
- **DTO/dashboard:** project the refs read-only (roles/headers → env-var-names, value-free by the write
  validation) so the UI can show + edit the wiring. `checks` is a shared table → the schema-parity fixture must
  carry `login_credentials` (per #232's flagged api companion) before this DTO lands.

**Recommendation:** lean **(b)** for immediacy + consistency with the already-DB-owned `secret_headers`, unless
Craig wants #233's git audit of credential structure — then **(c)**. Avoid **(a)** unless full version-control of
the refs is a hard requirement. **Do not build until Craig picks.**

---
### Appendix — evidence index
- `runner/reconcile.ts:406-417` (GIT_AUTHORITATIVE_COLUMNS — no secret_headers/login_credentials), `:432`
  (CHANGED_UPDATE_COLUMNS), `:31-47` (ManifestEntry — no secret_headers).
- `runner/reconcileMain.ts:209` (b10 sensitive/redact clobber), `:242` (redtest_anchor clobber) — the only
  scoped-syncs; neither touches these columns.
- `synthwatch-api/**/*.cs` grep `secret_headers|login_cred` → empty (api owns no write of them).
- `ChecksFunctions.cs:266-268` (PATCH UpdateCheck), verb-gate `ArtifactsFunctions.cs:42-46` / `AuthGate.Decide`
  (editor/admin floor).
- Refs-only invariant: `secretHeaders.ts:3-7`; value-free-by-write-validation precedent `CheckDtos.cs:56-57`.
- Prior recon: `docs/recon/2026-07-08-login-cred-consumption.md` (#233 — proposed scoped-syncing login_credentials).
