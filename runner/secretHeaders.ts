// Per-monitor SECRET request headers — model B: ENCRYPTED VALUES stored in the DB (was: env-var references).
//
// checks.secret_headers is { headerName -> CIPHERTEXT ("v1:…") }: the api ENCRYPTS the value on write; the
// runner DECRYPTS it ONCE at run start (crypto.ts) and injects `headerName: <plaintext>` per FIRST-PARTY
// request. The stored leaf is CIPHERTEXT — the plaintext value:
//   • NEVER logged        — a decrypt failure names the header, never the value/ciphertext.
//   • NEVER in a DTO       — the api read DTO returns masked, never plaintext OR ciphertext.
//   • NEVER in trace_signals — the trace extractor captures no request headers (security-invariants #219).
//
// ★ ANTI-LEAK (mirrors the vercel bypass token): a secret header is injected ONLY for a FIRST-PARTY request
//   — one whose host is the monitor's target host (or a subdomain). Never sprays to a third-party subresource.
//   Decrypt happens ONCE up front (decryptSecretHeaders, fail-closed); the per-request step only host-filters
//   the already-decrypted map (firstPartyHeaders) — so a decrypt failure fails the run cleanly BEFORE routing,
//   never throws inside a route handler.
//
// ★ FAIL-CLOSED: a missing/invalid CRED_ENC_KEY or a leaf that doesn't decrypt THROWS at run start (runOne's
//   B2 wrapper → 'error'). NEVER fall back to a raw value.
import { hostOf } from './deploys.js';
import { loadCredEncKey, decryptCredValue } from './crypto.js';

/** headerName -> CIPHERTEXT ("v1:…"). Only the decrypted value is secret. */
export type SecretHeaderValues = Record<string, string>;

/** First-party: the request host equals the monitor's target host, or is a subdomain of it. */
export function isFirstParty(host: string | null, target: string | null): boolean {
  if (!host || !target) return false;
  const h = host.toLowerCase();
  const t = target.toLowerCase();
  return h === t || h.endsWith('.' + t);
}

/**
 * DECRYPT a monitor's secret headers ONCE → { headerName: plaintext }. Loads CRED_ENC_KEY only when there
 * ARE headers. FAIL-CLOSED: a missing/invalid key or any leaf that doesn't decrypt THROWS (the run fails
 * closed rather than sending a wrong/absent header). The plaintext is NEVER logged.
 */
export function decryptSecretHeaders(enc: SecretHeaderValues | null | undefined): Record<string, string> {
  if (!enc || Object.keys(enc).length === 0) return {};
  const key = loadCredEncKey(); // fail-closed if CRED_ENC_KEY absent/invalid
  const out: Record<string, string> = {};
  for (const [header, ciphertext] of Object.entries(enc)) {
    try {
      out[header] = decryptCredValue(ciphertext, key);
    } catch {
      // NAME-only — never the value/ciphertext. Re-throw so the run fails closed.
      throw new Error(`[secret-headers] "${header}" did not decrypt (corrupt ciphertext, wrong key, or a legacy ref-name) — failing closed`);
    }
  }
  return out;
}

/**
 * Host-scope the ALREADY-DECRYPTED headers for a request to `requestUrl`: returns the values only when the
 * request is first-party to `targetHost`; `{}` otherwise (the anti-leak gate). No decrypt here — pure filter,
 * safe to call inside the per-request route handler.
 */
export function firstPartyHeaders(
  values: Record<string, string>,
  requestUrl: string,
  targetHost: string | null,
): Record<string, string> {
  if (Object.keys(values).length === 0) return {};
  if (!isFirstParty(hostOf(requestUrl), targetHost)) return {};
  return { ...values };
}
