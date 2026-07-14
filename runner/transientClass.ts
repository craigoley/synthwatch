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
/** One `console.messages[]` entry. origin/sourceHost are computed at capture via the SAME first-party
 *  allowlist that sets network `thirdParty` (traceSignals.ts) — so 'site' here is the identical notion. */
interface ConsoleMsg {
  level?: string;
  origin?: string; // 'site' = first-party, 'third-party' = not
  sourceHost?: string;
  text?: string;
}
/** The slice of trace_signals this classifier reads: network failures AND console messages. Reading console
 *  too fixes the blind spot that mis-classified run 963205 (five first-party console errors, zero seen). */
export interface TraceSignalsLike {
  network?: { failed?: NetworkFailed[] | null } | null;
  console?: { messages?: ConsoleMsg[] | null } | null;
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

// ── Console side (the fix) ──────────────────────────────────────────────────────────────────────────────
// A NEW first-party ERROR-level console message is a service signal, exactly as a new first-party failed
// request is. classifyTransient was blind to it — it read network.failed ONLY — so run 963205's five
// first-party errors (ChunkLoadError, a failed prod-API fetch, cart/cooklist mutation failures,
// ERR_CONNECTION_CLOSED) all scored ZERO and the run mis-classified as monitor-side (its lifetime-only, 100%
// false positive). The site was broken; the chip said the monitor was flaky.

// ★ PARITY: canonicalize console TEXT the SAME way the API's C# TraceSignalsDiff.Canonicalize does — lowercase,
// strip ISO timestamps + query strings, collapse [a-z0-9_-]{12,} id/hash tokens to '*', normalise whitespace;
// same regexes, same order. This is a SECOND implementation of that canonical form (the recurring runner↔C#
// parity class) — guard the two with a shared golden fixture (see PR). A drift here silently re-blinds the gate.
const ISO_TS = /\d{4}-\d{2}-\d{2}t[\d:.]+z?/gi;
const QUERY = /\?[^\s'")]*/g;
const LONG_TOKEN = /[a-z0-9_-]{12,}/gi;
const WS = /\s+/g;
export function canonicalizeConsole(text: string): string {
  return text
    .toLowerCase()
    .replace(ISO_TS, '')
    .replace(QUERY, '')
    .replace(LONG_TOKEN, '*')
    .replace(WS, ' ')
    .trim();
}

// Error-class levels that signal a real failure (not info/log/warning chatter). pageerror = uncaught exception.
const CONSOLE_ERROR_LEVELS = new Set(['error', 'pageerror']);

/** Canonical keys for FIRST-PARTY, ERROR-level console messages in one run's signals. `console:`-prefixed so
 *  they join the SAME "new vs baseline" set as network keys without ever colliding with a host+pathname. Reuses
 *  the existing first-party notion (origin === 'site') — NOT a second predicate. */
function firstPartyConsoleKeys(sig: TraceSignalsLike | null | undefined): Set<string> {
  const keys = new Set<string>();
  for (const m of sig?.console?.messages ?? []) {
    if (m.origin !== 'site') continue; // first-party only
    if (m.level == null || !CONSOLE_ERROR_LEVELS.has(m.level)) continue;
    if (!m.text) continue;
    keys.add(`console:${m.sourceHost ?? ''}|${canonicalizeConsole(m.text)}`);
  }
  return keys;
}

/**
 * Classify the superseded transient given its OWN signals + the last-N settled baseline runs' signals.
 *   • indeterminate — the failing run captured NO trace_signals (http/dns/ssl, or a strand). We can't see a
 *     first-party service error, so we DON'T guess — and B3-3 burns nothing for it.
 *   • service-side  — the failing run carried a NEW first-party service failure — a first-party fetch/xhr/doc
 *     that FAILED, OR a first-party ERROR-level CONSOLE message — that is NOT in the baseline union. A real
 *     blip the monitor caught (355's ChunkLoadError + failed prod-API fetch).
 *   • monitor-side  — trace_signals present, but NO new first-party failure (network OR console): a genuine
 *     monitor-side assertion / selector race (222's "grid rendered 0 rows"; persistent baseline noise, not new).
 *
 * ★ The "NEW vs baseline" clause is the whole discriminator. It now spans BOTH network.failed AND
 * console.messages: a first-party service failure often manifests only in the console (a chunk-load error, an
 * uncaught fetch rejection), never as a captured failed request — reading network alone was blind to it.
 */
export function classifyTransient(
  original: TraceSignalsLike | null | undefined,
  baseline: (TraceSignalsLike | null | undefined)[],
): TransientClass {
  if (original == null) return 'indeterminate';
  const keys = new Set<string>([...firstPartyFailedKeys(original), ...firstPartyConsoleKeys(original)]);
  const baseKeys = new Set<string>();
  for (const b of baseline) {
    for (const k of firstPartyFailedKeys(b)) baseKeys.add(k);
    for (const k of firstPartyConsoleKeys(b)) baseKeys.add(k);
  }
  const hasNewFirstParty = [...keys].some((k) => !baseKeys.has(k));
  return hasNewFirstParty ? 'service-side' : 'monitor-side';
}
