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

# ===========================================================================
# C. --yes semantics + the drop never being auto-proceeded (confirm gates).
#    confirm_head_mismatch / confirm_drop read stdin; we inject answers and toggle ASSUME_YES.
# ===========================================================================
assert_proceed() { local name="$1"; shift; if "$@"; then green "PASS  ${name} (proceed)"; else red "FAIL  ${name} — expected proceed"; FAILS=$((FAILS + 1)); fi; }
assert_abort()   { local name="$1"; shift; if "$@"; then red "FAIL  ${name} — expected abort"; FAILS=$((FAILS + 1)); else green "PASS  ${name} (abort)"; fi; }

WHATIF_ONLY=0

# (4a) --yes skips the benign HEAD-mismatch prompt (proceeds without reading stdin).
ASSUME_YES=1; assert_proceed "head-mismatch --yes proceeds" confirm_head_mismatch </dev/null; ASSUME_YES=0
# (4b) interactive HEAD-mismatch: 'y' proceeds, anything else aborts (default No).
assert_proceed "head-mismatch 'y' proceeds" confirm_head_mismatch <<< "y"
assert_abort   "head-mismatch 'n' aborts"   confirm_head_mismatch <<< "n"
assert_abort   "head-mismatch '' aborts"    confirm_head_mismatch <<< ""

# (4c) ★ the drop gate is NEVER auto-proceeded — typing 'yes' is the ONLY way through,
#      even with --yes set. This is the core safety guarantee.
assert_proceed "drop 'yes' proceeds"               confirm_drop <<< "yes"
assert_abort   "drop 'no' aborts"                  confirm_drop <<< "no"
ASSUME_YES=1
assert_abort   "drop ignores --yes ('no' aborts)"  confirm_drop <<< "no"
assert_abort   "drop ignores --yes ('' aborts)"    confirm_drop <<< ""
assert_proceed "drop still needs 'yes' under --yes" confirm_drop <<< "yes"
ASSUME_YES=0

echo
if [[ "${FAILS}" -eq 0 ]]; then
  green "ALL TESTS PASSED"
else
  red "${FAILS} TEST(S) FAILED"
fi
exit "$(( FAILS > 0 ? 1 : 0 ))"
