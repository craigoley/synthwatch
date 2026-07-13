// B3-2 stage 2 — classify a SUPERSEDED transient (a scheduled run that FAILED, then a fresh confirmation
// PASSED, so it was excluded from health) as MONITOR-SIDE / SERVICE-SIDE / INDETERMINATE.
//
// ★ WHY THIS EXISTS (the safety property B3-3's flake budget is gated on): ONLY monitor-side transients may
// burn a monitor's trust budget. A SERVICE-side transient is a real, if brief, outage — the monitor CAUGHT
// it and told the truth; penalising the monitor for the service being flaky would mean "the flakier your
// service, the quieter your monitoring", an inversion we refuse.
//
// The discriminator is `superseded-transient × NEW-first-party-error`. It is deliberately NETWORK-based (a
// first-party service request that FAILED), NOT the full API error-diff (console + network + id-hash
// canonicalisation): a coarse monitor/service verdict, not the forensic panel. The API's ErrorDiff.Compute
// stays the richer display path; this is the persisted budget gate.

export type TransientClass = 'monitor-side' | 'service-side' | 'indeterminate';

/** A `network.failed[]` entry as the runner persists it in trace_signals (thirdParty computed at capture). */
interface NetworkFailed {
  url?: string;
  thirdParty?: boolean;
  resourceType?: string;
}
/** The slice of trace_signals this classifier reads — network failures only. */
export interface TraceSignalsLike {
  network?: { failed?: NetworkFailed[] | null } | null;
}

// A FAILED first-party request of one of these types is a real service non-response. image / ping / beacon /
// websocket / media failures are telemetry-or-transport noise, not a first-party service outage — excluded so
// they never read as "the service erred".
const SERVICE_RESOURCE_TYPES = new Set(['fetch', 'xhr', 'document', 'script', 'stylesheet']);

/**
 * Canonical key for a failed first-party resource: `host + pathname`, QUERY STRIPPED. Stripping the query is
 * load-bearing: a Next.js RSC prefetch whose only variation across runs is `?_rsc=<hash>` collapses to ONE
 * stable key, so a PERSISTENT teardown-cancelled prefetch (present every run) sits in the baseline and is
 * never mistaken for a NEW failure. Un-parseable / host-less URLs (e.g. `wss:`) → null (skipped).
 */
function canonicalKey(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!u.host) return null;
    return u.host + u.pathname;
  } catch {
    return null;
  }
}

/** The set of canonical keys for FIRST-PARTY, service-type request FAILURES in one run's signals. */
function firstPartyFailedKeys(sig: TraceSignalsLike | null | undefined): Set<string> {
  const keys = new Set<string>();
  for (const f of sig?.network?.failed ?? []) {
    if (f.thirdParty !== false) continue; // first-party only (thirdParty === false; true/undefined excluded)
    if (f.resourceType != null && !SERVICE_RESOURCE_TYPES.has(f.resourceType)) continue;
    const key = canonicalKey(f.url);
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * Classify the superseded transient given its OWN signals + the last-N settled baseline runs' signals.
 *   • indeterminate — the failing run captured NO trace_signals (http/dns/ssl, or a strand). We can't see a
 *     first-party service error, so we DON'T guess — and B3-3 burns nothing for it.
 *   • service-side  — the failing run carried a NEW first-party service failure (a first-party fetch/xhr/doc
 *     that failed and is NOT in the baseline union). A real blip the monitor caught (355's Wegmans fetch).
 *   • monitor-side  — trace_signals present, but NO new first-party failure: a monitor-side assertion /
 *     selector race (222's "grid rendered 0 rows"; its _rsc failures are PERSISTENT baseline noise, not new).
 *
 * ★ The "NEW vs baseline" clause is the whole discriminator — it is the ONLY thing separating a persistent
 * first-party teardown failure (present every run) from a first-party failure that DEBUTED in this transient.
 */
export function classifyTransient(
  original: TraceSignalsLike | null | undefined,
  baseline: (TraceSignalsLike | null | undefined)[],
): TransientClass {
  if (original == null) return 'indeterminate';
  const keys = firstPartyFailedKeys(original);
  const baseKeys = new Set<string>();
  for (const b of baseline) for (const k of firstPartyFailedKeys(b)) baseKeys.add(k);
  const hasNewFirstParty = [...keys].some((k) => !baseKeys.has(k));
  return hasNewFirstParty ? 'service-side' : 'monitor-side';
}
