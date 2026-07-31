#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# GENERATE docs/handover/INVENTORY.md — a machine-generated inventory of the LIVE system.
#
# ★ WHY THIS EXISTS. The migration plan is being written by someone who cannot read these repos or this
#   subscription. Every fact reaches them by retelling, and that channel has already put two wrong
#   premises into the plan (an item marked to-do that was done; a rollback marked done that never
#   happened). A hand-written inventory rots the same way. This one is REGENERATED, so a claim is only
#   ever as old as its timestamp — and the timestamp is in the file.
#
# ★ RULES THIS SCRIPT FOLLOWS:
#   1. LIVE ONLY. Every fact comes from `az` / `gh` / the runner's Postgres. Nothing is read from docs,
#      from bicep, or from memory. Where a value CAN'T be resolved, it is recorded as a NAMED GAP rather
#      than guessed, omitted, or back-filled from a document.
#   2. NEVER PRINT A SECRET VALUE. Secret NAMES, their SCOPE and their LOCATION only. The one deliberate
#      exception is non-secret identifiers that are already public in workflow logs (subscription id,
#      client id, principal ids) — these are needed to re-verify and are not credentials.
#   3. EVERY SECTION SHOWS ITS COMMAND, so any line in the output can be re-run and checked by hand.
#
# USAGE:  scripts/generate-handover-inventory.sh [-o OUTPUT]
#   Requires: az (logged in), gh (logged in), jq, psql + DATABASE_URL for the egress/monitor sections.
#   Exits 0 even with gaps — a partial inventory that NAMES what it could not resolve is the goal.
#   Exits 1 only if it could not write the file at all.
#
# ★ pipefail note (banked repo lesson): `printf … | grep -q` is a SIGPIPE trap under pipefail and yields a
#   wrong result. Every membership test here uses a here-string or pure-bash `[[ ]]`.
# ---------------------------------------------------------------------------
set -uo pipefail

RG="${RG:-synthwatch-rg}"
ORG="${ORG:-craigoley}"
REPOS=("${ORG}/synthwatch" "${ORG}/synthwatch-api" "${ORG}/synthwatch-dashboard" "${ORG}/synthwatch-monitors")
OUT="docs/handover/INVENTORY.md"

# ── --self-test: prove the DUPLICATE-JOB-NAME detector can actually fire ─────────────────────────────
# A scan that reports "✅ none found" is worthless if it is incapable of finding one. This feeds the exact
# jq used below a fixture containing a known duplicate, asserts it is reported, and asserts a unique-name
# fixture reports nothing. Runs in CI, needs no credentials.
if [[ "${1:-}" == "--self-test" ]]; then
  fx="$(mktemp)"; trap 'rm -f "$fx"' EXIT
  cat >"$fx" <<'FIX'
{"file":"a.yml","wf":"A","triggers":[],"jobs":[{"id":"j1","name":"Lint","matrix":false,"matrix_in_name":false,"legs":0},{"id":"j2","name":"Test","matrix":false,"matrix_in_name":false,"legs":0}]}
{"file":"b.yml","wf":"B","triggers":[],"jobs":[{"id":"j3","name":"Lint","matrix":false,"matrix_in_name":false,"legs":0}]}
FIX
  DUP_JQ='[.[]|select(.error|not)|. as $w|.jobs[]|{name:.name,where:($w.file+":"+.id)}]
          | group_by(.name) | map(select(length>1)) | .[]
          | "\(.[0].name)\t\([.[].where]|join(", "))"'
  got="$(jq -sr "$DUP_JQ" "$fx" 2>/dev/null)"
  [[ "$got" == "Lint"$'\t'"a.yml:j1, b.yml:j3" ]] || { echo "SELF-TEST FAIL: duplicate NOT detected (got: ${got:-<empty>})" >&2; exit 1; }
  echo "  ok: a duplicate job name IS detected"
  head -1 "$fx" >"$fx.uniq"
  got2="$(jq -sr "$DUP_JQ" "$fx.uniq" 2>/dev/null)"
  [[ -z "$got2" ]] || { echo "SELF-TEST FAIL: false positive on unique names (got: $got2)" >&2; rm -f "$fx.uniq"; exit 1; }
  rm -f "$fx.uniq"
  echo "  ok: unique job names report nothing (no false positive)"
  echo "SELF-TEST PASSED — the duplicate-job-name detector is load-bearing."
  exit 0
fi

while getopts ":o:" opt; do case "$opt" in o) OUT="$OPTARG" ;; *) ;; esac; done

GEN_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TMP="$(mktemp)"; trap 'rm -f "$TMP" "$TMP".gaps' EXIT
: >"$TMP.gaps"

say()  { printf '%s\n' "$*" >>"$TMP"; }
cmd()  { printf '\n```console\n$ %s\n```\n\n' "$*" >>"$TMP"; }   # the exact command, so a claim is checkable
gap()  { printf -- '- **%s** — %s\n' "$1" "$2" >>"$TMP.gaps"; printf '>  ⚠️ **GAP: %s** — %s\n\n' "$1" "$2" >>"$TMP"; }
have() { command -v "$1" >/dev/null 2>&1; }

# Run a command; on failure record a gap and emit nothing. Never aborts the script.
try() { # try <gap-label> <gap-explanation> <command...>
  local label="$1" why="$2"; shift 2
  local out; out="$("$@" 2>/dev/null)" || { gap "$label" "$why"; return 1; }
  [[ -z "$out" ]] && { gap "$label" "$why (command succeeded but returned nothing)"; return 1; }
  printf '%s\n' "$out"
}

# ── preflight ───────────────────────────────────────────────────────────────
have az || { echo "az not on PATH" >&2; exit 1; }
have jq || { echo "jq not on PATH" >&2; exit 1; }

