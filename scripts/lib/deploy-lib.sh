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
# confirm_head_mismatch — the AMBIGUOUS newest-image≠HEAD gate. Returns 0 to proceed, 1 to
# abort. Honors the non-interactive flags: WHATIF_ONLY (no deploy happens anyway) and
# ASSUME_YES (--yes: the user pre-decided). Otherwise asks [y/N] (default No).
# Reads from stdin so it's unit-testable.
confirm_head_mismatch() {
  if [[ "${WHATIF_ONLY:-0}" -eq 1 || "${ASSUME_YES:-0}" -eq 1 ]]; then
    return 0
  fi
  local ans
  printf '      Deploy the existing image anyway? [y/N] ' >&2
  read -r ans
  [[ "${ans}" == "y" || "${ans}" == "Y" ]]
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
