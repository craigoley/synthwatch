#!/usr/bin/env bash
# THE ACCEPTANCE TEST for the dev environment. Not "it builds" — it proves an engineer can, from a clean
# clone, run everything CI runs, locally, against a real Postgres. Run inside the devcontainer:
#
#   bash .devcontainer/verify.sh            # all four steps
#   bash .devcontainer/verify.sh a d        # only the runner suite + the schema replay (fast; Gate A's need)
#
# Steps:  a = runner full test suite (unit + DB integration)   b = synthwatch-api `dotnet test`
#         c = BOTH mutation gates (runner StrykerJS + api Stryker.NET)   d = replay schema.sql + migrations
set -uo pipefail
cd "$(dirname "$0")/.."
RUNNER="$(pwd)"; ROOT="$(cd .. && pwd)"; API="$ROOT/synthwatch-api"
DB_URL="${DATABASE_URL:-postgres://postgres:postgres@db:5432/synthwatch_test}"
ADMIN_URL="$(echo "$DB_URL" | sed 's#/[^/]*$#/postgres#')"
STEPS=("${@:-a b c d}"); want() { [[ " ${STEPS[*]} " == *" $1 "* ]]; }
declare -A RESULT

# DROP/CREATE DATABASE cannot run inside a transaction block, and a single psql -c with two statements is one
# implicit transaction — so each must be its OWN single-statement invocation (autocommit).
recreatedb() {
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $1 WITH (FORCE);" \
    && psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE $1;"
}

step_a() {  # runner full suite against a real Postgres
  echo "──────── (a) runner full test suite ────────"
  recreatedb synthwatch_test \
    && psql "$DB_URL" -v ON_ERROR_STOP=1 -f db/schema.sql >/dev/null \
    && ( cd runner && DATABASE_URL="$DB_URL" npm test )
}
step_b() {  # synthwatch-api dotnet test (Testcontainers → host Docker socket)
  echo "──────── (b) synthwatch-api dotnet test ────────"
  [ -d "$API" ] || { echo "SKIP: synthwatch-api not cloned as a sibling"; return 3; }
  # ★ point at the TEST project, not the api root (root resolves to the non-test API csproj → runs NOTHING
  #   + exits 0: a vacuous pass). Matches the api's CI (`dotnet test tests/SynthWatch.Api.Tests/`). Capture
  #   output so we can FAIL a run that discovered/executed zero tests (the RequireDocker skip trap).
  local log; log="$(mktemp)"
  ( cd "$API" && dotnet test tests/SynthWatch.Api.Tests/ --nologo ) 2>&1 | tee "$log"
  local rc=${PIPESTATUS[0]}
  if grep -qiE "Passed![^,]*Failed:|Passed:[[:space:]]*[1-9]|total:[[:space:]]*[1-9]" "$log"; then
    # a real run with ≥1 executed test that didn't all skip
    if grep -qiE "Skipped:[[:space:]]*[1-9]" "$log" && ! grep -qiE "Passed:[[:space:]]*[1-9]|Passed![^,]*Passed:[[:space:]]*[1-9]" "$log"; then
      echo "✗ every test SKIPPED (RequireDocker: Testcontainers could not reach the Docker socket) — NOT a pass."; rm -f "$log"; return 1
    fi
    rm -f "$log"; return "$rc"
  fi
  echo "✗ dotnet test executed ZERO tests (wrong project path, or Docker skip) — refusing to report PASS."; rm -f "$log"; return 1
}
step_c() {  # BOTH mutation gates
  echo "──────── (c) mutation gates ────────"
  local ok=0
  echo "· runner StrykerJS (one representative module: retry)"
  ( cd runner && DATABASE_URL="$DB_URL" bash scripts/mutation.sh retry ) || ok=1
  if [ -d "$API" ]; then
    echo "· api Stryker.NET"
    ( cd "$API/tests/SynthWatch.Api.Tests" && dotnet-stryker ) || ok=1
  else
    echo "· api Stryker.NET — SKIP (api not cloned)"
  fi
  return $ok
}
step_d() {  # replay schema.sql + migrations into a scratch DB — exactly what Gate A needs
  echo "──────── (d) schema.sql + migrations replay ────────"
  recreatedb replay_check \
    && bash scripts/check-migration-replay.sh "$(echo "$DB_URL" | sed 's#/[^/]*$#/replay_check#')"
}

for s in a b c d; do
  want "$s" || continue
  if "step_$s"; then RESULT[$s]="PASS"; else rc=$?; RESULT[$s]=$([ "$rc" = 3 ] && echo "SKIP" || echo "FAIL"); fi
done

echo; echo "════════ acceptance summary ════════"
fail=0
for s in a b c d; do want "$s" || continue; printf '  (%s) %s\n' "$s" "${RESULT[$s]}"; [ "${RESULT[$s]}" = "FAIL" ] && fail=1; done
exit $fail
