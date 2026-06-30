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
# The deploy TARGET is origin/main, NOT local HEAD. The script `git fetch`es first and derives the
# target from origin/main — the CI-built, deployable truth — so a drifted local checkout (stale, or an
# orphan local commit never pushed/built) neither blocks the deploy nor needs manual git surgery. It
# NEVER touches the working tree: it warns if local differs and deploys origin/main regardless.
#
# The newest-image≠target check is SMART: if the target's commits since the newest image touch only
# infra/docs/scripts (no runner build expected), it PROCEEDS silently; but if the target touches RUNNER
# CODE (or db/, or an unclassifiable path) since the newest DEPLOYABLE image — meaning CI is still
# building the target's image or its build failed — it HALTS. It never silently ships an image that
# predates the target's runner code, because that applies the target's DB migrations WITHOUT the matching
# code (the DB-ahead-of-code half-state). The escape hatch is --sha (deploy a specific fully-built pair).
#
# Usage:
#   scripts/deploy.sh                 # pick SHA, what-if (auto-proceed if clean / prompt on drop), deploy, verify
#   scripts/deploy.sh --what-if-only  # steps 1-4 only: show the classified diff, then stop (PREVIEWS even a stale image)
#   scripts/deploy.sh --yes | -y      # accepted for back-compat, now a NO-OP. It can NOT bypass a
#                                     #   what-if DROP halt NOR a stale-runner-image halt (HEAD's runner
#                                     #   code has no built image). For the latter, use --sha.
#   scripts/deploy.sh --sha <sha>     # override the image SHA (skip the HEAD/registry check)
#   scripts/deploy.sh --post-reconcile # after deploy+verify: trigger the reconcile job, WAIT,
#                                     #   then print spec_catalog + reconcile_drift (no manual sleep).
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

# Jobs that reuse the RUNNER image (their deployed image == the intended SHA after a deploy).
readonly RUNNER_JOB='synthwatch-runner-job'
readonly CENTRALUS_RUNNER_JOB='synthwatch-runner-job-centralus'
readonly WESTUS2_RUNNER_JOB='synthwatch-runner-job-westus2'   # 3rd region (2-of-3 quorum)
readonly NARRATIVE_JOB='synthwatch-narrative-job'
readonly ROLLUP_JOB='synthwatch-rollup-job'
readonly RECONCILE_JOB='synthwatch-reconcile-job'
# The migrate job runs on the MIGRATE image (its own repo, same SHA) and applies migrations.
readonly MIGRATE_JOB='synthwatch-migrate-job'
# Every job that should be on the runner image after a deploy (verify checks each — BUG 2).
readonly RUNNER_IMAGE_JOBS=(
  "${RUNNER_JOB}" "${CENTRALUS_RUNNER_JOB}" "${WESTUS2_RUNNER_JOB}" "${NARRATIVE_JOB}" "${ROLLUP_JOB}" "${RECONCILE_JOB}"
)

# Repo root, so the script works from any cwd.
ROOT="$(git rev-parse --show-toplevel)"
readonly ROOT
readonly TEMPLATE="${ROOT}/infra/main.bicep"

WHATIF_ONLY=0
POST_RECONCILE=0
SHA_OVERRIDE=''
# The deploy TARGET commit — derived from origin/main (the CI-built, deployable truth), NOT local HEAD.
# Set by sync_target_to_origin(); read by pick_sha(). Empty under --sha (override skips the sync).
TARGET_HEAD=''

# Pure, testable helpers (path classifier + the confirmation gates). Shared with deploy_test.sh.
[[ -f "${ROOT}/scripts/lib/deploy-lib.sh" ]] || { echo "missing scripts/lib/deploy-lib.sh" >&2; exit 1; }
# shellcheck source=scripts/lib/deploy-lib.sh disable=SC1091
source "${ROOT}/scripts/lib/deploy-lib.sh"

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
  sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

