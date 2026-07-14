# Proposal — authenticated monitors: secrets, bypass headers, and trace redaction

> _Verified 2026-07-14 — prose with **no automated check**; if the code disagrees, the code is authoritative. This doc CAN rot._

**Status:** recon + proposal (no prod auth/secrets re-wired here — needs Craig's sign-off on the bits flagged ★DECISION).
**Scope:** can a spec (a) read injected secrets and (b) set HTTP headers/cookies (e.g. the Vercel bypass)? And does a login leak the password into the persisted trace signals / AI insights? RECON first, then the minimal addition.

---

## TL;DR

| Need | Already works? | Gap |
|---|---|---|
| Read a secret (test login / bypass token) in a spec | **YES** — `process.env.<NAME>`, sanctioned in `docs/AUTHORING.md` | global (not per-monitor); undocumented for the *browser* path specifically |
| Set a bypass **header**/cookie (Vercel protection bypass) | **YES** — the spec gets the real `page`; `page.setExtraHTTPHeaders()` / `page.context().addCookies()` are reachable, the harness doesn't lock them down | no convenience helper; not documented |
| Password **NOT** leaking into `trace_signals` / AI insights | **mostly YES** — the extractor reads only `url` + `content-encoding` + console `text` (no auth headers, no request bodies, no fill values) | a credential in a **URL query** or a **console log** would survive; and the raw **trace zip** *does* capture fill values + request headers |

**Bottom line:** the two capabilities the user asked for **already exist**; the real work is (1) a small documented helper for the bypass header, and (2) a **credential-redaction rule** so authenticated-monitor traces don't persist the password.

---

## 1. Secrets — OBSERVED: exists + sanctioned

- HTTP/multistep checks resolve a secret **reference** (an env-var *name*, never plaintext) → `process.env[name]` (`runner/httpCheck.ts:45-63`, `buildAuthHeader`: `bearer.token_env`, `basic.password_env`, `api_key.value_env`). Nothing secret is stored in the DB or echoed.
- **Browser/Option-C specs:** the compiled spec runs **in the runner process**, so it can read `process.env.<NAME>` directly. This is already the documented pattern — `docs/AUTHORING.md:82-89`:
  > *script the login as the first step(s), sourcing credentials from a **secret env var** on the runner (never hard-code them) … read any credential from `process.env.<NAME>` and set `<NAME>` as a runner ACA-job env var / secret.*
- **Injection path (prod):** a `@secure` bicep param → a job `secret` → an `env` `secretRef` on the runner jobs (`infra/main.bicep:397 secrets:[…]`, `:425 env:[{name, secretRef:'database-url'}]`). A new secret (a Vercel bypass token, a test-login password) follows the **same** path.
- `checks.auth` is **NOT** applied to browser contexts — `executeBrowser` does a bare `b.newContext()` (`index.ts:574`) and `auth` is referenced only by `httpCheck.ts`/`multistep.ts`. So browser specs use `process.env`, not `checks.auth`.

**Limitation:** this is a **global** runner env var — every spec in the process can read it. Fine for a shared bypass token or a single shared test account; **not** for many distinct per-monitor logins (see §5).

## 2. Headers / cookies — OBSERVED: already settable by a spec

- The shim hands the spec the **real** Playwright page: `specToFlow(fn, page) → fn({ page })` (`specfetch/specShim.ts:70`), where `page = context.newPage()` on a context the harness creates with **no lockdown** (`index.ts:574-575`).
- So a spec can already do, with the standard Playwright API:
  ```ts
  await page.setExtraHTTPHeaders({ 'x-vercel-protection-bypass': process.env.VERCEL_BYPASS! });
  // or a cookie:
  await page.context().addCookies([{ name: '_vercel_jwt', value: process.env.VERCEL_JWT!, domain: '...', path: '/' }]);
  ```
- Caveat: the shim's `test()` fixture passes **only `{ page }`** (not `{ context, request }`) — so use `page.context()` / `page.setExtraHTTPHeaders()`, not a `context` fixture arg.

**→ The Vercel-bypass header works today.** What's missing is a *sanctioned, documented* helper so authors don't re-derive it (and so we can centralize redaction — §3).

### ★ Proposed minimal addition (clean, ~2 files — propose, don't build blind)
Add to **`synthwatch-monitors/lib/flow.ts`** (and vendor into `runner/specfetch/specShim.ts`, which already vendors `assertLoaded`/`dismissInterstitials`):
```ts
/** Set request headers for every subsequent navigation/fetch on this page (e.g. a Vercel bypass). */
export async function setRequestHeaders(page: Page, headers: Record<string, string>): Promise<void> {
  await page.setExtraHTTPHeaders(headers);
}

/** Vercel protection-bypass: header + the set-bypass-cookie hint. Token from a runner secret env. */
export async function vercelBypass(page: Page, token = process.env.VERCEL_AUTOMATION_BYPASS_SECRET): Promise<void> {
  if (!token) throw new Error('vercelBypass: VERCEL_AUTOMATION_BYPASS_SECRET not set on the runner');
  await page.setExtraHTTPHeaders({
    'x-vercel-protection-bypass': token,
    'x-vercel-set-bypass-cookie': 'true',
  });
}

/** Read a required runner secret with a clear error (mirrors http-check's "env var not set"). */
export function secret(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`secret: env var "${name}" not set on the runner`);
  return v;
}
```
Plus an `AUTHORING.md` section "Authenticated & protected deployments". This is additive, no new infra, no secrets system — just ergonomics over capabilities that already exist.

## 3. ★ Trace leak — the security-critical finding + the redaction rule

A login spec types the password (`page.fill(loc, secret('TEST_PW'))`) and/or sends an auth header. Where can that surface, now that traces are persisted (#114, OPEN) and a compact summary is fed to AI?

- **`trace_signals` (DB, AI-fed) — LOW risk (OBSERVED).** The extractor (`feat/persist-trace-signals:runner/traceSignals.ts`) reads only: request `url`, the `content-encoding` response header, and console `messageType`/`text`/`location.url`. It does **NOT** extract `Authorization`/cookie headers, request **bodies**, or **fill values**. So a header-injected bypass token and a POST-body password **never reach `trace_signals`** → never reach AI. The only residual: a credential in a **URL query string** or printed to **console**.
- **The raw trace zip (`trace_url` per-run + `success-latest/check-<id>.zip` baseline) — HIGHER risk (INFERRED, Playwright behavior).** `tracing.start({ screenshots:true, snapshots:true })` (`index.ts:589`) captures the action log (a `page.fill` records its **value**), DOM snapshots (may capture input values), and `trace.network` request **headers** (where a bypass token / `Authorization` lands). So the zip **can** contain credentials. The zip is access-controlled (private blob, MI-proxied by the API) — but the **success-baseline** zip persists the "last known good" of an authenticated monitor *indefinitely*.

### ★DECISION — proposed redaction rule (3 layers, defense-in-depth)
1. **`trace_signals` invariant + scrub** (cheap, do this in/after #114): keep the extractor's "no headers/bodies/values" property as an explicit invariant, **and** redact known secret *values* from the fields it does keep. The runner knows the injected secret values (`process.env`), so before persisting, replace any occurrence of those values in `url`/console `text` with `«redacted»`. Closes the URL-query / console-log residual. ~10 lines, deterministic, no AI exposure of secrets.
2. **Prefer header/cookie/storageState injection over visible `page.fill`** for credentials, documented in AUTHORING.md. A header/cookie value is in network headers (not extracted by `trace_signals`); a `fill` value is in the action log. The Vercel bypass is already a header → ideal.
3. **Authenticated-monitor zip handling** (★DECISION — Craig): for checks flagged authenticated, either (a) **don't persist the success-baseline trace** (the baseline is the one that lingers), or (b) accept the zip as a sensitive artifact (already behind API auth) but **never feed the raw zip to AI** — only the scrubbed `trace_signals`. Recommend (a)+(2): skip the success-baseline for auth monitors and inject via header/storageState so even the per-run failure zip is clean.

## 4. Best-practice recommendation (storing the login)

- **Shared bypass token / single shared test account →** a **runner secret env var** (bicep `@secure` param → job secret → `secretRef`), read via `secret('NAME')`. Already supported; just add the secret. **Do this.**
- **Never** put credentials in the spec/repo (same rule as http-check auth).
- Inject as **header/cookie/storageState** where possible (keeps it out of the action log / `trace_signals`).

## 5. ★DECISION — per-monitor distinct logins (the bigger option, for Craig)

If many monitors each need a *different* login (not one shared account), env vars don't scale (one global namespace). Options, in order of effort:
- **A. Namespaced env vars** (cheap): `LOGIN_<SOURCE_KEY>_USER` / `_PW`, a helper resolves by the check's `source_key`. Still global-readable in-process, but per-monitor addressing. No schema change.
- **B. Encrypted per-monitor creds in the DB** (bigger): a `checks.auth_secret` (or a `monitor_secrets` table) holding **encrypted** credentials, decrypted in the runner with a Key Vault / MI-held key. Needs: schema + migration, a KV key + MI grant, encrypt-on-write (API) / decrypt-on-read (runner), and the API must **never** return plaintext. This is a real secrets subsystem — **lay out, don't build blind**; recommend only if the fleet genuinely needs many distinct logins.

Recommendation: start with **shared env secrets (§4)** + the **header helper (§2)** + the **redaction rule (§3)**. That covers the Vercel bypass and a shared test login immediately. Escalate to A/B only when a real multi-login need appears.

---

## What this PR is / isn't
- **Is:** recon findings (OBSERVED, with file:line) + a concrete proposal + ready-to-apply helper code + the redaction rule.
- **Isn't:** it does **not** re-wire prod auth, add secrets, or change #114 — those are the ★DECISION items above for Craig to greenlight (esp. the trace-redaction layer and any per-monitor creds).
