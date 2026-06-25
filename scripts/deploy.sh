#!/usr/bin/env bash
#
# scripts/deploy.sh — safe, repeatable deploy of infra/main.bicep to the live RG.
#
# Replaces the by-hand "what-if -> create -> check-what-landed" dance (run ~8x in 2 days,
# fumbled several times) with one command that keeps the SAFETY the manual review provided:
#   - never deploys without the @secure params (missing one WIPES a live secret),
#   - parses the what-if and HALTS on a real drop (deleted resource / removed job env key /
#     removed secret) while auto-proceeding through the documented benign what-if noise,
#   - survives the "Failed-but-landed" pattern (a late transient Postgres step fails the
#     deployment AFTER the jobs+image already rolled) by ALWAYS verifying what actually landed.
#
# This is a LOCAL helper Craig runs — not CD/automation. Scope: this script only.
#
# Usage:
#   scripts/deploy.sh                 # pick SHA, what-if (auto-proceed if clean / prompt on drop), deploy, verify
#   scripts/deploy.sh --what-if-only  # steps 1-4 only: show the classified diff, then stop
#   scripts/deploy.sh --sha <sha>     # override the image SHA (skip the HEAD/registry check)
#   scripts/deploy.sh --help
#
# Requires: az (logged in), jq, git, curl; psql for the DB check (provided via ~/.synthwatch.env PATH).
# Secrets (PG_PW, ACS_CONN) come from ~/.synthwatch.env and are passed INLINE to az — never logged.

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants — pinned to the live -e2 / eastus2 stack (see README "Re-running…").
# ---------------------------------------------------------------------------
readonly RG='synthwatch-rg'
readonly ACR='synthwatcholey0620'
readonly LOGIN_SERVER='synthwatcholey0620.azurecr.io'
readonly RUNNER_REPO='synthwatch-runner'
readonly MIGRATE_REPO='synthwatch-migrate'
readonly ENV_FILE="${HOME}/.synthwatch.env"
readonly EXPECTED_API_VERSION='2025-04-01-preview'   # the #93/#94 fix — must survive every deploy
readonly ACS_SECRET_REF='acs-email-conn'             # the runner ACS env's secretRef — the wipe canary
readonly API_HEALTH_URL='https://synthwatch-api.azurewebsites.net/api/checks'

# Jobs that reuse the runner image (so their deployed image == the intended SHA after a deploy).
readonly RUNNER_JOB='synthwatch-runner-job'
readonly NARRATIVE_JOB='synthwatch-narrative-job'
readonly RECONCILE_JOB='synthwatch-reconcile-job'

# Repo root, so the script works from any cwd.
ROOT="$(git rev-parse --show-toplevel)"
readonly ROOT
readonly TEMPLATE="${ROOT}/infra/main.bicep"

WHATIF_ONLY=0
SHA_OVERRIDE=''

# A temp file for the what-if JSON; cleaned up on exit. (@secure params are redacted by
# what-if, so this file never contains PG_PW/ACS_CONN — verified — but we still scope it tight.)
WHATIF_JSON=''
# shellcheck disable=SC2329  # invoked indirectly via the EXIT trap
cleanup() { [[ -n "${WHATIF_JSON}" && -f "${WHATIF_JSON}" ]] && rm -f "${WHATIF_JSON}"; }
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
c_red()   { printf '\033[31m%s\033[0m\n' "$*"; }
c_green() { printf '\033[32m%s\033[0m\n' "$*"; }
c_yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }
c_bold()  { printf '\033[1m%s\033[0m\n' "$*"; }

fail() { c_red "ERROR: $*" >&2; exit 1; }

usage() {
  sed -n '3,33p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

# ---------------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --what-if-only) WHATIF_ONLY=1; shift ;;
    --sha) [[ $# -ge 2 ]] || fail "--sha needs a value"; SHA_OVERRIDE="$2"; shift 2 ;;
    --help|-h) usage ;;
    *) fail "unknown arg: $1 (try --help)" ;;
  esac
done

# ---------------------------------------------------------------------------
# 1. Source env + FAIL FAST if a @secure value is missing (the wipe risk).
# ---------------------------------------------------------------------------
[[ -f "${ENV_FILE}" ]] || fail "${ENV_FILE} not found — needs PG_PW, ACS_CONN, DATABASE_URL."
# shellcheck source=/dev/null
source "${ENV_FILE}"
: "${PG_PW:?PG_PW is unset — refusing to deploy (a missing @secure param WIPES the Postgres secret). Set it in ${ENV_FILE}.}"
: "${ACS_CONN:?ACS_CONN is unset — refusing to deploy (a missing acsEmailConnectionString WIPES ACS email alerting). Set it in ${ENV_FILE}.}"

