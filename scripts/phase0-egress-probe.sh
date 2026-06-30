#!/bin/sh
# ---------------------------------------------------------------------------
# Phase 0 egress-IP MEASUREMENT probe (throwaway).
# See: docs/runbooks/phase0-egress-measurement.md  and  ANALYSIS-static-egress-ip-2026-06-30.md
#
# WHAT: reflects THIS container's public egress IP off two independent plain-text
#       IP reflectors and prints one structured JSON line per sample. Run it as a
#       throwaway Container Apps Job in EACH regional ACA env (synthwatch-env-e2 /
#       -centralus / -westus2) so the IP seen is the SAME env-level egress the
#       runner job leaves from — i.e. what Akamai actually sees from the monitors.
#
# WHY env-level: in a Consumption ACA environment (no custom VNet — confirmed in
#       the analysis doc) outbound IPs are a property of the managed ENVIRONMENT,
#       shared by every app/job in it. So a throwaway job in synthwatch-env-e2
#       egresses identically to synthwatch-runner-job in synthwatch-env-e2.
#
# GUARDRAILS: measurement ONLY. The reflectors are plain IP echoers — NO creds, NO
#       secrets, NO sensitive data sent or received. Provisions no NAT/VNet/proxy.
#       Allowlisting the result is Craig's Wegmans-side step, not this script.
#
# Pure POSIX sh + curl — runs as-is in curlimages/curl (busybox + curl).
# ---------------------------------------------------------------------------
set -u

REGION="${SYNTHWATCH_LOCATION:-${REGION:-unknown}}"          # vantage label (matches the runner's)
REPLICA="${CONTAINER_APP_REPLICA_NAME:-$(hostname 2>/dev/null || echo unknown)}" # distinct per execution → detects pool rotation
SAMPLES="${SAMPLES:-6}"                                       # samples per execution
INTERVAL="${INTERVAL:-20}"                                    # seconds between samples

# Reflect this container's public IP. Two independent reflectors → cross-check: a
# DISAGREEMENT means egress SNATs per-connection across multiple IPs (a pool), which
# is itself the signal we care about.
reflect() { curl -fsS --max-time 10 "$1" 2>/dev/null | tr -d '[:space:]'; }

i=1
while [ "$i" -le "$SAMPLES" ]; do
  TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  IP_AWS="$(reflect https://checkip.amazonaws.com)"
  IP_IPIFY="$(reflect https://api.ipify.org)"
  MATCH=false
  [ -n "$IP_AWS" ] && [ "$IP_AWS" = "$IP_IPIFY" ] && MATCH=true
  # One JSON line per sample, prefixed with a grep/KQL marker.
  printf 'PHASE0_EGRESS {"region":"%s","replica":"%s","sample":%s,"ts":"%s","ip_aws":"%s","ip_ipify":"%s","match":%s}\n' \
    "$REGION" "$REPLICA" "$i" "$TS" "$IP_AWS" "$IP_IPIFY" "$MATCH"
  i=$((i + 1))
  [ "$i" -le "$SAMPLES" ] && sleep "$INTERVAL"
done