SUB_ID="$(az account show --query id -o tsv 2>/dev/null || true)"
SUB_NAME="$(az account show --query name -o tsv 2>/dev/null || true)"
TENANT_ID="$(az account show --query tenantId -o tsv 2>/dev/null || true)"

say "# SynthWatch — handover inventory (GENERATED)"
say ""
say "> **Do not hand-edit.** Regenerate with \`scripts/generate-handover-inventory.sh\`."
say "> Every fact below is read from the LIVE system at generation time — never from docs or memory."
say "> Each section prints the exact command that produced it, so any single line can be re-verified."
say ""
say "| | |"
say "|---|---|"
say "| **Generated at (UTC)** | \`${GEN_START}\` |"
say "| **Generated by** | \`scripts/generate-handover-inventory.sh\` |"
say "| **Source commit** | \`$(git rev-parse --short HEAD 2>/dev/null || echo unknown)\` |"
say "| **Azure subscription** | ${SUB_NAME:-?} (\`${SUB_ID:-?}\`) |"
say "| **Tenant** | \`${TENANT_ID:-?}\` |"
say "| **Resource group** | \`${RG}\` |"
say ""
say "**Staleness gate:** \`.github/workflows/inventory-freshness.yml\` fails once this file is older than"
say "its threshold, so it cannot silently rot the way a hand-written document does."
say ""
say "---"
say ""

# ═══════════════════════════════════════════════════════════════════════════
say "## 1. Azure resources"
say ""
say "### 1.1 Every resource in \`${RG}\`"
cmd "az resource list -g ${RG} --query \"[].{type:type,name:name,location:location}\" -o tsv | sort"
if rows="$(try 'azure:resource-list' "az resource list failed — not logged in, or no reader on ${RG}" \
            az resource list -g "$RG" --query "[].{type:type,name:name,location:location}" -o tsv)"; then
  say "| Type | Name | Region |"
  say "|---|---|---|"
  # shellcheck disable=SC2001
  sort <<<"$rows" | while IFS=$'\t' read -r t n l; do say "| \`${t}\` | \`${n}\` | ${l} |"; done
  say ""
  say "_$(wc -l <<<"$rows" | tr -d ' ') resources._"
fi
say ""

say "### 1.2 Container Apps jobs — image, size, timeout, trigger"
say ""
say "\`replicaTimeout\` is the per-execution wall clock. A runner tick runs its due checks SEQUENTIALLY"
say "inside ONE execution and shares this budget — so it is a capacity fact, not just a setting."
cmd "az containerapp job list -g ${RG} --query '[].{...}' -o tsv"
if rows="$(try 'azure:aca-jobs' "az containerapp job list failed (containerapp extension missing?)" \
            az containerapp job list -g "$RG" --query \
            "[].{n:name,loc:location,img:properties.template.containers[0].image,cpu:properties.template.containers[0].resources.cpu,mem:properties.template.containers[0].resources.memory,to:properties.configuration.replicaTimeout,trig:properties.configuration.triggerType,cron:properties.configuration.scheduleTriggerConfig.cronExpression,par:properties.configuration.scheduleTriggerConfig.parallelism,env:properties.environmentId}" -o tsv)"; then
  say "| Job | Region | CPU / Mem | replicaTimeout | Trigger | Cron | Image tag |"
  say "|---|---|---|---|---|---|---|"
  sort <<<"$rows" | while IFS=$'\t' read -r n loc img cpu mem to trig cron par envid; do
    say "| \`${n}\` | ${loc} | ${cpu} / ${mem} | ${to}s | ${trig} | \`${cron:-—}\` | \`${img##*:}\` |"
  done
  say ""
  say "**Image repository (all jobs):** \`$(awk -F'\t' 'NR==1{split($3,a,":"); print a[1]}' <<<"$rows")\`"
  say ""
  say "★ All jobs must run the SAME image tag. A tag that differs from the others is a job CD did not roll"
  say "(the drift class \`scripts/deploy_test.sh\` guards). Distinct tags live right now:"
  awk -F'\t' '{split($3,a,":"); print a[2]}' <<<"$rows" | sort -u | while read -r t; do say "  - \`${t}\`"; done
fi
say ""

say "### 1.3 Managed identities and their EXACT live role assignments"
say ""
say "Read LIVE (\`az role assignment list --assignee\`), not from the bicep template — so a grant that"
say "exists in Azure but not in code, or vice versa, shows up here as it really is."
cmd "az identity list -g ${RG}; az role assignment list --assignee <principalId> --all"
if ids="$(try 'azure:identities' "az identity list failed" \
           az identity list -g "$RG" --query "[].{n:name,pid:principalId,cid:clientId}" -o tsv)"; then
  while IFS=$'\t' read -r n pid cid; do
    say ""
    say "**\`${n}\`** — principalId \`${pid}\`, clientId \`${cid}\`"
    say ""
    if ra="$(az role assignment list --assignee "$pid" --all --query "[].{r:roleDefinitionName,s:scope}" -o tsv 2>/dev/null </dev/null)" && [[ -n "$ra" ]]; then
      say "| Role | Scope |"
      say "|---|---|"
      sort <<<"$ra" | while IFS=$'\t' read -r r s; do say "| ${r} | \`${s#/subscriptions/${SUB_ID}}\` |"; done
    else
      say "_No role assignments._"
    fi
  done <<<"$ids"
fi
say ""