command -v az >/dev/null || fail "az CLI not found"
command -v jq >/dev/null || fail "jq not found"
[[ -f "${ROOT}/scripts/lib/whatif-halts.jq" ]] || fail "missing scripts/lib/whatif-halts.jq (the what-if classifier)"
az account show >/dev/null 2>&1 || fail "az not logged in (run: az login)"

# ---------------------------------------------------------------------------
# 2. Pick the image SHA.
#    The newest SHA-tagged runner image from the registry, time-desc. NOTE: --top 1 returns
#    the floating `latest` tag, so we filter to 40-hex commit tags and take the newest.
#    Then compare to main HEAD: if they differ (CI hasn't built HEAD yet — e.g. an infra-only
#    commit CI path-filters out), WARN and let the user decide. runner+migrate share the SHA.
# ---------------------------------------------------------------------------
pick_sha() {
  if [[ -n "${SHA_OVERRIDE}" ]]; then
    c_yellow "Using --sha override: ${SHA_OVERRIDE}" >&2
    printf '%s' "${SHA_OVERRIDE}"
    return
  fi

  local newest head
  newest="$(az acr repository show-tags -n "${ACR}" --repository "${RUNNER_REPO}" \
              --orderby time_desc -o tsv 2>/dev/null \
            | grep -E '^[0-9a-f]{40}$' | head -1 || true)"
  [[ -n "${newest}" ]] || fail "no SHA-tagged ${RUNNER_REPO} image found in ${ACR}."
  head="$(git rev-parse HEAD)"

  if [[ "${newest}" == "${head}" ]]; then
    c_green "Newest image == main HEAD (${newest:0:12}) — building from the current commit." >&2
  else
    c_yellow "WARN: newest image ${newest:0:12} is NOT main HEAD ${head:0:12}." >&2
    c_yellow "      CI may still be building HEAD, or HEAD is an infra/docs-only commit CI skips." >&2
    if [[ "${WHATIF_ONLY}" -eq 1 ]]; then
      c_yellow "      (--what-if-only: proceeding against the existing image ${newest:0:12}.)" >&2
    else
      printf '      Deploy the existing image %s? [y/N] ' "${newest:0:12}" >&2
      local ans; read -r ans
      [[ "${ans}" == "y" || "${ans}" == "Y" ]] || fail "aborted — no image for HEAD yet."
    fi
  fi

  # Soft check: the migrate image is built alongside the runner; warn if its SHA tag is absent.
  if ! az acr repository show-tags -n "${ACR}" --repository "${MIGRATE_REPO}" -o tsv 2>/dev/null \
        | grep -qx "${newest}"; then
    c_yellow "WARN: ${MIGRATE_REPO}:${newest:0:12} not found in registry — migrate image may lag." >&2
  fi

  printf '%s' "${newest}"
}

SHA="$(pick_sha)"
readonly SHA
readonly RUNNER_IMG="${LOGIN_SERVER}/${RUNNER_REPO}:${SHA}"
readonly MIGRATE_IMG="${LOGIN_SERVER}/${MIGRATE_REPO}:${SHA}"

# ---------------------------------------------------------------------------
# 3. Run the what-if (structured JSON via --no-pretty-print). Secrets passed inline.
# ---------------------------------------------------------------------------
WHATIF_JSON="$(mktemp -t synthwatch-whatif.XXXXXX)"

run_whatif() {
  c_bold "Running what-if (image ${SHA:0:12})…" >&2
  az deployment group what-if \
    -g "${RG}" -n "whatif-$(date -u +%Y%m%d-%H%M%S)" \
    --template-file "${TEMPLATE}" \
    --no-pretty-print \
    --parameters \
        postgresAdminPassword="${PG_PW}" \
        acsEmailConnectionString="${ACS_CONN}" \
        runnerImage="${RUNNER_IMG}" \
        migrateImage="${MIGRATE_IMG}" \
    > "${WHATIF_JSON}" 2>/dev/null \
    || fail "what-if call failed (az error)."
  jq -e '.changes' "${WHATIF_JSON}" >/dev/null 2>&1 \
    || fail "what-if output has no .changes (unexpected format)."
}

