#!/usr/bin/env bash
# check-pr-trigger-coverage.sh — a gate workflow must run on EVERY pull request, not just main-based ones.
#
# ★ WHY THIS EXISTS. Every PR-triggered workflow in this repo carried `pull_request: branches: [main]`, so a
#   PR targeting a NON-main base — a stacked PR — got no gate job at all. The PR page then showed only the
#   orchestration checks, which reads to a reviewer as "CI ran, nothing to do". Nothing had run. Observed in
#   synthwatch-monitors#124 and found by audit to be identical in all four SynthWatch repos.
#
#   `main` requires `ci-gate` plus a review, so nothing reached `main` ungated; the hole was the INTERMEDIATE
#   hop, where a stacked PR is reviewed and merged into its base with no run of its own. The damage is to
#   REVIEW, not to `main`: a reviewer trusts a page that asserted nothing.
#
# ★★ IN THIS REPO THE FILTER WAS ALSO A DEADLOCK WAITING TO HAPPEN. `ci-gate` fails CLOSED when a REQUIRED
#    sibling never REGISTERS a check run (the #102 class). So widening ci-gate alone — without widening the
#    workflows that produce its REQUIRED names — would make every stacked PR time out and block. The filters
#    must move together, which is exactly why this guard checks ALL workflows, not just ci-gate.
#
# HOW: for each workflow, look at the `pull_request` / `pull_request_target` trigger and require that it
#   carry no base-branch filter. `push: branches: [main]` is untouched and correct — a post-merge sweep
#   genuinely only concerns `main`.
#
# ★ EXEMPT entries need a REASON. An exemption must be a deliberate reviewed statement, never a way to
#   silence this guard. EMPTY is the healthy state.
#
# ★ NO `printf … | grep -q` ANYWHERE IN HERE. That pattern fails OPEN under `set -o pipefail`: grep -q
#   closes the pipe on its first match, the writer takes SIGPIPE (141), and pipefail reports 141 as the
#   pipeline status — inverting `if !` to the wrong branch. It bit scripts/deploy.sh three times (#155,
#   #279, #283). This script uses here-strings and awk only.
set -euo pipefail

WF_DIR="${1:-.github/workflows}"

# Workflows that may keep a main-only base filter, as `filename|reason` lines. Keep this empty if you can.
#
# ★ A NEWLINE-DELIMITED LIST, NOT AN ASSOCIATIVE ARRAY, ON PURPOSE. `declare -A` needs bash 4; macOS ships
#   bash 3.2, so the array version ran fine on CI's ubuntu and died with "declare: -A: invalid option" on
#   every developer laptop here. A gate nobody can run locally is a gate people discover only in CI — and
#   this repo's whole complaint is gates that assert nothing where you are looking.
EXEMPT='
'
exempt_reason() { awk -F'|' -v k="$1" '$1 == k { print $2; exit }' <<<"$EXEMPT"; }
exempt_names()  { awk -F'|' 'NF { print $1 }' <<<"$EXEMPT"; }
exempt_count()  { exempt_names | grep -c . || true; }

[ -d "$WF_DIR" ] || { echo "pr-trigger-coverage gate FAILED: no such directory: $WF_DIR" >&2; exit 1; }

# ★ FAIL, NEVER VACUOUSLY PASS, WHEN THERE IS NOTHING TO COMPARE. A gate that reports green while asserting
#   nothing manufactures confidence and is worse than no gate (the #279/#281 vacuous-CORS lesson). If the
#   glob matched no workflows, something is wrong with the path, not with the repo.
shopt -s nullglob
files=("$WF_DIR"/*.yml "$WF_DIR"/*.yaml)
shopt -u nullglob
[ "${#files[@]}" -gt 0 ] || { echo "pr-trigger-coverage gate FAILED: no workflow files under $WF_DIR — this gate cannot assert anything" >&2; exit 1; }

errors=(); warnings=(); checked=0

for f in "${files[@]}"; do
  base="$(basename "$f")"

  # Emits "FILTERED" if the pull_request trigger carries a branches filter, "PR" if it is PR-triggered
  # without one, and nothing at all if the workflow is not PR-triggered.
  #
  # Full-line comments are dropped FIRST: this header and the workflow headers DISCUSS `branches: [main]`
  # in prose while explaining the outage, and a guard that fires on the documentation of the bug it
  # prevents is noise — noise trains people to ignore the gate.
  verdict="$(awk '
    /^[[:space:]]*#/ { next }
    # top-level key ends any block we are tracking
    /^[A-Za-z_][A-Za-z0-9_-]*:/ { in_on = ($0 ~ /^on:/); in_pr = 0 }
    !in_on { next }
    # a 2-space key inside on: closes any pull_request sub-block
    /^[[:space:]]{1,2}[A-Za-z_][A-Za-z0-9_-]*:/ {
      in_pr = ($0 ~ /^[[:space:]]{1,2}pull_request(_target)?:/)
      if (in_pr) { seen = 1 }
      next
    }
    in_pr && /^[[:space:]]+branches(-ignore)?:/ { filtered = 1 }
    END { if (filtered) print "FILTERED"; else if (seen) print "PR" }
  ' "$f")"

  [ -n "$verdict" ] || continue
  checked=$((checked + 1))

  reason="$(exempt_reason "$base")"
  if [ "$verdict" = "FILTERED" ] && [ -z "$reason" ]; then
    errors+=("$base: its \`pull_request\` trigger carries a base-branch filter, so it does NOT run on a PR targeting a non-main base. A stacked PR then shows a page with no gate run on it and reads as gated. Remove the \`branches:\` filter (leave \`push: branches: [main]\` alone), or add $base to EXEMPT in this script WITH A REASON.")
  fi
  if [ "$verdict" = "PR" ] && [ -n "$reason" ]; then
    warnings+=("EXEMPT lists '$base', but its pull_request trigger has no base filter — remove the exemption.")
  fi
done

while IFS= read -r name; do
  [ -n "$name" ] || continue
  [ -f "$WF_DIR/$name" ] || warnings+=("EXEMPT lists '$name', which no longer exists in $WF_DIR — remove it.")
done <<<"$(exempt_names)"

for w in ${warnings+"${warnings[@]}"}; do echo "  warning: $w"; done

if [ "${#errors[@]}" -gt 0 ]; then
  echo "pr-trigger-coverage gate FAILED (${#errors[@]}):" >&2
  for e in "${errors[@]}"; do echo "  - $e" >&2; done
  exit 1
fi

echo "pr-trigger-coverage gate OK: $checked PR-triggered workflow(s) run on EVERY base ($(exempt_count) exempt)."
