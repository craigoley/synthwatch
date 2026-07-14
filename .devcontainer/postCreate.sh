#!/usr/bin/env bash
# Runs once when the devcontainer is created. Installs deps for BOTH repos so `verify.sh` (the acceptance
# test) can run immediately. Idempotent — safe to re-run. Skips Playwright browser downloads: the test
# suites are unit + DB-integration (no live browser); install them on demand with `npx playwright install`.
set -euo pipefail
cd "$(dirname "$0")/.."   # runner repo root
ROOT="$(cd .. && pwd)"    # /workspaces (parent holding both repos)

echo "▶ runner: npm ci"
( cd runner && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci )

if [ -d "$ROOT/synthwatch-api" ]; then
  echo "▶ api: dotnet restore"
  ( cd "$ROOT/synthwatch-api" && dotnet restore )
else
  echo "⚠ synthwatch-api not found beside this repo — clone it as a sibling for the api build/test steps."
fi

echo "✓ postCreate done. Run:  bash .devcontainer/verify.sh"
