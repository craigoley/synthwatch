#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# verify-handover-status.sh — RE-DERIVE every status in docs/handover/OUTSTANDING.md.
#
# ★ THE RULE THIS ENFORCES: no handover item may be marked done on the strength of a report — only on
#   the strength of its verification command's output. The register carries a command per row; this
#   script runs them all and prints the table, so "what is actually true today" is a one-liner rather
#   than a conversation.
#
# WHY: status was travelling as prose, and prose drifts. The migration plan has carried items marked
#   done that were not, and to-do that were done. A command cannot drift.
#
# USAGE:  bash scripts/verify-handover-status.sh [-q]
#   -q   quiet: table only (no per-check evidence line)
#
# EXIT CODES — deliberately NOT "1 on any NOT DONE". Most rows are legitimately outstanding; failing on
#   them would make the script useless as a routine check. It exits non-zero only when it could not
#   RUN a verification (a missing tool / lost auth), i.e. when the table would be misleading.
#     0 = every check ran (whatever it found)
#     2 = one or more checks could not run — treat the table as incomplete
#
# ★ Requires: az (logged in), gh (logged in), jq, psql + DATABASE_URL, and a synthwatch-api sibling
#   checkout for the OpenAPI row. Anything missing is reported as UNKNOWN, never guessed.
# ---------------------------------------------------------------------------
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

QUIET=0; [[ "${1:-}" == "-q" ]] && QUIET=1
UNRUNNABLE=0
ROWS=()

# row <status> <item> <evidence>
row() { local ev; ev="$(printf '%s' "$3" | tr '\n\t' '  ')"; ROWS+=("$1"$'\t'"$2"$'\t'"$ev"); [[ "$1" == "UNKNOWN" ]] && UNRUNNABLE=1; [[ $QUIET -eq 1 ]] || printf '  %-9s %-46s %s\n' "$1" "$2" "$ev"; }
have() { command -v "$1" >/dev/null 2>&1; }

[[ $QUIET -eq 1 ]] || echo "Re-deriving handover status ($(date -u +%Y-%m-%dT%H:%M:%SZ))…"
[[ $QUIET -eq 1 ]] || echo

# ── Azure ───────────────────────────────────────────────────────────────────
if have az && az account show >/dev/null 2>&1; then
  n=$(az keyvault list --query "length(@)" -o tsv 2>/dev/null || echo "?")
  [[ "$n" == "?" ]] && row UNKNOWN "CRED_ENC_KEY -> Key Vault" "az call failed" \
    || { [[ "$n" -ge 1 ]] && row DONE "CRED_ENC_KEY -> Key Vault" "$n vault(s)" \
         || row "NOT DONE" "CRED_ENC_KEY -> Key Vault" "0 key vaults in subscription"; }

  d=$(az containerapp job list -g synthwatch-rg --query "[?contains(name,'drift')].name" -o tsv 2>/dev/null)
  [[ -n "$d" ]] && row DONE "Gate B - prod<->replay drift detector" "$d" \
    || row "NOT DONE" "Gate B - prod<->replay drift detector" "no drift job among ACA jobs"

  bk=$(az postgres flexible-server show -g synthwatch-rg -n synthwatch-pg-e2 \
        --query "[backup.backupRetentionDays,backup.geoRedundantBackup,highAvailability.mode]" -o tsv 2>/dev/null | paste -sd'/' -)
  [[ -n "$bk" ]] && row PARTIAL "DR / backup topology" "retention/geo/ha = $bk (no rehearsed restore)" \
    || row UNKNOWN "DR / backup topology" "az postgres call failed"
else
  row UNKNOWN "CRED_ENC_KEY -> Key Vault" "az unavailable or not logged in"
  row UNKNOWN "Gate B - prod<->replay drift detector" "az unavailable"
  row UNKNOWN "DR / backup topology" "az unavailable"
fi

# ── rollback rehearsal: a deploy whose target commit predates the previous deploy's ──
if have gh; then
  found=0; prev=0
  while IFS=$'\t' read -r _ts sha; do
    [[ -z "$sha" ]] && continue
    cts=$(git show -s --format=%ct "$sha" 2>/dev/null || echo 0)
    [[ "$cts" -eq 0 ]] && continue
    [[ "$prev" -ne 0 && "$cts" -lt "$prev" ]] && found=$((found+1))
    prev=$cts
  done < <(gh run list --workflow deploy.yml --limit 40 --json createdAt,headSha,conclusion \
             -q '.[]|select(.conclusion=="success")|[.createdAt,.headSha]|@tsv' 2>/dev/null | sort)
  [[ "$found" -gt 0 ]] && row DONE "Rehearse a rollback" "$found rollback deploy(s) found" \
    || row "NOT DONE" "Rehearse a rollback" "0 deploys target an earlier commit"

  # monitors cart gates wired into CI? (match the GATE NAMES — `npm run check` false-positives on
  # `npm run check:matchers`, which is why this greps the gate names instead of the prefix.)
  wf=$(gh api repos/craigoley/synthwatch-monitors/contents/.github/workflows/check.yml --jq '.content' 2>/dev/null | base64 -d 2>/dev/null)
  if [[ -n "$wf" ]]; then
    c=$(grep -cE "clear-cart-gate|cart-count-gate|cart-identity-gate" <<<"$wf")
    [[ "$c" -gt 0 ]] && row DONE "monitors cart gates run in CI" "$c reference(s)" \
      || row "NOT DONE" "monitors cart gates run in CI" "0 refs - gates are local-only"
  else
    row UNKNOWN "monitors cart gates run in CI" "could not fetch check.yml"
  fi

  if gh api orgs/craigoley/actions/secrets --jq '.secrets[].name' >/dev/null 2>&1; then
    row DONE "GitHub ORG secrets enumerable" "readable"
  else
    row BLOCKED "GitHub ORG secrets enumerable" "HTTP 403 - needs admin:org scope"
  fi
