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
#   scripts/deploy.sh --no-wait       # on a stale-image halt (CI mid-build), refuse immediately instead
#                                     #   of WAITING for CI to finish building the target (the default).
#   scripts/deploy.sh --post-reconcile # after deploy+verify: trigger the reconcile job, WAIT,
#                                     #   then print spec_catalog + reconcile_drift (no manual sleep).
#   scripts/deploy.sh --sync          # NO-OP (back-compat): the tree is now fast-forwarded to origin/main at
#                                     #   the START of every run (a clean, behind main), so there's nothing
#                                     #   to sync afterward. A dirty or diverged tree aborts up front instead.
#   scripts/deploy.sh --help
#
# Requires: az (logged in), jq, git, curl; psql for the DB check (provided via ~/.synthwatch.env PATH).
# Secrets (PG_PW, ACS_CONN, VERCEL_BYPASS_TOKEN) come from ~/.synthwatch.env and are passed INLINE to az — never logged.

set -euo pipefail

# ---------------------------------------------------------------------------
# ★ bash-version guard — WHY THIS EXISTS: macOS ships bash 3.2 as /bin/bash, which `#!/usr/bin/env bash`
# resolves to on a Mac. A bash-4-only expansion (${var,,}) 'bad substitution's MID-VERIFY — the deploy
# then prints SUCCESS while a security gate (e.g. verify_sandbox_least_privilege) silently DID NOT RUN.
# Two layers of defense: (1) every construct in this script is audited 3.2-portable (no ${var,,}/${var^^}/
# mapfile/declare -A); (2) this guard re-execs under a modern bash if one is installed, so a FUTURE
# bash-4-ism can't silently skip a gate on the operator's default shell either. If no bash 4+ is found we
# CONTINUE (the script is 3.2-portable) but say so once — never silently, never blocking a fresh Mac.
# Same handover class as the esbuild-arm64 day-one trap.
# ---------------------------------------------------------------------------
if [ "${BASH_VERSINFO:-0}" -lt 4 ] && [ -z "${SW_DEPLOY_BASH_REEXEC:-}" ]; then
  _bash4=''
  for _cand in "$(command -v brew >/dev/null 2>&1 && printf '%s' "$(brew --prefix 2>/dev/null)/bin/bash")" \
               /opt/homebrew/bin/bash /usr/local/bin/bash; do
    [ -n "${_cand}" ] && [ -x "${_cand}" ] || continue
    _v="$("${_cand}" -c 'printf %s "${BASH_VERSINFO[0]}"' 2>/dev/null || printf 0)"
    if [ "${_v:-0}" -ge 4 ] 2>/dev/null; then _bash4="${_cand}"; break; fi
  done
  if [ -n "${_bash4}" ]; then
    export SW_DEPLOY_BASH_REEXEC=1
    exec "${_bash4}" "$0" "$@"
  fi
  printf '  note: running under bash %s — no bash 4+ found to re-exec under. This script is 3.2-portable, so\n' "${BASH_VERSION:-?}" >&2
  printf '        continuing; `brew install bash` is recommended so future bash-4 features can never skip a gate.\n' >&2
fi

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
readonly CRED_ENC_KEY_SECRET_REF='cred-enc-key'      # CRED_ENC_KEY secretRef — model-B value crypto (runner decrypt)
readonly API_HEALTH_URL='https://synthwatch-api.azurewebsites.net/api/checks'
readonly API_CRED_FP_URL='https://synthwatch-api.azurewebsites.net/api/cred-key/fingerprint'  # model-B key drift-check

# The runner-image jobs (RUNNER_JOB, CENTRALUS_RUNNER_JOB, WESTUS2_RUNNER_JOB, NARRATIVE_JOB, ROLLUP_JOB,
# RECONCILE_JOB) + the RUNNER_IMAGE_JOBS array now live in scripts/lib/deploy-lib.sh — the SINGLE SOURCE OF
# TRUTH that BOTH this script AND the unit test (deploy_test.sh) read, so the CD job list can't silently drift
# from it (deploy_test.sh asserts deploy.yml rolls EXACTLY this set). Sourced below; usages are all after that.
# The migrate job runs on the MIGRATE image (its own repo, same SHA) and applies migrations.
readonly MIGRATE_JOB='synthwatch-migrate-job'

# Repo root, so the script works from any cwd.
ROOT="$(git rev-parse --show-toplevel)"
readonly ROOT

# ★ START-OF-RUN SYNC — deploy.sh treats origin/main as authoritative for the template + image; it now does
# the SAME for its OWN working tree, so it ALWAYS runs current logic (and reads a current deploy-lib.sh /
# what-if classifier / db/migrations) BY CONSTRUCTION — no stale-detection, no manual `git reset` after every
# merge. Fetch, then fast-forward a CLEAN main to origin/main and RE-EXEC the now-current script. The re-exec
# is REQUIRED: a mid-run reset can't fix the RUNNING process — bash already parsed the old functions into
# memory. Guarded by SYNTHWATCH_DEPLOY_SYNCED so it runs ONCE (the re-exec'd process skips it). Runs BEFORE
# the lib is sourced / functions are parsed, using only plain git + echo (no lib deps yet).
# --help / -h is READ-ONLY — skip the sync entirely (no fetch, no tree mutation, no re-exec) so a docs lookup
# never touches the network or the working tree. --what-if-only DOES sync (it previews a real deploy, so it
# should run the CURRENT classifier logic). This runs before arg parsing, so match the raw args.
# Is the CURRENT branch fully merged into origin/main — i.e. is there NOTHING to lose by switching to main?
# Two signals, because --is-ancestor alone FALSE-NEGATIVES on a squash-merge (the squash is a NEW commit, so
# the branch tip isn't literally an ancestor of origin/main — the worktree recon hit exactly this):
#   • --is-ancestor HEAD origin/main → every commit is literally upstream (a normal merge / fast-forward).
#   • else `git cherry` PATCH-equivalence: it prints every commit not yet upstream with a leading '+'. NO '+'
#     line ⟹ every commit's PATCH is already in origin/main (a squash-merged linear branch) ⟹ nothing to lose;
#     ANY '+' ⟹ a commit whose patch is absent upstream = real unmerged/unpushed WORK → NOT safe.
# Caller guarantees a clean tree + a resolvable origin/main. ★ When in doubt, return non-zero (REFUSE): a false
# "safe" that discards work is far worse than a false refusal. The `git cherry` result is captured to a var and
# matched with a here-string (NOT a pipe) so there is no upstream writer to SIGPIPE under pipefail (#279/#283).
_branch_fully_merged() {
  local _root="$1" _cherry
  git -C "${_root}" merge-base --is-ancestor HEAD origin/main 2>/dev/null && return 0
  _cherry="$(git -C "${_root}" cherry origin/main HEAD 2>/dev/null)" || return 1
  if grep -q '^+' <<<"${_cherry}"; then return 1; fi  # a '+' line = an unmerged commit → NOT fully merged
  return 0
}