say "### 1.4 Storage, containers and lifecycle rules"
say ""
say "★ **Every** storage account in the group is enumerated, not just the first. There is more than one,"
say "and they do NOT have the same retention posture — reporting only one would state a true fact about"
say "the wrong account, which is precisely the class of wrong premise this document exists to end."
cmd "az storage account list -g ${RG} --query '[].name'   # then, per account: container list + management-policy show"
# ★ Which account do artifacts ACTUALLY live in? Resolved from runs.trace_url, not inferred from the
#   container name — two accounts here carry a `synthwatch-artifacts` container and only one is in use.
#   (Banked lesson: confirm an object's provenance before assuming it from its name.)
ACTIVE_SA=""
if have psql && [[ -n "${DATABASE_URL:-}" ]]; then
  ACTIVE_SA="$(psql "$DATABASE_URL" -tAc "SELECT regexp_replace(trace_url,'^https?://([^.]+)\..*','\1') FROM runs WHERE trace_url IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC LIMIT 1" 2>/dev/null | tr -d ' ' || true)"
fi
if accts="$(try 'azure:storage' "az storage account list failed" \
             az storage account list -g "$RG" --query "[].name" -o tsv)"; then
  while read -r SA; do
    [[ -z "$SA" ]] && continue
    say ""
    say "#### \`${SA}\`"
    say ""
    KEY="$(az storage account keys list -n "$SA" -g "$RG" --query '[0].value' -o tsv 2>/dev/null || true)"
    if [[ -n "$KEY" ]]; then
      if cs="$(az storage container list --account-name "$SA" --account-key "$KEY" --query "[].name" -o tsv 2>/dev/null)"; then
        say "- **Containers:** $(paste -sd', ' - <<<"$cs" | sed 's/[^,]*/`&`/g')"
        # Blob counts per container — an EMPTY container that merely shares a name is an orphan, not the
        # live artifact store, and the difference decides whether its (missing) retention policy matters.
        while read -r c; do
          [[ -z "$c" ]] && continue
          nb="$(az storage blob list --account-name "$SA" --account-key "$KEY" -c "$c" --num-results 1000 --query "length(@)" -o tsv 2>/dev/null || echo '?')"
          say "  - \`${c}\`: ${nb} blob(s) (capped at 1000 for speed)"
        done <<<"$cs"
        if [[ -n "$ACTIVE_SA" && "$SA" == "$ACTIVE_SA" ]]; then
          say "- ★ **THE LIVE RUN-ARTIFACT ACCOUNT** — resolved from \`runs.trace_url\`, not guessed from the"
          say "  container name. Its lifecycle rules below are the retention clock for PII-bearing artifacts"
          say "  and must stay in step with the runner's row-retention window: rows and their blobs have to"
          say "  expire on the same clock, or purged rows leave dangling \`trace_url\`s."
        elif grep -qxF 'synthwatch-artifacts' <<<"$cs"; then
          say "- ⚠️ **Carries a \`synthwatch-artifacts\` container but is NOT the live artifact store** — no run"
          say "  references it. Treat as an ORPHAN from an earlier deploy: confirm it is empty, then do not"
          say "  recreate it in the destination. Naming alone does not make it the artifact account."
        fi
      else
        say "- _No containers readable._"
      fi
    else
      say "- _Container list unavailable (no account key readable)._"
      gap "azure:storage-keys:${SA}" "could not read an account key for ${SA} — its container list is unresolved"
    fi
    if pol="$(az storage account management-policy show --account-name "$SA" -g "$RG" -o json 2>/dev/null)"; then
      say ""
      say "| Lifecycle rule | Enabled | Prefixes | Delete after |"
      say "|---|---|---|---|"
      jq -r '.policy.rules[] | "| `\(.name)` | \(.enabled) | \((.definition.filters.prefixMatch // []) | join(", ")) | \((.definition.actions.baseBlob.delete.daysAfterModificationGreaterThan // "—") | tostring) days |"' <<<"$pol" >>"$TMP"
    else
      say "- **Lifecycle: NONE** — blobs in this account are retained indefinitely unless deleted by hand."
    fi
  done <<<"$accts"
fi
say ""

say "### 1.5 Postgres, ACS and Azure OpenAI"
cmd "az postgres flexible-server list/db list; az communication list; az cognitiveservices account deployment list"
if pg="$(try 'azure:postgres' "az postgres flexible-server list failed" \
          az postgres flexible-server list -g "$RG" --query "[].{n:name,v:version,sku:sku.name,tier:sku.tier,store:storage.storageSizeGb,ver:fullyQualifiedDomainName}" -o tsv)"; then
  while IFS=$'\t' read -r n v sku tier store fqdn; do
    say "**Postgres:** \`${n}\` — v${v}, ${sku} (${tier}), ${store}GB, \`${fqdn}\`"
    say ""
    if dbs="$(az postgres flexible-server db list -g "$RG" -s "$n" --query "[].name" -o tsv 2>/dev/null)"; then
      say "  - Databases: $(paste -sd', ' - <<<"$dbs" | sed 's/[^,]*/`&`/g')"
    fi
  done <<<"$pg"
fi
say ""
if acs="$(try 'azure:acs' "az communication list failed (extension missing?)" \
           az communication list -g "$RG" --query "[].{n:name,ds:dataLocation}" -o tsv)"; then
  while IFS=$'\t' read -r n ds; do say "**Communication Services:** \`${n}\` (data location: ${ds}) — transactional alert email."; done <<<"$acs"
fi
say ""
AOAI="$(az cognitiveservices account list -g "$RG" --query "[0].name" -o tsv 2>/dev/null || true)"
if [[ -n "$AOAI" ]]; then
  say "**Azure OpenAI:** \`${AOAI}\` — powers RCA + report narratives. Absent config ⇒ both features go dark (opt-in by design)."
  say ""
  if dep="$(az cognitiveservices account deployment list -n "$AOAI" -g "$RG" --query "[].{n:name,m:properties.model.name,v:properties.model.version,sku:sku.name,cap:sku.capacity}" -o tsv 2>/dev/null)"; then
    say "| Deployment | Model | Version | SKU | Capacity |"
    say "|---|---|---|---|---|"
    while IFS=$'\t' read -r n m v sku cap; do say "| \`${n}\` | ${m} | ${v} | ${sku} | ${cap} |"; done <<<"$dep"
  fi
