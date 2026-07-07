# Per-monitor request headers — ground truth + scoped design (2026-07-07)

**Analysis only.** Grounds how headers work across runner + api + monitors TODAY, then scopes
per-monitor headers (values stored as never-extractable secrets). No code.

**Evidence contract:** every claim cites `file:line` / command output; OBSERVED vs INFERRED; each
answer is ground-truth-or-hypothesis with its falsifier. Worktree at `origin/main` HEAD `0a1e2fa`.

## TL;DR

- A **per-check header mechanism already exists** — `checks.request_headers` (JSONB), merged into every
  request on BOTH the HTTP and browser paths. But its values are **plaintext and API-extractable** → not
  usable for secrets.
- A **per-check secret-by-reference mechanism already exists** — `checks.auth` (the `*_env` model): stores
  an env-var NAME, resolves `process.env[name]` at request time, exposes references-only in the DTO. This
  is the "never-extractable" pattern to mirror — **but it is HTTP-path only and auth-shaped**.
- The **browser path injects NO per-check secret** (only the fleet-wide `VERCEL_BYPASS_TOKEN`). Per-monitor
  *secret* headers require building browser-path per-check secret injection — the SAME gap as #3.
- **No per-run request-header observability**: `trace_signals` captures request url+method + response only,
  never request headers. Today the only proof is an echo endpoint the spec asserts on.

---

## 1. Current header injection — the complete picture (GROUND TRUTH)

The runner injects request headers from **three** sources today:

**(A) `check.request_headers` — per-check, PLAINTEXT, all-hosts, BOTH paths.** A JSONB map on the check.
- Browser path: `const customHeaders = check.request_headers ?? {}` (`runner/index.ts:912`), fed to
  `browserHeaderAdditions(reqUrl, customHeaders)` (`vercelBypass.ts:60-67`) inside the
  `context.route('**/*')` handler → `route.continue({ headers })`. Merged into **every** request
  (`vercelBypass.ts:55` "sent to ALL hosts").
- HTTP path: `httpCheck.ts:5` "Request config (custom headers / body / auth) is sent when present".

**(B) `check.auth` — per-check, SECRET-BY-ENV-REFERENCE, HTTP-path ONLY.** `AuthConfig`
(`runner/db.ts:12-18`) = `{ type: 'none'|'basic'|'bearer'|'api_key', username?, password_env?, token_env?,
header?, value_env? }`. `buildAuthHeader` (`httpCheck.ts:47-65`) resolves `process.env[auth.token_env]`
(etc.) at request time and emits an `authorization` / `x-api-key` header. **The secret VALUE is never
stored — only the env-var NAME** (`db.ts:43` "secret-ref auth (the `*_env` model), never plaintext").
★ OBSERVED it is NOT wired into the browser path: `grep buildAuthHeader|check.auth runner/index.ts` → no
hits (only redaction comments). So `auth` works for `kind='http'` only.

**(C) `VERCEL_BYPASS_TOKEN` — FLEET-WIDE secret, HOST-SCOPED, both paths.** `vercelBypass.ts:36-51`: a
single fleet token from the ACA job secret (`process.env.VERCEL_BYPASS_TOKEN`), added **only** for hosts
in `PROTECTED_BYPASS_HOSTS` (`:23-28` — `wegmans.com`/`meals2go.com`, a hardcoded set, `:21` "NOT derived
from target_url, NOT per-check"). Per-request host-match, deliberately **not** `extraHTTPHeaders`, to avoid
spraying the secret to third-party subresources (`index.ts:904-909`).

### Is there ANY per-check header mechanism today?

**YES for non-secret headers** (`request_headers`, both paths). **NO per-check SECRET header on the browser
path** — the only browser-path secret is the fleet bypass token (host-set hardcoded, one value). `auth` is
the only per-check secret header and it is HTTP-only.

**"The B2C spec had to add its own route" — NOT VERIFIED / not shipped.** `grep -rE '\.route\(|extraHTTPHeaders|process\.env' synthwatch-monitors/monitors/` → **empty**: no monitor spec injects its own
header today. (There is an `ANALYSIS-login-monitor-design-2026-06-30.md` design doc — the B2C login
monitor is *planned*, not extant.) **Falsifier:** if a shipped spec injected a header it would call
`page.route`/`setExtraHTTPHeaders`; none do. *(A spec COULD — the shim hands it the raw Playwright `page`
(`specShim.ts:70`), so `page.route()` + `process.env.X` is reachable in-process — but that puts injection
logic in the spec and still needs the secret provisioned as a fleet env var. No spec does this.)*

---

## 2. Where per-check headers could live — the data model (GROUND TRUTH)

The `checks` table (`db/schema.sql`) **already has both header columns**:
- `request_headers JSONB` (`:43`) — plaintext per-check headers.
- `auth JSONB` (`:45`) — the secret-ref (`*_env`) per-check header; comment `:41` "auth is a SECRET
  REFERENCE (env-var name), never a plaintext credential."
- multistep `steps` carry per-step `headers?` + `auth?` (`:52`).

**Secret / redaction precedent — TWO distinct machineries, don't conflate:**
- **`auth` `*_env` references-only** = the **secret-STORAGE** precedent (value never in Postgres/DTO/log).
  This is what "header values as never-extractable secrets" should mirror.
- **`sensitive BOOLEAN` + `redact_patterns JSONB`** (`:90-91`, B10) = the **trace-OUTPUT-scrubbing**
  machinery (skips trace zips, scrubs `trace_signals`, genericises error_message). It protects what a
  monitor's trace *emits*; it does **not** store secret inputs. Relevant to "never in output," orthogonal
  to "store the value as a secret."

**Extractability today (the decisive constraint), from the API DTO (`synthwatch-api/Dtos/CheckDtos.cs`):**
- `RequestHeaders: IReadOnlyDictionary<string,string>?` (`:59,:104`) — returned **with values** → plaintext,
  extractable via `GET /checks`. **Unusable for secrets.**
- `Auth: IReadOnlyDictionary<string,string>?` (`:61`) — comment `:56` "auth is references-only (type +
  `*_env` names)" → the DTO carries the env-var NAMES, **never the secret value**. This is the
  never-extractable shape.

