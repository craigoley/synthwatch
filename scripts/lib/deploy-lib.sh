# shellcheck shell=bash
# deploy-lib.sh — pure, sourceable helpers for scripts/deploy.sh, factored out so the unit
# test (scripts/deploy_test.sh) exercises the EXACT logic the deploy uses (no drift). No
# top-level side effects; sourcing this runs nothing.

# ---------------------------------------------------------------------------
# RUNNER_IMAGE_JOBS — the ACA jobs that run the RUNNER image (all use `image: runnerImage` in
# infra/main.bicep). ★ SINGLE SOURCE OF TRUTH, HERE (not deploy.sh) so BOTH deploy.sh AND the unit test
# (deploy_test.sh) read the SAME value — a job added here reaches both. Two consumers enforce it:
#   • deploy.sh verify() asserts every one is on the same image after a deploy (BUG 2);
#   • CD (.github/workflows/deploy.yml) MUST roll EXACTLY this set on every merge, or the un-rolled jobs run
#     STALE code until a manual deploy (TD-3 — CD had drifted to 2 of 6). deploy_test.sh's parity test asserts
#     deploy.yml rolls exactly RUNNER_IMAGE_JOBS, so a future one-sided edit FAILS CI. Add a job in ONE place: here.
# ---------------------------------------------------------------------------
readonly RUNNER_JOB='synthwatch-runner-job'
readonly CENTRALUS_RUNNER_JOB='synthwatch-runner-job-centralus'
readonly WESTUS2_RUNNER_JOB='synthwatch-runner-job-westus2'   # 3rd region (2-of-3 quorum)
readonly NARRATIVE_JOB='synthwatch-narrative-job'
readonly ROLLUP_JOB='synthwatch-rollup-job'
readonly RECONCILE_JOB='synthwatch-reconcile-job'
readonly RETENTION_JOB='synthwatch-retention-job'
readonly RUNNER_IMAGE_JOBS=(
  "${RUNNER_JOB}" "${CENTRALUS_RUNNER_JOB}" "${WESTUS2_RUNNER_JOB}" "${NARRATIVE_JOB}" "${ROLLUP_JOB}" "${RECONCILE_JOB}" "${RETENTION_JOB}"
)