# ---------------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --what-if-only) WHATIF_ONLY=1; shift ;;
    # Accepted for back-compat; NO-OP. The newest-image≠HEAD case is now a hard HALT (never silently
    # ship runner code that predates HEAD), a what-if DROP still needs a typed 'yes', and a stale
    # image is overridden only with --sha — so there is nothing left for --yes to auto-proceed.
    --yes|-y) shift ;;
    --post-reconcile) POST_RECONCILE=1; shift ;;
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
#    Then reconcile with main HEAD — but SMARTLY (see mismatch_verdict + deploy_action_for_mismatch):
#    an infra/docs-only HEAD legitimately has no new image and PROCEEDS silently; a runner-code
#    mismatch (or one we can't classify) HALTS a real deploy — never ship an image that predates
#    HEAD's runner code (DB-ahead-of-code). runner+migrate share the SHA.
# ---------------------------------------------------------------------------

# mismatch_verdict <image_sha> <head_sha> -> "benign" | "prompt" | "unresolved".
#   benign     — HEAD's diff vs the image touches only non-image-producing paths.
#   prompt     — diff touches runner code, or an unclassifiable path (conservative).
#   unresolved — the image SHA isn't a resolvable ancestor of HEAD (diverged / force-push /
#                shallow clone) or git diff failed; we can't reason, so fall back to prompting.
mismatch_verdict() {
  local img="$1" head="$2" changed
  git rev-parse -q --verify "${img}^{commit}" >/dev/null 2>&1 || { echo "unresolved"; return; }
  git merge-base --is-ancestor "${img}" "${head}" 2>/dev/null || { echo "unresolved"; return; }
  changed="$(git diff --name-only "${img}" "${head}" 2>/dev/null)" || { echo "unresolved"; return; }
  printf '%s\n' "${changed}" | classify_paths
}

# repo_sha_tags <repo> -> newline list of 40-hex commit tags, newest first.
repo_sha_tags() {
  az acr repository show-tags -n "${ACR}" --repository "$1" --orderby time_desc -o tsv 2>/dev/null \
    | grep -E '^[0-9a-f]{40}$' || true
}