if [[ -z "${SYNTHWATCH_DEPLOY_SYNCED:-}" && " $* " != *" --help "* && " $* " != *" -h "* ]]; then
  _branch="$(git -C "${ROOT}" symbolic-ref --quiet --short HEAD || echo '(detached)')"
  # Fetch FIRST — origin/main must be current both to evaluate "is this branch fully merged?" below AND for the
  # on-main fast-forward that follows. A fetch on a path that ends up refusing is harmless (read-only).
  git -C "${ROOT}" fetch --quiet origin 2>/dev/null \
    || echo "deploy.sh: WARN 'git fetch origin' failed — proceeding against the last-fetched origin/main." >&2
  if [[ "${_branch}" != "main" ]]; then
    # Not on main. deploy.sh fast-forwards the tree to origin/main and re-execs, so it must NEVER strand work
    # you'd lose by leaving this branch. But a leftover retro/feature branch that is CLEAN and FULLY MERGED has
    # nothing to lose — refusing there is pure friction (the same class #273 removed by self-syncing main). So:
    # clean AND fully-merged → auto-checkout main and proceed; dirty OR unmerged/unpushed → REFUSE (as before).
    # "Dirty" = uncommitted changes to TRACKED files (untracked scratch survives a checkout, so it doesn't count).
    _dirty="$(git -C "${ROOT}" status --porcelain --untracked-files=no 2>/dev/null)"
    _om="$(git -C "${ROOT}" rev-parse origin/main 2>/dev/null || true)"
    if [[ -n "${_dirty}" ]]; then
      echo "deploy.sh: refusing to run on branch '${_branch}', not 'main' — it has UNCOMMITTED changes to tracked" >&2
      echo "  files (real work at risk; switching to main would strand them). Commit or stash, then re-run:" >&2
      echo "    git stash   (or git commit)   &&   ./scripts/deploy.sh" >&2
      exit 1
    elif [[ -z "${_om}" ]]; then
      # origin/main unresolvable (never fetched / offline first run) — can't PROVE the branch is merged.
      echo "deploy.sh: refusing to run on branch '${_branch}', not 'main' — cannot resolve origin/main to verify" >&2
      echo "  it is fully merged (fetch may have failed). Run 'git checkout main', then re-run." >&2
      exit 1
    elif _branch_fully_merged "${ROOT}"; then
      # Clean AND every commit already in origin/main (normal merge/ff via --is-ancestor, OR a squash-merge
      # caught by patch-equivalence). Nothing to lose → switch to main.
      git -C "${ROOT}" checkout --quiet main \
        || { echo "deploy.sh: 'git checkout main' failed — aborting rather than deploy from '${_branch}'." >&2; exit 1; }
      echo "deploy.sh: branch '${_branch}' is clean and fully merged into origin/main — switched to main." >&2
      # Re-exec so we run MAIN's deploy.sh: this process parsed the branch's (merged, possibly older) copy into
      # memory, and a mid-run checkout can't replace it — the same reason the fast-forward path re-execs (#273).
      # Do NOT set SYNTHWATCH_DEPLOY_SYNCED — the fresh process is now on main and runs the normal fetch +
      # fast-forward path from the top (which will pull main up to origin/main and re-exec once more if behind).
      exec bash "${ROOT}/scripts/deploy.sh" "$@"
    else
      echo "deploy.sh: refusing to run on branch '${_branch}', not 'main' — it has commit(s) NOT in origin/main" >&2
      echo "  (unpushed/unmerged work at risk). deploy.sh will NOT reset your branch. Push/merge it first, or run" >&2
      echo "  'git checkout main', then re-run." >&2
      exit 1
    fi
  fi
  _origin="$(git -C "${ROOT}" rev-parse origin/main 2>/dev/null || true)"
  _local="$(git -C "${ROOT}" rev-parse HEAD 2>/dev/null || true)"
  if [[ -n "${_origin}" && "${_local}" != "${_origin}" ]]; then
    if git -C "${ROOT}" merge-base --is-ancestor "${_local}" "${_origin}" 2>/dev/null; then
      # Local main is strictly BEHIND origin/main — a pure FAST-FORWARD (reset --hard only moves forward, no
      # committed work is lost). "Dirty" = uncommitted changes to TRACKED files; untracked files survive the
      # reset (scratch/analysis files are fine) so they don't block it — only real uncommitted WORK aborts,
      # never silently destroyed.
      if [[ -n "$(git -C "${ROOT}" status --porcelain --untracked-files=no 2>/dev/null)" ]]; then
        echo "deploy.sh: refusing to run — the tree is behind origin/main AND has uncommitted changes to" >&2
        echo "  TRACKED files. deploy.sh must run from origin/main; fast-forwarding would discard them." >&2
        echo "  Commit or stash, then re-run:   git stash   (or git commit)   &&   ./scripts/deploy.sh" >&2
        exit 1
      fi
      echo "deploy.sh: local main ${_local:0:12} is behind origin/main ${_origin:0:12} — fast-forwarding (clean tree)…" >&2
      git -C "${ROOT}" reset --hard origin/main >/dev/null 2>&1 \
        || { echo "deploy.sh: 'git reset --hard origin/main' failed — aborting rather than run a partially-synced tree." >&2; exit 1; }
      echo "deploy.sh: synced local main to origin/main ${_origin:0:12}; re-running with current logic…" >&2
      SYNTHWATCH_DEPLOY_SYNCED=1 exec bash "${ROOT}/scripts/deploy.sh" "$@"
    else
      # Local main has commit(s) NOT on origin/main (ahead / diverged / squash-merge leftover). NEVER
      # auto-reset — that could destroy real un-pushed work. Proceed against origin/main; the
      # belt-and-suspenders assert_deploy_scripts_current below ABORTS if the scripts are actually stale
      # (else this is a benign pre-squash leftover whose scripts already match origin).
      echo "deploy.sh: local main has commit(s) not on origin/main — NOT auto-syncing (preserving them);" >&2
      echo "  the deploy targets origin/main and the stale-script guard aborts if the scripts differ." >&2
    fi
  fi
  # Marked synced (behind→reset+reexec above already exited): already-current, diverged, or origin
  # unresolvable — nothing more to fast-forward this run.
  export SYNTHWATCH_DEPLOY_SYNCED=1
fi
# The infra template is deployed from the TARGET COMMIT (origin/main), NOT the working tree. The tree
# can be stale/behind — the BENIGN post-squash-merge state this script explicitly permits ("never touch
# the working tree", sync_target_to_origin) — and compiling ITS bicep would ship a PRE-merge template
# with the correct POST-merge image. That is the #250 replicaTimeout drift: origin/main=660, a behind
# working tree=240, `az create` reported success at 240, and the what-if (stale-template 240 vs live 240)
# showed "clean". TEMPLATE is materialized from the target by materialize_template() (below); the path is
# the source location WITHIN that commit.
readonly TEMPLATE_SRC_PATH="infra/main.bicep"
TEMPLATE=''  # materialized temp file (a real .bicep so az compiles it); set after the target is resolved

WHATIF_ONLY=0
POST_RECONCILE=0
SHA_OVERRIDE=''
# --sync is now a NO-OP (accepted for muscle-memory): the tree is fast-forwarded to origin/main at the START
# of every run (see the START-OF-RUN SYNC block above), so there is nothing to sync AFTER a deploy anymore.
# ★ FIX 3: when the newest deployable image PREDATES the target (CI mid-build), WAIT for CI to
# finish building the target then proceed, instead of erroring out + making the user re-run.
# Default ON; --no-wait restores the old immediate-refuse behavior. A CI FAILURE or a timeout
# still refuses (DB-ahead-of-code is never auto-shipped).
WAIT_FOR_CI=1
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
# Temp DIR holding the materialized target-commit template (a dir so the file keeps its .bicep name,
# which az needs to compile it as bicep — and so any future sibling module is materialized alongside it).
TEMPLATE_DIR=''
# shellcheck disable=SC2329  # invoked indirectly via the EXIT trap
cleanup() {
  [[ -n "${WHATIF_JSON}" && -f "${WHATIF_JSON}" ]] && rm -f "${WHATIF_JSON}"
  [[ -n "${TEMPLATE_DIR}" && -d "${TEMPLATE_DIR}" ]] && rm -rf "${TEMPLATE_DIR}"
  return 0
}
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
  sed -n '3,45p' "$0" | sed 's/^# \{0,1\}//'
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
    --sync) c_yellow "note: --sync is now a no-op — the tree is fast-forwarded to origin/main at the START of every run." >&2; shift ;;
    --no-wait) WAIT_FOR_CI=0; shift ;;   # ★ FIX 3: don't wait for CI — refuse immediately on a stale-image halt
    --sha) [[ $# -ge 2 ]] || fail "--sha needs a value"; SHA_OVERRIDE="$2"; shift 2 ;;
    --help|-h) usage ;;
    *) fail "unknown arg: $1 (try --help)" ;;
  esac
done

# ---------------------------------------------------------------------------
# 1. Source env + FAIL FAST if a @secure value is missing (the wipe risk).
# ---------------------------------------------------------------------------
[[ -f "${ENV_FILE}" ]] || fail "${ENV_FILE} not found — needs PG_PW, ACS_CONN, VERCEL_BYPASS_TOKEN, ALERT_RECIPIENT_EMAIL, DATABASE_URL."
# shellcheck source=/dev/null
source "${ENV_FILE}"
: "${PG_PW:?PG_PW is unset — refusing to deploy (a missing @secure param WIPES the Postgres secret). Set it in ${ENV_FILE}.}"
: "${ACS_CONN:?ACS_CONN is unset — refusing to deploy (a missing acsEmailConnectionString WIPES ACS email alerting). Set it in ${ENV_FILE}.}"
: "${VERCEL_BYPASS_TOKEN:?VERCEL_BYPASS_TOKEN is unset — refusing to deploy (a missing vercelBypassToken WIPES the Vercel bypass secret → protected Wegmans checks would fail the deployment-protection gate). Set it in ${ENV_FILE}.}"
# Not a secret, but REQUIRED (no bicep default): the external fleet-liveness Action Group needs a
# recipient — a deploy without it would create alerts that notify nobody. Kept out of git like the
# runner's DB-managed recipients; supplied here at deploy, same channel as the secrets above.
: "${ALERT_RECIPIENT_EMAIL:?ALERT_RECIPIENT_EMAIL is unset — refusing to deploy (the fleet-liveness alerts need a recipient; a missing one creates an Action Group that notifies nobody). Set it in ${ENV_FILE}.}"

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

# ★ FIX 3 helpers — wait for CI to build the TARGET sha instead of erroring out on the stale-image halt.
# target_ci_conclusion <sha> -> the deploy.yml (image-build) run's conclusion (or status if still running)
# for that exact commit; '' if gh is absent / not authed / no run found (→ ci_wait_verdict keeps waiting).
target_ci_conclusion() {
  command -v gh >/dev/null 2>&1 || { echo ''; return; }
  gh run list --workflow deploy.yml --limit 30 --json headSha,status,conclusion \
    -q '[.[] | select(.headSha=="'"$1"'")][0] | (.conclusion // .status) // ""' 2>/dev/null || true
}

