// ── Wegmans first-party host allowlist (Error-diff P1) ────────────────────────────────────────────────────
//
// THE shared answer to "is this host first-party (Wegmans) or third-party?", used by the trace-signal
// classifier to label console origins + network requests. FAITHFUL-PORTED to the C# extractor
// (synthwatch-api Infrastructure/FirstPartyHosts.cs) — keep the two byte-identical; the shared
// trace-signals golden fixture guards their agreement.
//
// WHY this replaces the old exact-target-host rule (`isSite`): the classifier used to call a host first-party
// ONLY when it equalled the check's target host or was a subdomain of it. That misread the whole Wegmans
// estate — a SIBLING subdomain of the target (images.wegmans.com when the check targets www.wegmans.com),
// anything on *.wegmans.cloud, the Azure APIM gateway, and the wegapi/kitting backends all fell through to
// "third-party". So the origin signal was wrong for exactly the hosts a Wegmans monitor most cares about.
//
// The allowlist is Wegmans-owned domains (apex + any subdomain) PLUS the backend families Craig confirmed:
// the Azure APIM gateway (*.azure-api.net) and any host whose name contains `wegapi` / `kitting`. The
// substring families are a deliberate heuristic (a bare host name, not an ownership proof) — good enough for
// a first-party/third-party DISPLAY label, not a security boundary.

/** host === domain OR host is a subdomain of domain (`*.domain`). Both args already lowercased. */
function isApexOrSub(host: string, domain: string): boolean {
  return host === domain || host.endsWith('.' + domain);
}

/**
 * Is `host` a Wegmans first-party host, independent of any particular check's target? Case-insensitive.
 * Empty host → false (blob:/data:/about: resources have no host → third-party).
 */
export function isWegmansHost(host: string): boolean {
  if (host.length === 0) return false;
  const h = host.toLowerCase();
  // Wegmans-owned domains: apex + every subdomain (www/images/preview.commerce/… all first-party).
  if (isApexOrSub(h, 'wegmans.com')) return true;
  if (isApexOrSub(h, 'wegmans.cloud')) return true;
  // Azure API Management gateway (all *.azure-api.net — Craig's call; the estate's APIM lives here).
  if (h.endsWith('.azure-api.net')) return true;
  // Backend API families by name (wegapi = the storefront API, kitting = kitting/catering-api).
  if (h.includes('wegapi')) return true;
  if (h.includes('kitting')) return true;
  return false;
}

/**
 * First-party for THIS check: a Wegmans allowlist host, OR the check's own target host / a subdomain of it.
 * The target clause keeps a monitor whose target is NOT in the static allowlist (a legacy/hand-made check, or
 * a future domain) treating its own site as first-party. Empty host → false. Case-insensitive.
 *
 * ★ This is the RESOURCE-host classifier: callers pass the host of the RESOURCE the error/request is about
 * (the request URL's host; or, for a console error, the host parsed out of the error text) — NOT the frame
 * that logged it. That's what fixes the CSP-violation case (a third-party resource refused by the site frame
 * was read as origin:'site' when keyed off the frame).
 */
export function isFirstParty(host: string, target: string | null): boolean {
  if (host.length === 0) return false;
  const h = host.toLowerCase();
  if (isWegmansHost(h)) return true;
  if (target) {
    const t = target.toLowerCase();
    if (h === t || h.endsWith('.' + t)) return true;
  }
  return false;
}
