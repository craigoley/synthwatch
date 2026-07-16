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

# ---------------------------------------------------------------------------
# ★ sha_in_tags — the pipe-free membership shared by pick_sha (--sha override, deploy.sh:302/304) and
# newest_common_sha. MUST-GO-RED (the SIGPIPE sibling of the #279/#281 sweep): a SHA at the TOP of a LARGE
# tag list is the exact input the old `printf '%s\n' "$tags" | grep -qxF "$sha"` got wrong — grep -q matches
# line 1 and closes the pipe, SIGPIPE-ing the still-writing printf, so under `set -o pipefail` the pipeline
# returns 141 EVEN ON A MATCH → the `|| fail` fires → a valid `--sha` deploy is falsely REFUSED. It MUST match.
SHA_HIT='aaa1111111111111111111111111111111111111'
BIG_TAGS="$(printf '%s\n' "${SHA_HIT}"; seq 5000)"
if sha_in_tags "${SHA_HIT}" "${BIG_TAGS}"; then green "PASS  sha_in_tags finds a SHA at the top of a large list (SIGPIPE-safe — the --sha must-go-red)"; else red "FAIL  sha_in_tags missed an early SHA in a large list — the SIGPIPE false-negative regressed (a valid --sha deploy would be refused)!"; FAILS=$((FAILS + 1)); fi
# ★ Cannot vacuously pass: an ABSENT sha, an EMPTY sha, and an EMPTY list must ALL flunk (never shrug).
if sha_in_tags "notpresent00000000000000000000000000000" "${BIG_TAGS}"; then red "FAIL  sha_in_tags matched a SHA that is NOT in the list (vacuous pass)"; FAILS=$((FAILS + 1)); else green "PASS  sha_in_tags flunks an absent SHA"; fi
if sha_in_tags "" "${BIG_TAGS}"; then red "FAIL  sha_in_tags matched an EMPTY sha (grep -xF '' would vacuously match an empty line — must be rejected)"; FAILS=$((FAILS + 1)); else green "PASS  sha_in_tags flunks an empty sha (no vacuous match)"; fi
if sha_in_tags "${SHA_HIT}" ""; then red "FAIL  sha_in_tags matched against an EMPTY tag list"; FAILS=$((FAILS + 1)); else green "PASS  sha_in_tags flunks an empty tag list"; fi
# newest_common_sha (deploy-lib.sh:115 site) is SIGPIPE-safe too: the common SHA at the TOP of a large migrate list.
expect_eq "common-sha finds an early match in a large migrate list (SIGPIPE-safe)" "${SHA_HIT}" \
  "$(newest_common_sha "${SHA_HIT}" "${BIG_TAGS}")"
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