# wait_for_target_image <target_sha> -> 0 once the target's runner+migrate images are BOTH built
# (proceed), 1 if CI failed or the wait timed out (refuse → the caller falls back to the halt error).
# Polls the registry (the authoritative "image exists" signal) + gh (to refuse fast on a real CI
# failure rather than waiting out the timeout). The decision each tick is the pure ci_wait_verdict.
# ★ Guard intact: returns 0 ONLY when the TARGET's own images exist — never a predating image — so
# DB-ahead-of-code stays impossible; a CI failure/timeout still refuses.
wait_for_target_image() {
  local target="$1" tries=0 max="${CI_WAIT_TRIES:-40}" nap="${CI_WAIT_SLEEP:-30}" built concl verdict rtags mtags
  c_yellow "Waiting up to $(( max * nap / 60 ))m for CI to build ${target:0:12} (runner+migrate); --no-wait to skip…" >&2
  while (( tries < max )); do
    built=0
    # ★ Membership test via captured vars + here-strings — NOT `printf "$(…)" | grep -qxF`. With the pipe,
    # `grep -q` short-circuits on the match and closes the read end while `printf` is still writing the
    # (long) tag list → printf takes SIGPIPE/EPIPE: the "printf: write error: Broken pipe" noise (twice,
    # one per repo). ★ And under `set -o pipefail` (line 41) it's worse than cosmetic — the matched
    # pipeline's status becomes printf's 141, not grep's 0, so the `if` reads FALSE and `built` stays 0
    # on that poll EVEN THOUGH the image exists (a missed detection; retries usually recover it, as the
    # #155 deploy did). A here-string has no dangling writer to break. Logic is identical: built=1 iff the
    # target's SHA is an exact line in BOTH the runner and migrate tag lists — now read deterministically.
    rtags="$(repo_sha_tags "${RUNNER_REPO}")"
    mtags="$(repo_sha_tags "${MIGRATE_REPO}")"
    if grep -qxF "${target}" <<<"${rtags}" && grep -qxF "${target}" <<<"${mtags}"; then built=1; fi
    concl="$(target_ci_conclusion "${target}")"
    verdict="$(ci_wait_verdict "${built}" "${concl}")"
    case "${verdict}" in
      proceed) c_green "  CI finished — ${target:0:12} is built in both repos; proceeding." >&2; return 0 ;;
      refuse)  c_red   "  CI build for ${target:0:12} ended '${concl}' (no image will appear) — refusing." >&2; return 1 ;;
    esac
    (( tries % 4 == 0 )) && c_yellow "  …still building (${concl:-no run yet}); waited $(( tries * nap ))s." >&2
    sleep "${nap}"; tries=$(( tries + 1 ))
  done
  c_red "  timed out after $(( max * nap / 60 ))m waiting for CI to build ${target:0:12}." >&2
  return 1
}

pick_sha() {
  local runner_tags migrate_tags
  runner_tags="$(repo_sha_tags "${RUNNER_REPO}")"
  migrate_tags="$(repo_sha_tags "${MIGRATE_REPO}")"

  if [[ -n "${SHA_OVERRIDE}" ]]; then
    # ★ BUG 1: even an explicit SHA must exist in BOTH repos, or the deploy half-applies.
    c_yellow "Using --sha override: ${SHA_OVERRIDE}" >&2
    # ★ Pipe-free membership (sha_in_tags), NOT `printf | grep -qxF`: under `set -o pipefail` the pipe
    # SIGPIPEs on an early match → pipeline 141 → this `|| fail` fires EVEN WHEN THE SHA IS PRESENT,
    # falsely refusing a valid --sha deploy (the #279/#281 SIGPIPE class; sibling of the line-280 fix).
    sha_in_tags "${SHA_OVERRIDE}" "${runner_tags}" \
      || fail "${RUNNER_REPO}:${SHA_OVERRIDE:0:12} not in registry — nothing to deploy."
    sha_in_tags "${SHA_OVERRIDE}" "${migrate_tags}" \
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
          # ★ NEVER silently ship a runner image that predates HEAD's runner code — deploying ${newest}
          # would apply HEAD's DB migrations WITHOUT the matching runner code (the DB-ahead-of-code
          # half-state that paged ft=1 monitors with no retry absorption).
          # ★ FIX 3: instead of erroring out + making the user re-run, WAIT for CI to finish building the
          # TARGET, then proceed with the now-built target. The guard is intact: we proceed ONLY once the
          # target's OWN images exist (wait_for_target_image returns 0); a CI FAILURE or a timeout still
          # falls through to the refusal below. --no-wait skips the wait (old immediate-refuse behavior).
          if [[ "${WAIT_FOR_CI}" -eq 1 ]] && wait_for_target_image "${head}"; then
            newest="${head}"   # CI built the target — deploy it (a fully-built runner+migrate pair).
            c_green "      Deploying the now-built target ${newest:0:12}." >&2
          # This is a HALT, not a prompt: --yes does NOT bypass it (like a what-if drop). Escape hatch: --sha.
          elif [[ "${runner_newest}" == "${head}" ]]; then
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
# ★ Concern B: refuse to run a STALE copy of the deploy scripts. deploy.sh executes the LOCAL working-tree
# copy of itself (+ scripts/lib), but deploys origin/main's template — so a local copy that lags origin/main
# runs OLD deploy logic while claiming success (the #254/#268 "merged but not executing" mystery). Compare by
# CONTENT (script_differs_from_ref), so a tree behind only on UNRELATED files is fine; a divergent SCRIPT
# aborts loudly. Runs right after the origin fetch. Requires origin/main fetched (the caller just did).
assert_deploy_scripts_current() {
  local p stale=""
  for p in scripts/deploy.sh scripts/lib/deploy-lib.sh scripts/lib/whatif-halts.jq; do
    if script_differs_from_ref "${ROOT}" origin/main "${p}"; then stale+="${p} "; fi
  done
  if [[ -n "${stale}" ]]; then
    fail "STALE deploy scripts vs origin/main: ${stale}
  Running them would deploy with OLD logic — merged fixes (e.g. #268's resource-reconcile, this RBAC/CORS
  verify) would NOT run while the deploy still reports success. Being behind on unrelated files is benign;
  being behind on the deploy SCRIPT is never benign. Fix, then re-run ./scripts/deploy.sh:
      git -C '${ROOT}' fetch origin && git -C '${ROOT}' reset --hard origin/main"
  fi
  c_green "Deploy scripts are current with origin/main (deploy.sh + lib + what-if classifier)." >&2
}

sync_target_to_origin() {
  c_bold "Fetching origin (the deploy target is origin/main, not local HEAD)…" >&2
  git fetch --quiet origin 2>/dev/null \
    || c_yellow "WARN: 'git fetch origin' failed — using the last-fetched origin/main (it may be stale)." >&2
  local origin_head local_head state
  origin_head="$(git rev-parse origin/main 2>/dev/null)" \
    || fail "cannot resolve origin/main — is the 'origin' remote configured with a 'main' branch?"
  # (The stale-SCRIPT guard runs UNCONDITIONALLY at the top level — before this, and before the --sha branch —
  # so it also covers --sha, which skips this function. See assert_deploy_scripts_current's call site.)
  local_head="$(git rev-parse HEAD 2>/dev/null || echo '')"
  state="$(git_drift_state "${local_head}" "${origin_head}")"
  # NOTE: the START-OF-RUN SYNC block already fast-forwarded a behind main to origin/main (and re-exec'd),
  # so on a clean checkout this is almost always 'same'. The other branches remain as defensive notes for a
  # diverged/squash-leftover local main (which the start sync deliberately does NOT auto-reset).
  case "${state}" in
    same)
      c_green "Local main == origin/main (${origin_head:0:12}) — deploying that." >&2 ;;
    behind)
      # ★ FIX 4: BENIGN — local is a strict ANCESTOR of origin/main (fast-forwardable), the normal
      # squash-merge aftermath (your branch merged; local main just hasn't pulled). Nothing is wrong
      # and nothing diverged, so this is a calm green NOTE, not an alarming yellow WARN (which is
      # reserved for the 'diverged' case below — local commits that are NOT on origin).
      c_green "NOTE: local main is behind origin/main (benign, fast-forwardable) — deploying origin/main ${origin_head:0:12}." >&2
      c_green "      (Benign for the TEMPLATE + files — the deploy SCRIPTS were confirmed current above, else we'd" >&2
      c_green "       have aborted. 'git pull' to catch up — not required; the deploy always targets origin.)" >&2 ;;
    stale)
      # ★ BENIGN squash-merge leftover: local main has commit(s) that aren't literally on origin, but
      # git_drift_state confirmed every one is ALREADY on origin as an equivalent patch (the PR merged
      # as a new squash SHA). Nothing un-merged is at risk, so this is a calm green NOTE — NOT the loud
      # 'diverged' WARN. This is the case that repeatedly read like a failure; say plainly it's expected.
      c_green "NOTE: local main is STALE (squash-merge leftover) — this is expected after a merge. Deploying" >&2
      c_green "      origin/main ${origin_head:0:12} (the merged code). Your local commit(s) below are pre-squash" >&2
      c_green "      duplicates, already on origin as a squash — safe to discard with:" >&2
      c_green "          git checkout main && git fetch origin && git reset --hard origin/main" >&2
      git log --oneline origin/main..HEAD 2>/dev/null | sed 's/^/        pre-squash duplicate (untouched): /' >&2 || true ;;
    diverged)
      # GENUINE divergence — local has commit(s) whose CHANGES are NOT on origin (real unpushed work, an
      # orphan never pushed/built). It has no image, so it must NOT be the deploy target. DO NOT reset —
      # IGNORE them and deploy origin. This is the one case that warrants the loud yellow WARN.
      c_yellow "WARN: local main has un-merged commit(s) NOT on origin/main (genuine divergence) — IGNORING them; deploying origin/main ${origin_head:0:12}:" >&2
      git log --oneline origin/main..HEAD 2>/dev/null | sed 's/^/        local-only (untouched): /' >&2 || true
      c_yellow "      (Push + let CI build a local commit to deploy it, or use --sha. Your tree is left as-is.)" >&2 ;;
  esac
  TARGET_HEAD="${origin_head}"
}