pick_sha() {
  local runner_tags migrate_tags
  runner_tags="$(repo_sha_tags "${RUNNER_REPO}")"
  migrate_tags="$(repo_sha_tags "${MIGRATE_REPO}")"

  if [[ -n "${SHA_OVERRIDE}" ]]; then
    # ★ BUG 1: even an explicit SHA must exist in BOTH repos, or the deploy half-applies.
    c_yellow "Using --sha override: ${SHA_OVERRIDE}" >&2
    printf '%s\n' "${runner_tags}"  | grep -qxF "${SHA_OVERRIDE}" \
      || fail "${RUNNER_REPO}:${SHA_OVERRIDE:0:12} not in registry — nothing to deploy."
    printf '%s\n' "${migrate_tags}" | grep -qxF "${SHA_OVERRIDE}" \
      || fail "${MIGRATE_REPO}:${SHA_OVERRIDE:0:12} not in registry — would split runner/migrate. Refusing."
    printf '%s' "${SHA_OVERRIDE}"
    return
  fi

  # ★ BUG 1 root cause: the runner & migrate images are built together, but a deploy can be
  # run while only the runner image of the newest commit has been pushed (CI mid-build). The
  # old code picked the newest RUNNER tag and only soft-warned if migrate:SHA was missing —
  # so the deploy set migrate to a not-yet-pushed tag, that resource update failed, and the
  # migrate job stayed on the OLD image (today's split: runner 3106bc7 / migrate 1ff07902).
  # FIX: pick the newest SHA present in BOTH repos, so both image params always resolve to a
  # real, fully-built pair. Both bicep params then derive from this one SHA (below).
  local runner_newest newest head
  runner_newest="$(printf '%s\n' "${runner_tags}" | head -1)"
  [[ -n "${runner_newest}" ]] || fail "no SHA-tagged ${RUNNER_REPO} image found in ${ACR}."
  newest="$(newest_common_sha "${runner_tags}" "${migrate_tags}" || true)"
  [[ -n "${newest}" ]] || fail "no SHA tag present in BOTH ${RUNNER_REPO} and ${MIGRATE_REPO}."
  if [[ "${newest}" != "${runner_newest}" ]]; then
    c_yellow "WARN: newest runner image ${runner_newest:0:12} has no matching ${MIGRATE_REPO} image" >&2
    c_yellow "      yet (CI likely mid-build); using the newest COMPLETE pair ${newest:0:12} instead." >&2
  fi
  # The TARGET is origin/main (sync_target_to_origin set TARGET_HEAD), NOT local HEAD — local main drifts
  # (stale, or an orphan local commit with no image). All #135 guards below operate on this target.
  head="${TARGET_HEAD}"

  if [[ "${newest}" == "${head}" ]]; then
    c_green "Newest image == origin/main (${newest:0:12}) — that commit is built." >&2
  else
    local verdict; verdict="$(mismatch_verdict "${newest}" "${head}")"
    if [[ "${verdict}" == "benign" ]]; then
      # EXPECTED: HEAD didn't change runner code, so CI built no new image. Proceed silently.
      c_green "INFO: HEAD (${head:0:12}) is infra/docs-only since the newest image (${newest:0:12});" >&2
      c_green "      deploying ${newest:0:12} — this is normal for an infra/config deploy." >&2
    else
      # AMBIGUOUS (runner code changed / unclassifiable) or UNRESOLVED — REFUSE a real deploy.
      if [[ "${verdict}" == "unresolved" ]]; then
        c_yellow "WARN: newest image ${newest:0:12} is NOT origin/main ${head:0:12}, and I can't classify" >&2
        c_yellow "      why (image SHA not an ancestor of HEAD? diverged / shallow clone)." >&2
      else
        c_yellow "WARN: newest image ${newest:0:12} is NOT origin/main ${head:0:12}, and HEAD touches runner" >&2
        c_yellow "      code since that image — CI may still be building, or a build failed." >&2
      fi
      case "$(deploy_action_for_mismatch "${verdict}" "${WHATIF_ONLY}")" in
        preview)
          c_yellow "      (--what-if-only: PREVIEWING against ${newest:0:12} — NOT what a real deploy would ship.)" >&2
          ;;
        halt)
          # ★ REFUSE — never silently ship a runner image that predates HEAD's runner code. Deploying
          # ${newest} would apply HEAD's DB migrations WITHOUT the matching runner code (the
          # DB-ahead-of-code half-state that paged ft=1 monitors with no retry absorption). This is a
          # HALT, not a prompt: --yes does NOT bypass it (like a what-if drop). Escape hatch: --sha.
          if [[ "${runner_newest}" == "${head}" ]]; then
            fail "refusing to deploy STALE runner code: HEAD's runner image ${head:0:12} IS built, but its ${MIGRATE_REPO} pair isn't pushed yet (CI mid-build), so the newest COMPLETE pair is the OLDER ${newest:0:12} — deploying it would apply HEAD's migrations without the matching runner code. Wait for CI to finish building ${head:0:12} (runner AND migrate), then re-run; or --sha <sha> to deploy a specific fully-built pair."
          else
            fail "refusing to deploy STALE runner code: the newest deployable image ${newest:0:12} PREDATES HEAD's runner code ${head:0:12} (CI may still be building ${head:0:12}, or its build failed) — deploying it would apply HEAD's DB migrations without the matching runner code (DB-ahead-of-code). Wait for CI, or --sha <sha> to deploy a specific fully-built pair."
          fi
          ;;
      esac
    fi
  fi

  # (Both images for ${newest} are guaranteed present — newest_common_sha required it.)
  printf '%s' "${newest}"
}