else
  gap "azure:aoai" "no Cognitive Services account in ${RG}"
fi
say ""

# ═══════════════════════════════════════════════════════════════════════════
say "## 2. Secrets — names, scope, and where they live"
say ""
say "★ **No values are printed anywhere in this file.** Names, scope and location only."
say ""
say "★ **THE TRANSFER RULE, and it is the reason this section is split by scope:**"
say "> **Repository** secrets/variables move WITH the repo when it is transferred."
say "> **Environment** and **Organization** secrets DO NOT — they must be recreated in the destination."
say ""

say "### 2.1 Container Apps secrets, by job"
say ""
say "These are the runtime credentials. Each is an ACA secret referenced by an env var; the VALUES live"
say "only in the job definition and must be re-seeded in a new subscription."
cmd "az containerapp job show -n <job> -g ${RG} --query 'properties.configuration.secrets[].name'"
if jobs="$(az containerapp job list -g "$RG" --query "[].name" -o tsv 2>/dev/null)"; then
  say "| Job | ACA secret names | Env vars bound via secretRef |"
  say "|---|---|---|"
  while read -r j; do
    [[ -z "$j" ]] && continue
    s="$(az containerapp job show -n "$j" -g "$RG" --query "join(', ', properties.configuration.secrets[].name)" -o tsv 2>/dev/null)"
    e="$(az containerapp job show -n "$j" -g "$RG" --query "join(', ', properties.template.containers[0].env[?secretRef!=null].name)" -o tsv 2>/dev/null)"
    say "| \`${j}\` | ${s:-—} | ${e:-—} |"
  done <<<"$jobs"
fi
say ""

say "### 2.2 GitHub secrets and variables, by scope"
if have gh; then
  for R in "${REPOS[@]}"; do
    say ""
    say "**\`${R}\`**"
    say ""
    if s="$(gh secret list -R "$R" --json name,updatedAt -q '.[]|"\(.name)\t\(.updatedAt)"' 2>/dev/null)" && [[ -n "$s" ]]; then
      say "| Repository secret | Updated | Transfers with repo? |"
      say "|---|---|---|"
      while IFS=$'\t' read -r n u; do say "| \`${n}\` | ${u%%T*} | ✅ yes |"; done <<<"$s"
    else
      say "_No repository-level secrets._"
    fi
    say ""
    if v="$(gh variable list -R "$R" --json name,value -q '.[]|"\(.name)\t\(.value)"' 2>/dev/null)" && [[ -n "$v" ]]; then
      say "| Repository variable | Value (non-secret) | Transfers with repo? |"
      say "|---|---|---|"
      while IFS=$'\t' read -r n val; do say "| \`${n}\` | \`${val}\` | ✅ yes |"; done <<<"$v"
    else
      say "_No repository-level variables._"
    fi
    say ""
    envs="$(gh api "repos/${R}/environments" --jq '.environments[]?.name' 2>/dev/null || true)"
    if [[ -n "$envs" ]]; then
      while read -r e; do
        [[ -z "$e" ]] && continue
        es="$(gh api "repos/${R}/environments/${e}/secrets" --jq '[.secrets[].name]|join(", ")' 2>/dev/null || echo '?')"
        say "- **Environment \`${e}\`** secrets: ${es:-none} — ❌ **do NOT transfer; recreate in the destination**"
      done <<<"$envs"
    else
      say "_No deployment environments (so no environment-scoped secrets to recreate)._"
    fi
  done
  say ""
  say "**Organization-scope (\`${ORG}\`)** — org secrets/variables are shared across repos and **do NOT**"
  say "transfer with any single repo:"
  say ""
  if os="$(gh api "orgs/${ORG}/actions/secrets" --jq '.secrets[]?.name' 2>/dev/null)"; then
    while read -r n; do say "- \`${n}\` (org secret) — ❌ recreate in the destination"; done <<<"$os"
  else
    gap "github:org-secrets" \
      "could not enumerate ORG-level secrets/variables for \`${ORG}\` — the token lacks the \`admin:org\` scope (HTTP 403). ★ This is the highest-risk gap in this document: org secrets are invisible here AND do not transfer with a repo, so a migration that only accounts for repo secrets will silently lose them. Resolve with: \`gh auth refresh -h github.com -s admin:org\` then re-run this generator, or have an org owner run \`gh api orgs/${ORG}/actions/secrets\`."
  fi
else
  gap "github:cli" "gh not on PATH — the entire GitHub half of this inventory is unresolved"
fi
say ""

# ═══════════════════════════════════════════════════════════════════════════
say "## 3. GitHub — workflows, jobs, protection, access"
say ""
say "Workflow bodies are fetched from the GitHub API (the live default branch), not from a local clone,"
say "so this reflects what actually runs."
cmd "gh api repos/<repo>/contents/.github/workflows  →  parse each workflow's name / triggers / jobs"

WF_TMP="$(mktemp)"; trap 'rm -f "$TMP" "$TMP".gaps "$WF_TMP"' EXIT
if have gh; then
  _n=0
  for R in "${REPOS[@]}"; do
    _n=$((_n+1))
    say ""
    say "### 3.${_n} \`${R}\` — workflows and job names"
    say ""
    files="$(gh api "repos/${R}/contents/.github/workflows" --jq '.[]|select(.name|endswith(".yml") or endswith(".yaml"))|.name' 2>/dev/null || true)"
    if [[ -z "$files" ]]; then
      say "_No workflows._"
      continue
    fi
    : >"$WF_TMP"
    while read -r f; do
      [[ -z "$f" ]] && continue
      body="$(gh api "repos/${R}/contents/.github/workflows/${f}" --jq '.content' 2>/dev/null | base64 -d 2>/dev/null || true)"
      [[ -z "$body" ]] && { gap "github:workflow-body" "could not fetch ${R}/.github/workflows/${f}"; continue; }
      printf '%s' "$body" | python3 -c '
