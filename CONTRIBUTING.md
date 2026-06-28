# Contributing to SynthWatch

Thanks for your interest! SynthWatch is a self-hosted synthetic monitoring
system (HTTP + real-browser checks). This guide covers local setup, the review
flow, and — most importantly — **how to write a browser flow safely**.

By participating you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

All TypeScript lives under `runner/` (Node ≥ 22, NodeNext ESM, strict).

```bash
cd runner
cp .env.example .env          # set DATABASE_URL (+ optional alert channels)
npm install
npm run typecheck             # tsc --noEmit — must be clean
npm run build                 # -> dist/
npm run lint                  # eslint --max-warnings 0
```

To exercise the browser tier, run the container so Chromium and its OS deps are
present (see the [README](README.md#local-development)):

```bash
docker build -t synthwatch-runner ./runner
docker run --rm --ipc=host -e DATABASE_URL="$DATABASE_URL" synthwatch-runner
```

### What runs on every pull request

These all run automatically and must be green before merge:

| Check | What it is |
| --- | --- |
| **CodeQL** | SAST (`security-and-quality`), JS/TS + Actions |
| **Semgrep** | SAST (`p/typescript`, `p/javascript`, `p/security-audit`, `p/secrets`) |
| **ESLint** | `eslint . --max-warnings 0` (flat config, typescript-eslint) |
| **OSV-Scanner** | dependency vulnerabilities (PR-diff + full) |
| **dependency-review** | flags risky dependency changes in the PR |
| **OpenSSF Scorecard** | supply-chain posture (runs on `main`) |

Run `npm run typecheck` and `npm run lint` locally before pushing to catch the
common failures early.

## Branch → PR → review flow

1. Branch from the latest `main` (e.g. `feat/…`, `fix/…`, `chore/…`).
2. Keep **one concern per PR**. Small, reviewable diffs merge faster.
3. Open a PR; fill in the template checklist.
4. CI must pass green (table above). Address review feedback.
5. A maintainer merges. Dependabot keeps dependencies and pinned action SHAs
   fresh.

---

## Writing a flow safely

> Browser flows execute a **real Chromium** holding live credentials. This
> section is mandatory reading before you add or change a flow.

- **Flows are CODE, added via PR and reviewed — never uploaded or executed at
  runtime.** A check row only *names* an existing flow module under
  `runner/checks/` (validated against `/^[a-z0-9-]+$/`). SynthWatch never accepts
  user-uploaded code.
- **No dynamic code execution.** No `eval`, no `new Function`, no `require`/
  `import()` of attacker-influenced paths, no Node `vm`. Flows are static
  TypeScript reviewed like any other code.
- **No secrets in flow files.** URLs, cadence, thresholds and other config live
  in the **dashboard / `checks` table**, not in source. Never hardcode
  credentials, tokens, or tenant-specific endpoints.
- **Every step is wrapped in `StepRecorder`.** Each action goes through
  `rec.step('<name>', async (page) => { … })`. The recorder holds the Playwright
  `Page` privately and only hands it to the step callback, so funnel telemetry is
  not optional — a flow that bypasses `rec.step` cannot drive the browser at all.
- **Selectors must be real.** Inspect the live DOM and use selectors you've
  verified. Never ship guessed/placeholder selectors — see the real flows under
  `runner/checks/` (e.g. `wegmans-search.ts`) for verified-selector examples.
- **One concern per PR; `tsc` + all scanners must pass green.**

### Minimal shape

```ts
import type { Flow } from './index.js';

export const flow: Flow = async (rec) => {
  await rec.step('open homepage', async (page) => {
    await page.goto(rec.baseUrl, { waitUntil: 'domcontentloaded' });
  });
  await rec.step('search returns results', async (page) => {
    await page.fill('#real-search-input', 'query');   // real, verified selector
    await page.keyboard.press('Enter');
    await page.waitForSelector('.real-results-container');
  });
};
```

## Reporting security issues

Do **not** open a public issue for a vulnerability — use the private process in
[SECURITY.md](SECURITY.md).