# ---------------------------------------------------------------------------
# Sync the deploy TARGET to origin/main — the CI-built, deployable truth. We deploy what is on ORIGIN,
# not local HEAD: local main drifts (stale and needs a pull, or carries an orphan local commit never
# pushed/built — which has NO image, so deriving the target from it would falsely HALT #135's "no image
# for HEAD"). ★ We NEVER touch the working tree (no reset/checkout): target origin/main, WARN if local
# differs, leave local commits untouched. Sets TARGET_HEAD, which pick_sha uses as `head`.
# ---------------------------------------------------------------------------
sync_target_to_origin() {
  c_bold "Fetching origin (the deploy target is origin/main, not local HEAD)…" >&2
  git fetch --quiet origin 2>/dev/null \
    || c_yellow "WARN: 'git fetch origin' failed — using the last-fetched origin/main (it may be stale)." >&2
  local origin_head local_head state
  origin_head="$(git rev-parse origin/main 2>/dev/null)" \
    || fail "cannot resolve origin/main — is the 'origin' remote configured with a 'main' branch?"
  local_head="$(git rev-parse HEAD 2>/dev/null || echo '')"
  state="$(git_drift_state "${local_head}" "${origin_head}")"
  case "${state}" in
    same)
      c_green "Local main == origin/main (${origin_head:0:12}) — deploying that." >&2 ;;
    behind)
      c_yellow "NOTE: local main is BEHIND origin/main — deploying origin/main ${origin_head:0:12}." >&2
      c_yellow "      (Your checkout is stale; 'git pull' to catch up — not required, the deploy targets origin.)" >&2 ;;
    diverged)
      # local has commit(s) NOT on origin (e.g. an orphan never pushed). DO NOT reset — IGNORE them.
      c_yellow "WARN: local main has commit(s) NOT on origin/main — IGNORING them; deploying origin/main ${origin_head:0:12}:" >&2
      git log --oneline origin/main..HEAD 2>/dev/null | sed 's/^/        local-only (untouched): /' >&2 || true
      c_yellow "      (Push + let CI build a local commit to deploy it, or use --sha. Your tree is left as-is.)" >&2 ;;
  esac
  TARGET_HEAD="${origin_head}"
}

# Derive the target from origin/main (unless --sha overrides the whole pick). --sha is the manual escape
# hatch and bypasses the origin sync entirely.
if [[ -z "${SHA_OVERRIDE}" ]]; then
  sync_target_to_origin
fi

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
EXPECTED_MIGRATIONS=''   # set by handle_migrations: versions the deploy range shipped (BUG 3)
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

  # ★ BUG 2: EVERY job must be on the intended image — not just the runner job. A correct
  # deploy puts the migrate job on migrate:SHA and every other job on runner:SHA. The old
  # verify only checked the runner job, so today's split (migrate stuck on the old SHA while
  # runner rolled) PASSED verify and 0032 silently didn't apply. Build a job->image map and
  # diff it against the intended images; any mismatch (or an absent/unreadable job) fails.
  local map="" j img mism
  for j in "${RUNNER_IMAGE_JOBS[@]}" "${MIGRATE_JOB}"; do
    img="$(job_image "${j}")"
    map+="${j}"$'\t'"${img}"$'\n'
  done
  mism="$(printf '%s' "${map}" | image_mismatches "${RUNNER_IMG}" "${MIGRATE_IMG}")"
  if [[ -z "${mism}" ]]; then
    pass "all jobs on image ${SHA:0:12} (runner+migrate+narrative+rollup+reconcile+centralus)"
  else
    while IFS= read -r j; do
      [[ -z "${j}" ]] && continue
      flunk "${j} image='$(job_image "${j}" | sed 's#.*/##')' (expect ${SHA:0:12})"
    done <<< "${mism}"
  fi

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

  # ★ BUG 3: if the deploy shipped migration(s), CONFIRM each is recorded in
  # schema_migrations (the migrate job ran them). This is what turns "migrate job exited 0"
  # into "0032 actually applied".
  if [[ -n "${EXPECTED_MIGRATIONS}" ]]; then
    local mig n
    while IFS= read -r mig || [[ -n "${mig}" ]]; do
      [[ -z "${mig}" ]] && continue
      if command -v psql >/dev/null 2>&1; then
        n="$(psql "${DATABASE_URL:-}" -tAc \
              "SELECT 1 FROM schema_migrations WHERE version='${mig}'" 2>/dev/null || true)"
        [[ "${n}" == "1" ]] && ok=1 || ok=0
        check "${ok}" "migration ${mig} recorded in schema_migrations"
      else
        flunk "migration ${mig} unverified — psql not on PATH"
      fi
    done <<< "${EXPECTED_MIGRATIONS}"
  fi

  echo
  if [[ "${VERIFY_FAILS}" -eq 0 ]]; then
    c_green "VERIFY: all checks passed."
  else
    c_red "VERIFY: ${VERIFY_FAILS} check(s) FAILED."
  fi
}