# ===========================================================================
# J. ★ CONFIG-VALUE extraction + comparison (verify()'s data-driven replicaTimeout/cpu/memory checks —
#    the fix for the silent-drop class). bicep_field must pull the RUNNER-job values from the deployed
#    template BLOCK-SCOPED (not bleed the aux jobs' 600/0.25/0.5Gi), and num_eq must be 2-vs-2.0 tolerant
#    AND MUST-GO-RED on a real mismatch (a dropped value → verify() flunks instead of a silent pass).
# ===========================================================================
BICEP_FIXTURE="$(cat <<'FIX'
resource job 'Microsoft.App/jobs@2024-03-01' = {
  properties: {
    configuration: {
      replicaTimeout: 660
    }
    template: {
      containers: [
        {
          resources: {
            cpu: json('2.0')
            memory: '4Gi'
          }
        }
      ]
    }
  }
}
resource retentionJob 'Microsoft.App/jobs@2024-03-01' = {
  properties: {
    configuration: {
      replicaTimeout: 600
    }
    template: {
      containers: [
        {
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
    }
  }
}
FIX
)"
expect_eq "bicep_field job replicaTimeout (runner, block-scoped)" "660" "$(printf '%s' "${BICEP_FIXTURE}" | bicep_field job replicaTimeout)"
expect_eq "bicep_field job cpu (unwraps json)"                   "2.0"  "$(printf '%s' "${BICEP_FIXTURE}" | bicep_field job cpu)"
expect_eq "bicep_field job memory (strips quotes)"              "4Gi"  "$(printf '%s' "${BICEP_FIXTURE}" | bicep_field job memory)"
expect_eq "bicep_field retentionJob replicaTimeout (NOT the runner 660)" "600" "$(printf '%s' "${BICEP_FIXTURE}" | bicep_field retentionJob replicaTimeout)"

# ★ ABSENT field → EMPTY, not a non-zero-exit abort. This file runs under `set -euo pipefail` (like
# deploy.sh), so `exp="$(bicep_field …)"` on a block MISSING the field would kill the run mid-line if the
# grep pipeline weren't `|| true`-guarded — bypassing verify()'s graceful `<none in template>` flunk. That
# these three assignments complete AT ALL proves no abort; the empty result proves absence is handled.
NOFIELD_FIXTURE="$(cat <<'FIX'
resource job 'Microsoft.App/jobs@2024-03-01' = {
  properties: { template: { containers: [ { } ] } }
}
FIX
)"
expect_eq "bicep_field ABSENT replicaTimeout → empty, no set-e abort" "" "$(printf '%s' "${NOFIELD_FIXTURE}" | bicep_field job replicaTimeout)"
expect_eq "bicep_field ABSENT cpu → empty, no set-e abort"            "" "$(printf '%s' "${NOFIELD_FIXTURE}" | bicep_field job cpu)"
expect_eq "bicep_field ABSENT memory → empty, no set-e abort"         "" "$(printf '%s' "${NOFIELD_FIXTURE}" | bicep_field job memory)"

if num_eq "2.0" "2";  then green "PASS  num_eq 2.0==2 (cpu tolerance)"; else red "FAIL  num_eq 2.0==2";   FAILS=$((FAILS + 1)); fi
if num_eq "660" "660"; then green "PASS  num_eq 660==660";            else red "FAIL  num_eq 660==660"; FAILS=$((FAILS + 1)); fi
# ★ MUST-GO-RED: a dropped value (live 240 vs expected 660) MUST be unequal → verify() flunks the deploy.
if num_eq "660" "240"; then red "FAIL  num_eq must-go-red: 660 vs 240 wrongly equal (a silent drop would PASS!)"; FAILS=$((FAILS + 1)); else green "PASS  num_eq must-go-red: 660 != 240 (a dropped replicaTimeout FLUNKS verify)"; fi
if num_eq "" "660"; then red "FAIL  num_eq empty-expected wrongly equal (a template-absent value would pass)"; FAILS=$((FAILS + 1)); else green "PASS  num_eq empty expected != anything"; fi

# ★ mem_eq — MEMORY is the exact value the #253/#256 drop lost (2Gi shipped where 4Gi was intended). Exact
# string compare; empty expected must FLUNK (a template-absent memory can't silently pass). verify() +
# reconcile_resources share mem_eq, so this is the tested compare behind both.
if mem_eq "4Gi" "4Gi"; then green "PASS  mem_eq 4Gi==4Gi"; else red "FAIL  mem_eq 4Gi==4Gi"; FAILS=$((FAILS + 1)); fi
if mem_eq "4Gi" "2Gi"; then red "FAIL  mem_eq must-go-red: 4Gi vs 2Gi wrongly equal (THE #253 silent drop would PASS!)"; FAILS=$((FAILS + 1)); else green "PASS  mem_eq must-go-red: 4Gi != 2Gi (a dropped memory FLUNKS verify)"; fi
if mem_eq "" "4Gi"; then red "FAIL  mem_eq empty-expected wrongly equal (a template-absent memory would pass)"; FAILS=$((FAILS + 1)); else green "PASS  mem_eq empty expected != anything"; fi

# ★ THE #279 SWEEP — every comparator behind a verify() check must FLUNK when it cannot actually compare:
# empty EXPECTED (a constant left unset / a parse that missed), empty LIVE (an az/psql read that failed), or
# BOTH empty (the vacuous empty-vs-empty match the CORS parser hit). A green here would manufacture confidence.

