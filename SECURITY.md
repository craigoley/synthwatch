# Security Policy

SynthWatch is a **security-adjacent tool**: it drives real browser automation
(Chromium via Playwright) and holds credentials for its database and alerting
channels (Azure Communication Services, Teams, xMatters, Azure Blob). Please
treat vulnerabilities here accordingly.

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

## Trust model — flows are reviewed code, never user input

The runner executes **only browser flows that live in this repository** under
`runner/checks/`. Flows are **code, added via pull request and reviewed** before
they ever run. SynthWatch does **not** accept, store, or execute user-uploaded
code, and it does **not** run arbitrary code from the database — a check row only
names an existing, repo-reviewed flow module (validated against `/^[a-z0-9-]+$/`
before import, so the name can never be used for path traversal).

If you discover a way to make the runner execute code that was *not* added
through repo review, that is a vulnerability — please report it via the private
channel above.

## What is in scope

- The runner (`runner/`), the database schema (`db/`), and the container image.
- The CI/security workflows under `.github/workflows/`.

Operational misconfiguration of *your own* deployment (e.g. leaking your own
`DATABASE_URL`) is not a vulnerability in SynthWatch itself, but we're happy to
help you harden a deployment.
