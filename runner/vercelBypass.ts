// Vercel Deployment Protection — bypass-header injection (two-factor gate: allowlisted egress IP + this header).
//
// The protected Wegmans properties (wegmans.com, meals2go) require BOTH the InfoSec-allowlisted egress IP AND
// an `x-vercel-protection-bypass` header carrying a fleet-wide shared token. The token is ONE value for the
// whole fleet, going to a KNOWN small set of hosts, so it lives as a runtime SECRET (the ACA job secret →
// env VERCEL_BYPASS_TOKEN), NEVER in Postgres, git, the DB, a DTO, or a log.
//
// ★★ SECURITY INVARIANTS:
//  • HOST-SCOPED: the token is injected ONLY for requests whose host is in PROTECTED_BYPASS_HOSTS. It must
//    NEVER spray to third-party subresources (analytics/CDNs) a browser page loads — hence per-request matching,
//    NOT Playwright's context-wide extraHTTPHeaders.
//  • FAIL-SOFT: if VERCEL_BYPASS_TOKEN is unset (local runs, non-protected fleets), NO header is added and
//    nothing breaks — non-protected checks are unaffected.
//  • NEVER LOGGED / NEVER PERSISTED: the value is a REQUEST header. The trace extractor (traceSignals.ts)
//    captures response/url/method only — NOT request headers — so the token can't reach runs.trace_signals.
import { hostOf } from './deploys.js';

export const BYPASS_HEADER = 'x-vercel-protection-bypass';

// ★ The Vercel-protected hostnames (Deployment Protection). Host-matched (lowercased, as hostOf returns).
// CLEARLY EDITABLE — this is the allow-set. NOT derived from target_url, NOT per-check. ★ CONFIRM with Craig
// the exact set (amore/nextdoor are NOT Vercel-protected per current recon; add here if that changes).
export const PROTECTED_BYPASS_HOSTS = new Set<string>([
  'www.wegmans.com',
  'wegmans.com',
  'www.meals2go.com',
  'meals2go.com',
]);

/** True iff `host` (a lowercased hostname from hostOf) is a Vercel-protected property needing the bypass header. */
export function isProtectedHost(host: string | null): boolean {
  return host !== null && PROTECTED_BYPASS_HOSTS.has(host);
}

/** The fleet-wide bypass token from the secret env, or null when unset/empty (fail-soft). */
export function bypassToken(): string | null {
  const t = process.env.VERCEL_BYPASS_TOKEN;
  return t !== undefined && t.length > 0 ? t : null;
}

/**
 * The bypass header entry `[name, value]` to add for a request to `url`, or null when the host isn't protected
 * OR the token isn't configured. Host-scoped: the token is returned ONLY for a protected host. Used by the HTTP
 * path (single target fetch) and, via browserHeaderAdditions, by the browser path (per request).
 */
export function bypassHeaderFor(url: string): [string, string] | null {
  const token = bypassToken();
  if (!token) return null;
  if (!isProtectedHost(hostOf(url))) return null;
  return [BYPASS_HEADER, token];
}

/**
 * The header additions a browser request to `url` should carry: the per-monitor `customHeaders`
 * (check.request_headers — sent to ALL hosts, matching the "merge request_headers for the browser path too"
 * gap-fix) PLUS the bypass token (protected hosts ONLY). Returns null when there is nothing to add, so the
 * route handler can `route.continue()` untouched. ★ The bypass token is added ONLY when bypassHeaderFor is
 * non-null (protected host + token set) — a third-party host never receives it (the anti-leak invariant).
 */
export function browserHeaderAdditions(
  url: string,
  customHeaders: Record<string, string>,
): Record<string, string> | null {
  const additions: Record<string, string> = { ...customHeaders };
  const bypass = bypassHeaderFor(url);
  if (bypass) additions[bypass[0]] = bypass[1];
  return Object.keys(additions).length > 0 ? additions : null;
}
