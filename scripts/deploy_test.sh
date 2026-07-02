#!/usr/bin/env bash
#
# scripts/deploy_test.sh — unit tests for the what-if drop-detection classifier
# (scripts/lib/whatif-halts.jq), the load-bearing safety logic in scripts/deploy.sh.
#
# Strategy: start from a REAL captured what-if (scripts/testdata/whatif-sample.json — a clean
# subset of a live `az deployment group what-if`: a job create, benign Postgres/managedEnv
# undeclared-default Deletes, and the AZURE_CLIENT_ID literal->reference env Modify). Assert it
# classifies CLEAN; then mutate it into each drop shape and assert it HALTS. No az/network.
#
# Run: scripts/deploy_test.sh   (exit 0 = all pass, non-zero = a failure)

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
readonly CLASSIFIER="${ROOT}/scripts/lib/whatif-halts.jq"
readonly SAMPLE="${ROOT}/scripts/testdata/whatif-sample.json"
readonly LIB="${ROOT}/scripts/lib/deploy-lib.sh"
readonly RUNNER_SEL='.resourceId|test("synthwatch-runner-job$")'

[[ -f "${CLASSIFIER}" ]] || { echo "missing ${CLASSIFIER}" >&2; exit 1; }
[[ -f "${SAMPLE}" ]] || { echo "missing ${SAMPLE}" >&2; exit 1; }
[[ -f "${LIB}" ]] || { echo "missing ${LIB}" >&2; exit 1; }
# Source the SAME helpers deploy.sh uses (classify_paths + the confirmation gates).
# shellcheck source=scripts/lib/deploy-lib.sh disable=SC1091
source "${LIB}"

FAILS=0
green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }

# classify <json-string> -> halt lines on stdout
classify() { jq -r -f "${CLASSIFIER}"; }

# expect_clean <name> <json>
expect_clean() {
  local name="$1" out
  out="$(printf '%s' "$2" | classify)"
  if [[ -z "${out}" ]]; then
    green "PASS  ${name} (no halt)"
  else
    red "FAIL  ${name} — expected CLEAN but halted with:"; printf '%s\n' "${out}"
    FAILS=$((FAILS + 1))
  fi
}

# expect_halt <name> <substring> <json>
expect_halt() {
  local name="$1" want="$2" out
  out="$(printf '%s' "$3" | classify)"
  if [[ -n "${out}" && "${out}" == *"${want}"* ]]; then
    green "PASS  ${name} (halted: $(printf '%s' "${out}" | head -1))"
  else
    red "FAIL  ${name} — expected halt containing '${want}', got: '${out}'"
    FAILS=$((FAILS + 1))
  fi
}

SAMPLE_JSON="$(cat "${SAMPLE}")"

# 1. The real clean what-if must NOT halt (benign pg/managedEnv Deletes + AZURE_CLIENT_ID
#    Modify + a reconcile-job Create are all benign).
expect_clean "real-clean-whatif" "${SAMPLE_JSON}"

# 2. A resource being DELETED must halt.
mut="$(printf '%s' "${SAMPLE_JSON}" | jq "(.changes[] | select(${RUNNER_SEL}) | .changeType) = \"Delete\"")"
expect_halt "resource-delete" "RESOURCE DELETED" "${mut}"

