# shellcheck shell=bash
# deploy-lib.sh — pure, sourceable helpers for scripts/deploy.sh, factored out so the unit
# test (scripts/deploy_test.sh) exercises the EXACT logic the deploy uses (no drift). No
# top-level side effects; sourcing this runs nothing.

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
# image_mismatches — BUG 2 verify. A correct deploy puts EVERY job on the intended image:
# the migrate job on the migrate image, every other job on the runner image. Reads a
# "<job>\t<actual-image>" line per job on stdin; given the expected runner image as $1 and
# migrate image as $2, echoes the name of each job whose actual image != expected (and of any
# job whose actual image is empty — an absent/unreadable job is a failure). Empty output =>
# all jobs are on the intended image. This is what would have caught today's split (the
# migrate job stuck on the old SHA while the runner job rolled).
image_mismatches() {
  local runner_img="$1" migrate_img="$2" job actual exp
  while IFS=$'\t' read -r job actual || [[ -n "${job}" ]]; do
    [[ -z "${job}" ]] && continue
    case "${job}" in
      *migrate*) exp="${migrate_img}" ;;
      *)         exp="${runner_img}" ;;
    esac
    [[ "${actual}" == "${exp}" ]] || echo "${job}"
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
