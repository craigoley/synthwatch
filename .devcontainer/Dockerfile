# SynthWatch dev image — the ONE toolchain that builds + tests BOTH repos locally, so nothing is
# push-and-pray. Pins match CI/prod exactly:
#   - .NET 10 SDK   → synthwatch-api targets net10.0 (build, dotnet test, dotnet-stryker)
#   - Node 22       → runner/ (package.json engines: node>=22; CI setup-node 22)
#   - psql 16 client→ schema gates A/B + the runner's DATABASE_URL integration tests (prod is PG 16)
# The Postgres SERVER is a sibling compose service (postgres:16), not baked in here.
FROM mcr.microsoft.com/dotnet/sdk:10.0

ENV DEBIAN_FRONTEND=noninteractive

# Node 22 (NodeSource) + PostgreSQL 16 client (PGDG) + git/curl. Pinning the psql client to 16 keeps
# pg_dump/psql byte-compatible with the prod major version the gates compare against.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git lsb-release \
 && install -d /etc/apt/keyrings \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/keyrings/pgdg.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update && apt-get install -y --no-install-recommends nodejs postgresql-client-16 \
 && rm -rf /var/lib/apt/lists/*

# Stryker.NET for the synthwatch-api mutation gate (StrykerJS for the runner arrives via `npm ci`).
# Installed as a global tool; the api's mutation.yml does the same (`dotnet tool install -g dotnet-stryker`).
RUN dotnet tool install -g dotnet-stryker
ENV PATH="${PATH}:/root/.dotnet/tools"

# Testcontainers (synthwatch-api's `dotnet test`) talks to the host Docker daemon over the socket the
# compose file bind-mounts. Tell it not to try to resolve a nested daemon.
ENV TESTCONTAINERS_RYUK_DISABLED=true

WORKDIR /workspaces