# 3. A job ENV KEY removed (flat leaf Delete on an env path) must halt.
mut="$(printf '%s' "${SAMPLE_JSON}" | jq "
  (.changes[] | select(${RUNNER_SEL}) | .delta) +=
  [{\"path\":\"properties.template.containers.0.env.3\",\"propertyChangeType\":\"Delete\",\"before\":{\"name\":\"AZURE_OPENAI_API_VERSION\"},\"after\":null,\"children\":null}]")"
expect_halt "env-key-removed-flat" "JOB ENV/SECRET REMOVED" "${mut}"

# 4. A job ENV element removed as a NESTED array child (the faithful what-if shape) must halt —
#    proves the delta-tree walk reconstructs the full path, not just top-level leaves.
mut="$(printf '%s' "${SAMPLE_JSON}" | jq "
  (.changes[] | select(${RUNNER_SEL}) | .delta) +=
  [{\"path\":\"properties.template.containers.0.env\",\"propertyChangeType\":\"Array\",\"children\":[
     {\"path\":\"3\",\"propertyChangeType\":\"Delete\",\"before\":{\"name\":\"DATABASE_URL\"},\"after\":null,\"children\":null}]}]")"
expect_halt "env-key-removed-nested" "env.3" "${mut}"

# 5. A SECRET removed must halt.
mut="$(printf '%s' "${SAMPLE_JSON}" | jq "
  (.changes[] | select(${RUNNER_SEL}) | .delta) +=
  [{\"path\":\"properties.configuration.secrets.0\",\"propertyChangeType\":\"Delete\",\"children\":null}]")"
expect_halt "secret-removed" "JOB ENV/SECRET REMOVED" "${mut}"

# 6. An env VALUE *Modify* (representation change, not a removal) must NOT halt — guards
#    against over-eager halting on the benign AZURE_CLIENT_ID literal->reference form.
mut="$(printf '%s' "${SAMPLE_JSON}" | jq "
  (.changes[] | select(${RUNNER_SEL}) | .delta) +=
  [{\"path\":\"properties.template.containers.0.env.2.value\",\"propertyChangeType\":\"Modify\",\"before\":\"x\",\"after\":\"y\",\"children\":null}]")"
expect_clean "env-value-modify-not-a-drop" "${mut}"

# 7. A benign undeclared-default Delete on a NON-env/secrets path must NOT halt.
mut="$(printf '%s' "${SAMPLE_JSON}" | jq "
  (.changes[] | select(${RUNNER_SEL}) | .delta) +=
  [{\"path\":\"properties.template.scale\",\"propertyChangeType\":\"Delete\",\"children\":null}]")"
expect_clean "benign-nonenv-delete-not-a-drop" "${mut}"

# ===========================================================================
# B. SMART HEAD-vs-image path classification (classify_paths). Fixtures are
#    captured `git diff --name-only <image-sha> HEAD` outputs (lists of paths).
#    "benign" => proceed silently; "prompt" => ask a human.
# ===========================================================================
# expect_verdict <name> <expected> <newline-separated-paths>
expect_verdict() {
  local name="$1" want="$2" got
  got="$(printf '%s' "$3" | classify_paths)"
  if [[ "${got}" == "${want}" ]]; then
    green "PASS  ${name} (${got})"
  else
    red "FAIL  ${name} — want '${want}', got '${got}'"
    FAILS=$((FAILS + 1))
  fi
}

# (1) infra/docs/scripts-only diff -> benign -> PROCEEDS without prompting (the bug fix).
expect_verdict "infra-docs-only-benign" "benign" \
  $'infra/main.bicep\nscripts/deploy.sh\nREADME.md\ndocs/AUTHORING.md'
# (2) runner code changed, no image for HEAD yet -> prompt (CI may still be building).
expect_verdict "runner-code-prompts" "prompt" $'runner/index.ts'
expect_verdict "db-change-prompts" "prompt" $'db/migrations/0030_source_key.sql'
expect_verdict "root-dockerfile-prompts" "prompt" $'Dockerfile'
expect_verdict "deploy-workflow-prompts" "prompt" $'.github/workflows/deploy.yml'
# (3) unclassifiable path -> prompt (CONSERVATIVE — lean to caution).
expect_verdict "unknown-path-prompts" "prompt" $'some-new-top-level/thing.bin'
# Mixed (one code path among benign) -> prompt; non-deploy workflow + md -> benign; empty -> benign.
expect_verdict "mixed-has-code-prompts" "prompt" $'infra/main.bicep\nrunner/db.ts'
expect_verdict "other-workflow-benign" "benign" $'.github/workflows/eslint.yml'
expect_verdict "empty-diff-benign" "benign" ''
# ★ the exact incident: HEAD (#133) added runner code + migration 0045 since the deployed image
#    (#132) -> "prompt" -> a real deploy HALTS (section C 4b), instead of shipping stale runner code
#    while applying 0045 (the DB-ahead-of-code half-state).
expect_verdict "issue133-runner+migration-prompts" "prompt" \
  $'runner/retry.ts\nrunner/index.ts\ndb/schema.sql\ndb/migrations/0045_fast_retry_on_fail_immediate_alert.sql'

# ===========================================================================
# C. ★ The newest-image≠HEAD ACTION (deploy_action_for_mismatch) + the drop never being
#    auto-proceeded. A runner-code mismatch must HALT a real deploy (never silently ship an image
#    that predates HEAD's runner code → DB-ahead-of-code), NOT prompt-then-proceed.
# ===========================================================================
assert_proceed() { local name="$1"; shift; if "$@"; then green "PASS  ${name} (proceed)"; else red "FAIL  ${name} — expected proceed"; FAILS=$((FAILS + 1)); fi; }
assert_abort()   { local name="$1"; shift; if "$@"; then red "FAIL  ${name} — expected abort"; FAILS=$((FAILS + 1)); else green "PASS  ${name} (abort)"; fi; }
# expect_action <name> <want> <verdict> <whatif_only>
expect_action() {
  local name="$1" want="$2" got; got="$(deploy_action_for_mismatch "$3" "$4")"
  if [[ "${got}" == "${want}" ]]; then green "PASS  ${name} (${got})"; else
    red "FAIL  ${name} — want '${want}', got '${got}'"; FAILS=$((FAILS + 1)); fi
}

# (4a) benign (infra/docs-only) -> proceed silently (the SMART skip — UNCHANGED), whatif or not.
expect_action "benign real -> proceed-infra"   "proceed-infra" "benign"     0
expect_action "benign whatif -> proceed-infra" "proceed-infra" "benign"     1
# (4b) ★ THE FIX: a runner-code mismatch on a REAL deploy -> HALT (was: prompt-then-proceed).
expect_action "runner-code real -> HALT"       "halt"          "prompt"     0
# (4c) ★ unresolved (can't verify the image includes HEAD's code) on a REAL deploy -> HALT.
expect_action "unresolved real -> HALT"        "halt"          "unresolved" 0
# (4d) --what-if-only ships nothing -> PREVIEW the (stale) image instead of halting.
expect_action "runner-code whatif -> preview"  "preview"       "prompt"     1
expect_action "unresolved whatif -> preview"   "preview"       "unresolved" 1

# (4e) ★ the drop gate ALWAYS requires a typed 'yes' — it is never auto-proceeded (confirm_drop
#      deliberately ignores --yes, which is now a no-op everywhere). The head-mismatch is a hard
#      HALT now, so its old interactive/--yes tests are gone.
assert_proceed "drop 'yes' proceeds"          confirm_drop <<< "yes"
assert_abort   "drop 'no' aborts"             confirm_drop <<< "no"
assert_abort   "drop '' aborts"               confirm_drop <<< ""
assert_proceed "drop needs exactly 'yes'"     confirm_drop <<< "yes"

# ===========================================================================
# D. BUG 1 — runner/migrate pinned to ONE SHA present in BOTH repos (newest_common_sha).
# ===========================================================================
expect_eq() {
  local name="$1" want="$2" got="$3"
  if [[ "${got}" == "${want}" ]]; then green "PASS  ${name} (${got:-<empty>})"; else
    red "FAIL  ${name} — want '${want}', got '${got}'"; FAILS=$((FAILS + 1)); fi
}
RUNNER_TAGS=$'aaa1111111111111111111111111111111111111\nbbb2222222222222222222222222222222222222\nccc3333333333333333333333333333333333333'
# Migrate is one build behind (missing the newest runner tag aaa…): pick the newest COMMON (bbb…).
MIGRATE_TAGS=$'bbb2222222222222222222222222222222222222\nccc3333333333333333333333333333333333333'
expect_eq "common-sha skips runner-only newest" "bbb2222222222222222222222222222222222222" \
  "$(newest_common_sha "${RUNNER_TAGS}" "${MIGRATE_TAGS}")"
# Both repos current -> the newest tag is common.
expect_eq "common-sha both-current picks newest" "aaa1111111111111111111111111111111111111" \
  "$(newest_common_sha "${RUNNER_TAGS}" "${RUNNER_TAGS}")"
# No overlap -> empty (deploy.sh fails hard on this).
expect_eq "common-sha no-overlap is empty" "" \
  "$(newest_common_sha 'aaa1111111111111111111111111111111111111' 'zzz9999999999999999999999999999999999999')"
# Both bicep params derive from the ONE resolved SHA -> identical :SHA suffix (never split).
RUNNER_IMG="reg.io/synthwatch-runner:bbb2222222222222222222222222222222222222"
MIGRATE_IMG="reg.io/synthwatch-migrate:bbb2222222222222222222222222222222222222"
expect_eq "runner+migrate share one SHA" "${RUNNER_IMG##*:}" "${MIGRATE_IMG##*:}"

# ===========================================================================
# E. BUG 2 — verify catches a stale MIGRATE job image (the bug that bit today), not just runner.
# ===========================================================================
expect_mismatch() {
  local name="$1" want="$2" map="$3" got
  got="$(printf '%s' "${map}" | image_mismatches "reg.io/synthwatch-runner:NEW" "reg.io/synthwatch-migrate:NEW" | tr '\n' ',' | sed 's/,$//')"
  if [[ "${got}" == "${want}" ]]; then green "PASS  ${name} (${got:-none})"; else
    red "FAIL  ${name} — want '${want}', got '${got}'"; FAILS=$((FAILS + 1)); fi
}
# All jobs on the new image -> no mismatch.
expect_mismatch "all-on-new -> clean" "" \
  $'synthwatch-runner-job\treg.io/synthwatch-runner:NEW\nsynthwatch-migrate-job\treg.io/synthwatch-migrate:NEW'
# ★ The exact bug: migrate job stuck on the OLD image while the runner job rolled -> FLAGGED.
expect_mismatch "stale migrate job -> flagged" "synthwatch-migrate-job" \
  $'synthwatch-runner-job\treg.io/synthwatch-runner:NEW\nsynthwatch-migrate-job\treg.io/synthwatch-migrate:OLD'
# A stale runner-family job is flagged too.
expect_mismatch "stale narrative job -> flagged" "synthwatch-narrative-job" \
  $'synthwatch-runner-job\treg.io/synthwatch-runner:NEW\nsynthwatch-narrative-job\treg.io/synthwatch-runner:OLD'
# An absent/unreadable job (empty image) is a failure, not a pass.
expect_mismatch "absent job -> flagged" "synthwatch-reconcile-job" \
  $'synthwatch-reconcile-job\t'

# ===========================================================================
# E2. CRY-WOLF fix (#147) — VERIFY image compare is SHA-prefix-aware: a short EXPECTED tag vs the
#     job's FULL tag of the SAME commit is NOT a false FAIL, but a genuinely different sha STILL fails.
# ===========================================================================
FULL_SHA='9e97f142df3929562b11370d3e6f9089429c2055'  # the actual #147 job tag
SHORT_SHA='9e97f142df39'                              # its 12-char prefix (what the expected carried)
OTHER_SHA='024035d01688c21394f6cebd776097ded66cf942'

eq_case() { # name, want('' = same image / job = flagged), expected-runner-img, job-line
  local name="$1" want="$2" exp="$3" line="$4" got
  got="$(printf '%s' "${line}" | image_mismatches "${exp}" "reg.io/synthwatch-migrate:${exp##*:}")"
  if [[ "${got}" == "${want}" ]]; then green "PASS  ${name} (${got:-same-image})"; else
    red "FAIL  ${name} — want '${want}', got '${got}'"; FAILS=$((FAILS + 1)); fi
}
# ★ the #147 false-FAIL: expected the SHORT prefix, job is on the FULL tag -> SAME image -> no mismatch.
eq_case "short-expected vs full job tag -> same image (no cry-wolf)" "" \
  "reg.io/synthwatch-runner:${SHORT_SHA}" $'synthwatch-runner-job\treg.io/synthwatch-runner:'"${FULL_SHA}"
# reverse direction: expected FULL, job on the short prefix -> still the same image.
eq_case "full-expected vs short job tag -> same image" "" \
  "reg.io/synthwatch-runner:${FULL_SHA}" $'synthwatch-runner-job\treg.io/synthwatch-runner:'"${SHORT_SHA}"
# ★ STILL catches a REAL mismatch: a genuinely DIFFERENT sha is flagged (prefix logic isn't permissive).
eq_case "genuinely different sha STILL flagged" "synthwatch-runner-job" \
  "reg.io/synthwatch-runner:${SHORT_SHA}" $'synthwatch-runner-job\treg.io/synthwatch-runner:'"${OTHER_SHA}"
# a different host/repo at the same sha is a real mismatch (host/repo must match exactly).
eq_case "different registry/repo STILL flagged" "synthwatch-runner-job" \
  "reg.io/synthwatch-runner:${SHORT_SHA}" $'synthwatch-runner-job\tOTHER.io/synthwatch-runner:'"${FULL_SHA}"
# a too-short / non-hex prefix is NOT a confident match -> flagged (don't trivially pass garbage tags).
eq_case "non-hex tag mismatch STILL flagged" "synthwatch-runner-job" \
  "reg.io/synthwatch-runner:${SHORT_SHA}" $'synthwatch-runner-job\treg.io/synthwatch-runner:latest'

# ===========================================================================
# F. BUG 3 — migration detection over the deploy's git-diff range (migrations_in_diff).
# ===========================================================================
expect_migs() {
  local name="$1" want="$2" diff="$3" got
  got="$(printf '%s' "${diff}" | migrations_in_diff | tr '\n' ',' | sed 's/,$//')"
  if [[ "${got}" == "${want}" ]]; then green "PASS  ${name} (${got:-none})"; else
    red "FAIL  ${name} — want '${want}', got '${got}'"; FAILS=$((FAILS + 1)); fi
}
# A shipped migration is detected -> the deploy auto-runs the migrate job (today's 0032 case).
expect_migs "detects shipped migration" "0032_incidents_opened_idx" \
  $'db/migrations/0032_incidents_opened_idx.sql\nrunner/index.ts\ninfra/main.bicep'
# Multiple migrations both detected.
expect_migs "detects multiple migrations" "0033_a,0034_b" \
  $'db/migrations/0033_a.sql\ndb/migrations/0034_b.sql'
# No migration in range -> empty -> migrate job not run (no needless state change).
expect_migs "no migration -> empty" "" \
  $'runner/index.ts\ninfra/main.bicep\nscripts/deploy.sh'
# db/ changes that are NOT migrations (e.g. schema.sql, seed.sql) don't trigger the migrate job.
expect_migs "db non-migration -> empty" "" \
  $'db/schema.sql\ndb/seed.sql'

# ===========================================================================
# G. FIX 1 — git-independent migration detection (unapplied_versions). The robust fallback when
#    the deploy's git range is degenerate (SHA..SHA) or unresolvable: schema_migrations vs files.
# ===========================================================================
expect_unapplied() {
  local name="$1" applied="$2" present="$3" want="$4" got
  got="$(printf '%s' "${present}" | unapplied_versions "${applied}" | tr '\n' ',' | sed 's/,$//')"
  if [[ "${got}" == "${want}" ]]; then green "PASS  ${name} (${got:-none})"; else
    red "FAIL  ${name} — want '${want}', got '${got}'"; FAILS=$((FAILS + 1)); fi
}
# (1) degenerate/unresolvable range + an UNAPPLIED migration -> fallback finds it -> migrate runs.
expect_unapplied "fallback finds the unapplied migration" \
  $'0034_a\n0035_b' $'0034_a\n0035_b\n0036_spec_catalog' '0036_spec_catalog'
# (2) degenerate range + ALL applied -> nothing unapplied -> NO migrate.
expect_unapplied "fallback: all applied -> no migrate" \
  $'0034_a\n0035_b\n0036_spec_catalog' $'0034_a\n0035_b\n0036_spec_catalog' ''
# multiple unapplied, and a fresh (empty schema_migrations) DB -> everything present is unapplied.
expect_unapplied "fallback finds multiple unapplied" \
  $'0034_a' $'0034_a\n0035_b\n0036_c' '0035_b,0036_c'
expect_unapplied "fallback: empty schema_migrations -> all unapplied" \
  '' $'0001_x\n0002_y' '0001_x,0002_y'

# ===========================================================================
# H. FIX 2 — post_reconcile triggers + waits + reports (az/psql/sleep stubbed).
# ===========================================================================
RG='rg-test'; DATABASE_URL='db'; RECONCILE_POLL_TRIES=1   # RECONCILE_JOB now comes from deploy-lib.sh (sourced above, readonly)
sleep() { :; }   # no real waiting in tests
check_contains() {
  local name="$1" hay="$2" needle="$3"
  case "${hay}" in *"${needle}"*) green "PASS  ${name}" ;; *) red "FAIL  ${name} — missing: ${needle}"; FAILS=$((FAILS + 1)) ;; esac
}

# Reconcile job Succeeds -> reports spec_catalog + reconcile_drift, rc 0.
az() { case "$*" in *"job start"*) echo "recon-exec-1" ;; *"execution show"*) echo "Succeeded" ;; esac; }
psql() {
  case "$*" in
    *"WHERE runnable"*)    echo "3" ;;
    *"FROM spec_catalog"*) echo "3" ;;
    *reconcile_drift*)     echo "new=3" ;;
  esac
}
if out="$(post_reconcile)"; then rc=0; else rc=$?; fi
if [[ "${rc}" -eq 0 ]]; then green "PASS  post_reconcile success rc=0"; else red "FAIL  post_reconcile rc=${rc}"; FAILS=$((FAILS + 1)); fi
check_contains "post_reconcile starts the job"  "${out}" "starting synthwatch-reconcile-job"
check_contains "post_reconcile waits"           "${out}" "waiting up to"
check_contains "post_reconcile reports catalog" "${out}" "spec_catalog: 3 row(s), 3 runnable"
check_contains "post_reconcile reports drift"   "${out}" "reconcile_drift: new=3"