# ---------------------------------------------------------------------------
# classify_paths — decide whether a set of changed files (newline-separated on stdin, as
# `git diff --name-only` produces) means the newest-image≠HEAD mismatch is EXPECTED or
# AMBIGUOUS.
#
# Echoes:
#   "benign"  — EVERY changed path is non-image-producing (infra/docs/scripts). HEAD simply
#               didn't trigger a runner build, so the newest image IS the right one to deploy.
#   "prompt"  — ANY path is image-producing OR unclassifiable. CI should have built a new
#               image (or might still be); a human should decide.
#
# IMAGE-PRODUCING globs MIRROR the CD trigger (.github/workflows/deploy.yml `on.push.paths`),
# the single source of truth for "what makes a new runner/migrate image":
#       runner/**   db/**   **/Dockerfile   .github/workflows/deploy.yml
# Anything matching those => a build is expected => "prompt".
#
# BENIGN allowlist (explicit, NOT just "everything else"): infra/, scripts/, docs/, any *.md,
# other .github/ files (workflows besides deploy.yml, etc.), and the known top-level repo
# meta files. A path matching NEITHER list is treated as image-producing ("prompt") —
# CONSERVATIVE by design (same lean-to-caution bias as the drop-gate): a false prompt costs
# one keypress; a false silent-proceed could ship a stale image when code actually changed.
#
# Empty input (no file changes between image and HEAD) => "benign".
classify_paths() {
  local p
  # `|| [[ -n "$p" ]]` so a final line with no trailing newline is still processed.
  while IFS= read -r p || [[ -n "${p}" ]]; do
    [[ -z "${p}" ]] && continue
    case "${p}" in
      # --- image-producing (mirror deploy.yml paths) -> a build is expected -> prompt ---
      runner/*|db/*|Dockerfile|*/Dockerfile|.github/workflows/deploy.yml)
        echo "prompt"; return 0 ;;
      # --- known-benign infra/docs/meta -> no build expected -> keep scanning ---
      infra/*|scripts/*|docs/*|*.md|.github/*|LICENSE|.gitignore|.gitattributes|.npmrc|.dockerignore)
        : ;;
      # --- anything else is unclassifiable -> conservative -> prompt ---
      *)
        echo "prompt"; return 0 ;;
    esac
  done
  echo "benign"
}

# ---------------------------------------------------------------------------
# deploy_action_for_mismatch — DECIDE what to do when the newest DEPLOYABLE image (the newest SHA
# present in BOTH the runner+migrate repos) is NOT main HEAD. Pure + unit-testable.
#   $1 verdict (from mismatch_verdict): benign | prompt | unresolved
#   $2 whatif_only (0/1)
# Echoes one of:
#   proceed-infra — benign: HEAD changed only infra/docs/scripts since the image, so CI built no
#                   new image; deploy it silently (the SMART infra-only skip — UNCHANGED behavior).
#   preview       — non-benign but --what-if-only: a dry-run ships nothing, so preview the diff
#                   against the (stale) image for information (with a loud caveat at the call site).
#   halt          — non-benign + a REAL deploy: REFUSE. The image PREDATES HEAD's runner code, so
#                   deploying it would apply HEAD's DB migrations WITHOUT the matching runner code
#                   (the DB-ahead-of-code half-state). NOT a prompt — like a what-if DROP this hazard
#                   is never auto-proceeded and --yes does NOT bypass it; the escape hatch is --sha.
deploy_action_for_mismatch() {
  local verdict="$1" whatif_only="${2:-0}"
  case "${verdict}" in
    benign) echo "proceed-infra" ;;
    *)      [[ "${whatif_only}" -eq 1 ]] && echo "preview" || echo "halt" ;;
  esac
}

# ---------------------------------------------------------------------------
# confirm_drop — the what-if DROP gate. Returns 0 to proceed, 1 to abort. Requires the user
# to type the literal "yes". ★ DELIBERATELY does NOT consult ASSUME_YES: a detected drop
# (deleted resource / removed job env key / removed secret) is NEVER auto-proceeded, so
# `--yes` can never bypass it. Reads from stdin so it's unit-testable.
confirm_drop() {
  local ans
  printf "  To deploy despite the drop above, type 'yes' (--yes does NOT skip this): " >&2
  read -r ans
  [[ "${ans}" == "yes" ]]
}

# ---------------------------------------------------------------------------
# newest_common_sha — BUG 1 fix. The runner and migrate images are built together for the
# same commit; the auto-pick must deploy a SHA that exists in BOTH repos, or a deploy can
# half-apply (runner job rolls to SHA, migrate job's update to a not-yet-pushed migrate:SHA
# fails -> migrate stays stale -> migrations silently don't apply). Given the runner tags
# (newline, newest-first) as $1 and the migrate tags (newline) as $2, echo the newest runner
# tag that ALSO exists in the migrate repo (empty if there is no common tag).
newest_common_sha() {
  local runner_tags="$1" migrate_tags="$2" t
  while IFS= read -r t || [[ -n "${t}" ]]; do
    [[ -z "${t}" ]] && continue
    # Exact-line membership test against the migrate tag list.
    if printf '%s\n' "${migrate_tags}" | grep -qxF "${t}"; then
      printf '%s' "${t}"
      return 0
    fi
  done <<< "${runner_tags}"
  return 1
}

# ---------------------------------------------------------------------------
# migrations_in_diff — BUG 3 detection. Reads `git diff --name-only <prev>..<new>` output on
# stdin; echoes (one per line) the migration "version" (filename without .sql) for each
# ADDED/CHANGED path under db/migrations/*.sql. Empty output => the deploy shipped no
# migration => no need to run the migrate job. Used to gate the auto-run of the migrate job.
migrations_in_diff() {
  local p base
  while IFS= read -r p || [[ -n "${p}" ]]; do
    case "${p}" in
      db/migrations/*.sql)
        base="${p##*/}"
        echo "${base%.sql}" ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# image_eq — are two image refs the SAME image? Exact match, OR (for SHA tags) one tag is a SHA-prefix
