#!/usr/bin/env bash
# Per-module mutation gate (task #12). ONE place defines, for each of the 6 highest-risk modules: the
# module-subset test command (test-subsetting drops per-mutant cost 35s → ~10s — the lever that makes this
# affordable), the mutate scope, and the RATCHETING break threshold derived from the measured POST-FIX baseline.
#
# Usage:  scripts/mutation.sh <module> [--incremental | --full-refresh | --deps]
#   --incremental  : PR-time — Stryker restores the nightly's cache and re-tests ONLY the mutants in changed
#                    code (a ~30-LOC evaluate.ts PR ≈ 1-2 min), then writes the refreshed cache. FAILS below
#                    the module's break threshold (blocking).
#   --full-refresh : NIGHTLY — CLEAR the incremental file first so EVERY mutant is tested (a true full sweep,
#                    unchanged from the old nightly), then run with incremental ENABLED so Stryker PERSISTS
#                    the ~100KB+ cache the PR gate restores. ★ The old nightly ran with NO flag → incremental
#                    was false → Stryker NEVER WROTE the cache (it only writes when incremental:true) → every
#                    saved CI cache was a ~200-byte empty-dir tarball → every PR restored empty and re-ran the
#                    FULL module (evaluate = 55 min). This mode is the fix: same full sweep, but it saves its work.
#   --deps         : print (newline-separated) the source + test files this module's score depends on — the PR
#                    matrix uses it to decide whether this module's job needs to run for a given diff. No run.
#   (omit)         : ad-hoc full run, no cache read/write (verify.sh's devcontainer smoke check).
#
# ★ Per-module thresholds, NEVER a single global floor: retry.ts is 100% with ZERO survivors — a global
# floor at min−margin (≈20%) would let it rot to 20%. Each break is floor(measured post-fix) − 3.
# ★ rca.ts mutates ONLY its pure-function surface (159-384): SYSTEM_PROMPT (prompt text is not logic) and the
# model/DB orchestration (gatherContext+, needs integration not unit tests) are excluded — the honest surface
# score, not the prompt-and-orchestration-dragged raw. Re-derive on the nightly if the line range drifts.
set -euo pipefail
MODULE="${1:?usage: mutation.sh <module> [--incremental | --full-refresh | --deps]}"
MODE="${2:-}"

case "$MODULE" in
  retry)
    CMD="node --test dist/retry.test.js"
    MUTATE='["retry.ts"]'; BREAK=97 ;;
  transientClass)
    CMD="node --test dist/transientClass.test.js dist/transientClassConsole.test.js"
    MUTATE='["transientClass.ts"]'; BREAK=76 ;;
  traceSignals)
    CMD="node --test dist/traceSignals.test.js"
    MUTATE='["traceSignals.ts"]'; BREAK=69 ;;
  rca)
    CMD="node --test dist/rca.test.js"
    # pure-function surface: extractTraceFacts + renderFactPack cite-logic (159-246) and validateCites /
    # evidenceThin / deterministicResult / rcaScreenshotUrls (284-384). Excludes SYSTEM_PROMPT, the render TEXT
    # (247-283), and the model/DB orchestration (gatherContext+). Measured surface 52.4%; break carries extra
    # margin. Measured on THIS scope: 62.5% (higher than the whole-module surface — the range is tighter).
    MUTATE='["rca.ts:159-246","rca.ts:284-384"]'; BREAK=59 ;;   # 62.5% − margin
  evaluate)
    CMD="node --test dist/evaluate.test.js dist/evaluate.integration.test.js dist/confirmationRetry.integration.test.js dist/transientBaselineSuccess.integration.test.js dist/countableRun.integration.test.js"
    MUTATE='["evaluate.ts"]'; BREAK=28 ;;   # measured 31.8% (post #307/#308) − margin
  reconcile)
    CMD="node --test dist/reconcile.test.js dist/reconcileApply.integration.test.js"
    MUTATE='["reconcile.ts"]'; BREAK=71 ;;   # measured 74.5% − margin
  *) echo "unknown module: $MODULE" >&2; exit 2 ;;
esac

# --deps: the single source of truth for "what files does this module's mutation score depend on" — the
# mutate source file(s) (line-ranges stripped) + the test sources in CMD (dist/X.test.js -> runner/X.test.ts).
# The PR matrix reads this LIVE from this script, so the change-detector can never drift from the real config
# (edit CMD/MUTATE here and the matrix follows automatically). Prints nothing else; runs no mutation.
if [ "$MODE" = "--deps" ]; then
  {
    printf '%s\n' "$MUTATE" | grep -oE '[A-Za-z0-9_]+\.ts'
    printf '%s\n' "$CMD"    | grep -oE 'dist/[A-Za-z0-9_.]+\.test\.js' | sed 's#^dist/##; s#\.js$#.ts#'
  } | sort -u | sed 's#^#runner/#'
  exit 0
fi

# Mode → whether Stryker reads/writes the incremental cache. ★ Stryker only WRITES the cache when
# incremental:true, so BOTH the PR gate and the nightly must set it true; the nightly additionally CLEARS
# the file first so every mutant is tested (a true full sweep that also persists a complete cache).
INCREMENTAL="false"
case "$MODE" in
  --incremental)  INCREMENTAL="true" ;;
  --full-refresh) INCREMENTAL="true"; rm -f ".stryker-incremental/$MODULE.json" ;;
  "")             ;;
  *) echo "unknown mode: $MODE (use --incremental | --full-refresh | --deps)" >&2; exit 2 ;;
esac

mkdir -p reports/mutation .stryker-incremental
# Stryker 9.6.1 mis-validates a config passed via -c (a spurious "concurrency" error); the DEFAULT
# stryker.conf.json path is clean. Write it, run, remove it. In CI each matrix module is its own checkout, so
# there is no collision; stryker.conf.json is gitignored so a stray one is never committed.
CONF="stryker.conf.json"
trap 'rm -f "$CONF"' EXIT
cat > "$CONF" <<JSON
{
  "packageManager": "npm",
  "testRunner": "command",
  "commandRunner": { "command": "$CMD" },
  "buildCommand": "tsc",
  "mutate": $MUTATE,
  "coverageAnalysis": "off",
  "disableTypeChecks": true,
  "timeoutMS": 30000,
  "incremental": $INCREMENTAL,
  "incrementalFile": ".stryker-incremental/$MODULE.json",
  "reporters": ["clear-text", "json"],
  "jsonReporter": { "fileName": "reports/mutation/$MODULE.json" },
  "thresholds": { "break": $BREAK }
}
JSON

echo "▶ mutation gate: $MODULE  (break=$BREAK%, incremental=$INCREMENTAL)"
node_modules/.bin/stryker run