**Git-managed monitors can declare NEITHER today (OBSERVED):**
- `manifest.schema.json` has **zero** `request_headers`/`auth`/`headers` fields
  (`grep -c 'request_headers|"auth"|"headers"' → 0`); it only declares `sensitive`/`redact_patterns`.
- `GIT_AUTHORITATIVE_COLUMNS` (`runner/reconcile.ts:351-358`) = `['name','kind','target_url','flow_name',
  'sensitive','redact_patterns']` — **not** `request_headers`, **not** `auth`. So those columns are
  **dashboard/seed-owned**, untouched by reconcile. A Git monitor cannot set headers via the manifest.

**Where a new field WOULD go:** reuse `request_headers` for non-secret; for secrets, either extend `auth`
to a generic secret-header type or add a `secret_headers JSONB` of `{name → env_var_name}` mirroring the
`*_env` model. Either way it needs a manifest-schema field + a `GIT_AUTHORITATIVE_COLUMNS` entry to reach
Git monitors.

---

## 3. The secret-injection gap — same work as per-check headers? (GROUND TRUTH)

**The prior finding holds for the browser path.** OBSERVED:
- HTTP path **has** per-check secret injection: `buildAuthHeader` resolves `process.env[auth.*_env]`
  per check (`httpCheck.ts:47-65`).
- Browser path **has none**: `executeBrowser` injects only `request_headers` (plaintext) +
  `browserHeaderAdditions`'s fleet bypass token. It never resolves `check.auth` or any per-check secret
  (`grep buildAuthHeader|check.auth runner/index.ts` → none).

**Same work or separable?**
- **Non-secret per-monitor headers: already done** — `request_headers` flows on both paths. No new work
  beyond exposing it to Git monitors (manifest + reconcile).
