# SynthWatch runner image.
#
# Base image ships a real Chromium (+ the chrome-headless-shell the runner launches)
# plus every OS dependency it needs (fonts, libnss, etc.). It MUST be pinned to the
# EXACT SAME version as the `playwright` npm dependency (1.62.0) — a MINOR drift bumps
# the bundled browser revision, so the binary the npm package looks for won't exist in
# the image and `chromium.launch()` fails at runtime (the 2026-07-25 outage: #368 moved
# npm to 1.62.0 while this stayed 1.61.0, and prod's browser monitors went 100% down with
# "Executable doesn't exist at .../chromium_headless_shell-<rev>/..."). Bump BOTH together,
# and the browser-smoke.yml CI job (which launches a browser IN this built image) now proves
# the pairing before merge.
#
# ★ THE 1.61.1 HOLD IS OVER (#385). npm was pinned back to 1.61.1 because Playwright 1.62.0
# had NO stable base image on mcr — only `-next-canary-*` tags. That tag has since published:
# `mcr.microsoft.com/playwright:v1.62.0-noble` (and -amd64/-arm64) is live on
# https://mcr.microsoft.com/v2/playwright/tags/list, verified before this bump. So the pair
# moves together to 1.62.0 in ONE commit, which is what the pairing gate demands — landing the
# npm half alone is exactly the #368 shape.
#
# ★ BEFORE BUMPING EITHER SIDE, CONFIRM THE TAG EXISTS. `curl -s
# https://mcr.microsoft.com/v2/playwright/tags/list` is the check; a `-next-canary-*` tag is NOT
# a stable release and must not be used here. (mcr already publishes v1.62.1 — do not chase it
# here; it pairs with whatever npm version the lockfile resolves, and Dependabot moves that.)
FROM mcr.microsoft.com/playwright:v1.62.0-noble

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json* ./
# The base image already bundles the browsers; skip the post-install download.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --omit=dev || npm install --omit=dev

# Build TypeScript -> dist/. We need devDependencies (tsc) only for this step.
COPY tsconfig.json ./
COPY . .
RUN npm install --no-save typescript@5.7.3 && npx tsc && npm prune --omit=dev

ENV NODE_ENV=production

# A4 prod-guard marker (prodGuard.ts). Baked into the IMAGE so it ships in the
# same artifact, through the same CD image-roll, as the guard code that reads it
# — the two can never desync. This is the durable fix for the 2026-07-06 outage,
# where the marker lived only in bicep: a full `scripts/deploy.sh` bicep-apply
# ran, its verify passed, yet the running jobs never got SYNTHWATCH_DEPLOYED and
# the fleet stayed down until a direct `az ... --set-env-vars` restored it. The
# bicep declaration (main.bicep, all 8 jobs) and any env-op are now redundant
# backups, not the primary path.
# Local dev runs from source (tsx / node dist), NOT this image, so it correctly
# lacks the marker and stays guarded; the image runs only in ACA or a deliberate
# `docker run` (the accepted #196 falsifier).
ENV SYNTHWATCH_DEPLOYED=1

# Runtime note: ACA / `docker run` should pass `--ipc=host`. Chromium uses a
# large amount of shared memory; the default 64MB /dev/shm causes renderer
# crashes under load. --ipc=host gives the container the host's shared-memory
# segment and avoids those OOM-style failures.
CMD ["node", "dist/index.js"]