# Reconcile job FAILS -> surfaced + rc non-zero.
az() { case "$*" in *"job start"*) echo "recon-exec-2" ;; *"execution show"*) echo "Failed" ;; esac; }
if out="$(post_reconcile)"; then rc=0; else rc=$?; fi
if [[ "${rc}" -ne 0 ]]; then green "PASS  post_reconcile surfaces failure (rc!=0)"; else red "FAIL  post_reconcile should fail"; FAILS=$((FAILS + 1)); fi
check_contains "post_reconcile prints the error" "${out}" "ERROR: synthwatch-reconcile-job ended: Failed"
unset -f az psql sleep check_contains

# ===========================================================================
# E. git_drift_state — local HEAD vs origin/main, in a throwaway repo (no working-tree mutation of
#    THIS repo). The deploy targets origin/main; this only classifies what to warn.
# ===========================================================================
run_drift_tests() {
  local repo cwd A B S L LREAL
  repo="$(mktemp -d)"; cwd="${PWD}"
  cd "${repo}"
  git init -q; git config user.email t@t; git config user.name t
  git commit -q --allow-empty -m A; A="$(git rev-parse HEAD)"
  git commit -q --allow-empty -m B; B="$(git rev-parse HEAD)" # B is a child of A
  expect_eq "drift same (local == origin)"        "same"     "$(git_drift_state "${A}" "${A}")"
  expect_eq "drift behind (local A, origin B)"     "behind"   "$(git_drift_state "${A}" "${B}")"
  expect_eq "drift diverged (local B ahead of A)"  "diverged" "$(git_drift_state "${B}" "${A}")"

  # ★ STALE (squash-merge leftover): an ORIGIN commit and a LOCAL commit that make the SAME change (equal
  # patch-id) on divergent branches off A. The pre-squash local commit isn't an ancestor of origin, but its
  # change IS already on origin as an equivalent patch → must classify 'stale' (benign), NOT 'diverged'.
  git checkout -q -b origin_line "${A}"
  printf 'X\n' > foo; git add foo; git commit -q -m 'squash on origin'; S="$(git rev-parse HEAD)"
  git checkout -q -b local_dup "${A}"
  printf 'X\n' > foo; git add foo; git commit -q -m 'pre-squash local dup'; L="$(git rev-parse HEAD)"
  expect_eq "drift STALE (local dup already on origin as a squash)" "stale" "$(git_drift_state "${L}" "${S}")"

  # ★ GENUINE diverged: a local commit with REAL content NOT on origin (a different change) → the loud
  # warning is preserved (when the local work isn't subsumed, never downgrade to 'stale').
  git checkout -q -b local_real "${A}"
  printf 'Y\n' > bar; git add bar; git commit -q -m 'real unpushed work'; LREAL="$(git rev-parse HEAD)"
  expect_eq "drift diverged (real content not on origin)" "diverged" "$(git_drift_state "${LREAL}" "${S}")"

  cd "${cwd}"; rm -rf "${repo}"
}
run_drift_tests

