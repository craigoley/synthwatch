#!/usr/bin/env bash
# Per-module mutation gate (task #12). ONE place defines, for each of the 6 highest-risk modules: the
# module-subset test command (test-subsetting drops per-mutant cost 35s → ~10s — the lever that makes this
# affordable), the mutate scope, and the RATCHETING break threshold derived from the measured POST-FIX baseline.
#
# Usage:  scripts/mutation.sh <module> [--incremental]
#   --incremental : PR-time — Stryker re-tests only the mutants in changed code (a ~30-LOC evaluate.ts PR ≈
#                   1-2 min) and FAILS below the module's break threshold (blocking).
#   (omit)        : nightly — full run; refreshes the incremental cache; the caller decides blocking-ness.
#
# ★ Per-module thresholds, NEVER a single global floor: retry.ts is 100% with ZERO survivors — a global
# floor at min−margin (≈20%) would let it rot to 20%. Each break is floor(measured post-fix) − 3.
# ★ rca.ts mutates ONLY its pure-function surface (159-384): SYSTEM_PROMPT (prompt text is not logic) and the
# model/DB orchestration (gatherContext+, needs integration not unit tests) are excluded — the honest surface
# score, not the prompt-and-orchestration-dragged raw. Re-derive on the nightly if the line range drifts.
set -euo pipefail
MODULE="${1:?usage: mutation.sh <module> [--incremental]}"
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

INCREMENTAL="false"; [ "$MODE" = "--incremental" ] && INCREMENTAL="true"

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