# str_eq — the guarded comparator the verify() STRING checks (AOAI api-version, ACS/CRED secretRef,
# SYNTHWATCH_DEPLOYED, API 200, migration recorded) now route through, so an empty-vs-empty can never pass.
if str_eq "2025-04-01-preview" "2025-04-01-preview"; then green "PASS  str_eq exact match"; else red "FAIL  str_eq exact match"; FAILS=$((FAILS + 1)); fi
if str_eq "2025-04-01-preview" "2024-01-01"; then red "FAIL  str_eq mismatch wrongly equal (a drifted value would PASS!)"; FAILS=$((FAILS + 1)); else green "PASS  str_eq must-go-red: mismatch FLUNKS"; fi
if str_eq "" "acs-email-conn";  then red "FAIL  str_eq EMPTY-EXPECTED matched (a constant left unset would vacuously PASS — the #279 class!)"; FAILS=$((FAILS + 1)); else green "PASS  str_eq must-go-red: empty expected != anything"; fi
if str_eq "acs-email-conn" ""; then red "FAIL  str_eq empty-LIVE matched (a failed az read would PASS!)"; FAILS=$((FAILS + 1)); else green "PASS  str_eq must-go-red: empty live != a real expected"; fi
if str_eq "" "";               then red "FAIL  str_eq BOTH-EMPTY matched (the vacuous empty-vs-empty pass — the exact #279 shape!)"; FAILS=$((FAILS + 1)); else green "PASS  str_eq must-go-red: empty-vs-empty FLUNKS (no vacuous match)"; fi

# num_eq / mem_eq — round out the empty-LIVE and BOTH-EMPTY axes (empty-EXPECTED already covered above).
if num_eq "660" ""; then red "FAIL  num_eq empty-LIVE matched (a failed job_replica_timeout read would PASS!)"; FAILS=$((FAILS + 1)); else green "PASS  num_eq must-go-red: empty live != 660"; fi
if num_eq "" "";    then red "FAIL  num_eq BOTH-EMPTY matched (vacuous #279 shape)"; FAILS=$((FAILS + 1)); else green "PASS  num_eq must-go-red: empty-vs-empty FLUNKS"; fi
if mem_eq "4Gi" ""; then red "FAIL  mem_eq empty-LIVE matched (a failed job_memory read would PASS!)"; FAILS=$((FAILS + 1)); else green "PASS  mem_eq must-go-red: empty live != 4Gi"; fi
if mem_eq "" "";    then red "FAIL  mem_eq BOTH-EMPTY matched (vacuous #279 shape)"; FAILS=$((FAILS + 1)); else green "PASS  mem_eq must-go-red: empty-vs-empty FLUNKS"; fi

# ===========================================================================
# K. ★ image_covered_by_template — the STALE-TEMPLATE guard (the ACTUAL #253/#256 root cause). The
#    2026-07-11 deploy shipped commit 3a2f955's 2Gi template atop the CURRENT image; materialize's
#    fallback-to-a-stale-TARGET_HEAD let the template PREDATE the image, and verify() validated live 2Gi
#    against that same stale 2Gi template and PASSED. The guard REFUSES a template older than the image.
#    Build a throwaway 2-commit repo (OLD ancestor <- NEW descendant) and assert the covered/stale verdicts.
# ===========================================================================
GITGUARD_DIR="$(mktemp -d -t synthwatch-gitguard.XXXXXX)"
git -C "${GITGUARD_DIR}" init -q
git -C "${GITGUARD_DIR}" config user.email t@example.test
git -C "${GITGUARD_DIR}" config user.name test
printf 'old\n' > "${GITGUARD_DIR}/f"; git -C "${GITGUARD_DIR}" add f; git -C "${GITGUARD_DIR}" commit -qm old
printf 'new\n' > "${GITGUARD_DIR}/f"; git -C "${GITGUARD_DIR}" commit -qam new
GG_NEW="$(git -C "${GITGUARD_DIR}" rev-parse HEAD)"
GG_OLD="$(git -C "${GITGUARD_DIR}" rev-parse HEAD~1)"
# image_covered_by_template runs bare `git`, so evaluate it with cwd inside the fixture repo.
guard() { ( cd "${GITGUARD_DIR}" && image_covered_by_template "$1" "$2" ); }
if guard "${GG_NEW}" "${GG_NEW}"; then green "PASS  guard: template == image → covered"; else red "FAIL  guard: template==image should be covered"; FAILS=$((FAILS + 1)); fi
if guard "${GG_OLD}" "${GG_NEW}"; then green "PASS  guard: template (NEW) is newer than image (OLD) → covered"; else red "FAIL  guard: newer template should be covered"; FAILS=$((FAILS + 1)); fi
# ★ MUST-GO-RED: a template OLDER than the image (2Gi ancestor template on the current image) MUST be refused.
if guard "${GG_NEW}" "${GG_OLD}"; then red "FAIL  guard must-go-red: a STALE template (older than the image) was ACCEPTED — the #253 drop would ship!"; FAILS=$((FAILS + 1)); else green "PASS  guard must-go-red: stale template (older than image) is REFUSED"; fi
rm -rf "${GITGUARD_DIR}"