# (offer_local_sync REMOVED — the START-OF-RUN SYNC fast-forwards the tree to origin/main BEFORE the deploy,
#  so there is no stale/behind local main left to offer a post-deploy sync for. `--sync` is a no-op alias.)

# ★ Concern B: refuse a STALE copy of the deploy scripts — UNCONDITIONALLY, before any deploy work and BEFORE
# the --sha branch. --sha skips sync_target_to_origin, so putting the guard here (not inside sync) keeps a
# stale script from silently running old verify()/materialize logic on a --sha deploy too. Needs a fresh
# origin/main; this fetch also primes the ref sync_target_to_origin reads next (a second fetch is harmless).
git fetch --quiet origin 2>/dev/null \
  || c_yellow "WARN: 'git fetch origin' failed — the deploy-script currency check uses the last-fetched origin/main." >&2
assert_deploy_scripts_current

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
# Materialize the infra template from the DEPLOY TARGET commit — the change that makes "deploy
# origin/main" TRUE for the TEMPLATE, not just the image. NEVER the working tree: a behind/stale tree is
# the benign post-merge norm this script deploys THROUGH, and its bicep would be pre-merge.
#
# ★ #251 materialized from TARGET_HEAD (local `git rev-parse origin/main`) alone — but that STILL dropped
# value changes (the #253 silent drop): the deploy shipped image ${SHA} (resolved from ACR, which CI had
# already pushed for the newest commit) while the LOCAL origin/main ref LAGGED it (fetch race / not yet
# pulled). So TARGET_HEAD pointed at an ANCESTOR (#252, memory 2Gi) while the image was #253 (4Gi) — a
# stale template rode a current image, and `az create` reported success at 2Gi. Deploy from the NEWER
# (descendant) of {TARGET_HEAD, image ${SHA}} so the TEMPLATE can never be older than the image it ships:
#   • image ${SHA} is a descendant of origin/main (the lag bug, incl. equal) → use ${SHA} (matches image);
#   • origin/main is a descendant of the image (infra-only commits ahead of the newest built image) →
#     use TARGET_HEAD (ship those infra-only changes);
#   • genuinely diverged (no ancestor line) → HALT rather than guess.
# The image commit may not be in the local object store yet (ACR ahead of the last fetch — the bug's root)
# so fetch it by SHA first. main.bicep is self-contained (no module/loadTextContent/loadFileAsBase64 refs),
# so a single `git show` into a temp dir is sufficient; the dir keeps the `.bicep` name az needs.
# ---------------------------------------------------------------------------
materialize_template() {
  # The image commit (${SHA}) is the FLOOR: it is the code being deployed, so its infra template is the one
  # that must ship — the template must NEVER predate it. Ensure the commit is in the local object store (ACR
  # can be ahead of the last `git fetch` — the root of the #253 drop); try a targeted fetch, then REQUIRE it.
  # ★ #256 REGRESSION FIXED HERE: the old code fell back to TARGET_HEAD when the image commit was unfetchable
  # (`elif ! git cat-file -e SHA; then ref=TARGET_HEAD`). When the LOCAL origin/main ref was itself stale
  # (behind the just-merged image — a fetch race), that fallback shipped an ANCESTOR's template atop the
  # current image (2Gi on a 4Gi image). verify() then compared live 2Gi to the STALE 2Gi template and PASSED
  # — the exact double-failure at synthwatch-deploy-20260711-164541 (templateHash 5669735136662207502 ==
  # commit 3a2f955's 2Gi bicep). We now REFUSE instead of guessing.
  git cat-file -e "${SHA}^{commit}" 2>/dev/null || git fetch --quiet origin "${SHA}" 2>/dev/null || true
  git cat-file -e "${SHA}^{commit}" 2>/dev/null \
    || fail "the deployed image commit ${SHA:0:12} is not in the local repo and could not be fetched — refusing to deploy: its infra template can't be resolved, and falling back to a possibly-stale origin/main would ship an ANCESTOR's template atop the image (the #253 drop). Run 'git fetch origin' (or 'git fetch origin ${SHA:0:12}') and retry."

  # Deploy the NEWER of {origin/main (TARGET_HEAD), image ${SHA}} so the template can never PREDATE the image.
  local ref
  if [[ -z "${TARGET_HEAD}" ]]; then
    ref="${SHA}"                                                    # --sha override: sync skipped
  elif git merge-base --is-ancestor "${TARGET_HEAD}" "${SHA}" 2>/dev/null; then
    ref="${SHA}"                                                    # image >= origin/main (incl. the lag bug)
  elif git merge-base --is-ancestor "${SHA}" "${TARGET_HEAD}" 2>/dev/null; then
    ref="${TARGET_HEAD}"                                            # origin/main has infra-only commits ahead
  else
    fail "deploy target diverged: the image commit ${SHA:0:12} and origin/main ${TARGET_HEAD:0:12} share no ancestor line — refusing to guess the infra template. Run 'git fetch origin' and retry (or --sha to pin)."
  fi

  # ★ INVARIANT (the #253/#256 stale-template guard, made explicit + belt-and-suspenders): ref must NOT
  # predate the image. ref is max(TARGET_HEAD, SHA) by construction above, so this can only fire if a future
  # refactor reintroduces a stale-fallback path — in which case it fails LOUD here rather than shipping a
  # template verify() would validate against and silently pass.
  image_covered_by_template "${SHA}" "${ref}" \
    || fail "refusing to ship a STALE template: commit ${ref:0:12} PREDATES the deployed image ${SHA:0:12} (a template older than the image it ships — the #253/#256 drop). Run 'git fetch origin' and retry."

  TEMPLATE_DIR="$(mktemp -d -t synthwatch-tpl.XXXXXX)" \
    || fail "could not create a temp dir for the materialized template."
  TEMPLATE="${TEMPLATE_DIR}/main.bicep"
  git show "${ref}:${TEMPLATE_SRC_PATH}" > "${TEMPLATE}" 2>/dev/null \
    || fail "cannot materialize ${TEMPLATE_SRC_PATH} from ${ref:0:12} — refusing to fall back to the (possibly stale) working tree. Is that commit fetched?"
  [[ -s "${TEMPLATE}" ]] || fail "materialized template ${ref:0:12}:${TEMPLATE_SRC_PATH} is empty."
  c_green "Infra template: deploying ${ref:0:12}:${TEMPLATE_SRC_PATH} (newest of origin/main + image commit — never older than the shipped image)." >&2
}
materialize_template

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
        vercelBypassToken="${VERCEL_BYPASS_TOKEN}" \
        alertRecipientEmail="${ALERT_RECIPIENT_EMAIL}" \
        credEncKey="${CRED_ENC_KEY:?CRED_ENC_KEY must be set in ~/.synthwatch.env before deploy (base64 of 32 random bytes; an empty ACA secret is rejected and the runner cannot decrypt credential values)}" \
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
        vercelBypassToken="${VERCEL_BYPASS_TOKEN}" \
        alertRecipientEmail="${ALERT_RECIPIENT_EMAIL}" \
        credEncKey="${CRED_ENC_KEY:?CRED_ENC_KEY must be set in ~/.synthwatch.env before deploy (base64 of 32 random bytes; an empty ACA secret is rejected and the runner cannot decrypt credential values)}" \
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
VERIFY_SKIPS=0
EXPECTED_MIGRATIONS=''   # set by handle_migrations: versions the deploy range shipped (BUG 3)
pass() { c_green "  PASS  $*"; }
flunk() { c_red   "  FAIL  $*"; VERIFY_FAILS=$((VERIFY_FAILS + 1)); }
# skip <message> : a check that is legitimately NOT APPLICABLE — an AFFIRMATIVELY-established "nothing to
# assert" (the parser WORKED and found none), NOT a parse that failed and shrugged. ★ Printed DISTINCTLY from
# PASS so a green never stands in for a check that asserted nothing (the #279 lesson: a vacuous PASS
# manufactures confidence). Not a failure — but a SKIP where a PASS is expected is itself a signal, so it is
# counted and surfaced in the summary. A parse FAILURE must still `flunk`, never `skip`.
skip() { c_yellow "  SKIP  $*"; VERIFY_SKIPS=$((VERIFY_SKIPS + 1)); }
# check <ok-bool> <message> : pass if first arg is "1", else flunk. Avoids the A&&B||C trap.
check() { if [[ "$1" == "1" ]]; then pass "$2"; else flunk "$2"; fi; }

# ★ FIX 1 — the post-deploy VERIFY false-empty read (the ACS secretRef cry-wolf: live ref was
# 'acs-email-conn' but VERIFY read ''). ROOT CAUSE: verify runs right after the deploy while the
# just-rolled job revision is still RECONCILING, and `az ... 2>/dev/null || true` swallows the
# transient empty/error read into "" — which the check then FAILs. The az path + parse are correct
# (proven: the same query reads 'acs-email-conn' once reconciliation settles). FIX: retry an EMPTY
# read a few times before trusting it. ★ A GENUINELY-missing/wiped value stays empty across all
# retries → the caller still FLUNKS, so the guard keeps its teeth; only the mid-reconciliation
# transient is absorbed. A present value returns on the FIRST try (no latency pre-deploy / normally).
readonly VERIFY_READ_TRIES="${VERIFY_READ_TRIES:-8}"   # 8 × 5s ≈ 40s of headroom on an empty read
readonly VERIFY_READ_SLEEP="${VERIFY_READ_SLEEP:-5}"
# retry_nonempty lives in scripts/lib/deploy-lib.sh (already sourced) so the unit test drives it.