# ===========================================================================
# F. ★ FIX 3 — ci_wait_verdict (the pure per-tick decision of the CI-wait loop). Proves BOTH
#    directions: it PROCEEDs only when the target is actually built, REFUSEs on a real CI failure
#    (so DB-ahead-of-code is never auto-shipped), and otherwise WAITs.
# ===========================================================================
expect_eq "ci-wait proceeds when target built"          "proceed" "$(ci_wait_verdict 1 '')"
expect_eq "ci-wait proceeds even if gh unknown + built" "proceed" "$(ci_wait_verdict 1 in_progress)"
expect_eq "ci-wait waits while CI in_progress"          "wait"    "$(ci_wait_verdict 0 in_progress)"
expect_eq "ci-wait waits when no run found yet"         "wait"    "$(ci_wait_verdict 0 '')"
# ★ success-but-image-not-yet-pushed → keep waiting (only a PRESENT image proceeds, never a predating one).
expect_eq "ci-wait waits on success w/o image yet"      "wait"    "$(ci_wait_verdict 0 success)"
# ★ a REAL CI failure refuses NOW — the guard against auto-deploying past a failed build.
expect_eq "ci-wait REFUSES on CI failure"               "refuse"  "$(ci_wait_verdict 0 failure)"
expect_eq "ci-wait REFUSES on CI cancelled"             "refuse"  "$(ci_wait_verdict 0 cancelled)"
expect_eq "ci-wait REFUSES on CI timed_out"             "refuse"  "$(ci_wait_verdict 0 timed_out)"