# of the other. The deploy's expected image is `repo:${SHA}`, but a job's ACTUAL tag may be the FULL
# 40-char SHA while the expected is a SHORT 12-char prefix (or vice-versa) — the SAME image. An exact
# `==` FALSE-FAILs that (the #147 cry-wolf: expected 9e97f142df39, actual 9e97f142df39…2055). The
# host/repo MUST still match exactly, and the shorter tag must be a >=7-char HEX prefix (git short-sha
# minimum) of the longer — so a genuinely DIFFERENT sha, a different repo, or a non-sha tag is NEVER a
# false match (it still FAILs, catching a real stale/wrong image).
image_eq() {
  local a="$1" b="$2"
  [[ "${a}" == "${b}" ]] && return 0                 # exact (the common full==full case)
  local arepo="${a%:*}" atag="${a##*:}" brepo="${b%:*}" btag="${b##*:}"
  [[ "${arepo}" == "${brepo}" ]] || return 1         # different host/repo → real mismatch
  local short long
  if (( ${#atag} <= ${#btag} )); then short="${atag}"; long="${btag}"; else short="${btag}"; long="${atag}"; fi
  # same image only if the shorter tag is a >=7-char hex SHA-prefix of the longer one.
  [[ "${short}" =~ ^[0-9a-f]{7,}$ && "${long}" == "${short}"* ]]
}

# image_mismatches — BUG 2 verify. A correct deploy puts EVERY job on the intended image:
# the migrate job on the migrate image, every other job on the runner image. Reads a
# "<job>\t<actual-image>" line per job on stdin; given the expected runner image as $1 and
# migrate image as $2, echoes the name of each job whose actual image != expected (and of any
# job whose actual image is empty — an absent/unreadable job is a failure). Empty output =>
# all jobs are on the intended image. This is what would have caught today's split (the migrate
# job stuck on the old SHA while the runner job rolled). The compare is SHA-prefix-aware (image_eq)
# so a short-expected-vs-full-actual tag of the SAME commit is not a false FAIL (the #147 cry-wolf).
image_mismatches() {
  local runner_img="$1" migrate_img="$2" job actual exp
  while IFS=$'\t' read -r job actual || [[ -n "${job}" ]]; do
    [[ -z "${job}" ]] && continue
    case "${job}" in
      *migrate*) exp="${migrate_img}" ;;
      *)         exp="${runner_img}" ;;
    esac
    image_eq "${actual}" "${exp}" || echo "${job}"
  done
}

# ---------------------------------------------------------------------------
# unapplied_versions — FIX 1 (git-independent migration detection). Reads the on-disk migration
# "versions" (filenames without .sql, one per line) on stdin; given the APPLIED versions (from
# schema_migrations, newline-separated) as $1, echoes each on-disk version NOT yet applied.
# Empty output => everything on disk is already in schema_migrations (nothing to run). This is
# the robust fallback when the git deploy-range is degenerate (SHA..SHA) or unresolvable: it
# needs no git at all — just the DB's applied set vs the files present. (migrate.sh is
# idempotent, so running the migrate job on the result is always safe.)
unapplied_versions() {
  local applied="$1" v
  while IFS= read -r v || [[ -n "${v}" ]]; do
    [[ -z "${v}" ]] && continue
    grep -qxF "${v}" <<< "${applied}" || echo "${v}"
  done
}

# ---------------------------------------------------------------------------
# post_reconcile — FIX 2. After a successful deploy, trigger the reconcile job, WAIT for it,
# then print the resulting post-deploy state (spec_catalog + reconcile_drift) so the operator
# sees it in one command instead of manually sleeping + re-querying. Returns non-zero if the
# reconcile job failed. Uses az/psql/sleep (stubbable in tests) + env: RG, RECONCILE_JOB,
# DATABASE_URL, RECONCILE_POLL_TRIES (default 9 × ~10s ≈ 90s). Plain output (no colors) so it's
# sourceable + unit-testable; deploy.sh prints a colored header before calling it.
post_reconcile() {
  local exec_name status tries=0 max="${RECONCILE_POLL_TRIES:-9}"
  printf 'Post-deploy reconcile: starting %s…\n' "${RECONCILE_JOB}"
  exec_name="$(az containerapp job start -n "${RECONCILE_JOB}" -g "${RG}" --query name -o tsv 2>/dev/null)" \
    || { printf '  ERROR: could not start %s\n' "${RECONCILE_JOB}"; return 1; }
  printf '  started %s; waiting up to %ss for it to finish…\n' "${exec_name}" "$(( max * 10 ))"
  while (( tries < max )); do
    status="$(az containerapp job execution show -n "${RECONCILE_JOB}" -g "${RG}" \
                --job-execution-name "${exec_name}" --query properties.status -o tsv 2>/dev/null || true)"
    case "${status}" in
      Succeeded) printf '  %s Succeeded.\n' "${RECONCILE_JOB}"; break ;;
      Failed|Degraded|Cancelled)
        printf '  ERROR: %s ended: %s\n' "${RECONCILE_JOB}" "${status}"; return 1 ;;
    esac
    sleep 10
    tries=$(( tries + 1 ))
  done
  [[ "${status}" == "Succeeded" ]] \
    || printf '  WARN: %s not confirmed Succeeded within the wait; showing current state.\n' "${RECONCILE_JOB}"

  # Post-deploy state (best-effort; a psql failure shows '?').
  local catalog_total catalog_runnable drift_summary
  catalog_total="$(psql "${DATABASE_URL}" -tA -c 'SELECT count(*) FROM spec_catalog' 2>/dev/null || echo '?')"
  catalog_runnable="$(psql "${DATABASE_URL}" -tA -c 'SELECT count(*) FROM spec_catalog WHERE runnable' 2>/dev/null || echo '?')"
  drift_summary="$(psql "${DATABASE_URL}" -tA -c "SELECT coalesce(string_agg(drift_type||'='||c, ', ' ORDER BY drift_type), 'none') FROM (SELECT drift_type, count(*) c FROM reconcile_drift GROUP BY drift_type) t" 2>/dev/null || echo '?')"
  printf '  spec_catalog: %s row(s), %s runnable\n' "${catalog_total}" "${catalog_runnable}"
  printf '  reconcile_drift: %s\n' "${drift_summary}"
  return 0
}

