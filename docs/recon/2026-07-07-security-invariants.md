# Security-invariants audit (2026-07-07)

**Analysis only.** Confirms the security-load-bearing invariants this session touched actually **HOLD
across the code**, not just where last edited. Each is grepped for its violation shape and cited. Worktree
at `synthwatch` origin/main HEAD `732649f`; cross-repo reads pinned via `git show origin/main:`.

## Verdict summary — all five HOLD, zero VIOLATED

| # | Invariant | Verdict |
|---|-----------|---------|
| 1 | Secret never logged (bypass token / creds / `*_env`-resolved values) | **HOLDS** |
| 2 | Sensitive monitor ⇒ redaction present AND no unredacted capture | **HOLDS** |
| 3 | `trace_signals` never captures request headers | **HOLDS** |
| 4 | Reconcile-apply destructive-SQL guard intact (no DELETE/DROP/TRUNCATE) | **HOLDS** |
| 5 | `x-vercel-set-bypass-cookie` (#215) host-scoped, can't leak to third-party | **HOLDS** |

---

## 1. Secret never logged — HOLDS

**The model is references-only; resolved secret VALUES flow ONLY into request-header values, never into
a log/error/trace.**
- `buildAuthHeader` (`httpCheck.ts:52-65`) resolves `process.env[auth.token_env]` (etc.) into `token`/`pw`/`val`,
  used ONLY to build the header (`Bearer ${token}`, base64, `x-api-key`). Every failure path returns
  `error: auth: env var "${auth.token_env}" not set` — the env-var **NAME**, never the value.
- The bypass token (`bypassToken()` → `VERCEL_BYPASS_TOKEN`) is returned as a `[header, value]` pair and
  injected via `route.continue({headers})`; it is never interpolated into a logged string. `grep -E
  '\$\{token\}|\$\{pw\}|\$\{val\}|\$\{bypass'` over `runner/*.ts` → only the `Bearer ${token}` header
  construction, no log site.
- The two `throw` sites that mention a token (`aoai.ts:41`, `rca.ts:186`) throw a **static** message on
  `!token?.token` (absence check) — no value.
- `recordFatal`/`runner_errors` persist `err.message`+stack; a Playwright/HTTP error references URLs/
  selectors, not request headers, so the header-borne secrets can't reach it. Sensitive monitors
  additionally `scrubError` the message (`index.ts:561`).
- **Caveat (NEEDS-LIVE-CHECK, low):** OTel HTTP-client span attributes — default instrumentation records
  method/url/status, not header *values* (same posture as `trace_signals`), but I did not exhaustively
  audit span-attribute config. Not a grep-visible leak.

## 2. Sensitive-monitor redaction — HOLDS

**Two independent gates, both intact and wired:**
- **Enable gate (declare):** `validateManifest` rejects a `sensitive: true` monitor with no `redact_patterns`
  ("B10 requires a sensitive monitor to declare redaction before it can be enabled"), so a sensitive
  monitor can't reconcile without redaction.
- **Capture gate (persist):** `tracePersistPlan(sensitive, status)` returns `{failureTrace:false,
  successBaseline:false, failureScreenshot:false, baselineScreenshot:false}` for `sensitive` (`redact.ts:66-68`)
  — **no trace zip, no screenshot, no baseline**. Wired at the persist site: `index.ts:567`
  `const persist = tracePersistPlan(sensitive, status)` gating `persist.failureScreenshot` (`:574`) and
  `persist.failureTrace` (`:602`).
- **Live check:** the only `sensitive: true` monitor on `synthwatch-monitors` origin/main is
  `wegmans-b2c-login-test` (#52) — it **has** `redact_patterns`. No sensitive monitor has an unredacted
  capture path.

## 3. `trace_signals` request-header invariant — HOLDS

`trace_signals` is written by exactly one path: `extractTraceSignals` (`traceSignals.ts`) → persisted at
`index.ts`. That extractor reads `req.url` + `req.method` and the **response** (`resp.status/headers/_transferSize`)
only — it never reads `req.headers`. `grep -E 'req\.headers|request.*header'` over `traceSignals.ts` → **empty**.
So the bypass token / auth header (request-side) cannot reach `runs.trace_signals`. A "helpful" future
addition of request headers here would leak the token per-run — the invariant is currently intact and is
the reason the header-recon (#214) flagged it.

## 4. Reconcile-apply destructive-SQL guard — HOLDS

**Two layers, neither weakened:**
- **Runner (emit):** the `missing` drift branch emits `UPDATE checks SET enabled = false … ` — a
  **soft-disable**, explicitly "NEVER hard-delete" (`reconcile.ts:375-382, 775-776`). The runner never
  renders a `DELETE`/`DROP`/`TRUNCATE`. Plan-as-contract: the API executes only what the runner emits.
- **API (execute, defense-in-depth):** the apply executor refuses anything that isn't the exact
  soft-disable / redaction-excluded `UPDATE` shape and refuses any `DELETE` (`ReconcileFunctions.cs:129`
  "ApplyChangedAsync's shape-guard refuses one that isn't").
- **The #186 adjudication is a FALSE POSITIVE, not a weakening.** api PR #186 resolved the two
  `cs/constant-condition` CodeQL alerts (#151/#152) on this guard: the flagged clause is a
  compiler-required null guard the deeper analyzer proves redundant; the security property ("refuse any
  DELETE; refuse any non-soft-disable UPDATE") holds independently of it. Verdict quoted: "**Guard not
  weakened.** … Do not 'fix' by deleting the clause." So the guard is intact **and** the alert on it is
  correctly a non-bug.

## 5. `x-vercel-set-bypass-cookie` host-scoping (#215) — HOLDS

`browserHeaderAdditions` adds `x-vercel-set-bypass-cookie: 'true'` **inside `if (bypass)`**
(`vercelBypass.ts:83-89`), where `bypass = bypassHeaderFor(url)` is non-null only for a
`PROTECTED_BYPASS_HOSTS` host with the token set. A third-party subresource ⇒ `bypass === null` ⇒ no
set-cookie header (and no token). Same host-scope + anti-leak invariant as the token itself; #215's
must-go-red test proves ungating it fails the "third-party never carries set-bypass-cookie" assertion.
It cannot leak to a third-party origin.

---

## Method note

Grepped each invariant's violation shape over `runner/*.ts` + the api `ReconcileFunctions.cs`/apply
guard, and read the live `synthwatch-monitors` manifest (`git show origin/main:manifest.json`) for the
sensitive-monitor check. All five HOLD; none VIOLATED. The single non-exhaustive item is OTel span
attributes (INV1 caveat) — default instrumentation doesn't capture header values, but span-attribute
config wasn't audited line-by-line: **NEEDS-LIVE-CHECK, low priority**. No code, schema, deploy, or
remote DB — analysis only.