# shellcheck disable=SC2329  # invoked indirectly via retry_nonempty "$@"
_job_env_value() {  # job, env-name -> value (empty if absent)
  az containerapp job show -n "$1" -g "${RG}" \
    --query "properties.template.containers[0].env[?name=='$2'].value | [0]" -o tsv 2>/dev/null || true
}
# shellcheck disable=SC2329  # invoked indirectly via retry_nonempty "$@"
_job_env_secretref() {  # job, env-name -> secretRef (empty if absent)
  az containerapp job show -n "$1" -g "${RG}" \
    --query "properties.template.containers[0].env[?name=='$2'].secretRef | [0]" -o tsv 2>/dev/null || true
}
# shellcheck disable=SC2329  # invoked indirectly via retry_nonempty "$@"
_job_image() {  # job -> image
  az containerapp job show -n "$1" -g "${RG}" \
    --query "properties.template.containers[0].image" -o tsv 2>/dev/null || true
}
# shellcheck disable=SC2329  # invoked indirectly via retry_nonempty "$@"
_job_replica_timeout() {  # job -> replicaTimeout (seconds)
  az containerapp job show -n "$1" -g "${RG}" \
    --query "properties.configuration.replicaTimeout" -o tsv 2>/dev/null || true
}
# shellcheck disable=SC2329  # invoked indirectly via retry_nonempty "$@"
_job_cpu() {  # job -> container cpu
  az containerapp job show -n "$1" -g "${RG}" \
    --query "properties.template.containers[0].resources.cpu" -o tsv 2>/dev/null || true
}
# shellcheck disable=SC2329  # invoked indirectly via retry_nonempty "$@"
_job_memory() {  # job -> container memory
  az containerapp job show -n "$1" -g "${RG}" \
    --query "properties.template.containers[0].resources.memory" -o tsv 2>/dev/null || true
}
# Verify-facing wrappers: retry the raw read on a transient empty (mid-reconciliation).
job_env_value()      { retry_nonempty _job_env_value "$@"; }
job_env_secretref()  { retry_nonempty _job_env_secretref "$@"; }
job_image()          { retry_nonempty _job_image "$@"; }
job_replica_timeout() { retry_nonempty _job_replica_timeout "$@"; }
job_cpu()            { retry_nonempty _job_cpu "$@"; }
job_memory()         { retry_nonempty _job_memory "$@"; }

# ---------------------------------------------------------------------------
# 6a. Reconcile runner-job RESOURCES to the deployed template (the #253/#256 fix, automated).
# ACA job cpu/memory live on template.containers[].resources; an ARM `az deployment group create` does NOT
# reliably resize an EXISTING job's resources in place — which is why Craig had to `az containerapp job
# update --cpu/--memory` by hand (3×). So AFTER the ARM deploy, explicitly reconcile each of the 3
# browser-runner jobs to the template's intended values (bicep_field on ${TEMPLATE}, now PINNED to the image
# commit by the hardened materialize_template — never a stale ancestor). Idempotent: a job already in sync is
# left alone. This makes Craig's manual force part of every deploy; verify() (next) then confirms it landed
# and FAILS the deploy if it didn't. Mirrors start_and_wait_migrate's `az ... job update --image` pattern.
# ---------------------------------------------------------------------------
reconcile_resources() {
  c_bold "Reconciling runner-job resources to the template (cpu/memory/replicaTimeout)…"
  local tmpl pair ri jn ecpu emem ert lcpu lmem lrt
  tmpl="$(cat "${TEMPLATE}" 2>/dev/null || true)"
  if [[ -z "${tmpl}" ]]; then
    c_red "  could not read the template ${TEMPLATE} — skipping resource reconcile (verify will flag drift)."
    return
  fi
  for pair in "job:${RUNNER_JOB}" "centralusJob:${CENTRALUS_RUNNER_JOB}" "westus2Job:${WESTUS2_RUNNER_JOB}"; do
    ri="${pair%%:*}"; jn="${pair##*:}"
    ecpu="$(printf '%s' "${tmpl}" | bicep_field "${ri}" cpu)"
    emem="$(printf '%s' "${tmpl}" | bicep_field "${ri}" memory)"
    ert="$(printf '%s'  "${tmpl}" | bicep_field "${ri}" replicaTimeout)"
    if [[ -z "${ecpu}" || -z "${emem}" ]]; then
      c_yellow "  ${jn}: template carries no cpu/memory (cpu='${ecpu}' mem='${emem}') — skipping (verify flags)."
      continue
    fi
    lcpu="$(job_cpu "${jn}")"; lmem="$(job_memory "${jn}")"; lrt="$(job_replica_timeout "${jn}")"
    if num_eq "${ecpu}" "${lcpu}" && mem_eq "${emem}" "${lmem}" && { [[ -z "${ert}" ]] || num_eq "${ert}" "${lrt}"; }; then
      c_green "  ${jn}: already ${lcpu}cpu / ${lmem} / ${lrt}s — in sync."
      continue
    fi
    c_bold "  ${jn}: ${lcpu}cpu/${lmem}/${lrt}s → ${ecpu}cpu/${emem}/${ert:-$lrt}s — az containerapp job update…"
    # ${ert:+…} keeps this bash-3.2-safe (no arrays under set -u); replicaTimeout is a bare int, no splitting.
    az containerapp job update -n "${jn}" -g "${RG}" \
      --cpu "${ecpu}" --memory "${emem}" ${ert:+--replica-timeout} ${ert:+"${ert}"} -o none 2>/dev/null \
      || c_red "  ${jn}: az job update FAILED — verify() will flag the drift and fail the deploy."
  done
}

# ★ Concern A — RBAC: assert every role assignment the TEMPLATE DECLARES is live (data-driven, like the
# config-value checks — never a hand-curated subset that only grows after a failure). For each
# Microsoft.Authorization/roleAssignments resource in the materialized bicep, resolve its role name (from the
# GUID var), principal, and scope, then `az role assignment list` and FLUNK if the role isn't present live.
# An UNKNOWN principal/scope token FLUNKS (never silently skips) so a new assignment can't slip past
# unasserted. Sets ok/flunk via the same check() plumbing as the rest of verify().
verify_rbac() {
  local tmpl sub_id p_api id_name storage_acct acr_name rows sandbox_id_name sandbox_container
  tmpl="$(cat "${TEMPLATE}" 2>/dev/null || true)"
  if [[ -z "${tmpl}" ]]; then flunk "rbac: could not read the template ${TEMPLATE}"; return; fi
  sub_id="$(az account show --query id -o tsv 2>/dev/null || true)"
  if [[ -z "${sub_id}" ]]; then flunk "rbac: could not resolve the subscription id (az account show)"; return; fi
  p_api="$(printf '%s' "${tmpl}" | bicep_param apiManagedIdentityPrincipalId)"
  id_name="$(printf '%s' "${tmpl}" | bicep_param identityName)"
  storage_acct="$(printf '%s' "${tmpl}" | bicep_param storageAccountName)"
  acr_name="$(printf '%s' "${tmpl}" | bicep_param acrName)"
  sandbox_id_name="$(printf '%s' "${tmpl}" | bicep_param sandboxIdentityName)"      # sandbox preview grants
  sandbox_container="$(printf '%s' "${tmpl}" | bicep_param sandboxContainerName)"
  rows="$(printf '%s' "${tmpl}" | role_assignments_from_template)"
  if [[ -z "${rows}" ]]; then flunk "rbac: template declares NO role assignments (parser broke or bicep changed shape)"; return; fi

  local roleVar principalTok scopeTok roleGuid roleName principalId scopeId live
  while IFS=$'\t' read -r roleVar principalTok scopeTok; do
    [[ -z "${roleVar}" ]] && continue
    roleGuid="$(printf '%s' "${tmpl}" | bicep_var "${roleVar}")"
    if [[ -z "${roleGuid}" ]]; then flunk "rbac ${roleVar}: role GUID not found in template"; continue; fi
    roleName="$(az role definition list --name "${roleGuid}" --query "[0].roleName" -o tsv 2>/dev/null </dev/null || true)"
    if [[ -z "${roleName}" ]]; then flunk "rbac ${roleVar} (${roleGuid}): could not resolve role name (az)"; continue; fi
    case "${principalTok}" in
      apiManagedIdentityPrincipalId) principalId="${p_api}" ;;
      identity.properties.principalId) principalId="$(az identity show -n "${id_name}" -g "${RG}" --query principalId -o tsv 2>/dev/null </dev/null || true)" ;;
      sandboxIdentity.properties.principalId) principalId="$(az identity show -n "${sandbox_id_name}" -g "${RG}" --query principalId -o tsv 2>/dev/null </dev/null || true)" ;;  # sandbox preview MI
      *) flunk "rbac '${roleName}': UNKNOWN principal token '${principalTok}' — verify() needs a resolver (refusing to skip)"; continue ;;
    esac
    if [[ -z "${principalId}" ]]; then flunk "rbac '${roleName}': could not resolve principal '${principalTok}'"; continue; fi
    case "${scopeTok}" in
      resourceGroup) scopeId="/subscriptions/${sub_id}/resourceGroups/${RG}" ;;  # ★ RG-scoped (no `scope:` in bicep) — e.g. the runner's Cost Management Reader grant
      storage)      scopeId="/subscriptions/${sub_id}/resourceGroups/${RG}/providers/Microsoft.Storage/storageAccounts/${storage_acct}" ;;
      acr)          scopeId="/subscriptions/${sub_id}/resourceGroups/${RG}/providers/Microsoft.ContainerRegistry/registries/${acr_name}" ;;
      job)          scopeId="/subscriptions/${sub_id}/resourceGroups/${RG}/providers/Microsoft.App/jobs/${RUNNER_JOB}" ;;
      centralusJob) scopeId="/subscriptions/${sub_id}/resourceGroups/${RG}/providers/Microsoft.App/jobs/${CENTRALUS_RUNNER_JOB}" ;;
      westus2Job)   scopeId="/subscriptions/${sub_id}/resourceGroups/${RG}/providers/Microsoft.App/jobs/${WESTUS2_RUNNER_JOB}" ;;
      reconcileJob) scopeId="/subscriptions/${sub_id}/resourceGroups/${RG}/providers/Microsoft.App/jobs/${RECONCILE_JOB}" ;;
      sandboxJob)   scopeId="/subscriptions/${sub_id}/resourceGroups/${RG}/providers/Microsoft.App/jobs/synthwatch-sandbox" ;;  # sandbox preview job (literal name in bicep)
      sandboxContainer) scopeId="/subscriptions/${sub_id}/resourceGroups/${RG}/providers/Microsoft.Storage/storageAccounts/${storage_acct}/blobServices/default/containers/${sandbox_container}" ;;  # sandbox blob container (sandboxBlobWriter + apiSandboxBlobWriter)
      *) flunk "rbac '${roleName}': UNKNOWN scope token '${scopeTok}' — verify() needs a resolver (refusing to skip)"; continue ;;
    esac
    # Match (role, scope) over ALL of the principal's assignments, scope compared LOWERCASED — `az role
    # assignment list --scope` string-matches EXACTLY and Azure stores mixed casing (resourcegroups vs
    # resourceGroups), so an exact-scope filter false-flunks a grant that IS live. `</dev/null` keeps az from
    # eating the while-loop's here-string.
    local scope_lc live_scopes
    scope_lc="$(printf '%s' "${scopeId}" | tr '[:upper:]' '[:lower:]')"
    live_scopes="$(az role assignment list --assignee "${principalId}" --all --query "[?roleDefinitionName=='${roleName}'].scope" -o tsv 2>/dev/null </dev/null | tr '[:upper:]' '[:lower:]' || true)"
    if printf '%s' "${live_scopes}" | contains_line "${scope_lc}"; then
      pass "rbac: '${roleName}' on ${scopeTok} for ${principalTok} (${principalId:0:8}…)"
    else
      flunk "rbac: '${roleName}' MISSING live on ${scopeTok} for ${principalTok} (${principalId:0:8}…) — the bicep declares it; the deploy did NOT land it"
    fi
  done <<< "${rows}"
}

