# Security Policy

SynthWatch is a **security-adjacent tool**: it drives real browser automation
(Chromium via Playwright) and holds credentials for its database and alerting
channels (Azure Communication Services, generic webhook, Azure Blob). Please
treat vulnerabilities here accordingly.

> _Verified 2026-07-14 — this policy is prose with **no automated check**. If the code disagrees with it, the code is authoritative; fix the doc. Distrust anything here the source contradicts._

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.**

Report privately through GitHub's **[Private vulnerability reporting](https://github.com/craigoley/synthwatch/security/advisories/new)**
(the *Security → Advisories → Report a vulnerability* flow). This opens a private
GitHub Security Advisory visible only to maintainers until a fix is published.

Please include:

- A description of the issue and its impact.
- Steps to reproduce (or a proof of concept).
- Affected version / commit, and any relevant configuration.

We aim to acknowledge a report within **5 business days** and to keep you updated
as we triage and remediate. Coordinated disclosure is appreciated — give us a
reasonable window to ship a fix before any public write-up.

## Supported versions

This project is pre-1.0 and ships from `main`. Security fixes are applied to the
latest released state; older snapshots are not back-patched.

| Version            | Supported          |
| ------------------ | ------------------ |
| `main` (latest)    | :white_check_mark: |
| Tagged pre-1.0     | :x:                |

## Trust model — the execution boundary (there IS a dynamic-code surface; here is how it is bounded)

SynthWatch runs two kinds of monitor logic, and **one of them is a deliberate, bounded
dynamic-code-execution surface.** Naming it precisely is the point: a denied risk is
unauditable, a described-and-bounded one is defensible. The controls here are good — so
they are described, not hidden.

1. **In-repo flows.** A `flow_name` check runs a Playwright flow that lives in *this*
   repo under `runner/checks/`, added via reviewed PR. The name is validated against
   `/^[a-z0-9-]+$/` before import (no path traversal). Static, reviewed code.

2. **Option-C specs — the dynamic surface.** A `spec_path` check runs a Playwright spec
   that lives in a **separate repo, `craigoley/synthwatch-monitors`**. At run time the
   runner:
   - **fetches** it from that repo at **`main`'s HEAD commit SHA, single-file, over the
     GitHub contents API** (`runner/specfetch/fetchSpec.ts`). Host + repo are hardcoded
     constants; the path is traversal-guarded by `SPEC_PATH_RE` + a `..` check
     (`assertValidSpecPath`), so a poisoned DB row cannot redirect the fetch.
   - **esbuild-compiles** it with `resolveDir: tmpdir()` and exactly **one** import
     alias, `lib/flow` → the runner's shim (`runner/specfetch/compileSpec.ts`). A spec
     importing **any other module cannot bundle.** That single-alias constraint is a
     **security control, not a build quirk** — it is what keeps a spec to one file with
     no arbitrary imports.
   - caches the compiled JS in **`spec_cache`** and **`await import()`s it at runner
     privilege** (`runner/specfetch/compileSpec.ts:75`).

   **Therefore a `spec_cache` write is arbitrary code execution as the runner — that is
   the RCE boundary.** Migration `0041_spec_cache_least_privilege.sql` says so in as many
   words: a stray write grant would be "a MERGE-GATE BYPASS … → RCE."

### The controls (every one, by file)

- **`spec_cache` is write-locked to the runner (Postgres owner `synthadmin`) at BOTH
  layers.** There is no API write route, and the limited `synthwatch-api` role is
  explicitly REVOKED INSERT/UPDATE/DELETE on it
  (`db/migrations/0041_spec_cache_least_privilege.sql:36`; `db/schema.sql` carries a
  "do NOT add it" note on the table). Only the runner can write what gets executed.
- **The source is pinned and the path is guarded.** Host + repo hardcoded; the spec path
  must match `SPEC_PATH_RE` and contain no `..` (`runner/specfetch/fetchSpec.ts`).