# ===========================================================================
# L. ★ Concern A — template-derived RBAC + CORS parsers (verify_rbac / verify_cors read the EXPECTED role
#    assignments + CORS origins FROM the bicep, so verify stays correct as they change — never a hand-curated
#    subset). A mini-bicep fixture with two roleAssignments (an API-MI grant on storage + a runner-MI acrPull)
#    exercises the parser; contains_line is the must-go-red comparator behind the live assertions.
# ===========================================================================
RBAC_FIXTURE="$(cat <<'FIX'
param apiManagedIdentityPrincipalId string = '67f2bd0c-1334-42a7-b521-3005064d7171'
param identityName string = 'synthwatch-runner-id'
param storageAccountName string = 'synthwatche24e33105c'
param dashboardCorsOrigins array = [
  'https://synthwatch-dashboard.vercel.app'
  'https://preview.example.app'
]
var storageBlobDelegatorRoleId = 'db58b8e5-c6ad-4a2a-8342-4190687cbf4a'
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
resource apiBlobDelegatorAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, apiManagedIdentityPrincipalId, storageBlobDelegatorRoleId)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDelegatorRoleId)
    principalId: apiManagedIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}
resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, identity.id, acrPullRoleId)
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
resource runnerCostReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, identity.id, costManagementReaderRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', costManagementReaderRoleId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
FIX
)"
expect_eq "bicep_var role GUID" "db58b8e5-c6ad-4a2a-8342-4190687cbf4a" "$(printf '%s' "${RBAC_FIXTURE}" | bicep_var storageBlobDelegatorRoleId)"
expect_eq "bicep_param principalId literal" "67f2bd0c-1334-42a7-b521-3005064d7171" "$(printf '%s' "${RBAC_FIXTURE}" | bicep_param apiManagedIdentityPrincipalId)"
expect_eq "bicep_param identityName" "synthwatch-runner-id" "$(printf '%s' "${RBAC_FIXTURE}" | bicep_param identityName)"
expect_eq "bicep_param_array first origin" "https://synthwatch-dashboard.vercel.app" "$(printf '%s' "${RBAC_FIXTURE}" | bicep_param_array dashboardCorsOrigins | sed -n 1p)"
expect_eq "bicep_param_array second origin" "https://preview.example.app" "$(printf '%s' "${RBAC_FIXTURE}" | bicep_param_array dashboardCorsOrigins | sed -n 2p)"
# The assignments, TSV, in declaration order.
expect_eq "role_assignments_from_template row 1" "storageBlobDelegatorRoleId	apiManagedIdentityPrincipalId	storage" "$(printf '%s' "${RBAC_FIXTURE}" | role_assignments_from_template | sed -n 1p)"
expect_eq "role_assignments_from_template row 2" "acrPullRoleId	identity.properties.principalId	acr" "$(printf '%s' "${RBAC_FIXTURE}" | role_assignments_from_template | sed -n 2p)"
# ★ RG-scoped assignment (NO `scope:` in bicep) → scope token `resourceGroup`, NOT dropped. This is the gap
# that let the runner's Cost Management Reader grant deploy "green" while silently failing — must be asserted.
expect_eq "role_assignments_from_template row 3 (RG-scoped, no scope: line)" "costManagementReaderRoleId	identity.properties.principalId	resourceGroup" "$(printf '%s' "${RBAC_FIXTURE}" | role_assignments_from_template | sed -n 3p)"
expect_eq "role_assignments count" "3" "$(printf '%s' "${RBAC_FIXTURE}" | role_assignments_from_template | grep -c .)"