else
  row UNKNOWN "Rehearse a rollback" "gh unavailable"
  row UNKNOWN "monitors cart gates run in CI" "gh unavailable"
  row UNKNOWN "GitHub ORG secrets enumerable" "gh unavailable"
fi

# ── Postgres ────────────────────────────────────────────────────────────────
if have psql && [[ -n "${DATABASE_URL:-}" ]]; then
  ch=$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM channels WHERE enabled" 2>/dev/null)
  [[ -n "$ch" ]] && { [[ "$ch" -gt 1 ]] && row DONE "On-call roster (routed, not one inbox)" "$ch enabled channels" \
      || row "NOT DONE" "On-call roster (routed, not one inbox)" "$ch enabled channel (single inbox)"; } \
    || row UNKNOWN "On-call roster (routed, not one inbox)" "query failed"

  pay=$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM checks WHERE enabled AND (name ILIKE '%checkout%' OR name ILIKE '%payment%' OR name ILIKE '%order%')" 2>/dev/null)
  [[ -n "$pay" ]] && { [[ "$pay" -gt 0 ]] && row DONE "Payment / order-placement monitoring" "$pay check(s)" \
      || row "NOT DONE" "Payment / order-placement monitoring" "0 checkout/payment/order checks"; } \
    || row UNKNOWN "Payment / order-placement monitoring" "query failed"

  roles=$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM pg_roles WHERE rolcanlogin AND rolname NOT LIKE 'pg_%' AND rolname NOT IN ('azuresu','replication','synthadmin','synthwatch-api','synthwatch-runner-id')" 2>/dev/null)
  [[ -n "$roles" ]] && { [[ "$roles" -gt 1 ]] && row DONE "Postgres per-user accounts" "$roles non-service login roles" \
      || row "NOT DONE" "Postgres per-user accounts" "no per-engineer roles (service principals only)"; } \
    || row UNKNOWN "Postgres per-user accounts" "query failed"

  c355=$(psql "$DATABASE_URL" -tAc "SELECT status||' @ '||coalesce(failed_step,'-') FROM runs WHERE check_id=355 ORDER BY started_at DESC LIMIT 1" 2>/dev/null)
  case "$c355" in
    pass*)  row DONE "check 355 verify-cart-4 healthy" "$c355" ;;
    "")     row UNKNOWN "check 355 verify-cart-4 healthy" "query failed" ;;
    *)      row "NOT DONE" "check 355 verify-cart-4 healthy" "$c355" ;;
  esac
else
  for i in "On-call roster (routed, not one inbox)" "Payment / order-placement monitoring" \
           "Postgres per-user accounts" "check 355 verify-cart-4 healthy"; do
    row UNKNOWN "$i" "psql/DATABASE_URL unavailable"
  done
fi

# ── repo state (no credentials needed) ──────────────────────────────────────
grep -q "synthwatch-sandbox" <(bash -c 'source scripts/lib/deploy-lib.sh; printf "%s\n" "${RUNNER_IMAGE_JOBS[@]}"' 2>/dev/null) \
  && row DONE "sandbox rolled + image-verified" "in RUNNER_IMAGE_JOBS (8+1 verify)" \
  || row "NOT DONE" "sandbox rolled + image-verified" "absent from RUNNER_IMAGE_JOBS"

# ★ SELF-MATCH GUARD: this script's own source contains the needle, so a bare `grep -r scripts/` matches
#   THIS FILE and reports DONE. Exclude the verifier, and split the literal so it cannot self-match.
gate_a_needle="schema-vs""-replay"
[[ -n "$(grep -rl "$gate_a_needle" scripts/ --exclude="$(basename "$0")" 2>/dev/null)" ]] \
  && row DONE "Gate A - schema.sql <-> replay" "present on main" \
  || row "NOT DONE" "Gate A - schema.sql <-> replay" "not on main (branch only)"