# ★ NEGATIVE least-privilege assertion for the SANDBOX MI (the #327 silent-failure class, inverted). The
# sandbox runs UPLOADED, UNMERGED code (RCE) — so its blast radius is exactly its grants. verify_rbac() above
# proves the DECLARED grants are LIVE (positive); this proves NOTHING ELSE is. An EXTRA live grant — a stale
# assignment, a manual portal change, a bicep bug that reads green — would silently widen the box. So: list
# ALL of the sandbox MI's live role assignments and FLUNK unless the set is EXACTLY {AcrPull on the ACR,
# Storage Blob Data Contributor on the sandbox container}. Same silent-drift class as the #327 Cost-Reader GUID
# that failed twice while reading green — asserted against the LIVE TENANT, not just the template.
verify_sandbox_least_privilege() {
  local tmpl sub_id sandbox_id_name sandbox_pid acr_name storage_acct sandbox_container
  tmpl="$(cat "${TEMPLATE}" 2>/dev/null || true)"
  if [[ -z "${tmpl}" ]]; then flunk "sandbox-rbac: could not read the template ${TEMPLATE}"; return; fi
  sub_id="$(az account show --query id -o tsv 2>/dev/null || true)"
  if [[ -z "${sub_id}" ]]; then flunk "sandbox-rbac: could not resolve the subscription id"; return; fi
  sandbox_id_name="$(printf '%s' "${tmpl}" | bicep_param sandboxIdentityName)"
  acr_name="$(printf '%s' "${tmpl}" | bicep_param acrName)"
  storage_acct="$(printf '%s' "${tmpl}" | bicep_param storageAccountName)"
  sandbox_container="$(printf '%s' "${tmpl}" | bicep_param sandboxContainerName)"
  if [[ -z "${sandbox_id_name}" ]]; then flunk "sandbox-rbac: sandboxIdentityName not in template (bicep changed shape)"; return; fi
  sandbox_pid="$(az identity show -n "${sandbox_id_name}" -g "${RG}" --query principalId -o tsv 2>/dev/null </dev/null || true)"
  if [[ -z "${sandbox_pid}" ]]; then flunk "sandbox-rbac: could not resolve the sandbox MI principalId (identity '${sandbox_id_name}' not deployed?)"; return; fi

  # The ONLY two grants allowed, as lowercased "roleName<TAB>scope" (Azure stores mixed casing — RG/acr/storage
  # names may be mixed-case, and `live` below is tr-lowercased, so `allowed` must match). ★ bash 3.2: lowercase
  # via `tr`, NEVER ${var,,} — that is a bash-4 expansion and 'bad substitution's on the macOS default shell,
  # crashing this gate MID-VERIFY so the deploy reports SUCCESS while the gate silently did not run.
  local acr_scope container_scope allowed acr_scope_lc container_scope_lc
  acr_scope="/subscriptions/${sub_id}/resourcegroups/${RG}/providers/microsoft.containerregistry/registries/${acr_name}"
  container_scope="/subscriptions/${sub_id}/resourcegroups/${RG}/providers/microsoft.storage/storageaccounts/${storage_acct}/blobservices/default/containers/${sandbox_container}"
  acr_scope_lc="$(printf '%s' "${acr_scope}" | tr '[:upper:]' '[:lower:]')"
  container_scope_lc="$(printf '%s' "${container_scope}" | tr '[:upper:]' '[:lower:]')"
  allowed="$(printf 'acrpull\t%s\nstorage blob data contributor\t%s\n' "${acr_scope_lc}" "${container_scope_lc}")"

  # ALL live assignments for the sandbox MI, lowercased "roleName<TAB>scope".
  local live
  live="$(az role assignment list --assignee "${sandbox_pid}" --all --query "[].[roleDefinitionName, scope]" -o tsv 2>/dev/null </dev/null | tr '[:upper:]' '[:lower:]' || true)"

  # ★ NEGATIVE: any live grant NOT in the allowed set is a widened blast radius reading green → FLUNK. This is
  #   what catches a Key Vault / prod-DB / prod-storage / broader-scope grant that the positive check can't.
  local extra=0 row
  while IFS= read -r row; do
    [[ -z "${row}" ]] && continue
    if ! contains_line "${row}" <<<"${allowed}"; then
      flunk "sandbox-rbac: UNEXPECTED live grant on the sandbox MI → '${row}' — ONLY AcrPull + the sandbox blob container are allowed (RCE blast-radius widened)"
      extra=1
    fi
  done <<< "${live}"

  # POSITIVE: both expected grants must be present (else the sandbox can't pull its image / write its trace).
  local missing=0
  while IFS= read -r row; do
    [[ -z "${row}" ]] && continue
    contains_line "${row}" <<<"${live}" || { flunk "sandbox-rbac: MISSING expected grant '${row}'"; missing=1; }
  done <<< "${allowed}"

  # ★ Postgres Entra admin is NOT an RBAC role assignment (set via `az postgres`), so it never appears above.
  #   The sandbox MI must NEVER be it — assert directly. (Belt-and-braces: the sandbox job also carries no
  #   database-url secret, so it has no connection string even if this ever regressed.)
  local pg_name pg_admins
  pg_name="$(printf '%s' "${tmpl}" | bicep_param postgresServerName 2>/dev/null || true)"
  if [[ -n "${pg_name}" ]]; then
    pg_admins="$(az postgres flexible-server ad-admin list -g "${RG}" -s "${pg_name}" --query "[].principalName" -o tsv 2>/dev/null </dev/null | tr '[:upper:]' '[:lower:]' || true)"
    if grep -qiF "${sandbox_id_name}" <<<"${pg_admins}"; then  # grep -i already case-folds; NO ${var,,} (bash-4)
      flunk "sandbox-rbac: the sandbox MI is a Postgres Entra ADMIN — it must have NO DB access at all"
    fi
  fi

  [[ ${extra} -eq 0 && ${missing} -eq 0 ]] && pass "sandbox-rbac: sandbox MI has EXACTLY {AcrPull, sandbox blob container} live — no DB / Key Vault / prod-storage grant"
}