# ★ cors_origins_tokens: EVERY corsRule's allowedOrigins param token (not just the first) — so verify_cors's
# data-driven guarantee is N-rules-deep (a 2nd rule referencing a different param can't slip past unasserted).
CORS_FIXTURE="$(cat <<'FIX'
cors: {
  corsRules: [
    {
      allowedOrigins: dashboardCorsOrigins
      allowedMethods: [ 'GET', 'HEAD' ]
    }
    {
      allowedOrigins: previewCorsOrigins
      allowedMethods: [ 'GET' ]
    }
  ]
}
FIX
)"
expect_eq "cors_origins_tokens finds BOTH rules' origin params" "dashboardCorsOrigins previewCorsOrigins" "$(printf '%s' "${CORS_FIXTURE}" | cors_origins_tokens | tr '\n' ' ' | sed 's/ $//')"

# ★ template_declares_cors — the detection that gates verify_cors. THE 2026-07-12 BUG: verify_cors used
# `printf '%s' "$tmpl" | grep -q corsRules`; under `set -o pipefail` grep -q short-circuited on the match and
# SIGPIPE'd printf, so the pipeline returned 141 and `! <pipeline>` read as "no CORS" — a VACUOUS PASS exactly
# WHEN CORS was present (+ the broken-pipe). template_declares_cors is the pure-bash, pipe-free replacement.
if template_declares_cors "${CORS_FIXTURE}"; then green "PASS  template_declares_cors detects a declared corsRules block"; else red "FAIL  template_declares_cors missed a declared corsRules block (CORS would go UNVERIFIED)"; FAILS=$((FAILS + 1)); fi
if template_declares_cors "param x string = 'y'"; then red "FAIL  template_declares_cors false-positived on a CORS-less template"; FAILS=$((FAILS + 1)); else green "PASS  template_declares_cors: no corsRules → the rare, explicit 'nothing to assert' state"; fi
# ★ MUST-GO-RED (the SIGPIPE regression): corsRules at the TOP of a LARGE template — the exact input the old
# `printf | grep -q` got wrong (early match → SIGPIPE → false "no CORS"). Detection MUST still see it. If
# template_declares_cors is ever reverted to an internal `printf | grep -q`, this fails under pipefail.
BIG_CORS="$(printf 'corsRules\n'; seq 5000)"
if template_declares_cors "${BIG_CORS}"; then green "PASS  template_declares_cors detects early CORS in a large template (SIGPIPE-safe — the 2026-07-12 must-go-red)"; else red "FAIL  template_declares_cors missed early corsRules in a large template — the SIGPIPE vacuous-pass regressed!"; FAILS=$((FAILS + 1)); fi
# ★ MUST-GO-RED (declared CORS, LIVE empty → verify FLUNKS): the declared origin is read from the bicep and
# checked against the LIVE list; an empty live list (CORS not landed) MUST flunk — the exact silent not-landed
# shape verify_cors exists to catch, over the real declared-origin → contains_line path.
CORS_DECLARED_ORIGIN="$(printf '%s' "${RBAC_FIXTURE}" | bicep_param_array dashboardCorsOrigins | sed -n 1p)"
if printf '' | contains_line "${CORS_DECLARED_ORIGIN}"; then red "FAIL  CORS must-go-red: a DECLARED origin matched an EMPTY live list (live CORS not landed would PASS!)"; FAILS=$((FAILS + 1)); else green "PASS  CORS must-go-red: a declared origin absent from live CORS FLUNKS verify"; fi
# ★ MUST-GO-RED (parse failure → FAIL, not PASS): a template that DECLARES corsRules but whose rule has NO
# allowedOrigins param token is UNPARSEABLE — template_declares_cors is TRUE (enters the assert branch) while
# cors_origins_tokens is EMPTY, which verify_cors turns into a flunk ("declares corsRules but no allowedOrigins
# param token parsed"), never a vacuous pass.
CORS_UNPARSEABLE="$(cat <<'FIX'
cors: {
  corsRules: [
    {
      allowedMethods: [ 'GET', 'HEAD' ]
    }
  ]
}
FIX
)"
if template_declares_cors "${CORS_UNPARSEABLE}" && [[ -z "$(printf '%s' "${CORS_UNPARSEABLE}" | cors_origins_tokens)" ]]; then green "PASS  parse-miss: declared corsRules + no origin token → verify_cors flunks (not a vacuous pass)"; else red "FAIL  parse-miss handling regressed (an unparseable corsRules could vacuously pass)"; FAILS=$((FAILS + 1)); fi

