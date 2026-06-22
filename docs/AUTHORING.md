# Authoring browser flows

A **browser flow** is a Playwright script that SynthWatch runs on a schedule as a
`kind='browser'` check. Flows live in `runner/checks/<name>.ts`. If you know
Playwright, you already know how to write one — there's near-zero SynthWatch
ceremony.

## The shape

```ts
import { defineFlow, type FlowMeta } from './index.js';

// Optional: shows up in the dashboard's flow picker (the flow_manifest table).
export const meta: FlowMeta = {
  description: 'Homepage loads and the search box renders',
  entryUrlHint: 'https://example.com/',
};

export const flow = defineFlow(async ({ page, step, baseUrl, expect }) => {
  await step('open homepage', async () => {
    await page.goto(baseUrl, { waitUntil: 'load' });
  });

  await step('search renders', async () => {
    await page.getByRole('searchbox').waitFor({ state: 'visible' });
  });
});
```

What you get in the flow context:

| | |
| --- | --- |
| `page` | the live Playwright `Page` — **in scope**, so codegen pastes verbatim |
| `step(name, async () => {…})` | like Playwright's `test.step` — times the body and records a `run_steps` row (pass/fail/error). Wrap each meaningful action in a step to get the funnel breakdown. |
| `baseUrl` | the check's `target_url` — navigate here so one flow can target many environments |
| `expect(condition, message)` | assert an expectation. A falsy condition throws and the step is recorded as **`fail`** (a clean assertion miss). Any *other* throw (a Playwright timeout, a navigation crash) is recorded as **`error`** (an exception). |

`step()` is how the funnel telemetry is captured. Actions you run *outside* a
`step` still execute, but aren't individually recorded — same model as
Playwright's optional `test.step` grouping. Once a step throws, the flow stops
there and the run shows exactly which step died (no re-running).

## From click-through to deployed monitor, in one PR

1. **Record** the journey against the real site:
   ```bash
   npx playwright codegen https://www.example.com/
   ```
   Click through the journey; codegen writes `await page.…` statements.

2. **Paste** into a new `runner/checks/<name>.ts`. Drop the codegen body into one
   or more `step('…', async () => { … })` blocks — because `page` is in scope, the
   statements paste **unchanged** (no `(page) =>` rewriting). Use `<name>` matching
   `^[a-z0-9-]+$` (it becomes `checks.flow_name`).

3. **Firm it up** (recommended): prefer web-first **role/text locators**
   (`getByRole`, `getByText`) over brittle CSS; add `expect(…)` assertions for the
   things that actually matter; let auto-waiting locators handle hydration (a
   `waitFor({ state: 'visible' })` on a key element beats a fixed sleep). See
   `wegmans-homepage.ts` / `wegmans-search.ts` for worked examples against a real
   JS-hydrated SPA.

4. **PR it.** On merge, CD ships the new runner image; the runner publishes the
   flow to the `flow_manifest` table on its first tick, so the dashboard's flow
   picker offers it immediately. Point a check at it:
   ```sql
   UPDATE checks SET kind='browser', flow_name='<name>',
                     target_url='https://www.example.com/'
    WHERE id = <check_id>;
   -- or create a new browser check.
   ```

## Porting an existing Playwright suite

- **Per-step structure:** wrap your existing actions in `step('…', …)` blocks for
  the funnel breakdown. A plain `test('…', async ({ page }) => { … })` body maps
  to the `defineFlow` body; `page` is the same object.
- **Fixtures:** SynthWatch flows don't use Playwright's fixture/`test()` runner, so
  custom fixtures don't carry over directly. Put per-flow setup (helpers, test
  data) at the top of the flow body or in a shared module under `runner/checks/`.
- **Pre-authenticated flows (`storageState`):** to monitor behind a login without
  scripting the login every run, create a `BrowserContext` with a saved
  `storageState`. The current runner shares one context per run; a storageState
  hook is a planned follow-up. Until then, script the login as the first step(s),
  sourcing credentials from a **secret env var** on the runner (never hard-code
  them in the flow — same secret-reference rule as http-check auth).
- **Secrets:** read any credential from `process.env.<NAME>` and set `<NAME>` as a
  runner ACA-job env var / secret. Nothing tenant-specific belongs in source.

## The manifest

The runner discovers every flow module under `runner/checks/` at startup and
upserts it into the `flow_manifest` table (name + `meta`). That table — not
`SELECT DISTINCT flow_name FROM checks` — is the source of truth for "what flows
exist", so a flow is offerable the moment it deploys, before any check uses it.