# ★ Concern A — BLOB CORS: if the template declares blob-service CORS rules, assert the LIVE blob service has
# each declared allowed-origin. Expected origins are read FROM the template (the allowedOrigins param the
# corsRules reference), so this stays correct as origins change. Live corsRules was `[]` before #270 — the
# exact silent pre-state to catch.
verify_cors() {
  local tmpl storage_acct origins live o
  tmpl="$(cat "${TEMPLATE}" 2>/dev/null || true)"
  if [[ -z "${tmpl}" ]]; then flunk "cors: could not read the template ${TEMPLATE}"; return; fi
  # ★ Detect declared CORS with a pure-bash predicate (template_declares_cors), NOT `printf '%s' "$tmpl" | grep
  # -q corsRules`. Under `set -o pipefail` grep -q short-circuits on the FIRST match + closes the pipe, so
  # printf takes SIGPIPE and the PIPELINE returns 141 (printf's), not 0 (grep's); `! <pipeline>` then inverts
  # that to "no CORS" — a VACUOUS PASS precisely WHEN corsRules IS present (the 2026-07-12 false pass + the
  # "printf: write error: Broken pipe" noise). A pure-bash match has no pipe → it reads the true presence and
  # can never SIGPIPE, so "declares no CORS" is a reliable, RARE state (never a parse miss). A DECLARED block
  # that then can't be parsed FLUNKS below (never a silent pass).
  if ! template_declares_cors "${tmpl}"; then
    # AFFIRMATIVELY established (template_declares_cors is a reliable pure-bash predicate post-#279, not a
    # parse that shrugged) → SKIP, not PASS: this check asserted nothing, so it must never show green (the
    # #279 lesson). If corsRules ARE declared but unparseable, the flunks below fire — never this skip.
    skip "cors: template declares no blob CORS — nothing to assert (verified: no corsRules in the template)"
    return
  fi
  storage_acct="$(printf '%s' "${tmpl}" | bicep_param storageAccountName)"
  # EVERY corsRule's allowedOrigins token — not just the first — so the data-driven guarantee is N-rules-deep
  # (a second rule referencing a different origins param must not slip past unasserted).
  local toks="" tok
  toks="$(printf '%s' "${tmpl}" | cors_origins_tokens)"
  if [[ -z "${toks}" ]]; then flunk "cors: template declares corsRules but no allowedOrigins param token parsed"; return; fi
  live="$(az storage account blob-service-properties show -n "${storage_acct}" -g "${RG}" --query "cors.corsRules[].allowedOrigins[]" -o tsv 2>/dev/null || true)"
  while IFS= read -r tok || [[ -n "${tok}" ]]; do
    [[ -z "${tok}" ]] && continue
    origins="$(printf '%s' "${tmpl}" | bicep_param_array "${tok}")"
    if [[ -z "${origins}" ]]; then flunk "cors: could not resolve origins from param '${tok}' (inline arrays unsupported — add a resolver)"; continue; fi
    while IFS= read -r o || [[ -n "${o}" ]]; do
      [[ -z "${o}" ]] && continue
      if printf '%s' "${live}" | contains_line "${o}"; then
        pass "cors: blob service allows origin ${o}"
      else
        flunk "cors: blob service does NOT allow origin ${o} (live corsRules empty/missing it) — the bicep declares it; the deploy did NOT land it"
      fi
    done <<< "${origins}"
  done <<< "${toks}"
}