# contains_line — the tested comparator behind the RBAC + CORS live assertions.
if printf 'AcrPull\nStorage Blob Delegator\n' | contains_line "Storage Blob Delegator"; then green "PASS  contains_line finds an exact role"; else red "FAIL  contains_line should find the role"; FAILS=$((FAILS + 1)); fi
# ★ MUST-GO-RED: a declared role/origin ABSENT from the live list MUST flunk (a silent not-landed grant/CORS
# would otherwise pass — the memory-drop class).
if printf 'AcrPull\nStorage Blob Data Reader\n' | contains_line "Storage Blob Delegator"; then red "FAIL  contains_line must-go-red: a MISSING role was accepted (a silent not-landed grant would PASS!)"; FAILS=$((FAILS + 1)); else green "PASS  contains_line must-go-red: a missing role FLUNKS verify"; fi
if printf '' | contains_line "https://synthwatch-dashboard.vercel.app"; then red "FAIL  contains_line empty-live wrongly matched (empty CORS would pass)"; FAILS=$((FAILS + 1)); else green "PASS  contains_line empty live list != anything (empty CORS FLUNKS)"; fi
# ★ REGRESSION: a SINGLE live value with NO trailing newline — the exact shape `printf '%s' "$(az … -o tsv)"`
# yields for a one-item result — MUST still be found. (A naive `while read` drops an unterminated final line,
# which false-flunked a live AcrPull/Delegator grant during live validation.)
if printf '%s' "OnlyRoleNoNewline" | contains_line "OnlyRoleNoNewline"; then green "PASS  contains_line finds a lone value with no trailing newline"; else red "FAIL  contains_line drops an unterminated final line (would false-flunk a live grant!)"; FAILS=$((FAILS + 1)); fi

# ===========================================================================
# M. ★ Concern B — script_differs_from_ref: the stale-deploy-script guard's tested core. deploy.sh executes
#    the LOCAL copy of itself while deploying origin/main's template; a script differing from origin/main runs
#    OLD logic. Build a throwaway repo, commit a script, then edit the local copy → must read STALE.
# ===========================================================================
SCRIPTGUARD_DIR="$(mktemp -d -t synthwatch-scriptguard.XXXXXX)"
git -C "${SCRIPTGUARD_DIR}" init -q
git -C "${SCRIPTGUARD_DIR}" config user.email t@example.test
git -C "${SCRIPTGUARD_DIR}" config user.name test
mkdir -p "${SCRIPTGUARD_DIR}/scripts"
printf 'echo v1\n' > "${SCRIPTGUARD_DIR}/scripts/deploy.sh"
git -C "${SCRIPTGUARD_DIR}" add scripts/deploy.sh
git -C "${SCRIPTGUARD_DIR}" commit -qm v1
# Simulate origin/main == the committed v1.
git -C "${SCRIPTGUARD_DIR}" update-ref refs/remotes/origin/main HEAD
# Identical local copy → NOT stale.
if script_differs_from_ref "${SCRIPTGUARD_DIR}" origin/main scripts/deploy.sh; then red "FAIL  script guard: identical script read as stale"; FAILS=$((FAILS + 1)); else green "PASS  script guard: identical local script is current"; fi
# ★ MUST-GO-RED: edit the local copy so it lags origin/main → MUST read STALE (else deploy.sh runs old logic).
printf 'echo v0-STALE\n' > "${SCRIPTGUARD_DIR}/scripts/deploy.sh"
if script_differs_from_ref "${SCRIPTGUARD_DIR}" origin/main scripts/deploy.sh; then green "PASS  script guard must-go-red: a stale local deploy.sh is DETECTED (deploy would abort)"; else red "FAIL  script guard must-go-red: a STALE deploy.sh read as current — it would silently run OLD logic!"; FAILS=$((FAILS + 1)); fi
# A ref that lacks the path → not "stale" (can't compare) — the caller logs a skip, never a false abort.
if script_differs_from_ref "${SCRIPTGUARD_DIR}" origin/main scripts/nonexistent.sh; then red "FAIL  script guard: a ref-missing path wrongly read as stale"; FAILS=$((FAILS + 1)); else green "PASS  script guard: a ref-missing path is not stale (skip, no false abort)"; fi
rm -rf "${SCRIPTGUARD_DIR}"