# ---------------------------------------------------------------------------
# git_drift_state — classify local HEAD vs origin/main WITHOUT touching the working tree. The deploy
# TARGET is always origin/main (the CI-built, deployable truth); this only decides what to WARN.
#   same     — local HEAD == origin/main.
#   behind   — local is an ancestor of origin/main (fast-forwardable; a stale checkout).
#   stale    — local has commit(s) NOT literally on origin/main, but EVERY one is already present on
#              origin as an equivalent patch (a squash-merge leftover: your PR merged as a new squash
#              SHA, so the pre-squash local commit isn't an ancestor, yet its CHANGES are on origin).
#              Benign — nothing un-merged is at risk; the local commits are safe to discard.
#   diverged — local has commit(s) whose changes are NOT on origin (GENUINE unpushed work — an orphan
#              never pushed/built; it has no image and must NOT be the deploy target). The loud case.
# Distinguishing stale from diverged: `git cherry <origin> <local>` marks each local-only commit '-'
# (an equivalent patch exists upstream — squash-merged) or '+' (no equivalent — real new work). If there
# is ≥1 local-only commit and NONE are '+', local is fully subsumed by origin → stale. Any '+' (or an
# error / an unmatched multi-commit squash) stays diverged — when unsure, keep the louder warning.
# Pure (just two SHAs + the repo's commit graph) so it's unit-testable. Returns the word on stdout.
git_drift_state() {
  local local_head="$1" origin_head="$2" cherry
  if [[ "${local_head}" == "${origin_head}" ]]; then echo "same"; return; fi
  if git merge-base --is-ancestor "${local_head}" "${origin_head}" 2>/dev/null; then echo "behind"; return; fi
  cherry="$(git cherry "${origin_head}" "${local_head}" 2>/dev/null)" || { echo "diverged"; return; }
  if [[ -n "${cherry}" ]] && ! grep -q '^+' <<<"${cherry}"; then echo "stale"; return; fi
  echo "diverged"
}