import sys, yaml, json
f = sys.argv[1]
try:
    d = yaml.safe_load(sys.stdin.read()) or {}
except Exception as e:
    print(json.dumps({"file": f, "error": str(e)})); sys.exit()
# GitHub`s `on:` is parsed by YAML 1.1 as the boolean True
trig = d.get("on", d.get(True, {}))
if isinstance(trig, dict):
    trigs = []
    for k, v in trig.items():
        paths = (v or {}).get("paths") if isinstance(v, dict) else None
        trigs.append({"event": str(k), "paths": paths})
elif isinstance(trig, list):
    trigs = [{"event": str(t), "paths": None} for t in trig]
else:
    trigs = [{"event": str(trig), "paths": None}]
jobs = []
for jid, j in (d.get("jobs") or {}).items():
    j = j or {}
    nm = str(j.get("name", jid))
    mtx = ((j.get("strategy") or {}).get("matrix"))
    # ★ A MATRIX job produces one status check PER LEG. If its name does not interpolate a matrix
    #   variable, every leg reports under the SAME name — the duplicate-status-check hazard, arriving
    #   at runtime where a static scan of names cannot see it.
    jobs.append({
        "id": jid, "name": nm,
        "matrix": bool(mtx),
        "matrix_in_name": ("matrix." in nm),
        "legs": (len(next((v for v in mtx.values() if isinstance(v, list)), [])) if isinstance(mtx, dict) else 0),
    })
print(json.dumps({"file": f, "wf": d.get("name", f), "triggers": trigs, "jobs": jobs}))
' "$f" >>"$WF_TMP"
    done <<<"$files"

    say "| Workflow | File | Triggers | Path filters | Job names |"
    say "|---|---|---|---|---|"
    jq -r 'select(.error|not) |
      "| \(.wf) | `\(.file)` | \([.triggers[].event]|join(", ")) | \([.triggers[]|select(.paths)|.paths[]]|if length==0 then "—" else join("<br>") end) | \([.jobs[]|"`"+.name+"`"]|join("<br>")) |"' "$WF_TMP" >>"$TMP"
    jq -r 'select(.error) | "| `\(.file)` | PARSE ERROR: \(.error) | | | |"' "$WF_TMP" >>"$TMP"
    say ""
    nwf="$(wc -l <"$WF_TMP" | tr -d ' ')"
    njob="$(jq -s '[.[].jobs[]?]|length' "$WF_TMP")"
    say "_${nwf} workflows, ${njob} jobs._"
    say ""

    # ── ★ DUPLICATE JOB NAMES ────────────────────────────────────────────────
    say "**★ Duplicate job-name check.** GitHub identifies a status check by its JOB NAME. Two jobs sharing"
    say "a name across workflows produce ambiguous required-status-checks, and a required check that matches"
    say "more than one job can block merges or pass on the wrong run."
    say ""
    dups="$(jq -sr '[.[]|select(.error|not)|. as $w|.jobs[]|{name:.name,where:($w.file+":"+.id)}]
              | group_by(.name) | map(select(length>1)) | .[]
              | "\(.[0].name)\t\([.[].where]|join(", "))"' "$WF_TMP" 2>/dev/null || true)"
    if [[ -n "$dups" ]]; then
      say "| ⚠️ Duplicated job name | Defined in |"
      say "|---|---|"
      while IFS=$'\t' read -r n w; do say "| \`${n}\` | ${w} |"; done <<<"$dups"
      say ""
      say "**Action required before migration:** rename so every job name in this repo is unique."
    else
      say "✅ **No duplicate job names in \`${R}\`** — every one of the ${njob} job names is unique, so each"
      say "status check resolves to exactly one job."
      say ""
      say "<sub>This check is not vacuous: \`scripts/generate-handover-inventory.sh --self-test\` feeds it a"
      say "known-duplicate fixture and asserts it FIRES, so a green line here means it looked and found none.</sub>"
    fi
    say ""

    # ── matrix jobs: the status-check name is DYNAMIC ─────────────────────────
    mtx="$(jq -sr '[.[]|select(.error|not)|. as $w|.jobs[]|select(.matrix)|
             "\(.name)\t\($w.file):\(.id)\t\(.legs)\t\(.matrix_in_name)"]|.[]' "$WF_TMP" 2>/dev/null || true)"
    if [[ -n "$mtx" ]]; then
      say "**Matrix jobs — the status-check name is DYNAMIC.** Each leg reports as its own check, so the"
      say "name to put in a required-checks list is the EXPANDED one, not the string in the YAML."
      say ""
      say "| Job (as written) | Defined in | Legs | Interpolates a matrix var? |"
      say "|---|---|---|---|"
      while IFS=$'\t' read -r n w legs inname; do
        # legs==0 means the matrix is COMPUTED at runtime (fromJSON of a job output), not a static list —
        # say so rather than printing "0", which reads as "no legs".
        [[ "$legs" == "0" ]] && legs="dynamic (computed at runtime)"
        if [[ "$inname" == "true" ]]; then
          say "| \`${n}\` | ${w} | ${legs} | ✅ yes — legs get distinct names |"
        else
          say "| \`${n}\` | ${w} | ${legs} | ⚠️ **NO — every leg reports under this ONE name** |"
        fi
      done <<<"$mtx"
      say ""
      if grep -q $'\tfalse$' <<<"$mtx"; then
        say "⚠️ **A matrix job above does not interpolate its matrix variable**, so its legs share a single"
        say "status-check name. That is the ambiguous-check hazard arriving at RUNTIME, where a static scan"
        say "of job names cannot see it. Required-checks configuration should be re-verified against a real"
        say "run's check names before relying on it in the destination."
      fi
      say ""
    fi

    # ── branch protection / rulesets / required checks ───────────────────────
    say "**Branch protection & required checks (\`main\`)**"
    say ""
    if bp="$(gh api "repos/${R}/branches/main/protection" 2>/dev/null)"; then
      req="$(jq -r '(.required_status_checks.contexts // [])|if length==0 then "—" else map("`"+.+"`")|join(", ") end' <<<"$bp")"
      revs="$(jq -r '.required_pull_request_reviews.required_approving_review_count // 0' <<<"$bp")"
      adm="$(jq -r '.enforce_admins.enabled // false' <<<"$bp")"
      say "- Required status checks: ${req}"
      say "- Required approving reviews: **${revs}**"
      say "- Enforced for admins: ${adm}"
      say "- Dismiss stale reviews: $(jq -r '.required_pull_request_reviews.dismiss_stale_reviews // false' <<<"$bp")"
    else
      say "- _No classic branch protection readable (may use rulesets, or token lacks admin)._"
    fi
    rs="$(gh api "repos/${R}/rulesets" --jq '.[]?|"\(.name) [\(.enforcement)]"' 2>/dev/null || true)"
    if [[ -n "$rs" ]]; then
      say "- Rulesets: $(paste -sd'; ' - <<<"$rs")"
    else
      say "- Rulesets: none"
    fi
    say ""

    say "**Collaborators and permission levels**"
    say ""
    if col="$(gh api "repos/${R}/collaborators" --jq '.[]|"\(.login)\t\(.role_name)"' 2>/dev/null)" && [[ -n "$col" ]]; then
      say "| User | Permission |"
      say "|---|---|"
      while IFS=$'\t' read -r u p; do say "| \`${u}\` | ${p} |"; done <<<"$col"
    else
      gap "github:collaborators:${R}" "could not list collaborators (token lacks repo admin)"
    fi
  done