# ===========================================================================
# N. ★ START-OF-RUN tree-sync policy (tree_sync_decision) — the pure verdict the deploy.sh sync block acts on.
#    ON MAIN: a DIRTY behind tree ABORTS (never discards work); a clean behind tree FAST-FORWARDS; a diverged
#    tree is PRESERVED (never auto-reset). NOT ON MAIN: auto-switch to main ONLY when the branch is clean AND
#    fully merged (nothing to lose); refuse when dirty, unmerged, or unverifiable (work at risk / when in doubt).
# ===========================================================================
expect_eq "tree_sync: local == origin → current"           "current"  "$(tree_sync_decision main aaa aaa 1 0)"
expect_eq "tree_sync: origin unresolvable → current"       "current"  "$(tree_sync_decision main aaa '' 0 0)"
expect_eq "tree_sync: behind + clean → fast-forward"       "ff"       "$(tree_sync_decision main aaa bbb 1 0)"
# ★ MUST-GO-RED: a behind tree with uncommitted TRACKED changes must ABORT — a silent fast-forward would
# discard the work (the exact thing this must never do).
expect_eq "tree_sync must-go-red: behind + DIRTY → abort"  "dirty"    "$(tree_sync_decision main aaa bbb 1 1)"
# ★ MUST-GO-RED: a diverged local (commit(s) not on origin) must be PRESERVED, never auto-reset.
expect_eq "tree_sync must-go-red: diverged → preserve"     "diverged" "$(tree_sync_decision main aaa bbb 0 0)"

# ── NOT-ON-MAIN auto-switch policy (the friction fix): switch iff clean AND fully merged; else refuse ──
# THE COMMON CASE: a clean, fully-merged leftover branch (merged=1) has nothing to lose → auto-switch to main.
expect_eq "tree_sync: not-main clean+merged → switch"      "switch-main"        "$(tree_sync_decision retro/x aaa bbb 0 0 1)"
# ★ MUST-GO-RED (work at risk): uncommitted TRACKED changes on the branch → REFUSE, even if 'merged' were set.
expect_eq "tree_sync must-go-red: not-main DIRTY → refuse" "not-main-dirty"     "$(tree_sync_decision retro/x aaa bbb 0 1 1)"
# ★ MUST-GO-RED (work at risk): clean but has commit(s) NOT upstream (unpushed/unmerged) → REFUSE.
expect_eq "tree_sync must-go-red: not-main unmerged→refuse" "not-main-unmerged" "$(tree_sync_decision retro/x aaa bbb 0 0 0)"
# ★ MUST-GO-RED (when in doubt): origin/main unresolvable → can't PROVE merged → REFUSE (never a false 'safe').
expect_eq "tree_sync must-go-red: not-main unverified→refuse" "not-main-unverified" "$(tree_sync_decision retro/x aaa '' 0 0 1)"
# The 'merged' flag DEFAULTS to 0 (safe): a caller omitting it never auto-switches — it refuses as unmerged.
expect_eq "tree_sync: not-main merged omitted → refuse"    "not-main-unmerged"  "$(tree_sync_decision retro/x aaa bbb 0 0)"

echo
if [[ "${FAILS}" -eq 0 ]]; then
  green "ALL TESTS PASSED"
else
  red "${FAILS} TEST(S) FAILED"
fi
exit "$(( FAILS > 0 ? 1 : 0 ))"