# ===========================================================================
# G. ★ FIX 1 — retry_nonempty (the verify mid-reconciliation false-empty fix). Proves BOTH directions:
#    a transient empty that LATER returns a value is absorbed (PASS), but a value that stays empty
#    across all retries is returned empty (so the caller's check still FLUNKS — guard kept).
# ===========================================================================
run_retry_tests() {
  export VERIFY_READ_TRIES=4 VERIFY_READ_SLEEP=0
  # shellcheck disable=SC2317,SC2329  # stub invoked indirectly; shellcheck can't see it
  sleep() { :; }   # no real waiting in tests
  # The reader runs in a command-substitution SUBSHELL each call, so the call counter must live in a
  # FILE (a plain var wouldn't persist across the subshells). statef holds the call count.
  local statef; statef="$(mktemp)"; printf '0' > "${statef}"
  export STATEF="${statef}"
  # (a) empty on tries 1-2, then 'acs-email-conn' on the 3rd — the mid-reconciliation transient → absorbed.
  # shellcheck disable=SC2317,SC2329
  _read_transient() { local n; n=$(< "${STATEF}"); n=$((n + 1)); printf '%s' "${n}" > "${STATEF}"; (( n >= 3 )) && printf 'acs-email-conn'; }
  export -f _read_transient
  expect_eq "retry absorbs a transient empty" "acs-email-conn" "$(retry_nonempty _read_transient)"
  # (b) ALWAYS empty (a genuinely-missing/wiped ref) → stays empty → caller flunks (guard preserved).
  # shellcheck disable=SC2317,SC2329
  _read_missing() { printf ''; }
  export -f _read_missing
  expect_eq "retry leaves a genuinely-missing value empty" "" "$(retry_nonempty _read_missing)"
  rm -f "${statef}"; unset -f sleep _read_transient _read_missing; unset STATEF VERIFY_READ_TRIES VERIFY_READ_SLEEP
}
run_retry_tests   # retry_nonempty is sourced from deploy-lib.sh (the EXACT shipped function)

