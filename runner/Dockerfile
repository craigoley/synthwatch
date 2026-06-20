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

# Runtime note: ACA / `docker run` should pass `--ipc=host`. Chromium uses a
# large amount of shared memory; the default 64MB /dev/shm causes renderer
# crashes under load. --ipc=host gives the container the host's shared-memory
# segment and avoids those OOM-style failures.
CMD ["node", "dist/index.js"]