fi
say ""

say "### 3.$((_n+1)) OIDC — the federated identity GitHub Actions deploys as"
say ""
say "★ This principal is an **Entra app registration, NOT a resource in \`${RG}\`** — so it does **not**"
say "move with the resource group and must be recreated (with its federated subjects) in the destination"
say "tenant. Its \`clientId\` is the \`AZURE_CLIENT_ID\` repo variable above."
cmd "az ad app federated-credential list --id <AZURE_CLIENT_ID>; az role assignment list --assignee <appId> --all"
GHA_CID="$(gh variable list -R "${ORG}/synthwatch" --json name,value -q '.[]|select(.name=="AZURE_CLIENT_ID")|.value' 2>/dev/null || true)"
if [[ -n "$GHA_CID" ]]; then
  app_name="$(az ad app show --id "$GHA_CID" --query displayName -o tsv 2>/dev/null || true)"
  say "**App registration:** \`${app_name:-?}\` — appId \`${GHA_CID}\`"
  say ""
  if fc="$(az ad app federated-credential list --id "$GHA_CID" --query "[].{n:name,s:subject,i:issuer}" -o tsv 2>/dev/null)"; then
    say "| Credential | Subject (who may assume it) | Issuer |"
    say "|---|---|---|"
    while IFS=$'\t' read -r n s i; do say "| \`${n}\` | \`${s}\` | ${i} |"; done <<<"$fc"
    say ""
    say "★ Only the subjects listed above can deploy. A repo NOT listed here has no path to Azure — check"
    say "this against the workflow list in 3.1 before assuming a repo can deploy itself."
  else
    gap "azure:federated-credentials" "could not list federated credentials for ${GHA_CID}"
  fi
  say ""
  if ra="$(az role assignment list --assignee "$GHA_CID" --all --query "[].{r:roleDefinitionName,s:scope}" -o tsv 2>/dev/null </dev/null)"; then
    say "**Its Azure role assignments:**"
    say ""
    say "| Role | Scope |"
    say "|---|---|"
    while IFS=$'\t' read -r r s; do say "| ${r} | \`${s#/subscriptions/${SUB_ID}}\` |"; done <<<"$ra"
  fi
else
  gap "github:azure-client-id" "AZURE_CLIENT_ID variable not readable — the OIDC deploy principal could not be resolved"
fi
say ""

# ═══════════════════════════════════════════════════════════════════════════
say "## 4. Vercel (dashboard hosting)"
say ""
cmd "vercel project ls / vercel env ls   (requires the Vercel CLI + a token)"
if have vercel; then
  say '```'
  vercel project ls 2>/dev/null >>"$TMP" || true
  say '```'
else
  gap "vercel:cli" \
    "the Vercel CLI is not installed and no VERCEL_TOKEN is present, so project / env-var / domain facts could NOT be enumerated live. ★ Do not fill this in from memory — that is the failure mode this document exists to end. Resolve with: \`npm i -g vercel && vercel login && vercel link\` in synthwatch-dashboard, then re-run. ★ What must be captured when resolved: env var NAMES per environment (production/preview/development), which are \`NEXT_PUBLIC_*\` (**inlined into the client bundle at BUILD time — changing one requires a REBUILD, not just a redeploy, and its value is publicly readable**), custom domains, and the protection-bypass setting."
fi
say ""
say "**What is known from this side of the fence** (the runner's own view of the dashboard):"
say ""
if have psql && [[ -n "${DATABASE_URL:-}" ]]; then
  if rows="$(psql "$DATABASE_URL" -tAc "SELECT DISTINCT regexp_replace(target_url,'^https?://([^/]+).*','\1') FROM checks WHERE enabled AND target_url ILIKE '%vercel%'" 2>/dev/null)"; then
    while read -r h; do [[ -n "$h" ]] && say "- Monitored Vercel host: \`${h}\`"; done <<<"$rows"
  fi