- **The `synthwatch-monitors` merge gate IS the admission control.** What can ever
  execute is exactly what passes that repo's required checks (validate-manifest,
  check-matchers, typecheck, test:compile). This is **why the matcher allowlist is a
  security control, not a style rule** — it gates what runs as the runner.

### Residual risk (named, not hidden)

**Anyone who can merge to `craigoley/synthwatch-monitors` can cause code to execute as
the runner.** That is the trust model: the monitors-repo merge gate is the boundary and
its reviewers are the trusted set. Harden that gate accordingly — the single-file/alias
constraint bounds *what a spec may import*, not *whether a merged spec runs*.

If you find a way to execute code that did **not** pass the monitors-repo merge gate — a
`spec_cache` write path, a fetch redirect, an escape from the esbuild `lib/flow` alias —
that is a vulnerability; please report it via the private channel above.

## Secret & credential model — how a monitor authenticates (and where a credential can leak)

A monitor that logs in or sends a bypass token uses **runner-held secrets**, never credentials
stored in the DB or the repo. Verified in code (source: `docs/proposals/spec-auth-and-secrets.md`):

- **Secrets are injected as runner env vars, referenced by NAME.** An HTTP/multistep check's
  `auth` carries only an env-var *name* (`token_env` / `password_env` / `value_env`) →
  `process.env[name]` at run time (`runner/httpCheck.ts:47-65`, `buildAuthHeader`). Nothing
  secret is stored in the DB or echoed. Prod injection: a `@secure` bicep param → a job secret →
  a `secretRef` env on the runner jobs.
- **Option-C browser specs read `process.env.<NAME>` directly** — the compiled spec runs *in the
  runner process*, so it sources its credential straight from a runner env var (the sanctioned
  pattern in `docs/AUTHORING.md`). This is a **global** namespace: every spec in the process can
  read every secret env var — fine for a shared bypass token or one shared test account, not for
  many distinct per-monitor logins.
- **A spec gets the REAL Playwright `page`** (`runner/specfetch/specShim.ts:70`), on a context
  the harness creates with **no lockdown** (bare `b.newContext()`, `runner/index.ts:991`). So a
  spec can already `page.setExtraHTTPHeaders(...)` / `page.context().addCookies(...)` (e.g. a
  Vercel protection-bypass header) with the standard Playwright API.
- **★ `checks.auth` is NOT applied to browser contexts.** `auth` is consumed ONLY by the HTTP
  path (`runner/httpCheck.ts:82`) and multistep (`runner/multistep.ts:193`); `executeBrowser`
  never reads it. Browser specs authenticate via `process.env`, not `checks.auth` — do not assume
  the two share a path.

### Where a credential can leak (and the mitigations)

- **`trace_signals` (persisted, AI-fed) — low risk.** The extractor keeps only request `url`, the
  `content-encoding` header, and console `text`/`location` — **no `Authorization`/cookie headers,
  no request bodies, no `fill` values** — so a header-injected token or a POST-body password never
  reaches AI. Residual: a credential in a **URL query** or printed to **console** would survive; a
  value-scrub against the known `process.env` secret values closes it (a proposed ★DECISION).
- **The raw trace zip — higher risk.** `tracing.start({ screenshots, snapshots })` records the
  action log (a `page.fill` captures its **value**) and network request **headers**, so the zip
  *can* contain credentials — and the **success-baseline** zip persists indefinitely. Prefer
  **header / cookie / storageState** injection over a visible `page.fill`, and treat an
  authenticated monitor's baseline zip as sensitive. ★DECISION items, for sign-off.

_The forward-looking mitigations (value-scrub, per-monitor creds, baseline-zip handling) are
proposals awaiting sign-off — `docs/proposals/spec-auth-and-secrets.md`. The OBSERVED capabilities
and the `checks.auth`-not-on-browser fact are current, verified behaviour._

## What is in scope

- The runner (`runner/`), the database schema (`db/`), and the container image.
- The CI/security workflows under `.github/workflows/`.

Operational misconfiguration of *your own* deployment (e.g. leaking your own
`DATABASE_URL`) is not a vulnerability in SynthWatch itself, but we're happy to
help you harden a deployment.
