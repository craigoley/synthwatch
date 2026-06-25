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
readonly RUNNER_SEL='.resourceId|test("synthwatch-runner-job$")'

[[ -f "${CLASSIFIER}" ]] || { echo "missing ${CLASSIFIER}" >&2; exit 1; }
[[ -f "${SAMPLE}" ]] || { echo "missing ${SAMPLE}" >&2; exit 1; }

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

echo
if [[ "${FAILS}" -eq 0 ]]; then
  green "ALL TESTS PASSED"
else
  red "${FAILS} TEST(S) FAILED"
fi
exit "$(( FAILS > 0 ? 1 : 0 ))"