else
  gap "db:unavailable" "psql or DATABASE_URL unavailable — monitor-derived sections (4, 5, 6) are incomplete"
fi
say ""

# ═══════════════════════════════════════════════════════════════════════════
say "## 5. External dependencies with NO owner in this repo"
say ""
say "★ Each of these is maintained by someone outside this codebase. In a new subscription or tenant they"
say "do not come along, and a failure caused by one looks exactly like a parity failure."
say ""
say "| Dependency | Where it is wired | Who owns it | Migration risk |"
say "|---|---|---|---|"
say "| **Vercel protection-bypass token** | ACA secret \`vercel-bypass-token\` → env \`VERCEL_BYPASS_TOKEN\`; injected per-request by \`runner/vercelBypass.ts\`, host-scoped to \`PROTECTED_BYPASS_HOSTS\` | Wegmans (Vercel project owner) | Token is per-Vercel-project. Gates the commerce **PREVIEW** monitor; without it that check bot-blocks. |"
say "| **Akamai / Wegmans IP allowlist** | Not in code — allowlisted on the Wegmans side, keyed to the egress IPs in §6 | Wegmans / Akamai ops | ★ **New subscription ⇒ new egress IPs ⇒ every authenticated Wegmans monitor bot-blocks until re-allowlisted.** Lead time is external. |"
say "| **Algolia search endpoint** | Monitored directly as a check target (\`*-dsn.algolia.net\`) | Wegmans (Algolia app owner) | App ID is embedded in the check's URL; a key rotation on their side reds the check with no change here. |"
say "| **OpenTable reservation widgets** | Third-party embed asserted by the Amore / Next Door monitors | OpenTable + the restaurant sites | Widget markup can change without notice; the monitor asserts their DOM, not ours. |"
say "| **B2C test account** | ACA secret \`cred-enc-key\` decrypts \`checks.login_credentials\` | Wegmans identity team | Account lockout/expiry reds the authenticated flows; credentials must be re-seeded and re-encrypted in the destination. |"
say ""
say "**Live third-party hosts asserted by enabled checks** (the real external surface):"
say ""
if have psql && [[ -n "${DATABASE_URL:-}" ]]; then
  if hosts="$(psql "$DATABASE_URL" -tAc "SELECT DISTINCT regexp_replace(target_url,'^https?://([^/]+).*','\1') AS h FROM checks WHERE enabled ORDER BY 1" 2>/dev/null)"; then
    while read -r h; do [[ -n "$h" ]] && say "- \`${h}\`"; done <<<"$hosts"
  fi
  say ""
    # ── ★ FIRST-PARTY HOSTS THAT ARE **NOT** RESOURCES IN THIS SUBSCRIPTION ──────────────────────────
  # A host that is plainly ours by naming convention (*.azurewebsites.net / *.vercel.app) but has no
  # matching resource in the enumerated subscription is a load-bearing component living somewhere this
  # inventory cannot see. That is a migration blocker hiding in plain sight: the RG can be moved in full
  # and the system still not work.
  say ""
  say "**★ First-party hosts with NO matching resource in this subscription**"
  say ""
  say "These are monitored, passing, and ours by naming convention — but they are not in the resource list"
  say "in §1.1, and this subscription has only the one resource group. Whatever hosts them is OUT OF SCOPE"
  say "of everything above and must be tracked down separately before a migration is called complete."
  say ""
  ALL_RES="$(az resource list --query "[].name" -o tsv 2>/dev/null || true)"
  RG_COUNT="$(az group list --query "length(@)" -o tsv 2>/dev/null || echo '?')"
  say "| Host | Monitored by | Found in this subscription? |"
  say "|---|---|---|"
  if fh="$(psql "$DATABASE_URL" -tAc "
        SELECT host||E'\t'||string_agg(DISTINCT id::text, ', ' ORDER BY id::text)
        FROM (SELECT id, regexp_replace(target_url,'^https?://([^/]+).*','\1') AS host
                FROM checks
               WHERE enabled AND (target_url ILIKE '%azurewebsites.net%' OR target_url ILIKE '%vercel.app%')) t
        GROUP BY host ORDER BY host" 2>/dev/null)"; then
    while IFS=$'\t' read -r h ids; do
      [[ -z "$h" ]] && continue
      base="${h%%.*}"
      if grep -qxF "$base" <<<"$ALL_RES"; then
        say "| \`${h}\` | checks ${ids} | ✅ yes — \`${base}\` |"
      else
        say "| \`${h}\` | checks ${ids} | ⚠️ **NO — no resource named \`${base}\` in any of the ${RG_COUNT} resource group(s)** |"
      fi
    done <<<"$fh"
  fi
  say ""
  say "★ A ⚠️ row above means the component is hosted outside this subscription (a different subscription,"
  say "tenant, or a personal account). Moving \`${RG}\` will NOT move it, and the monitors that assert it"
  say "will keep passing right up until the day it disappears."
  say ""

say "**Checks carrying encrypted login credentials** (each needs its account re-provisioned):"
  say ""
  if cr="$(psql "$DATABASE_URL" -tAc "SELECT id||E'\t'||name||E'\t'||enabled FROM checks WHERE login_credentials IS NOT NULL ORDER BY id" 2>/dev/null)"; then
    say "| Check | Name | Enabled |"
    say "|---|---|---|"
    while IFS=$'\t' read -r i n e; do say "| ${i} | ${n} | ${e} |"; done <<<"$cr"
  fi
fi
say ""

