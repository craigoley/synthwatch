// Per-monitor SECRET request headers — references-only (mirrors checks.auth's *_env model).
//
// checks.secret_headers is { headerName -> ENV_VAR_NAME }: the runner resolves process.env[ENV_VAR_NAME]
// at REQUEST time and injects `headerName: <value>`. The stored map is NON-secret (header names + env-var
// names — the same references-only shape as `auth`). The resolved VALUE is a request header only:
//   • NEVER logged        — the resolver's warn (on a missing env var) names the header + ENV_VAR only.
//   • NEVER in a DTO       — the api deliberately does not map checks.secret_headers.
//   • NEVER in trace_signals — the trace extractor captures no request headers (security-invariants #219).
//
// ★ ANTI-LEAK (mirrors the vercel bypass token): a secret header is injected ONLY for a FIRST-PARTY
//   request — one whose host is the monitor's target host (or a subdomain). It must never spray to a
//   third-party subresource (analytics/CDN) the page loads. This is why injection is per-request +
//   host-scoped, not context-wide extraHTTPHeaders.
//
// ★ PROVISIONING CEILING (honest limit): each ENV_VAR_NAME must be an ACA job env var (like
//   VERCEL_BYPASS_TOKEN) — there is no per-monitor secret vault.
import { hostOf } from './deploys.js';

/** headerName -> ENV_VAR_NAME. Both non-secret; only the resolved env value is secret. */
export type SecretHeaderRefs = Record<string, string>;

/** First-party: the request host equals the monitor's target host, or is a subdomain of it. */
export function isFirstParty(host: string | null, target: string | null): boolean {
  if (!host || !target) return false;
  const h = host.toLowerCase();
  const t = target.toLowerCase();
  return h === t || h.endsWith('.' + t);
}

/**
 * Resolve a monitor's secret headers for a request to `requestUrl`, host-scoped to `targetHost`.
 * Returns `{ headerName: value }` for each ref whose ENV_VAR is set AND the request is first-party;
 * `{}` otherwise (null refs, third-party host, or all env vars unset).
 *
 * FAIL-SOFT: a ref whose env var is unset/empty is SKIPPED (with a NAME-only warn) — a missing secret
 * must not crash the run; the monitor's own assertion then goes red, which is the correct signal.
 *
 * ★ The resolved VALUE appears ONLY in the returned map (→ the request header). It is NEVER logged.
 */
export function resolveSecretHeaders(
  refs: SecretHeaderRefs | null | undefined,
  requestUrl: string,
  targetHost: string | null,
): Record<string, string> {
  if (!refs) return {};
  // ★ ANTI-LEAK: a third-party request never receives the secret.
  if (!isFirstParty(hostOf(requestUrl), targetHost)) return {};
  const out: Record<string, string> = {};
  for (const [header, envName] of Object.entries(refs)) {
    const value = process.env[envName];
    if (value === undefined || value.length === 0) {
      // NAME-only — never the (absent) value.
      console.warn(`[secret-headers] "${header}" -> env var "${envName}" not set — header skipped (fail-soft)`);
      continue;
    }
    out[header] = value;
  }
  return out;
}