[[ -n "$(grep -nE '^(export )?(async )?function .*(cluster|correlat)' runner/narrative.ts 2>/dev/null)" ]] \
  && row DONE "Narrative holistic build" "correlation function present" \
  || row "NOT DONE" "Narrative holistic build" "prompt instruction only, no code pass"

nf=$(ls runner/test-fixtures/trace-signals-golden/ 2>/dev/null | grep -c canonicalize)
[[ "${nf:-0}" -ge 2 ]] && row DONE "2nd golden canonicalize fixture" "$nf fixtures" \
  || row "NOT DONE" "2nd golden canonicalize fixture" "${nf:-0} fixture"

pi=$(python3 -c "import json;print(json.load(open('runner/package.json'))['scripts'].get('postinstall','(none)'))" 2>/dev/null || echo "(none)")
[[ "$pi" == "(none)" ]] && row "NOT DONE" "esbuild arm64 (local-test gap)" "no postinstall hook" \
  || row DONE "esbuild arm64 (local-test gap)" "$pi"

[[ -n "$(grep -rln 'rateTrigger\|rate-based' runner/*.ts 2>/dev/null)" ]] \
  && row DONE "Rate-based alert trigger" "code present" \
  || row "NOT DONE" "Rate-based alert trigger" "not built (scope unconfirmed)"

bk_break=$(grep -A1 "^  evaluate)" runner/scripts/mutation.sh 2>/dev/null | grep -o "BREAK=[0-9]*" | head -1)
row "NOT DONE" "evaluate.ts mutation coverage" "${bk_break:-unknown} (open by design - raise after killing survivors)"

nrt=$(ls ../synthwatch-monitors/scripts/redtest-*.mjs 2>/dev/null | wc -l | tr -d ' ')
[[ "${nrt:-0}" -ge 1 ]] \
  && row PARTIAL "Cart-DOM snapshot" "${nrt} committed red-test fixtures (reconstructions; no capture procedure)" \
  || row "NOT DONE" "Cart-DOM snapshot" "no committed fixtures"

if [[ -d ../synthwatch-api ]] && grep -q "Lessons from 2026-07-20" ../synthwatch-api/CLAUDE.md 2>/dev/null \
   && [[ -f ../synthwatch-api/scripts/assert-tests-ran.py ]]; then
  row DONE "api CI gotchas documented" "CLAUDE.md lesson + assert-tests-ran.py present"
else
  row "NOT DONE" "api CI gotchas documented" "lesson or guard missing"
fi

if [[ -d ../synthwatch-api ]]; then
  spec=$( { find ../synthwatch-api -iname "*openapi*" -o -iname "*swagger*"; } 2>/dev/null | grep -v obj/ | head -1)
  [[ -n "$spec" ]] && row DONE "OpenAPI spec (api)" "$spec" \
    || row "NOT DONE" "OpenAPI spec (api)" "no spec file, no Swashbuckle"
else
  row UNKNOWN "OpenAPI spec (api)" "../synthwatch-api not checked out"
fi

# ── Vercel + cost ───────────────────────────────────────────────────────────
have vercel && row DONE "Vercel inventory enumerable" "vercel CLI present" \
  || row BLOCKED "Vercel inventory enumerable" "no CLI/token - do NOT fill from memory"

if have curl; then
  # ★ Assert on .azure.mtdActual, NOT `.azure != null`: the object is present while its fields can be
  #   null, so the coarse check reports DONE while the headline shows nothing.
  if curl -s --max-time 25 https://synthwatch-api.azurewebsites.net/api/reports/cost 2>/dev/null \
       | jq -e '.azure.mtdActual != null' >/dev/null 2>&1; then
    row DONE "Azure cost headline live" "azure.mtdActual populated"
  else
    row "NOT DONE" "Azure cost headline live" "azure.mtdActual null or endpoint unreachable"
  fi
else
  row UNKNOWN "Azure cost headline live" "curl unavailable"
fi

# ── table ───────────────────────────────────────────────────────────────────
echo
echo "| Status | Item | Evidence |"
echo "|---|---|---|"
printf '%s\n' "${ROWS[@]}" | sort | while IFS=$'\t' read -r s i e; do echo "| **${s}** | ${i} | ${e} |"; done
echo
printf 'DONE=%s  NOT DONE=%s  PARTIAL=%s  BLOCKED=%s  UNKNOWN=%s\n' \
  "$(printf '%s\n' "${ROWS[@]}" | grep -c '^DONE')" \
  "$(printf '%s\n' "${ROWS[@]}" | grep -c '^NOT DONE')" \
  "$(printf '%s\n' "${ROWS[@]}" | grep -c '^PARTIAL')" \
  "$(printf '%s\n' "${ROWS[@]}" | grep -c '^BLOCKED')" \
  "$(printf '%s\n' "${ROWS[@]}" | grep -c '^UNKNOWN')"

if [[ $UNRUNNABLE -eq 1 ]]; then
  echo
  echo "⚠️  One or more checks could not RUN (UNKNOWN above) — this table is INCOMPLETE." >&2
  exit 2
fi