# ---------------------------------------------------------------------------
# ci_wait_verdict — FIX 3 (CI-timing race). When the newest DEPLOYABLE image predates the target
# (the DB-ahead-of-code halt), the deploy can WAIT for CI to finish building the target instead of
# erroring out. This PURE function decides each poll tick from two facts the loop supplies:
#   $1 target_built — "1" if the TARGET sha's image is present in BOTH the runner+migrate repos.
#   $2 ci_conclusion — the target's CI (deploy.yml) run conclusion/status, "" if unknown/absent.
# Echoes:
#   proceed — the target's images exist (CI finished the build) → deploy the target. The guard is
#             intact: we proceed ONLY once the target's OWN image is built, never a predating one.
#   refuse  — CI ended in a NON-success terminal state → the image will never appear → REFUSE now
#             (don't wait out the timeout). Preserves the "no auto-deploy past a real CI failure" rule.
#   wait    — anything else (in_progress / queued / success-but-image-not-yet-pushed / unknown) →
#             keep polling. A "success" with no image yet still WAITs (registry push lag), so we only
#             ever proceed on a real, present image.
# ★ Only target_built=1 yields proceed — a CI failure or a timeout (the loop's fallback) still
# refuses, so DB-ahead-of-code can never be auto-shipped.
ci_wait_verdict() {
  local target_built="$1" ci_conclusion="${2:-}"
  [[ "${target_built}" == "1" ]] && { echo "proceed"; return; }
  case "${ci_conclusion}" in
    failure|cancelled|timed_out|startup_failure|action_required|stale) echo "refuse" ;;
    *)                                                                  echo "wait" ;;
  esac
}

# ---------------------------------------------------------------------------
# retry_nonempty — FIX 1 (verify mid-reconciliation false-empty). Runs the command "$@"; if its
# stdout is blank, retries up to VERIFY_READ_TRIES (default 8) with VERIFY_READ_SLEEP (default 5s)
# between, then echoes the last stdout. The post-deploy VERIFY reads (job env value/secretRef/image)
# can transiently read empty while a just-rolled job revision is still reconciling — `2>/dev/null ||
# true` then swallows that into "" and the check FALSE-FAILs (the ACS-secretRef cry-wolf). ★ A
# GENUINELY-absent/wiped value stays empty across ALL retries, so the caller's check still FLUNKS —
# the guard keeps its teeth; only the transient is absorbed. A present value returns on the 1st try.
# Lives here (not deploy.sh) so the unit test drives the EXACT shipped logic.
retry_nonempty() {
  local out='' i
  for (( i = 1; i <= ${VERIFY_READ_TRIES:-8}; i++ )); do
    out="$("$@" 2>/dev/null || true)"
    [[ -n "${out//[$' \t\r\n']/}" ]] && break
    (( i < ${VERIFY_READ_TRIES:-8} )) && sleep "${VERIFY_READ_SLEEP:-5}"
  done
  printf '%s' "${out}"
}

# ── Config-value extraction from the DEPLOYED bicep (data-driven verify) ─────────────────────────────
# The infra silent-drop class (#250 replicaTimeout 240→660, #253 memory 2Gi→4Gi) shipped a CURRENT image
# with a STALE template and PASSED verify() — which checked images/env/secretRefs but NEVER these
# container/config values — so the drop surfaced weeks later as a runtime OOM/strand. These PURE helpers
# read the EXPECTED value straight out of the deployed template so verify() stays correct as values change
# (never a hardcoded 660/4Gi). Kept here so deploy_test.sh drives the EXACT shipped logic.