# ---------------------------------------------------------------------------
# 4. Classify the what-if — the load-bearing safety logic.
#
#    Walks each change's nested delta tree into full dotted property paths, then:
#
#    HALT-WORTHY (a real drop):
#      - resource-level changeType == "Delete"               (a resource is being deleted)
#      - a property Delete whose path hits an `env` segment   (a job env KEY is removed —
#        e.g. AZURE_OPENAI_API_VERSION / ACS secretRef / AZURE_CLIENT_ID / DATABASE_URL)
#      - a property Delete whose path hits a `secrets` segment (a secret/secretRef removed)
#
#    KNOWN BENIGN NOISE (do NOT halt — documented what-if false positives):
#      - registry `server` string -> reference(...) representation (a Modify, same value)
#      - AZURE_CLIENT_ID literal GUID -> reference(...).clientId  (a Modify, #90 self-correcting form)
#      - Postgres undeclared-default Deletes: properties.dataEncryption/network/replica/
#        replicationRole/storage.{tier,iops,autoGrow} — shown as "-" but not real removals
#      - managedEnvironment peerAuthentication/peerTrafficConfiguration "-"
#      - blobServices/container deleteRetentionPolicy/defaultEncryptionScope/
#        denyEncryptionScopeOverride "-"
#      - roleAssignment principalId/principalType representation
#
#    THE DISCRIMINATOR: a HALT is a JOB ENV LOSING A KEY, a RESOURCE DELETED, or a SECRET
#    REMOVED — i.e. a Delete UNDER an `env`/`secrets` path, or a resource Delete. A property
#    representation change (Modify) or an undeclared-default on a non-env/secrets path is benign.
#    The benign Deletes never sit under env/secrets, so the path test cleanly separates them.
#    When genuinely ambiguous we lean to HALT — a false halt costs one 'yes'; a false
#    auto-proceed costs a wiped secret.
# ---------------------------------------------------------------------------
readonly JQ_HALTS_FILE="${ROOT}/scripts/lib/whatif-halts.jq"

classify_whatif() {
  # Halt findings (empty == clean). The classifier lives in its own .jq file so the unit
  # test (scripts/deploy_test.sh) exercises the exact program shipped here.
  HALTS="$(jq -r -f "${JQ_HALTS_FILE}" "${WHATIF_JSON}")"
  # Summary counts + the list of creates (informational, not a halt).
  SUMMARY="$(jq -r '[.changes[].changeType] | group_by(.) | map("\(length) \(.[0])") | join(", ")' "${WHATIF_JSON}")"
  CREATES="$(jq -r '.changes[] | select(.changeType=="Create") | "  + create " + (.resourceId|split("/")|.[-2:]|join("/"))' "${WHATIF_JSON}")"
}

# ---------------------------------------------------------------------------
# 5. Deploy (timestamped name). Secrets inline. Exit code is NOT trusted (see step 6).
# ---------------------------------------------------------------------------
do_deploy() {
  local name
  name="synthwatch-deploy-$(date -u +%Y%m%d-%H%M%S)"
  c_bold "Deploying ${name} (image ${SHA:0:12})…"
  set +e
  az deployment group create \
    -g "${RG}" -n "${name}" \
    --template-file "${TEMPLATE}" \
    --parameters \
        postgresAdminPassword="${PG_PW}" \
        acsEmailConnectionString="${ACS_CONN}" \
        runnerImage="${RUNNER_IMG}" \
        migrateImage="${MIGRATE_IMG}" \
    -o none
  DEPLOY_RC=$?
  set -e
  if [[ "${DEPLOY_RC}" -eq 0 ]]; then
    c_green "az create reported success."
  else
    c_yellow "az create reported FAILURE (rc=${DEPLOY_RC}). This is often the 'Failed-but-landed'"
    c_yellow "pattern (a late transient Postgres step fails AFTER jobs+image rolled). Verifying what"
    c_yellow "actually landed regardless…"
  fi
}

# ---------------------------------------------------------------------------
# 7. Verify what LANDED (always runs, even if create 'Failed'). Non-zero exit on any failure.
# ---------------------------------------------------------------------------
VERIFY_FAILS=0
pass() { c_green "  PASS  $*"; }
flunk() { c_red   "  FAIL  $*"; VERIFY_FAILS=$((VERIFY_FAILS + 1)); }
# check <ok-bool> <message> : pass if first arg is "1", else flunk. Avoids the A&&B||C trap.
check() { if [[ "$1" == "1" ]]; then pass "$2"; else flunk "$2"; fi; }

job_env_value() {  # job, env-name -> value (empty if absent)
  az containerapp job show -n "$1" -g "${RG}" \
    --query "properties.template.containers[0].env[?name=='$2'].value | [0]" -o tsv 2>/dev/null || true
}
job_env_secretref() {  # job, env-name -> secretRef (empty if absent)
  az containerapp job show -n "$1" -g "${RG}" \
    --query "properties.template.containers[0].env[?name=='$2'].secretRef | [0]" -o tsv 2>/dev/null || true
}
job_image() {  # job -> image
  az containerapp job show -n "$1" -g "${RG}" \
    --query "properties.template.containers[0].image" -o tsv 2>/dev/null || true
}