# ===========================================================================
# I. ★ CD ↔ deploy.sh JOB-LIST PARITY (the structural guard). CD (.github/workflows/deploy.yml) MUST roll
#    EXACTLY the RUNNER_IMAGE_JOBS set on every merge (TD-3: CD had drifted to 2 of 6 → westus2/narrative/
#    rollup/reconcile ran STALE code until a manual deploy). RUNNER_IMAGE_JOBS is the single source (in
#    deploy-lib.sh, sourced above); the CD set is parsed from deploy.yml's `az containerapp job update -n
#    <name>` lines. (The migrate update uses `-n "$JOB"`, so the literal-name grep captures ONLY the 6 runner
#    jobs — never the migrate one.) Set-equality BOTH directions: a job in one but not the other FAILS.
# ===========================================================================
cd_rolled="$(grep -oE 'containerapp job update -n [a-z0-9-]+' "${ROOT}/.github/workflows/deploy.yml" | awk '{print $NF}' | sort -u | tr '\n' ' ')"
runner_image_set="$(printf '%s\n' "${RUNNER_IMAGE_JOBS[@]}" | sort -u | tr '\n' ' ')"
expect_eq "deploy.yml rolls EXACTLY RUNNER_IMAGE_JOBS (no CD/deploy.sh drift)" "${runner_image_set}" "${cd_rolled}"

echo
if [[ "${FAILS}" -eq 0 ]]; then
  green "ALL TESTS PASSED"
else
  red "${FAILS} TEST(S) FAILED"
fi
exit "$(( FAILS > 0 ? 1 : 0 ))"
