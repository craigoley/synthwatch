# Model B (encrypted DB-stored credential values) — Step 1 handoff + Step 2 encryption primitive (2026-07-08)

**Design recon. Docs-only — do NOT build the write path until this is reviewed (per the task gate).** Evidence
is `file:line` + OBSERVED/INFERRED. This covers the two GATED design deliverables (clobber/ownership handoff +
the encryption primitive); Steps 3-5 are sketched only for ordering.

## Step 1 — clobber trap + ownership handoff

### 1a. Clobber: the premise is (again) REFUTED — nothing to move out

The task says these are "in `GIT_AUTHORITATIVE_COLUMNS` → reconcile reverts DB divergence → they MUST move
OUT." **They are already out (OBSERVED, same finding as recon #234):**
- `GIT_AUTHORITATIVE_COLUMNS` (`runner/reconcile.ts:406-417`) = `name, kind, target_url, flow_name, sensitive,
  redact_patterns, environment, rewrite_from_origin`. **Neither `secret_headers` nor `login_credentials` is in
  it.**
- Neither appears **anywhere** in `runner/reconcile.ts`, and the scoped-sync (`reconcileMain.ts`) clobbers only
  `sensitive`/`redact_patterns` (`:209`) and `redtest_anchor` (`:242`). The api owns no write of them.
- Contrast `environment` (the "dead-on-arrival" case): it **is** in `GIT_AUTHORITATIVE_COLUMNS` (`:414`) + in
  `CHANGED_UPDATE_COLUMNS` (`:432`), so a divergent DB value is drift the apply corrects. That mechanism is
  **absent** for these two columns.