verify() {
  c_bold "Verifying what landed…"

  # AOAI api-version preserved on runner + narrative (the #93/#94 defect).
  local v ok
  v="$(job_env_value "${RUNNER_JOB}" AZURE_OPENAI_API_VERSION)"
  [[ "${v}" == "${EXPECTED_API_VERSION}" ]] && ok=1 || ok=0
  check "${ok}" "${RUNNER_JOB} AZURE_OPENAI_API_VERSION='${v}' (expect ${EXPECTED_API_VERSION})"
  v="$(job_env_value "${NARRATIVE_JOB}" AZURE_OPENAI_API_VERSION)"
  [[ "${v}" == "${EXPECTED_API_VERSION}" ]] && ok=1 || ok=0
  check "${ok}" "${NARRATIVE_JOB} AZURE_OPENAI_API_VERSION='${v}' (expect ${EXPECTED_API_VERSION})"

  # ACS secretRef present on the runner job (the recurring email-wipe defect).
  v="$(job_env_secretref "${RUNNER_JOB}" ACS_EMAIL_CONNECTION_STRING)"
  [[ "${v}" == "${ACS_SECRET_REF}" ]] && ok=1 || ok=0
  check "${ok}" "${RUNNER_JOB} ACS_EMAIL_CONNECTION_STRING secretRef='${v}' (expect ${ACS_SECRET_REF})"

  # AZURE_CLIENT_ID present where expected (MI pin; #90).
  local j
  for j in "${RUNNER_JOB}" "${NARRATIVE_JOB}" "${RECONCILE_JOB}"; do
    v="$(job_env_value "${j}" AZURE_CLIENT_ID)"
    [[ -n "${v}" ]] && ok=1 || ok=0
    check "${ok}" "${j} AZURE_CLIENT_ID present (or job absent)"
  done

  # Deployed image SHA matches intent (runner job).
  local img
  img="$(job_image "${RUNNER_JOB}")"
  [[ "${img}" == "${RUNNER_IMG}" ]] && ok=1 || ok=0
  check "${ok}" "${RUNNER_JOB} image='${img##*:}' (expect ${SHA})"

  # Postgres reachable.
  if command -v psql >/dev/null 2>&1 && psql "${DATABASE_URL:-}" -tAc 'SELECT 1' >/dev/null 2>&1; then
    pass "Postgres SELECT 1"
  else
    flunk "Postgres SELECT 1 (psql missing, or DB unreachable — check client-IP firewall / DATABASE_URL)"
  fi

  # API health.
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${API_HEALTH_URL}" 2>/dev/null || true)"
  [[ "${code}" == "200" ]] && ok=1 || ok=0
  check "${ok}" "API ${API_HEALTH_URL} -> '${code}' (expect 200)"

  echo
  if [[ "${VERIFY_FAILS}" -eq 0 ]]; then
    c_green "VERIFY: all checks passed."
  else
    c_red "VERIFY: ${VERIFY_FAILS} check(s) FAILED."
  fi
}

# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------
main() {
  run_whatif
  classify_whatif

  echo
  c_bold "What-if summary: ${SUMMARY}"
  [[ -n "${CREATES}" ]] && echo "${CREATES}"

  if [[ -n "${HALTS}" ]]; then
    echo
    c_red "HALT — the what-if shows a real DROP (not benign noise):"
    # Pretty-print the tab-separated halt lines.
    while IFS=$'\t' read -r kind res path; do
      c_red "  ✗ ${kind}: ${res}${path:+  [${path}]}"
    done <<< "${HALTS}"
  else
    c_green "No drops detected — only modifies / creates / benign representation noise."
  fi

  if [[ "${WHATIF_ONLY}" -eq 1 ]]; then
    echo
    c_bold "--what-if-only: stopping before deploy."
    [[ -n "${HALTS}" ]] && exit 3 || exit 0
  fi

  if [[ -n "${HALTS}" ]]; then
    echo
    c_yellow "A drop was flagged above. Review it. To deploy anyway, type 'yes':"
    printf '  > '
    local ans; read -r ans
    [[ "${ans}" == "yes" ]] || fail "aborted — drop not confirmed."
  else
    c_green "Clean what-if — proceeding to deploy."
  fi

  do_deploy
  echo
  verify
  exit "$(( VERIFY_FAILS > 0 ? 1 : 0 ))"
}

main