# bicep_block <resource-ident> : stdin = bicep text → the `resource <ident> '…' = { … }` block, up to the
# next TOP-LEVEL `resource `/`module ` (both start at column 0). The trailing space in the head makes
# `job` match `resource job '…'` but NOT `resource centralusJob`/`jobFoo`.
bicep_block() {
  awk -v head="resource $1 " '
    index($0, head) == 1 { inblk = 1 }
    inblk && (index($0, "resource ") == 1 || index($0, "module ") == 1) && index($0, head) != 1 { inblk = 0 }
    inblk { print }
  '
}

# bicep_field <resource-ident> <replicaTimeout|cpu|memory> : stdin = bicep → the value on that job
# resource (empty if absent). cpu unwraps json('X'); memory strips the quotes; replicaTimeout is the int.
bicep_field() {
  local block; block="$(bicep_block "$1")"
  # ★ Each case ends in `|| true`: a field ABSENT from the block makes the grep pipeline exit non-zero,
  # which — since verify() reads this via `exp="$(bicep_field …)"` under `set -euo pipefail` — would abort
  # the whole DEPLOY instead of letting num_eq/`<none in template>` flunk it gracefully. Absence must yield
  # EMPTY (a flunk), never a hard exit (a future bicep reformat that drops/moves a value must fail loud in
  # verify(), not kill the deploy mid-run).
  case "$2" in
    replicaTimeout) printf '%s' "${block}" | grep -oE 'replicaTimeout:[[:space:]]*[0-9]+' | head -1 | grep -oE '[0-9]+' || true ;;
    cpu)            printf '%s' "${block}" | grep -oE "cpu:[[:space:]]*json\('[0-9.]+'\)" | head -1 | grep -oE "[0-9.]+" || true ;;
    memory)         printf '%s' "${block}" | grep -oE "memory:[[:space:]]*'[0-9A-Za-z.]+'" | head -1 | sed -E "s/memory:[[:space:]]*'//; s/'//" || true ;;
  esac
}

# num_eq <a> <b> : equality tolerant of 2 vs 2.0 vs 2.00 (cpu is json('2.0') in bicep, 2 or 2.0 live).
# Both numeric → numeric compare; otherwise exact string compare. Empty expected → never matches (so a
# value absent from the template can't silently "pass"). Exit 0 = equal.
num_eq() {
  [[ -z "$1" ]] && return 1
  awk -v a="$1" -v b="$2" 'BEGIN{
    if (a ~ /^[0-9]+(\.[0-9]+)?$/ && b ~ /^[0-9]+(\.[0-9]+)?$/) { exit !((a+0) == (b+0)) }
    exit !(a == b)
  }'
}

# mem_eq <expected> <live> : memory equality — EXACT string ('4Gi' is a unit value, no numeric tolerance).
# Empty expected → never matches (a value absent from the template must FLUNK, not silently pass — same
# teeth as num_eq). Exit 0 = equal. Split from num_eq because MEMORY is the value the #253/#256 drop lost:
# a 2Gi template shipped atop a 4Gi image and verify() (comparing live 2Gi to the STALE 2Gi template)
# passed. verify() + reconcile_resources share this so the compare is tested in one place.
mem_eq() {
  [[ -n "$1" && "$1" == "$2" ]]
}

# image_covered_by_template <image_sha> <template_ref> : exit 0 IFF the deployed image's commit is an
# ancestor-OR-EQUAL of the template commit — i.e. the template does NOT predate the image it ships. THE
# #253/#256 stale-template guard: shipping an ANCESTOR's template atop a current image (a 2Gi ancestor
# template on the current 4Gi image — confirmed at synthwatch-deploy-20260711-164541, templateHash
# 5669735136662207502 == commit 3a2f955's 2Gi bicep) is the silent drop that verify() then validated against
# and PASSED. Exit non-zero = STALE/unrelated → materialize REFUSES. Pure over git (no network); both refs
# must be present locally (materialize fetches the image commit first, then requires it).
image_covered_by_template() {
  git merge-base --is-ancestor "$1" "$2" 2>/dev/null
}