**Handoff conclusion:** there is **nothing to remove from Git-authoritative** — these columns are already
DB-territory, so a UI DB-write survives reconcile today. The one guardrail: **do NOT wire `login_credentials`
into the reconcile scoped-sync** (recon #233 *proposed* GitOps scoped-sync for it — model B supersedes that).
Leaving it un-reconciled keeps it DB-owned.

### 1b. Do the manifest declarations orphan? No.

Neither column is a `ManifestEntry` field (`reconcile.ts:31-47` — no `secret_headers`/`login_credentials`), so
**nothing in the manifest declares them today.** The DB fully owns them; there are no manifest declarations to
orphan. (secret_headers is set out-of-band today; login_credentials is written by nothing yet — see 1c.)

### 1c. ★ The real Step-1 issue: a COLUMN-SEMANTICS shift (#232 refs → model-B values)

This is the substantive handoff, not the clobber. **#232 (open) defined `checks.login_credentials` as a
REFERENCE map** `{ role → ENV_VAR_NAME }` — the runner resolves `process.env[ENV_VAR]` and publishes
`SW_CRED_<ROLE>` (`runner/loginCredentials.ts`). **Model B stores the VALUE (encrypted)**, not a ref. These are
different column semantics. Decide the handoff:
- **(i) Repurpose** `login_credentials` to hold `{ role → ENCRYPTED_VALUE }` (drop the ref meaning). Cleaner
  single column; the runner resolve path gains a decrypt branch (Step 2).
- **(ii) Separate column** `login_credentials_enc` for encrypted values, keeping `login_credentials` (refs) for
  any GitOps monitor that prefers refs. "instead / in addition" (the task's phrase) → the runner tries the
  encrypted column first, falls back to the ref path. More flexible, two columns to reason about.

**Recommend (i) repurpose** for login_credentials (model B is the locked model; the ref path was never
populated in prod — see 1d), and apply the SAME value-model to `secret_headers` (a UI-set header value,
encrypted) OR keep secret_headers as refs if its values are always ACA-provisioned. State this per column when
building. Either way the #232 `SW_CRED_<ROLE>` one-run-publish-then-clear + the value-redaction (just fixed in
#232) are **reused** — only the *source* of the value changes (env-ref → decrypt).

### 1d. Migration of existing data — OBSERVED: there is none to lose

- `checks.login_credentials` is written by **nothing** today: #232 (the column) is unmerged, and no reconcile
  mapping / manual set populates it. So **no existing DB values** exist to migrate.
- b2c-login-test's creds live **only as ACA env secrets** `B2C_TEST_USER`/`B2C_TEST_PASS` (the manifest b2c
  entry declares `sensitive`/`redact_patterns` but **no** `login_credentials`/`secret_headers`; the spec reads
  them via `requireSecret` / — post-#232 — `credential()` over `SW_CRED_`).
- **Migration = re-entry, not backfill:** Craig re-enters the two b2c values once through the Step-4 UI editor
  (which encrypts + stores); the `B2C_TEST_*` ACA env vars can then be retired. No lossy transform, because the
  authoritative source (the ACA secret) is known to Craig. (A one-time script *could* read the ACA env value and
  write the encrypted column, but re-entry is simpler and avoids scripting the secret through another surface.)

## Step 2 — encryption primitive (the B guardrail)

### 2a. What's available (OBSERVED)

- **No encryption anywhere today:** grep `pgcrypto|encrypt|KeyVault|DataProtection` over `infra/`, `db/`,
  api `*.cs` → **empty**. Nothing to reuse.
- **No Key Vault.** Secrets flow `@secure` bicep param → ACA job secret → `secretRef` env (`infra/main.bicep`:
  `postgresAdminPassword` `:60-61,:64`, ACS conn `:72-77`). This is the ONLY secret-delivery mechanism (same
  as the B2C-secrets task established).
- **Postgres = Flexible Server** (`synthwatch-pg-e2`, `infra/main.bicep:91-92`). `pgcrypto` is allowlistable on
  Flexible Server (`azure.extensions` server param + `CREATE EXTENSION pgcrypto`) — but see the tradeoff.
- **Entra/MI to Postgres** exists (the runner MI is the PG Entra admin, `:157-164`) — auth, not encryption.

### 2b. ★ Recommended primitive: app-layer AES-256-GCM, key = an ACA secret

Given no KV and a split write(api/.NET)/read(runner/Node), **encrypt in the app layer with AES-256-GCM, the key
delivered as a new ACA job secret** — reusing the exact `@secure`-param → `secretRef` plumbing that already
carries `postgresAdminPassword` to both jobs:
- **Key:** a new `@secure param credEncKey` → ACA secret `cred-enc-key` → `secretRef CRED_ENC_KEY` on **both**
  the api jobs (encrypt-on-write) and the runner jobs (decrypt-on-resolve). 32 bytes, base64. Set once in Azure
  (like the B2C secrets); never in git.
- **Storage:** the column holds `base64(nonce ‖ ciphertext ‖ tag)` per value (AES-GCM = authenticated → tamper
  is detected on decrypt). Versioned prefix (e.g. `v1:`) so the key can rotate.
- **Write (api, .NET):** `System.Security.Cryptography.AesGcm` encrypts the plaintext value → store. The
  plaintext never persists; the DTO never returns it (Step 3 write-only).
- **Read (runner, Node):** `node:crypto` `createDecipheriv('aes-256-gcm', …)` decrypts the column →
  `SW_CRED_<ROLE>` (the #232 one-run-then-cleared publish) → `credential(role)` in the spec, AND register the
  decrypted value as an escaped-literal redaction rule (the #232 defect-2 fix — already built).

**Why not pgcrypto:** (a) needs an infra change (allowlist + `CREATE EXTENSION`); (b) `pgp_sym_encrypt(v,key)`
puts the KEY in SQL text → it can land in `pg_stat_statements`/query logs (a real leak surface); (c) both api
and runner would still need the key anyway. App-layer AES-GCM avoids key-in-SQL, needs no extension, gives
authenticated encryption, and reuses the ACA-secret plumbing verbatim. **Do not use pgcrypto here.**

**Why not "MI/KV envelope":** there is no Key Vault to hold a KEK; introducing one is a larger infra change than
model B warrants. If KV is later added, wrap `CRED_ENC_KEY` as a KV-managed DEK — a clean future upgrade, not a
blocker now.

### 2c. The decrypt-resolve path (design, do not build yet)

```
runOne(check) →
  if check.login_credentials has encrypted values:
    for [role, ciphertext] in decrypt-all(check.login_credentials, CRED_ENC_KEY):
      process.env[SW_CRED_<ROLE>] = plaintext            // #232 publish
      redactorValues.push(plaintext)                     // #232 defect-2 registration
  makeRedactor(check.redact_patterns, redactorValues)    // scrubs the decrypted value from text
  … run spec (credential(role) reads SW_CRED_<ROLE>) …
  finally: clearLoginCredentials()  // deletes SW_CRED_<ROLE>; the plaintext + its redact rule die with the run
```
This is the #232 mechanism with `resolveLoginCredentials` (env-ref read) swapped for `decrypt-all` (DB read +
AES-GCM). Same one-run lifetime; same value-redaction; same fail-closed `credential()`.

## Ordered chain (Steps 3-5 sketch — gates unchanged)

Per the task order, each PR gates the next (no capture-before-gate, no mock-before-contract):
1. **schema** (synthwatch): the encrypted value column (repurpose per 1c-i) + confirm it stays OUT of
   `GIT_AUTHORITATIVE_COLUMNS`/reconcile. `checks` is shared → api schema-parity fixture bump.
2. **runner** (synthwatch): `decrypt-all` resolve + reuse #232 publish/clear + value-redaction. Needs
   `CRED_ENC_KEY` wired to the runner jobs (bicep @secure param → secretRef, the postgresAdminPassword path).
3. **api** (synthwatch-api): editor-gated **write** endpoint accepting VALUES, AES-GCM-encrypt-before-store;
   **write-only DTO** — the read path returns masked (`"set"` / `"••••"` / a ref label), NEVER plaintext or
   ciphertext (test must-go-red: value in any read DTO). `CRED_ENC_KEY` wired to the api jobs. Auth = the
   existing `AuthorizationMiddleware` editor/admin verb-gate. Audit rows via `AuditRedaction` (masks values).
4. **dashboard** (synthwatch-dashboard): the #219 SecretHeadersPanel viewer → EDITOR (add/edit/remove entries
   with masked VALUE inputs: set-new / masked-current), `canWrite`-gated, built against the REAL Step-3
   endpoint (no mock).
5. **migrate** (ops, not a code PR): Craig re-enters the b2c values via the editor; retire `B2C_TEST_*` ACA env
   vars (per 1d).

**Deploy-order guardrails:** the runner decrypt (2) and api encrypt (3) both need `CRED_ENC_KEY` set in Azure
*before* they run, or resolve/write fails closed (safe — a login run goes red, a write 500s — no plaintext
leak). And **PR 1b (raw-trace capture) stays independent and behind its view-gate** — model-B value-redaction
covers TEXT channels only and does NOT make a raw trace/screenshot safe (restated from #231/#232).

---
### Appendix — evidence index
- Clobber: `runner/reconcile.ts:406-417,432` (GIT_AUTHORITATIVE / CHANGED_UPDATE), `reconcileMain.ts:209,242`
  (scoped-sync clobbers only sensitive/redact/redtest); `:31-47` (ManifestEntry — no secret_headers/login_creds).
- Refs→values shift: `runner/loginCredentials.ts` (#232 ref model), `runner/redact.ts` makeRedactor(patterns,
  values) (#232 defect-2, built).
- Encryption availability: grep pgcrypto/KeyVault/encrypt → empty; `infra/main.bicep:60-61` (postgresAdminPassword
  @secure→secretRef), `:91-92` (Flexible Server), `:157-164` (runner MI = PG Entra admin).
- Write-only precedent: api `Infrastructure/AuditRedaction.cs` (masks password/token/connectionString).
- Prior recon: `2026-07-08-cred-header-write-path.md` (#234, clobber), `2026-07-08-login-cred-consumption.md`
  (#233, refs model), `2026-07-08-sensitive-trace.md` (#231, 1b view-gate).
