# CRED_ENC_KEY single-source — deploy-mechanism finding + drift-safe automation (2026-07-08)

**Analysis, then build.** Goal: one `~/.synthwatch.env` value flows to BOTH the runner secret and the api
appsetting, with a check that catches divergence — no manual double-entry, no silent prod decrypt failure.
Evidence = `file:line` + OBSERVED/INFERRED.

## Deploy-mechanism finding (the crux — resolved, NOT assumed)

1. **Runner** — `scripts/deploy.sh` sources `~/.synthwatch.env` (`:145`) and applies the runner bicep
   (`infra/main.bicep`, `:75`) via `az deployment group what-if`/`create` (`:410,:477`), passing
   `credEncKey="${CRED_ENC_KEY:?…}"` (`:421,:487`). So the runner key **is** the env-file value. **OBSERVED.**
2. **API** — the api bicep (which carries the `CRED_ENC_KEY` appsetting via the `credEncKey` param) is applied
   **manually / locally**: `az deployment group create -g synthwatch-rg -f infra/main.bicep -p …`
   (synthwatch-api `README:129`, `infra/main.bicep:13`). **It is NOT CI-owned** — no `.github/workflows/*`
   runs `az deployment group create` (the only `main.bicep` hit is `grant-coverage.yml`, a static parse), and
   the code-deploy `deploy.yml` is `dotnet publish` + `functions-action` only (it merely *warns* on missing
   appsettings, never sets them). There is **no api deploy script** today. **OBSERVED.**
3. **deploy.sh applies ONLY the runner** — it references the api solely as a post-deploy health-URL smoke
   check (`:63,:630`), never `az deployment group create` for the api. **OBSERVED.**
