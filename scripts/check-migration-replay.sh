#!/usr/bin/env bash
# check-migration-replay.sh <empty-database-url>
#
# ★ THE FROM-SCRATCH REPLAY GUARD. Asserts that db/schema.sql (the converged end state) + every
# db/migrations/*.sql replayed ON TOP, in lexical order, converge with NO error — the exact model a fresh DB, a
# restore, and the synthwatch-api "Runner column parity" gate all use.
#
# WHY IT EXISTS (the 0069 class): schema.sql is kept at the CURRENT end state, but the numbered migrations replay
# HISTORICALLY on top of it. So an OLD migration that `CREATE OR REPLACE`s a function whose signature a LATER
# migration changed tries to DOWNGRADE the end-state function — and Postgres REFUSES a return-type change via
# CREATE OR REPLACE ("cannot change return type of existing function — use DROP FUNCTION first"), halting the
# replay. 0069_cost_projection hit exactly this after 0078 changed the return type + schema.sql followed;
# #284 fixed it (DROP-then-CREATE). This model makes EVERY historical `CREATE OR REPLACE FUNCTION` a latent
# downgrade hazard on the next signature change — so the structural rule is: a migration that redefines a
# function MUST `DROP FUNCTION IF EXISTS <exact old argtypes>;` before the CREATE.
#
# ★ This guard ENFORCES that rule by actually REPLAYING (no static lint to drift), and it runs in the runner's
# REQUIRED Test job — so the conflict is caught on the RUNNER PR that introduces the migration (shifted LEFT of
# the api parity gate, which found 0069 late), and a red replay can never be silently ignored.
#
# Usage: check-migration-replay.sh <url-of-an-EMPTY-database>
#   CI: create a throwaway DB against the Postgres service, then run this against it.
#   Local: initdb a scratch cluster, createdb replay_check, run this against it.
set -euo pipefail

DB="${1:?usage: check-migration-replay.sh <empty-database-url>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
pq() { command psql -v ON_ERROR_STOP=1 -q -d "$DB" "$@"; }

# api-role shim: schema.sql + migrations GRANT to "synthwatch-api"; create the role so a GRANT doesn't error on
# this throwaway DB (the api parity gate does the same; grants aren't part of the compare).
pq -c "DO \$do\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='synthwatch-api') THEN CREATE ROLE \"synthwatch-api\"; END IF; END \$do\$;"

# check_function_bodies=false: a function body may reference an object a LATER migration adds; the api gate
# defers body checks the same way. We are testing the REPLAY (create/alter/drop ordering), not body resolution.
echo "[replay] applying db/schema.sql (the converged end state)…"
pq -c "SET check_function_bodies=false;" -f "$ROOT/db/schema.sql"

echo "[replay] replaying every migration on top, in lexical order…"
n=0
for f in "$ROOT"/db/migrations/*.sql; do
  [ -e "$f" ] || { echo "[replay] no migrations found under $ROOT/db/migrations" >&2; exit 2; }
  if ! pq -c "SET check_function_bodies=false;" -f "$f"; then
    echo "::error::migration replay FAILED at $(basename "$f") — schema.sql + migrations do NOT converge." >&2
    echo "  Most common cause: a CREATE OR REPLACE FUNCTION that changed a return type. It must" >&2
    echo "  'DROP FUNCTION IF EXISTS <exact old argtypes>;' BEFORE the CREATE (see 0069 / #284)." >&2
    exit 1
  fi
  n=$((n + 1))
done

echo "[replay] ✓ db/schema.sql + all ${n} migrations converged cleanly (fresh-DB / restore / parity-gate model)."