- **Secret per-monitor headers: REQUIRE the browser-path per-check secret-injection path (= the #3 gap).**
  Building secret headers for browser monitors IS building per-check secret injection for the browser path.
  They are the **same work** for `kind='browser'`. For `kind='http'` the injection path already exists
  (`auth`); a generic secret-header there is a smaller extension of `buildAuthHeader`.
- **The storage half is reusable and already proven** — the `auth` `*_env` references-only model. So the
  gap is specifically **browser-path injection**, not secret storage.

**One hard dependency the `auth` model exposes:** `*_env` resolves against `process.env` → the secret must
be provisioned as an **ACA job env/secret** (like `VERCEL_BYPASS_TOKEN` / `ACS_*` in bicep). There is **no
per-monitor secret vault**; a per-monitor secret header still needs ops to add that env var to the runner
job (a bicep change per distinct secret). This is the real cost ceiling, not the header plumbing.

---

## 4. Verify-it's-working — per-run header observability (GROUND TRUTH)

**There is NO per-run request-header observability.** `trace_signals` (`runner/traceSignals.ts`) reads from
each `resource-snapshot`: `req.url` + `req.method` (`:154,:166`) and **response** fields
(`resp.status/headers/_transferSize`, `:156-164`, `header()` reads `resp.headers` `:319-326`). It never
reads request headers. `vercelBypass.ts:14-15` states this as a security invariant: "The trace extractor
captures response/url/method only — NOT request headers — so the token can't reach `runs.trace_signals`."
**Falsifier:** if request headers were captured, `traceSignals.ts` would read `req.headers`; it does not.

**So "prove header X applied on monitor Y's request" today requires:** an **echo endpoint** — the monitor
hits a service that reflects the request headers into the response body, and the spec asserts on it (this is
the "ONE header on ONE route" proof the task references). This is spec-level, per-monitor, and only works if
you can point the monitor at an echo.

**For arbitrary per-monitor headers there are two verify surfaces (both must be BUILT):**
- **(a) Echo-assertion pattern** — cheap, spec-authored, no runner change; but requires an echo target and
  only proves headers the reflected response reveals. Not general (can't prove a header sent to the real
  prod site).
- **(b) Per-run sent-header capture (redacted)** — new observability: record which request header NAMES (and
  redacted values) were injected on a run, into a run-scoped field. Nothing captures this today; the raw
  Playwright trace zip *does* record request headers, but the extractor deliberately drops them and a
  **sensitive** monitor persists no zip at all (`redact.ts tracePersistPlan` → all-false). So (b) is net-new
  and must respect the same never-log-the-value rule (capture NAMES + a redacted marker, never the secret).

---

## 5. Design options — the path to per-monitor headers (scoped, not built)

Four pieces; the table flags EXISTS vs BUILD and the #3 dependency.

| Piece | Non-secret header | Secret header |
|-------|-------------------|---------------|
| **Schema** | `checks.request_headers` — **EXISTS** | `checks.auth` `*_env` model **EXISTS**; generalize to a `secret_headers` `{name→env_var}` or an `auth.type` extension — **BUILD (small)** |
| **Runner injection** | both paths — **EXISTS** | HTTP via `buildAuthHeader` — EXISTS; **browser path — BUILD** (the #3 gap: resolve `*_env` in the `context.route` handler alongside `browserHeaderAdditions`) |
| **Secret storage / non-extractability** | n/a (plaintext) | references-only DTO like `auth` (`CheckDtos.cs:56`), value as ACA job env var, never in Postgres/DTO/log/trace — **PATTERN EXISTS, apply it** |
| **Git-monitor declaration** | manifest field + `GIT_AUTHORITATIVE_COLUMNS` — **BUILD** | same — **BUILD** |
| **Verify surface** | echo-assertion — spec-only; or sent-header capture — **BUILD** | same, plus the capture must redact the value — **BUILD** |

**Recommended shape (mirrors the proven `auth` secret-ref, generalized to arbitrary header names):**
1. **Storage:** a `secret_headers` block of `{ headerName: envVarName }` (references-only, like `auth.*_env`).
   Non-secret headers stay in `request_headers`. DTO exposes the env-var NAMES only, never values
   (mirror `CheckDtos.cs:56`).
2. **Injection:** in `executeBrowser`'s `context.route('**/*')` handler, extend `browserHeaderAdditions` to
   also resolve `secret_headers` → `process.env[envVarName]` per request (host-scope it the way the bypass
   token is host-scoped, so a secret header never sprays to third-party subresources — the existing anti-leak
   invariant). This closes the **#3 browser-path secret-injection gap**; the HTTP path extends `buildAuthHeader`.
3. **Secret provisioning:** the referenced env var is an ACA job secret (bicep), same as `VERCEL_BYPASS_TOKEN`
   — no per-monitor vault exists, so each distinct secret is an ops/bicep addition. Flag this ceiling to Craig.
4. **Verify:** ship the echo-assertion pattern immediately (spec-level, zero runner change); optionally build
   run-scoped **sent-header-name capture (redacted)** for general proof-of-injection.

**Dependency graph:** secret per-monitor headers **⟵ depend on** the browser-path secret-injection (#3) and
on ACA env provisioning. Non-secret per-monitor headers are **already shipped** for dashboard/seed checks;
only Git-monitor declaration (manifest + reconcile) is missing. Do the manifest/reconcile mapping and the
browser-path injection first; the echo verify is free.

---

## Method note

Read the runner header path end-to-end (`vercelBypass.ts`, `httpCheck.ts`, `index.ts`, `db.ts`,
`traceSignals.ts`, `reconcile.ts`), the `synthwatch-api` check DTOs, and `synthwatch-monitors`
(`manifest.schema.json` + all specs). Every "does not exist" is a run grep (empty result cited), not an
assumption. No code, schema, deploy, or remote DB — analysis only.
