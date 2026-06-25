# whatif-halts.jq — emit one line per HALT-WORTHY change in an `az deployment group what-if
# --no-pretty-print` result (empty output == clean). Shared by scripts/deploy.sh (the gate)
# and scripts/deploy_test.sh (the proof), so the tested program IS the shipped program.
#
# Walks each change's nested delta tree into full dotted property paths, then HALTS on:
#   - a resource-level changeType == "Delete"            (a resource is being deleted), or
#   - a property Delete under an `env` segment            (a job env KEY is removed), or
#   - a property Delete under a `secrets` segment         (a secret / secretRef is removed).
# Everything else — Modify representation changes (registry server, AZURE_CLIENT_ID literal->
# reference) and undeclared-default Deletes on non-env/secrets paths (Postgres dataEncryption/
# network/replica/storage.*, managedEnv peer*, blob/container retention) — is BENIGN noise.
# The benign Deletes never sit under env/secrets, so the path test cleanly separates them.
def walk($prefix):
  ($prefix + (if .path==null then "" elif $prefix=="" then .path else "."+.path end)) as $full
  | if (.children|type)=="array" and (.children|length>0)
    then (.children[] | walk($full))
    else {ct: .propertyChangeType, path: $full} end;
.changes[] as $c
| ($c.resourceId | split("/") | .[-2:] | join("/")) as $r
| (
    (if $c.changeType == "Delete" then "RESOURCE DELETED\t\($r)" else empty end),
    (if $c.delta != null then
       $c.delta[] | walk("")
       | select(.ct == "Delete" and (.path | test("(^|\\.)(env|secrets)(\\.|$)")))
       | "JOB ENV/SECRET REMOVED\t\($r)\t\(.path)"
     else empty end)
  )
