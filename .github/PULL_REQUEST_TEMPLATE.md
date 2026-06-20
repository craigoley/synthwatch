<!-- Keep PRs to one concern. Fill in the checklist below. -->

## What & why

<!-- A short description of the change and the motivation. -->

## Checklist

- [ ] One concern per PR (small, reviewable diff).
- [ ] `npm run typecheck` (`tsc --noEmit`) is clean.
- [ ] `npm run lint` (`eslint --max-warnings 0`) is clean.
- [ ] CI is green (CodeQL, Semgrep, ESLint, OSV, dependency-review).
- [ ] No secrets, credentials, or tenant-specific values added to source.
- [ ] Docs updated if behavior or schema changed.

## If this PR adds or changes a browser flow

<!-- Delete this section if not applicable. -->

- [ ] Selectors are **real**, verified against the live DOM (not placeholders/guesses).
- [ ] **No dynamic code execution** (no `eval`, `new Function`, Node `vm`, or
      runtime code loading) — the flow is static, reviewed code.
- [ ] Every action is wrapped in `StepRecorder` (`rec.step(...)`).
- [ ] No secrets in the flow file; config (URL, cadence) lives in the dashboard.

## If this PR changes the database schema

<!-- Delete this section if not applicable. -->

- [ ] Additive migration added under `db/migrations/`.
- [ ] `db/schema.sql` updated so a fresh apply converges to the same end state.