# ---------------------------------------------------------------------------
# 6b. Migration handling (BUG 3). The migrate job is Manual-trigger, so a deploy that ships
#     a new migration does NOT apply it unless the job is separately started — today 0032
#     silently didn't apply until a manual `job start`. We CHOSE option (a): auto-run the
#     migrate job when the deploy's git range adds a db/migrations/ file, then wait + confirm.
#     Justified: migrate.sh is idempotent (IF NOT EXISTS / only applies UNAPPLIED versions),
#     the migrate job is the designated mechanism, and applying the migration the new code
#     expects IS part of a correct deploy. It's gated on detection so it only fires when a
#     migration actually shipped; the apply is the same safe step CD runs on merge.
# ---------------------------------------------------------------------------
job_image_sha() { job_image "$1" | sed 's/.*://'; }   # job -> just the :SHA tag

# Re-point the migrate job to the intended migrate image (defensive: even if the bicep
# deploy's migrate update half-failed, this guarantees we run the RIGHT migration set — the
# OLD image wouldn't contain the new migration), then start a one-off execution and poll to a
# terminal state (mirrors .github/workflows/deploy.yml). 0 = Succeeded.
start_and_wait_migrate() {
  local exec_name status _
  az containerapp job update -n "${MIGRATE_JOB}" -g "${RG}" --image "${MIGRATE_IMG}" -o none 2>/dev/null \
    || { c_red "  could not point ${MIGRATE_JOB} at ${MIGRATE_IMG##*/}"; return 1; }
  exec_name="$(az containerapp job start -n "${MIGRATE_JOB}" -g "${RG}" --query name -o tsv 2>/dev/null)" \
    || { c_red "  could not start ${MIGRATE_JOB}"; return 1; }
  c_bold "  started ${MIGRATE_JOB} execution ${exec_name}; polling…"
  for _ in $(seq 1 60); do
    status="$(az containerapp job execution show -n "${MIGRATE_JOB}" -g "${RG}" \
                --job-execution-name "${exec_name}" --query properties.status -o tsv 2>/dev/null || true)"
    case "${status}" in
      Succeeded) c_green "  ${MIGRATE_JOB} Succeeded."; return 0 ;;
      Failed|Degraded|Cancelled) c_red "  ${MIGRATE_JOB} ended: ${status}."; return 1 ;;
    esac
    sleep 10
  done
  c_red "  ${MIGRATE_JOB} did not finish within timeout."
  return 1
}

# The migration "versions" present on disk (db/migrations/*.sql basenames, no .sql).
migration_versions_on_disk() {
  local f
  for f in "${ROOT}"/db/migrations/*.sql; do
    [[ -e "${f}" ]] || continue
    f="${f##*/}"
    echo "${f%.sql}"
  done
}

