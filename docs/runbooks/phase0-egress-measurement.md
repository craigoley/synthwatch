# Runbook — Phase 0: measure the monitors' real egress IP (is it already stable?)

> _Verified 2026-07-14 — prose with **no automated check**; if the code disagrees, the code is authoritative. This doc CAN rot._

**Goal:** find the actual public egress IP each regional monitor leaves from, and whether it's a **single stable IP** (→ allowlist as-is, **zero infra**) or **rotates across a pool** (→ Phase 1: proxy/NAT). See `ANALYSIS-static-egress-ip-2026-06-30.md`.

**Owner:** Craig runs these (they create + start throwaway Azure jobs). Recon/build provisioned nothing.

**Guardrails honored:** measurement only — no NAT/VNet/proxy, no env change, no allowlisting (that's the Wegmans-side step). The probe (`scripts/phase0-egress-probe.sh`) only hits plain IP-reflectors (`checkip.amazonaws.com`, `api.ipify.org`) — no creds, no sensitive data.

---

## Why this context is representative
The runner is a **Container Apps Job** in a per-region **Consumption** ACA env with **no custom VNet** (cited in the analysis). In that config, **outbound IPs are a property of the managed environment**, shared by every app/job in it. So a throwaway job placed in `synthwatch-env-e2` egresses through the **same** path as `synthwatch-runner-job` in `synthwatch-env-e2`. We measure once per env → that's what Akamai sees from the monitors.

## Why multiple runs (not one sample)
A single job execution = one replica, which typically holds **one** SNAT IP for its whole life — so one execution can't tell "stable" from "got lucky." Real stability needs **many distinct executions over time**. We therefore run the probe on a **schedule (every 5 min)** for a few hours → dozens of distinct replicas → then count distinct egress IPs per region. The probe also takes 6 in-execution samples (cross-checked against two reflectors) to catch *mid-replica* IP flips.

---

## Step 1 — Create a throwaway scheduled probe job in EACH regional env
Run from the repo root (it reads the probe body from `scripts/phase0-egress-probe.sh`, so there's no copy to drift):

```bash
RG=synthwatch-rg
PROBE="$(cat scripts/phase0-egress-probe.sh)"          # the exact script in this repo
IMG=curlimages/curl:8.11.1                              # public image: busybox sh + curl, anonymous pull

# (env name, region label) — region label matches the runner's SYNTHWATCH_LOCATION
for pair in "synthwatch-env-e2:eastus2" "synthwatch-env-centralus:centralus" "synthwatch-env-westus2:westus2"; do
  ENV="${pair%%:*}"; REGION="${pair##*:}"
  az containerapp job create \
    -g "$RG" -n "phase0-egress-${REGION}" \
    --environment "$ENV" \
    --trigger-type Schedule \
    --cron-expression "*/5 * * * *" \
    --replica-timeout 300 --replica-retry-limit 0 \
    --parallelism 1 --replica-completion-count 1 \
    --image "$IMG" --cpu 0.25 --memory 0.5Gi \
    --command "/bin/sh" --args "-c" "$PROBE" \
    --env-vars "SYNTHWATCH_LOCATION=${REGION}" "SAMPLES=6" "INTERVAL=20" \
    -o none && echo "created phase0-egress-${REGION} in ${ENV}"
done
```

> Want a **quick single look** instead of a schedule? Use `--trigger-type Manual` above, then run each on demand:
> `az containerapp job start -g "$RG" -n "phase0-egress-eastus2" -o none` (repeat per region; start several times over a couple hours to get distinct replicas).

## Step 2 — Let it run, then check it's producing samples
Leave the scheduled jobs running **~2–4 hours** (≈ 24–48 executions/region → a trustworthy stability signal). Spot-check executions:

```bash
az containerapp job execution list -g synthwatch-rg -n phase0-egress-eastus2 \
  --query "[].{name:name, status:properties.status, start:properties.startTime}" -o table
```

## Step 3 — Query the results (all 3 regions land in one Log Analytics workspace)
All envs ship console logs to **`synthwatch-logs-e2`** (workspace GUID `8a11a8a8-7061-4540-8f5d-07fccf556742`). Run the KQL headless:

```bash
az monitor log-analytics query \
  --workspace 8a11a8a8-7061-4540-8f5d-07fccf556742 \
  --analytics-query "$(cat <<'KQL'
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(6h)
| where Log_s has "PHASE0_EGRESS"
| extend p = parse_json(extract(@"PHASE0_EGRESS (\{.*\})", 1, Log_s))
| extend region=tostring(p.region), replica=tostring(p.replica),
         ip_aws=tostring(p.ip_aws), ip_ipify=tostring(p.ip_ipify), match=tobool(p.match)
| summarize samples=count(), executions=dcount(replica),
            distinct_egress_ips=dcount(ip_aws), egress_ips=make_set(ip_aws),
            ipify_ips=make_set(ip_ipify), reflector_mismatches=countif(match==false),
            first=min(TimeGenerated), last=max(TimeGenerated)
        by region
| order by region asc
KQL
)" -o table
```

(If the table name errors, try `ContainerAppConsoleLogs` — resource-specific vs legacy `_CL`. Or read the Logs blade for workspace `synthwatch-logs-e2` and paste the KQL body.)

## Step 4 — Interpret → the verdict
Per region, read `distinct_egress_ips` + `egress_ips` over many `executions`:

| Result | Meaning | Action |
|---|---|---|
| `distinct_egress_ips == 1`, stable across all executions/hours, `ipify` agrees, `reflector_mismatches == 0` | **Single stable egress IP** | ✅ **Zero-infra**: hand Wegmans that 1 IP per region (3 total). Re-run the B2C probe from that egress. |
| small **fixed** set (2–4), unchanged over time | Small stable pool | ✅ Allowlist the set / a tight CIDR (3 regions × the set). Still zero-infra, just more IPs. |
| set keeps **growing** with more executions, and/or `reflector_mismatches > 0` | **Rotating pool / per-connection SNAT** | ❌ Not allowlistable as-is → **Phase 1** (Option C proxy = 1 reserved IP, or Option A NAT = 3). |

**The 3 IPs to hand Wegmans** (only if the top row holds) = the single `egress_ips` value for `eastus2`, `centralus`, `westus2`. Allowlisting them is **Craig's Wegmans-side process** (internal), not a step here.

## Step 5 — Clean up (throwaway — delete when done)
```bash
for REGION in eastus2 centralus westus2; do
  az containerapp job delete -g synthwatch-rg -n "phase0-egress-${REGION}" --yes -o none \
    && echo "deleted phase0-egress-${REGION}"
done
```

---

### Notes
- **Representativeness caveat (strongest possible test):** if you want zero doubt that the throwaway job's egress == the *runner's* egress, the probe can instead be run from the runner image itself (same container/image). Not needed if you accept the env-level-egress fact above; offered as a belt-and-suspenders option.
- **Stability ≠ Microsoft guarantee:** even if it reads as 1 stable IP today, Microsoft does **not** contractually pin a Consumption-env egress IP. A zero-infra allowlist is a great *bridge*; the durable guarantee still comes from Phase 1 (NAT/proxy with a reserved IP we own). Document the interim as such when handing IPs to Wegmans.