# ── template-derived RBAC + CORS expectations (verify() concern A) ─────────────────────────────────────────
# verify() must assert what the TEMPLATE DECLARES (data-driven), not a hand-curated subset that only grows
# after a failure (the memory-drop class). These pure parsers pull the expected role assignments + CORS
# origins straight from the materialized bicep; verify() resolves them live + FLUNKS on any that isn't there.

# bicep_var <name> : stdin = bicep → the value of `var <name> = '<value>'` (e.g. a role-definition GUID). Empty
# if absent (a flunk, never a set-e abort — like bicep_field).
bicep_var() {
  sed -nE "s/^var $1 = '([^']+)'.*/\1/p" | head -1
}

# bicep_param <name> : stdin = bicep → the default of `param <name> string = '<value>'` (the materialized
# template carries every param's default literal). Empty if absent.
bicep_param() {
  sed -nE "s/^param $1 string = '([^']+)'.*/\1/p" | head -1
}

# bicep_param_array <name> : stdin = bicep → each quoted string inside `param <name> array = [ … ]`, one per
# line (e.g. the CORS allowed-origins list). Empty if absent.
bicep_param_array() {
  awk -v name="$1" '
    $0 ~ ("^param " name " array = \\[") { inblk=1; next }
    inblk && /^\]/ { inblk=0 }
    inblk { print }
  ' | grep -oE "'[^']+'" | sed "s/'//g"
}

# role_assignments_from_template : stdin = bicep → one TSV line per Microsoft.Authorization/roleAssignments
# resource: `<roleDefVarName>\t<principalToken>\t<scopeToken>` — the raw bicep tokens (verify() resolves each
# to a live GUID / principalId / scope id, and FLUNKS an unknown token so a NEW assignment can't slip past
# unasserted). Parses each top-level resource block (its closing `}` is at column 0; nested braces are
# indented). Emits nothing for a malformed block (missing a field), which a count check in verify() catches.
role_assignments_from_template() {
  awk '
    /^resource[[:space:]].*Microsoft\.Authorization\/roleAssignments/ { inblk=1; rv=""; pr=""; sc=""; next }
    inblk {
      if (index($0, "roleDefinitionId:") && index($0, "roleDefinitions")) {
        line=$0; sub(/.*roleDefinitions[^,]*,[[:space:]]*/, "", line); sub(/\).*/, "", line); rv=line
      } else if ($0 ~ /^[[:space:]]*principalId:/ && pr=="") {
        line=$0; sub(/^[[:space:]]*principalId:[[:space:]]*/, "", line); sub(/[[:space:]].*/, "", line); pr=line
      } else if ($0 ~ /^[[:space:]]*scope:/ && sc=="") {
        line=$0; sub(/^[[:space:]]*scope:[[:space:]]*/, "", line); sub(/[[:space:]].*/, "", line); sc=line
      }
      if ($0 ~ /^}/) { if (rv!="" && pr!="" && sc!="") print rv "\t" pr "\t" sc; inblk=0 }
    }
  '
}

# contains_line <needle> : stdin = a newline list → exit 0 IFF <needle> is an EXACT line. Empty stdin → 1 (a
# value that must be present but the live list is empty MUST flunk, never silently pass — same teeth as
# num_eq/mem_eq). The tested comparator behind verify()'s RBAC + CORS assertions.
contains_line() {
  local needle="$1" line
  # `|| [[ -n "${line}" ]]` processes a FINAL line with no trailing newline — the shape `printf '%s' "$live"`
  # produces for a single-item az result. Without it a lone live role/origin (no newline) is silently skipped
  # → a real grant/CORS rule reads as MISSING (false flunk) — or worse, the last of several is never checked.
  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ "${line}" == "${needle}" ]] && return 0
  done
  return 1
}