# run_unapplied_via_schema_migrations: FIX 1 fallback. Git-independent — query schema_migrations
# for the applied set, diff against the migration files on disk (unapplied_versions), and run the
# (idempotent) migrate job if any file is unapplied. Used when the git range can't decide.
run_unapplied_via_schema_migrations() {
  local applied present unapplied
  applied="$(psql "${DATABASE_URL:-}" -tA -c 'SELECT version FROM schema_migrations' 2>/dev/null || true)"
  present="$(migration_versions_on_disk)"
  unapplied="$(printf '%s' "${present}" | unapplied_versions "${applied}")"
  if [[ -z "${unapplied}" ]]; then
    c_green "  schema_migrations: every on-disk migration is already applied — migrate job not needed."
    return
  fi
  EXPECTED_MIGRATIONS="${unapplied}"
  c_bold "  unapplied migration(s) per schema_migrations: $(printf '%s' "${unapplied}" | tr '\n' ' ')"
  start_and_wait_migrate || c_red "  migrate job did not succeed — migrations may NOT be applied (verify will flag)."
}

# handle_migrations <prev_sha> <new_sha>: auto-detect + run shipped migrations.
#  FAST PATH — a RESOLVABLE, NON-DEGENERATE git range: detect via git diff (cheap, precise).
#  ★ FIX 1 — when the range is DEGENERATE (prev==new) or UNRESOLVABLE (failed pull / shallow /
#  diverged), git can't tell us what shipped, so fall back to a GIT-INDEPENDENT check against
#  schema_migrations (run_unapplied_via_schema_migrations). A live deploy hit the degenerate
#  SHA..SHA case and got a "apply manually" warning — defeating the auto-apply exactly when git
#  state was confused. Now it auto-applies regardless (migrate.sh is idempotent, so safe).
# Sets EXPECTED_MIGRATIONS so verify confirms they landed.
handle_migrations() {
  local prev="$1" new="$2" migs
  c_bold "Migration handling…"

  if [[ -n "${prev}" && "${prev}" != "${new}" ]] \
     && git rev-parse -q --verify "${prev}^{commit}" >/dev/null 2>&1 \
     && git rev-parse -q --verify "${new}^{commit}" >/dev/null 2>&1; then
    # Fast path: a real, resolvable range.
    migs="$(git diff --name-only "${prev}" "${new}" 2>/dev/null | migrations_in_diff)"
    if [[ -n "${migs}" ]]; then
      EXPECTED_MIGRATIONS="${migs}"
      c_bold "  deploy shipped migration(s) [git range]: $(printf '%s' "${migs}" | tr '\n' ' ')"
      start_and_wait_migrate || c_red "  migrate job did not succeed — migrations may NOT be applied (verify will flag)."
      return
    fi
    c_green "  no new migrations in ${prev:0:12}..${new:0:12} — migrate job not needed."
    return
  fi

  # ★ FIX 1: degenerate (prev==new) or unresolvable range -> git-independent schema_migrations check.
  c_yellow "  deploy range degenerate/unresolvable (${prev:0:12}..${new:0:12}) — checking schema_migrations directly…"
  run_unapplied_via_schema_migrations
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
    c_yellow "A drop was flagged above. Review it carefully."
    # ★ confirm_drop ignores --yes by design: a drop is NEVER auto-proceeded.
    confirm_drop || fail "aborted — drop not confirmed."
  else
    c_green "Clean what-if — proceeding to deploy."
  fi

  # Baseline BEFORE deploy: the runner job's current image SHA defines the migration range.
  local prev_sha; prev_sha="$(job_image_sha "${RUNNER_JOB}")"

  do_deploy
  echo
  handle_migrations "${prev_sha}" "${SHA}"   # BUG 3 + FIX 1: auto-run the migrate job if one shipped
  echo
  verify                                       # BUG 2: every job's image; + migration-applied

  # ★ FIX 2: --post-reconcile — trigger the reconcile job, wait, print the post-deploy state
  # (spec_catalog + reconcile_drift) so the operator sees it without manually sleeping/re-querying.
  if [[ "${POST_RECONCILE}" -eq 1 ]]; then
    echo
    c_bold "Post-reconcile (--post-reconcile)…"
    post_reconcile || c_red "post-reconcile reported a problem (see above)."
  fi

  exit "$(( VERIFY_FAILS > 0 ? 1 : 0 ))"
}

main