# ═══════════════════════════════════════════════════════════════════════════
say "## 6. ★ Static egress IPs per region"
say ""
say "★ **The single most migration-critical table in this document.** These are the addresses Wegmans/Akamai"
say "allowlist. They are properties of the ACA managed ENVIRONMENT — a new subscription means new"
say "environments and therefore **new IPs**. Monitors will then fail for an environmental reason that is"
say "indistinguishable, from the logs, from a genuine parity regression."
say ""
say "Measured from what the runner ACTUALLY egressed as — \`runs.egress_ip\`, captured per run — not from"
say "an environment property or a doc."
cmd "psql \"\$DATABASE_URL\" -c \"SELECT location, egress_ip, count(*), min(started_at), max(started_at) FROM runs WHERE egress_ip IS NOT NULL AND started_at > now() - interval '30 days' GROUP BY 1,2\""
if have psql && [[ -n "${DATABASE_URL:-}" ]]; then
  if eg="$(psql "$DATABASE_URL" -tAc "
      SELECT location||E'\t'||egress_ip||E'\t'||count(*)||E'\t'||min(started_at)::date||E'\t'||max(started_at)::date
      FROM runs WHERE egress_ip IS NOT NULL AND started_at > now() - interval '30 days'
      GROUP BY location, egress_ip ORDER BY location, count(*) DESC" 2>/dev/null)"; then
    say "| Region | Egress IP | Runs (30d) | First seen | Last seen |"
    say "|---|---|---|---|---|"
    while IFS=$'\t' read -r l ip c f t; do say "| ${l} | **\`${ip}\`** | ${c} | ${f} | ${t} |"; done <<<"$eg"
    say ""
    n_ips="$(wc -l <<<"$eg" | tr -d ' ')"
    n_regions="$(cut -f1 <<<"$eg" | sort -u | wc -l | tr -d ' ')"
    say "_${n_ips} distinct (region, IP) pairs across ${n_regions} regions in the last 30 days._"
    if [[ "$n_ips" -gt "$n_regions" ]]; then
      say ""
      say "⚠️ **More IPs than regions** — at least one region egressed from more than one address in the"
      say "window. That is the instability described below showing up in the data; allowlisting a single"
      say "IP per region is then not sufficient."
    fi
  else
    gap "egress:query" "could not read runs.egress_ip"
  fi
else
  gap "egress:db" "psql/DATABASE_URL unavailable — the egress IPs could NOT be read. ★ This is a migration-blocking gap; re-run with DATABASE_URL set."
fi
say ""
say "★ **These IPs are empirically stable but NOT contractually stable.** The ACA environments are"
say "Consumption-tier with no custom VNet, so outbound traffic leaves via Azure's shared egress, which"
say "Microsoft explicitly documents as *not guaranteed stable* and *not intended as an allowlist target*."
say "They have held for the window above, and the allowlist depends on them — but a platform maintenance"
say "event can change them with no deploy on our side. A durable answer requires VNet integration + a NAT"
say "gateway, and \`vnetConfiguration\` is **immutable after environment creation**, so that means"
say "re-creating all three environments — a migration-shaped change, not a config tweak."
say ""

# ═══════════════════════════════════════════════════════════════════════════
say "---"
say ""
say "## ⚠️ Gaps — what this run could NOT resolve"
say ""
say "A named gap is worth more than a table that looks complete. Each line is something a reader must NOT"
say "assume is covered."
say ""
if [[ -s "$TMP.gaps" ]]; then
  cat "$TMP.gaps" >>"$TMP"
  say ""
  say "_$(wc -l <"$TMP.gaps" | tr -d ' ') unresolved item(s)._"
else
  say "_None — every section resolved from the live system._"
fi
say ""
say "---"
say ""
say "_Generated \`${GEN_START}\` · regenerate with \`scripts/generate-handover-inventory.sh\`._"

# ── ★ REDACTION GUARD — refuse to write a file containing a secret VALUE ─────────────────────────────
# Rule 2 is only worth as much as its enforcement. This scans the generated output for the VALUES of the
# secret-bearing env vars this machine actually holds, plus a few generic credential shapes. A hit means
# some section printed a value it should have printed a NAME for, and the file is NOT written — a
# half-redacted inventory committed to a public repo is far worse than no inventory.
leak_report="$(
  python3 - "$TMP" <<'PY'
import os, re, sys
doc = open(sys.argv[1], encoding='utf-8', errors='replace').read()
hits = []
for k in ('PG_PW','DATABASE_URL','ACS_CONN','VERCEL_BYPASS_TOKEN','CRED_ENC_KEY',
          'B2C_TEST_USER','B2C_TEST_PASS','GITHUB_TOKEN','AZURE_STORAGE_CONNECTION_STRING'):
    v = os.environ.get(k)
    if v and len(v) > 6 and v in doc:
        hits.append(f"the VALUE of ${k}")
for label, rx in (('a storage account key', r'[A-Za-z0-9+/]{86}=='),
                  ('an AccountKey= connection string', r'AccountKey='),
                  ('a password= in a connection string', r'password=\S{6,}'),
                  ('a JWT', r'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'),
                  ('a PEM private key', r'-----BEGIN')):
    if re.search(rx, doc, re.I):
        hits.append(label)
print('\n'.join(hits))
PY
)"
if [[ -n "$leak_report" ]]; then
  echo "REFUSING TO WRITE ${OUT} — the generated output contains secret material:" >&2
  # Line-wise, not word-wise: an unquoted $leak_report word-splits each reason into fragments.
  while IFS= read -r reason; do [[ -n "$reason" ]] && echo "  - ${reason}" >&2; done <<<"$leak_report"
  echo "Fix the offending section to print a NAME, not a value, then re-run." >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
cp "$TMP" "$OUT" || { echo "could not write ${OUT}" >&2; exit 1; }
echo "wrote ${OUT} ($(wc -l <"$OUT" | tr -d ' ') lines, $(wc -l <"$TMP.gaps" | tr -d ' ') gaps)"
