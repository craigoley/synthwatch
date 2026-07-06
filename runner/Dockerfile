# SynthWatch runner image.
#
# Base image ships a real Chromium plus every OS dependency it needs (fonts,
# libnss, etc.). It is pinned to the SAME version as the `playwright` npm
# dependency (1.61.0) — if these drift, the browser binaries the npm package
# looks for won't exist in the image and launches fail. Bump BOTH together.
FROM mcr.microsoft.com/playwright:v1.61.0-noble

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
