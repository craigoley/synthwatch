#!/usr/bin/env bash
# ci-gate-eval.sh — the PURE decision logic behind .github/workflows/ci-gate.yml, extracted so it is
# TESTABLE. ci-gate runs `--self-test` as its FIRST step on every PR, so a regression in this file fails
# ci-gate loudly instead of silently WIDENING the merge gate (the failure mode this file exists to fix).
#
# ★ THE RULE (the header of ci-gate.yml states it too — keep them in sync):
#   Branch protection requires ONLY `ci-gate`, so ci-gate IS the merge gate. Therefore:
#     • EVERY check present on the PR head GATES — it must reach a terminal state and not have failed —
#       EXCEPT the two declared lists below. That includes the SLOW checks (CodeQL / code-scanning /
#       mutation / osv) that the old snapshot logic silently skipped.
#     • ADVISORY: never waited for, never blocks. Only for checks that are advisory BY THEIR OWN
#       WORKFLOW'S DESIGN (a `continue-on-error` that says so), and notification/comment bots. An
#       external check representing a real BUILD/DEPLOY outcome GATES; a notification bot does NOT.
#     • ORCHESTRATION: never waited for, never blocks — ci-gate's own plumbing. ★ Waiting on these is a
#       DEADLOCK: self-heal's `heal` job polls "waiting for ci-gate to conclude", so if ci-gate also
#       waited for heal, both spin to their timeouts and EVERY PR blocks.
#     • An UNCLASSIFIED check gates by default (fail-safe): a new check must be explicitly declared
#       advisory to stop blocking.
#
# Sourced by ci-gate.yml; no `set -e` at top level so sourcing is safe.

# ci_gate_not_ready <runs_json> <required_json> <advisory_json> <orchestration_json> [osv_prefix]
#   -> prints every name ci-gate must still WAIT for (empty = safe to judge).
#   (a) REQUIRED names not yet present+completed  — fail-closed on a check that never registers.
#   (b) [osv_prefix] if set: no completed check whose name starts with it (its name varies by PR type:
#       "scan-pr / osv-scan" when the reusable job runs, "scan-pr" when the caller is skipped).
#   (c) ★ THE FIX: any PRESENT non-advisory/non-orchestration check still running. The old logic broke
#       out as soon as (a) held and judged THAT snapshot, so a slower check (CodeQL/mutation/osv) with
#       conclusion=null was never counted and could fail AFTER ci-gate had already passed.
ci_gate_not_ready() {
  local runs="$1" req="$2" adv="$3" orch="$4" osv="${5:-}"
  jq -r --argjson req "$req" --argjson adv "$adv" --argjson orch "$orch" --arg osv "$osv" '
    ([ .[] | select(.status=="completed") | .name ]) as $done
    | ($req - $done) as $missing
    | (if $osv == "" then []
       elif ([ .[] | select(.status=="completed" and (.name|startswith($osv))) ] | length) == 0
       then ["osv (" + $osv + "*)"] else [] end) as $osv_missing
    | ([ .[] | select(.status != "completed")
             | .name as $n
             | select(($adv  | index($n)) == null)
             | select(($orch | index($n)) == null)
             | $n ] | unique) as $running
    | ($missing + $osv_missing + $running) | unique | .[]' <<< "$runs"
}

# ci_gate_failures <runs_json> <advisory_json> <orchestration_json>
#   -> prints every check that concluded in a REAL failure (empty = merge may proceed).
#   skipped / neutral / success all pass — a skipped sibling must never deadlock the merge (#102).
ci_gate_failures() {
  local runs="$1" adv="$2" orch="$3"
  jq -r --argjson adv "$adv" --argjson orch "$orch" '
    .[] | .name as $n | .conclusion as $c
        | select(($adv  | index($n)) == null)
        | select(($orch | index($n)) == null)
        | select(["failure","timed_out","cancelled","action_required","startup_failure"] | index($c))
        | $n' <<< "$runs" | sort -u
}

# ── LEGACY logic — kept ONLY as the self-test's must-go-red anchor. This is what shipped before: it
# breaks out as soon as REQUIRED is terminal, which is exactly the hole. Never used by ci-gate.
_ci_gate_not_ready_legacy() {
  jq -r --argjson req "$2" '([ .[] | select(.status=="completed") | .name ]) as $done | ($req - $done) | .[]' <<< "$1"
}