4. **Both keys are bicep-owned (drop-safe).** The runner secret is a bicep `secrets:` entry and the api key is
   a bicep appsetting (both from the `credEncKey`/`credEncKey` params, PRs #236/#199). So neither can be set
   durably by a one-off `az … secret set` / `appsettings set` — a later bicep apply re-asserts the param and
   wipes an out-of-band value. **The value MUST flow through both bicep applies.** **OBSERVED + INFERRED.**

**Because the api is local (not CI-owned), single-source is achievable locally** — the honest option the task
asked me to flag (CI-set would've made it harder) does not apply.

## Why "extend deploy.sh to apply BOTH bicep deploys" is UNSAFE

`az deployment group create` applies the whole template; any param not passed → its **default**. The api
bicep has params prod sets **non-default** that default to empty: `adminEmails=''` (`:47`) and
`azureOpenAiEndpoint=''` (`:59`) — auth admins + the AI-insights endpoint. If the runner's `deploy.sh`
applied the api bicep with only `pgHost`/`cors`/`credEncKey` (the README's documented set), it would **wipe
`adminEmails` and `azureOpenAiEndpoint` to ''**, breaking auth + AI. `deploy.sh` does not know the full api
param set, so it must not own the api apply. **OBSERVED (param defaults).**

## The chosen design — single env source + a VERIFIED fingerprint drift-check

Satisfies the task's "minimal change that guarantees same-value-both-sides" without the wipe risk:

1. **One value, both reads.** `CRED_ENC_KEY` lives once in `~/.synthwatch.env`. The runner `deploy.sh` reads
   it (already). A **new `synthwatch-api/scripts/set-cred-key.sh`** sources the SAME `~/.synthwatch.env` and
   sets the api's `CRED_ENC_KEY` via an **incremental** `az functionapp config appsettings set --settings
   CRED_ENC_KEY=…` — which touches ONLY that setting (no wipe of `adminEmails`/`azureOpenAiEndpoint`, and the
   code-deploy `deploy.yml` never touches app settings, so it persists). No double-entry: both read one value.
   The bicep `credEncKey` param (#199) remains the DECLARED source re-asserted on a full api bicep apply
   (pass `credEncKey="$CRED_ENC_KEY"` there too); `set-cred-key.sh` is the quick single-source set between
   bicep applies. Either way the value comes from the one env file, and the drift-check (below) is the net.
2. **★ The drift-check (the real safety net).** The api exposes a non-secret **key fingerprint**; the runner
   `deploy.sh` computes the SAME fingerprint from `~/.synthwatch.env`'s `CRED_ENC_KEY` and asserts it equals
   the api's. **Mismatch → the deploy VERIFY goes RED** — catching a divergence (api deployed with a different
   key, or not deployed) *before* it becomes a silent prod decrypt failure. The runner side is the env value
   by construction (deploy.sh sets it from the same var), so `fp(env) == fp(api)` ⇒ `runner == api`.

**Fingerprint scheme (identical in .NET + bash, never the key):**
`fp = first 16 hex of sha256("CRED_ENC_KEY_FP_v1:" + <base64 key string>)`.
- Domain-separated (the `CRED_ENC_KEY_FP_v1:` prefix) so it isn't a bare key hash; truncated to 64 bits —
  enough to detect drift, useless to an attacker; sha256 of a 256-bit key is irreversible regardless.
- Hashing the **base64 string** (not decoded bytes) keeps bash portable (no `base64 -d`/`-D` split) AND makes
  it detect even a whitespace/padding typo — exactly the fat-finger we're guarding. Both sides set the SAME
  source string, so a match is expected; a mismatch is real drift.
- api: `SHA256(UTF8("CRED_ENC_KEY_FP_v1:" + keyB64))[..16 hex]`; bash:
  `printf 'CRED_ENC_KEY_FP_v1:%s' "$CRED_ENC_KEY" | openssl dgst -sha256 -hex | awk '{print $NF}' | cut -c1-16`.

**Why a fingerprint, not a KAT round-trip:** a round-trip (api-encrypt → runner-decrypt a test value) needs a
live api encrypt endpoint + a runner decrypt path wired + a shared test artifact across a cron boundary —
heavy and not yet built. A fingerprint compare is a single non-secret hash each side already has the inputs
for, verifiable in `deploy.sh` with one `curl`. It proves key-equality, which is exactly the invariant.

## Build (this task)

- **synthwatch-api**: `CredCrypto.Fingerprint(keyB64)` + a small **fingerprint endpoint**
  (`GET /api/cred-key/fingerprint` → `{ fingerprint }`, 503 fail-closed if the key is absent; the value is a
  hash, never the key). Tests: stable, different key → different fp, a pinned known-answer that locks the
  scheme to deploy.sh's bash, fail-closed. Plus `scripts/set-cred-key.sh` (wipe-safe single-source setter
  reading `~/.synthwatch.env`).
- **synthwatch**: `deploy.sh` VERIFY gains a **drift-check** — compute `fp(CRED_ENC_KEY)` locally, `curl` the
  api fingerprint, `check` they match (RED on mismatch). Never logs the key (only the 16-hex fingerprint).

**VERIFY:** one value in `~/.synthwatch.env` feeds both deploy scripts; the drift-check confirms match
(must-go-red on a deliberate mismatch); the key is never logged. Runner deploy.sh optionally invoking the api
script for literal "one command" is a follow-up nicety — deferred so the runner deploy doesn't own the api
param set (the wipe risk above).

---
### Appendix — evidence index
- Runner: `scripts/deploy.sh:145` (source env), `:421,:487` (credEncKey param), `:75` (runner template),
  `:63,:630` (api = health smoke only).
- API deploy: synthwatch-api `README:129` + `infra/main.bicep:13` (manual `az deployment group create`);
  `deploy.yml` (code-only, warn-on-missing appsettings); no CI bicep apply; no api deploy script.
- Wipe risk: synthwatch-api `infra/main.bicep:26` (pgHost required), `:47` (adminEmails=''), `:59`
  (azureOpenAiEndpoint='').
- Both keys bicep-owned: #236 (runner secret), #199 (api appsetting).
