#!/bin/sh
# SynthWatch migration runner.
#
# Applies every migration in $MIGRATIONS_DIR (lexical order) that has not yet been
# recorded in the schema_migrations table, each via psql with ON_ERROR_STOP so a
# SQL error aborts with a non-zero exit (the CD migrate step then fails and the
# new image is NOT rolled). Already-applied migrations are never re-run.
#
# Safety model:
#   - Tracking: schema_migrations(version) records what has run. version = the
#     migration filename without ".sql" (e.g. 0001_run_metrics).
#   - Idempotency: every migration MUST be idempotent (IF NOT EXISTS /
#     CREATE OR REPLACE). That makes two things safe:
#       1. The record-after-apply gap. If a migration commits but the follow-up
#          INSERT into schema_migrations fails, the next run simply re-applies it
#          (a harmless no-op) and records it. No stuck state, no manual repair.
#       2. Baselining an EXISTING database. A DB that already has 0001/0002 applied
#          but no schema_migrations row gets brought under tracking automatically:
#          the migration re-runs as a no-op and is recorded. No manual baseline.
#   - Each migration file manages its own BEGIN/COMMIT, so its DDL is atomic.
#
# Required env: DATABASE_URL
# Optional env: MIGRATIONS_DIR (default /migrations)
set -eu

: "${DATABASE_URL:?DATABASE_URL must be set}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-/migrations}"

run_sql() {
  # ON_ERROR_STOP=1 => non-zero exit on any SQL error. -q quiet, -t -A for scalars.
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 "$@"
}

echo "[migrate] ensuring schema_migrations exists"
run_sql -q -c "CREATE TABLE IF NOT EXISTS schema_migrations (
    version    text        PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);"

applied=0
skipped=0

for file in "$MIGRATIONS_DIR"/*.sql; do
  # Guard against a literal glob when the directory is empty.
  [ -e "$file" ] || { echo "[migrate] no .sql files in $MIGRATIONS_DIR"; break; }

  version="$(basename "$file" .sql)"

  is_applied="$(run_sql -t -A -c "SELECT 1 FROM schema_migrations WHERE version = '$version'")"
  if [ "$is_applied" = "1" ]; then
    echo "[migrate] skip   $version"
    skipped=$((skipped + 1))
    continue
  fi

  echo "[migrate] apply  $version"
  run_sql -q -f "$file"
  run_sql -q -c "INSERT INTO schema_migrations (version) VALUES ('$version') ON CONFLICT DO NOTHING;"
  applied=$((applied + 1))
done

echo "[migrate] done: $applied applied, $skipped skipped"