verify() {
  c_bold "Verifying what landed…"

  # AOAI api-version preserved on runner + narrative (the #93/#94 defect).
  local v ok
  v="$(job_env_value "${RUNNER_JOB}" AZURE_OPENAI_API_VERSION)"
  str_eq "${EXPECTED_API_VERSION}" "${v}" && ok=1 || ok=0
  check "${ok}" "${RUNNER_JOB} AZURE_OPENAI_API_VERSION='${v}' (expect ${EXPECTED_API_VERSION})"
  v="$(job_env_value "${NARRATIVE_JOB}" AZURE_OPENAI_API_VERSION)"
  str_eq "${EXPECTED_API_VERSION}" "${v}" && ok=1 || ok=0
  check "${ok}" "${NARRATIVE_JOB} AZURE_OPENAI_API_VERSION='${v}' (expect ${EXPECTED_API_VERSION})"

  # ★ AZURE COST ENV on the ROLLUP job — the env the Azure Cost Management pull needs.
  # THE DEFECT THIS CATCHES: bicep declared AZURE_SUBSCRIPTION_ID/AZURE_RESOURCE_GROUP on the three RUNNER
  # jobs, but rollupMain.ts is the ONLY caller of refreshAzureCost — so the one job that needs them did not
  # have them. fetchAzureCost hit its first guard, logged "[azure-cost] skipped — … not set", and returned
  # null; refreshAzureCost then `return false`s WITHOUT writing, so the execution still reported Succeeded.
  # azure_cost was never written (n_tup_ins = 0) and /reports/cost served azure: null for days while
  # totalProjectedMonthly — computed independently — stayed healthy and masked it.
  # ★ A "declared on one job, consumed by another" gap is invisible to every other check here: the image is
  # right, the marker is right, the resources are right. Only asserting it ON THE CONSUMER catches it.
  for cost_var in AZURE_SUBSCRIPTION_ID AZURE_RESOURCE_GROUP; do
    v="$(job_env_value "${ROLLUP_JOB}" "${cost_var}")"
    # Non-empty is the assertion: the VALUES are subscription()/resourceGroup() expressions resolved by ARM,
    # so pinning literals here would just re-encode the template. Absence is the failure mode seen in prod.
    [[ -n "${v}" ]] && ok=1 || ok=0
    check "${ok}" "${ROLLUP_JOB} ${cost_var}='${v}' (must be NON-EMPTY — the Azure cost pull silently no-ops without it)"
  done

  # ACS secretRef present on the runner job (the recurring email-wipe defect).
  v="$(job_env_secretref "${RUNNER_JOB}" ACS_EMAIL_CONNECTION_STRING)"
  str_eq "${ACS_SECRET_REF}" "${v}" && ok=1 || ok=0
  check "${ok}" "${RUNNER_JOB} ACS_EMAIL_CONNECTION_STRING secretRef='${v}' (expect ${ACS_SECRET_REF})"

  # CRED_ENC_KEY secretRef PLUMBING present on the runner job (model-B value crypto — the decrypt canary).
  # Asserts the env→secretRef mapping is intact (not the value). A future deploy that drops it → runner
  # can't decrypt credential values → login monitors fail closed; caught here.
  v="$(job_env_secretref "${RUNNER_JOB}" CRED_ENC_KEY)"
  str_eq "${CRED_ENC_KEY_SECRET_REF}" "${v}" && ok=1 || ok=0
  check "${ok}" "${RUNNER_JOB} CRED_ENC_KEY secretRef='${v}' (expect ${CRED_ENC_KEY_SECRET_REF})"

  # AZURE_CLIENT_ID present where expected (MI pin; #90).
  local j
  for j in "${RUNNER_JOB}" "${NARRATIVE_JOB}" "${RECONCILE_JOB}"; do
    v="$(job_env_value "${j}" AZURE_CLIENT_ID)"
    [[ -n "${v}" ]] && ok=1 || ok=0
    check "${ok}" "${j} AZURE_CLIENT_ID present (or job absent)"
  done

  # ★ A4 prod-guard marker: SYNTHWATCH_DEPLOYED=='1' on EVERY guard-protected job. The
  # 2026-07-06 outage: a full bicep-apply ran, verify() printed "all checks passed", yet every
  # runner job was REFUSING TO START — the marker never landed on the RUNNING jobs and verify()
  # checked every env var EXCEPT the one the prod-guard (runner/prodGuard.ts) actually gates on.
  # A deploy must not report success while the guard would refuse.
  # ★ SCOPE: GUARDED_ENTRYPOINT_JOBS — NOT RUNNER_IMAGE_JOBS. Those two were identical until #351, and
  #   the old comment here asserted "RUNNER_IMAGE_JOBS is exactly the set that runs a guarded entrypoint".
  #   #351 FALSIFIED that by adding synthwatch-sandbox, which runs the runner IMAGE but not a guarded
  #   ENTRYPOINT — so this check went red on every deploy while asserting something demonstrably false
  #   (the sandbox starts fine without the marker; it is DB-less, so the guard's DATABASE_URL trigger can
  #   never fire, and sandboxMain.ts does not import prodGuard). A stated invariant that is false is the
  #   doc-vs-code drift class, so the ARRAY now carries the distinction rather than a comment claiming it.
  #   See deploy-lib.sh GUARDED_ENTRYPOINT_JOBS for the full exemption rationale.
  #   The migrate job runs the migrate image, has no guard, and is likewise excluded.
  # The marker also ships baked into the runner image (runner Dockerfile) — this assertion is the
  # deploy-time proof it is genuinely present on each RUNNING job.
  for j in "${GUARDED_ENTRYPOINT_JOBS[@]}"; do
    v="$(job_env_value "${j}" SYNTHWATCH_DEPLOYED)"
    str_eq "1" "${v}" && ok=1 || ok=0
    check "${ok}" "${j} SYNTHWATCH_DEPLOYED='${v}' (expect 1 — A4 prod-guard; the job REFUSES TO START without it)"
  done

  # ★ CONFIG-VALUE checks: replicaTimeout / cpu / memory on the 3 browser-runner jobs must match the
  # DEPLOYED template. This is the gap that let TWO silent drops (replicaTimeout 240→660 #250, memory
  # 2Gi→4Gi #253) ship a current image atop a STALE template while verify() reported "all passed" — the
  # drop only surfaced weeks later as a runtime OOM/strand. EXPECTED comes from the materialized template
  # itself (bicep_field on ${TEMPLATE}), so this stays correct as values change — never a hardcoded 660/4Gi.
  # (Only the 3 browser-runner jobs carry non-default resources/timeout; the aux jobs are left to bicep.)
  local tmpl pair ri jn exp
  tmpl="$(cat "${TEMPLATE}" 2>/dev/null || true)"
  if [[ -z "${tmpl}" ]]; then
    flunk "config-verify: could not read the deployed template ${TEMPLATE} for expected values"
  else
    for pair in "job:${RUNNER_JOB}" "centralusJob:${CENTRALUS_RUNNER_JOB}" "westus2Job:${WESTUS2_RUNNER_JOB}"; do
      ri="${pair%%:*}"; jn="${pair##*:}"
      exp="$(printf '%s' "${tmpl}" | bicep_field "${ri}" replicaTimeout)"
      v="$(job_replica_timeout "${jn}")"
      num_eq "${exp}" "${v}" && ok=1 || ok=0
      check "${ok}" "${jn} replicaTimeout='${v}' (expect ${exp:-<none in template>})"
      exp="$(printf '%s' "${tmpl}" | bicep_field "${ri}" cpu)"
      v="$(job_cpu "${jn}")"
      num_eq "${exp}" "${v}" && ok=1 || ok=0
      check "${ok}" "${jn} cpu='${v}' (expect ${exp:-<none in template>})"
      exp="$(printf '%s' "${tmpl}" | bicep_field "${ri}" memory)"
      v="$(job_memory "${jn}")"
      mem_eq "${exp}" "${v}" && ok=1 || ok=0
      check "${ok}" "${jn} memory='${v}' (expect ${exp:-<none in template>})"
    done
  fi

  # ★ COST-MODEL ALLOCATION: the deploy-stamped SYNTHWATCH_RUNNER_CPU/MEMORY_GIB (the cost model's live
  # allocation — runner/costModel.ts) must match the REAL container resources, or the two-meter rate silently
  # drifts on a resize (the whole point of the 0.00003 blended-rate bug: the model read NO allocation). This is
  # the guard that makes the deploy-stamp trustworthy — it compares the LIVE job's env against the LIVE job's
  # resources (two independent reads), so stamping a wrong value FAILS the deploy (must-go-red). The 3
  # browser-runner jobs carry their OWN allocation, so env must equal their own cpu/memory; the narrative job
  # PRICES the runner workload (its own resources are aux 0.25/0.5), so its env must equal the PRIMARY runner
  # job's live allocation. mem is stored GiB-only ('4'), resources report '4Gi' — strip the unit to compare.
  local acpu amem lcpu lmem
  acpu="$(job_cpu "${RUNNER_JOB}")"                 # authoritative live runner allocation
  amem="$(job_memory "${RUNNER_JOB}")"; amem="${amem%Gi}"
  for jn in "${RUNNER_JOB}" "${CENTRALUS_RUNNER_JOB}" "${WESTUS2_RUNNER_JOB}"; do
    lcpu="$(job_env_value "${jn}" SYNTHWATCH_RUNNER_CPU)"
    num_eq "$(job_cpu "${jn}")" "${lcpu}" && ok=1 || ok=0
    check "${ok}" "${jn} SYNTHWATCH_RUNNER_CPU='${lcpu}' (expect == live cpu $(job_cpu "${jn}") — cost model reads the live allocation)"
    lmem="$(job_env_value "${jn}" SYNTHWATCH_RUNNER_MEMORY_GIB)"
    v="$(job_memory "${jn}")"; v="${v%Gi}"
    num_eq "${v}" "${lmem}" && ok=1 || ok=0
    check "${ok}" "${jn} SYNTHWATCH_RUNNER_MEMORY_GIB='${lmem}' (expect == live memory ${v}Gi)"
  done
  # Narrative job: prices the RUNNER workload → env must equal the primary runner job's live allocation.
  lcpu="$(job_env_value "${NARRATIVE_JOB}" SYNTHWATCH_RUNNER_CPU)"
  num_eq "${acpu}" "${lcpu}" && ok=1 || ok=0
  check "${ok}" "${NARRATIVE_JOB} SYNTHWATCH_RUNNER_CPU='${lcpu}' (expect == runner ${acpu} — it prices the runner workload, not its own aux shape)"
  lmem="$(job_env_value "${NARRATIVE_JOB}" SYNTHWATCH_RUNNER_MEMORY_GIB)"
  num_eq "${amem}" "${lmem}" && ok=1 || ok=0
  check "${ok}" "${NARRATIVE_JOB} SYNTHWATCH_RUNNER_MEMORY_GIB='${lmem}' (expect == runner ${amem}Gi)"

  # ★ Concern A: RBAC role assignments + blob CORS the TEMPLATE declares must be live (the memory-drop class:
  # #270's MI Storage Blob Delegator + blob CORS could silently not land while verify reported success).
  verify_rbac
  verify_sandbox_least_privilege
  verify_cors

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
    # ★ DERIVED, never retyped. The old literal "(runner+migrate+narrative+rollup+reconcile+centralus)"
    #   was false TWICE: it claimed "all jobs" while the sandbox was not even in the loop, and its own list
    #   had drifted from its own array (no westus2, no retention). A hand-maintained summary of a machine-
    #   maintained list is a lie waiting to happen — so build it from the array that was actually checked.
    #   Names are shortened for readability only ('synthwatch-' stripped, '-job' stripped).
    local checked
    checked="$(printf '%s\n' "${RUNNER_IMAGE_JOBS[@]}" "${MIGRATE_JOB}" \
      | sed -e 's/^synthwatch-//' -e 's/-job//' | paste -sd'+' -)"
    pass "all ${#RUNNER_IMAGE_JOBS[@]}+1 jobs on image ${SHA:0:12} (${checked})"
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
  str_eq "200" "${code}" && ok=1 || ok=0
  check "${ok}" "API ${API_HEALTH_URL} -> '${code}' (expect 200)"

  # ★ CRED_ENC_KEY DRIFT-CHECK (model-B single-source safety net). The runner secret was set from
  # ~/.synthwatch.env's CRED_ENC_KEY (the create step above); the API must hold the SAME key or the runner
  # can't decrypt api-written ciphertext (silent prod failure). Compare the NON-SECRET fingerprint each side
  # derives — sha256("CRED_ENC_KEY_FP_v1:"+key), first 16 hex (CredCrypto.Fingerprint ↔ this bash). A
  # mismatch (or the api 503'ing = no/invalid key) fails the deploy. Only the 16-hex fingerprint is printed,
  # NEVER the key.
  local fp_local fp_api
  fp_local="$(printf 'CRED_ENC_KEY_FP_v1:%s' "${CRED_ENC_KEY:-}" | openssl dgst -sha256 -hex | awk '{print $NF}' | cut -c1-16)"
  fp_api="$(curl -s --max-time 15 "${API_CRED_FP_URL}" 2>/dev/null | jq -r '.fingerprint // empty' 2>/dev/null || true)"
  if [[ -n "${fp_api}" && "${fp_local}" == "${fp_api}" ]]; then
    pass "CRED_ENC_KEY matches API (fingerprint ${fp_local}) — runner can decrypt api ciphertext"
  else
    flunk "CRED_ENC_KEY DRIFT: runner fp=${fp_local} != api fp='${fp_api:-<none / api 503: key absent>}' — the runner CANNOT decrypt api-written credentials. Re-deploy the API with credEncKey=\"\$CRED_ENC_KEY\" from ~/.synthwatch.env (synthwatch-api/scripts/deploy.sh)."
  fi

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
        str_eq "1" "${n}" && ok=1 || ok=0
        check "${ok}" "migration ${mig} recorded in schema_migrations"
      else
        flunk "migration ${mig} unverified — psql not on PATH"
      fi
    done <<< "${EXPECTED_MIGRATIONS}"
  fi

  echo
  local skipnote=""
  if [[ "${VERIFY_SKIPS}" -gt 0 ]]; then
    skipnote=" (${VERIFY_SKIPS} SKIP — asserted nothing; see SKIP lines. A SKIP where a PASS is expected is a signal.)"
  fi
  if [[ "${VERIFY_FAILS}" -eq 0 ]]; then
    c_green "VERIFY: all checks passed.${skipnote}"
  else
    c_red "VERIFY: ${VERIFY_FAILS} check(s) FAILED.${skipnote}"
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
  reconcile_resources                          # ★ #253/#256: force runner-job cpu/memory to the template
  echo                                         #    (ARM won't resize an existing job in place) — no manual az
  handle_migrations "${prev_sha}" "${SHA}"   # BUG 3 + FIX 1: auto-run the migrate job if one shipped
  echo
  verify                                       # BUG 2: every job's image; config-value drift; migration-applied

  # ★ FIX 2: --post-reconcile — trigger the reconcile job, wait, print the post-deploy state
  # (spec_catalog + reconcile_drift) so the operator sees it without manually sleeping/re-querying.
  if [[ "${POST_RECONCILE}" -eq 1 ]]; then
    echo
    c_bold "Post-reconcile (--post-reconcile)…"
    post_reconcile || c_red "post-reconcile reported a problem (see above)."
  fi

  # (No post-deploy sync offer: the START-OF-RUN SYNC already fast-forwarded the tree to origin/main before
  #  the deploy, so local main is current by the time we get here.)
  exit "$(( VERIFY_FAILS > 0 ? 1 : 0 ))"
}

main