# ── stale-deploy-script guard (concern B) ──────────────────────────────────────────────────────────────────
# deploy.sh DEPLOYS origin/main's template + image, but EXECUTES the local working-tree copy of ITSELF (and
# its libs). If those are stale vs origin/main, the deploy silently runs OLD logic — merged fixes that are NOT
# running (#254's secret removal, #268's resource-reconcile were merged but not executing). Being behind on
# the SCRIPT is never benign; the template is materialized from origin, the script is not.
#
# script_differs_from_ref <repo> <ref> <relpath> : exit 0 IFF <repo>/<relpath> (the running copy) differs in
# CONTENT from <ref>:<relpath> — i.e. STALE/edited vs the ref. Exit 1 if identical OR the ref lacks the path
# (can't compare → not "stale"; the caller logs a skip). CONTENT compare, so a tree behind only on UNRELATED
# files is not flagged. The tested core of assert_deploy_scripts_current.
script_differs_from_ref() {
  local repo="$1" ref="$2" relpath="$3"
  git -C "${repo}" cat-file -e "${ref}:${relpath}" 2>/dev/null || return 1   # ref lacks it → not stale
  ! diff -q <(git -C "${repo}" show "${ref}:${relpath}") "${repo}/${relpath}" >/dev/null 2>&1
}

# cors_origins_tokens : stdin = bicep → the param token of EVERY blob corsRule's `allowedOrigins:` (one per
# line), so verify_cors asserts all rules' origins, not just the first (the data-driven guarantee is
# N-rules-deep). Empty if none. (Inline `allowedOrigins: [ … ]` arrays yield no token — a param ref is
# expected; verify_cors flunks an unresolvable token rather than skipping it.)
cors_origins_tokens() {
  sed -nE 's/^[[:space:]]*allowedOrigins:[[:space:]]*([A-Za-z0-9_]+).*/\1/p'
}

# template_declares_cors <bicep-text> : exit 0 IFF the bicep declares a blob-service corsRules block. Takes the
# template as an ARGUMENT (not stdin) DELIBERATELY. The old inline `printf '%s' "$tmpl" | grep -q corsRules`
# under `set -o pipefail` made grep -q short-circuit on the FIRST match and close the pipe, so printf took
# SIGPIPE and the PIPELINE's status became 141 (printf's), not 0 (grep's) — and `! <pipeline>` inverted that to
# "no CORS": a VACUOUS PASS precisely WHEN corsRules WAS present (it matched early), plus the "printf: write
# error: Broken pipe" noise. A pure-bash `[[ == *…* ]]` has no subprocess / pipe / early-exit, so it reads the
# TRUE presence and can never SIGPIPE — "template declares no CORS" becomes a reliable, RARE state, never a
# parse miss masquerading as a pass. (Same fix shape as the #155 tag-membership here-string.)
template_declares_cors() {
  [[ "$1" == *corsRules* ]]
}

# ── start-of-run tree-sync policy (concern: run current logic by construction) ─────────────────────────────
# tree_sync_decision <branch> <local_sha> <origin_sha> <is_ancestor 0|1> <dirty 0|1> : the PURE policy the
# START-OF-RUN SYNC block in deploy.sh implements — kept here so it's unit-tested (the block computes the git
# facts + acts; this decides). Prints exactly one verdict:
#   not-main  → the checkout isn't on 'main'                          → ABORT (never reset a feature branch)
#   current   → local == origin/main (or origin unresolvable)         → proceed as-is
#   ff        → local is strictly BEHIND origin/main + tree clean      → fast-forward (reset --hard) + re-exec
#   dirty     → behind, but uncommitted TRACKED changes               → ABORT (fast-forward would discard work)
#   diverged  → local has commit(s) NOT on origin (ahead/squash-left) → proceed, NEVER auto-reset (preserve work)
# is_ancestor = 1 iff local_sha is an ancestor-or-equal of origin_sha (git merge-base --is-ancestor).
tree_sync_decision() {
  local branch="$1" lsha="$2" osha="$3" is_anc="$4" dirty="$5"
  [[ "${branch}" != "main" ]] && { echo "not-main"; return; }
  [[ -z "${osha}" || "${lsha}" == "${osha}" ]] && { echo "current"; return; }
  if [[ "${is_anc}" == "1" ]]; then
    [[ "${dirty}" == "1" ]] && { echo "dirty"; return; }
    echo "ff"; return
  fi
  echo "diverged"
}