if [ "${1:-}" = "--self-test" ]; then
  set -uo pipefail
  fails=0
  # Real if/then/else — NOT `A && ok || bad` (SC2015: the `||` branch can fire even when the assertion
  # passed). A self-test whose own reporting can lie is the bug class this gate exists to kill.
  check() { # check <description> <actual> <expected>
    if [ "$2" = "$3" ]; then
      echo "  PASS  $1"
    else
      echo "  FAIL  $1"
      echo "          expected: '$3'"
      echo "          actual:   '$2'"
      fails=$((fails + 1))
    fi
  }

  REQ='["Lint","Claude review","Test"]'
  ADV='["Scan","Vercel Preview Comments"]'
  ORC='["ci-gate","automerge","heal"]'

  # Every REQUIRED check terminal+green, but the MUTATION gate (slow, not REQUIRED) is still running —
  # plus ci-gate/heal/advisory in flight, which must never be waited on.
  RUNNING='[{"name":"Lint","status":"completed","conclusion":"success"},
            {"name":"Claude review","status":"completed","conclusion":"success"},
            {"name":"Test","status":"completed","conclusion":"success"},
            {"name":"mutation evaluate","status":"in_progress","conclusion":null},
            {"name":"ci-gate","status":"in_progress","conclusion":null},
            {"name":"heal","status":"in_progress","conclusion":null},
            {"name":"Scan","status":"in_progress","conclusion":null}]'
  # The same snapshot once the slow check has concluded FAILURE.
  FAILED="$(jq -c '(.[] | select(.name=="mutation evaluate")) |= (.status="completed"|.conclusion="failure")' <<< "$RUNNING")"
  # The same snapshot with the slow check absent — only orchestration/advisory are in flight.
  ORCH_ONLY="$(jq -c '[ .[] | select(.name != "mutation evaluate") ]' <<< "$RUNNING")"

  # 1 — MUST-GO-RED ANCHOR: prove the bug is real. The legacy logic breaks out (nothing to wait for)
  #     while the mutation gate is still running, then judges that snapshot — so the failure lands after
  #     ci-gate has already passed, and branch protection (which requires ONLY ci-gate) merges it.
  check "1 legacy logic reproduces the bug (breaks out with a slow check still running)" \
    "$(_ci_gate_not_ready_legacy "$RUNNING" "$REQ")" ""

  # 2 — THE FIX: the new logic WAITS for the slow non-REQUIRED check.
  check "2 new logic WAITS for a slow non-REQUIRED check" \
    "$(ci_gate_not_ready "$RUNNING" "$REQ" "$ADV" "$ORC")" "mutation evaluate"

  # 3 — and once that check concludes FAILURE, the gate BLOCKS the merge.
  check "3 new logic is ready to judge once the slow check concludes" \
    "$(ci_gate_not_ready "$FAILED" "$REQ" "$ADV" "$ORC")" ""
  check "3 new logic BLOCKS the merge on the slow check's failure" \
    "$(ci_gate_failures "$FAILED" "$ADV" "$ORC")" "mutation evaluate"

  # 4 — ★ THE DEADLOCK GUARD — THIS CASE MUST STAY GREEN FOREVER. self-heal's `heal` job polls
  #     "waiting for ci-gate to conclude"; if ci-gate ever waited for heal (or for itself), both spin
  #     to their timeouts and EVERY PR blocks. Orchestration + advisory are never waited on.
  check "4 NO DEADLOCK: ci-gate/heal/advisory in flight are never waited on" \
    "$(ci_gate_not_ready "$ORCH_ONLY" "$REQ" "$ADV" "$ORC")" ""

  # 5 — a FAILED orchestration/advisory check must not block a good PR (a broken self-heal reported
  #     FAILURE on every run under the #313 OIDC bug; semgrep's "Scan" is advisory by its own design).
  BROKEN='[{"name":"Lint","status":"completed","conclusion":"success"},
           {"name":"Claude review","status":"completed","conclusion":"success"},
           {"name":"Test","status":"completed","conclusion":"success"},
           {"name":"heal","status":"completed","conclusion":"failure"},
           {"name":"Scan","status":"completed","conclusion":"failure"}]'
  check "5 a failed orchestration/advisory check does NOT block a good PR" \
    "$(ci_gate_failures "$BROKEN" "$ADV" "$ORC")" ""

  # 6 — ★ THE SCHEMA-FREEZE GUARD ("Will this freeze synthwatch-api?", schema-freeze-preflight.yml) GATES
  #     WHEN PRESENT. It is UNCLASSIFIED (in none of the lists), so the "unclassified gates by default" rule
  #     is exactly what holds a runner PR that would freeze the api: on a db/** PR the guard runs, and if it
  #     REDS, ci_gate_failures must NAME it → ci-gate fails → merge held. (The "it's advisory / merges anyway"
  #     reading doubted this; it is asserted here so no refactor can silently make the guard non-gating.)
  FREEZE='Will this freeze synthwatch-api?'
  DBPR_RED='[{"name":"Lint","status":"completed","conclusion":"success"},
             {"name":"'"$FREEZE"'","status":"completed","conclusion":"failure"}]'
  check "6 unclassified freeze-guard RED is caught → merge HELD (gates when present)" \
    "$(ci_gate_failures "$DBPR_RED" "$ADV" "$ORC")" "$FREEZE"
  # and ci-gate WAITS for it while it is still running (never settles past a running guard).
  DBPR_RUN='[{"name":"Lint","status":"completed","conclusion":"success"},
             {"name":"'"$FREEZE"'","status":"in_progress","conclusion":null}]'
  check "6 ci-gate WAITS for a running freeze-guard" \
    "$(ci_gate_not_ready "$DBPR_RUN" '["Lint"]' "$ADV" "$ORC")" "$FREEZE"

  # 7 — ★ …AND THE GUARD MUST NOT BE ADDED TO REQUIRED. It is PATH-FILTERED (db/migrations/**, db/schema.sql),
  #     so on a NON-db PR it never runs and never registers. As a REQUIRED name it would be perpetually
  #     "missing" → ci_gate_not_ready never empties → the 15-min deadline trips → ci-gate FAILS → EVERY non-db
  #     PR deadlocks (the #102 skipped-required/path-filter class this whole gate exists to avoid). Unclassified,
  #     the SAME non-db PR settles clean. This pins WHY the correct posture is "gates-when-present", not REQUIRED.
  NONDB='[{"name":"Lint","status":"completed","conclusion":"success"}]'
  check "7 freeze-guard AS REQUIRED deadlocks a non-db PR (never registers)" \
    "$(ci_gate_not_ready "$NONDB" '["Lint","'"$FREEZE"'"]' "$ADV" "$ORC")" "$FREEZE"
  check "7 freeze-guard UNCLASSIFIED does NOT block a non-db PR (absent = fine)" \
    "$(ci_gate_not_ready "$NONDB" '["Lint"]' "$ADV" "$ORC")" ""

  echo ""
  if [ "$fails" -eq 0 ]; then
    echo "ci-gate-eval self-test: ALL PASSED"
    exit 0
  fi
  echo "ci-gate-eval self-test: ${fails} FAILED"
  exit 1
fi
