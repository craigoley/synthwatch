// Per-monitor LOGIN CREDENTIALS — model B: ENCRYPTED VALUES stored in the DB (was: env-var references).
//
// checks.login_credentials is { credentialRole -> CIPHERTEXT } (e.g. { username: 'v1:…', password: 'v1:…' }):
// the api ENCRYPTS the value on write (CredCrypto v1); the runner DECRYPTS it at RUN time (crypto.ts) and
// exposes the plaintext to the browser spec under a GENERIC role name via the SW_CRED_<ROLE> one-run env
// (applyLoginCredentials + the shim's credential()). The stored leaf is CIPHERTEXT — the plaintext value:
//   • NEVER logged        — a decrypt failure names the role, never the value/ciphertext.
//   • NEVER in a DTO       — the api read DTO returns masked ("set"/role name), never plaintext OR ciphertext.
//   • NEVER in trace_signals — the extractor captures no form values (audit #219); + it's a registered
//                              escaped-literal redact rule (#232), so a leak into console/error is scrubbed.
//
// ★ FAIL-CLOSED: a leaf that doesn't decrypt (bad key / corrupt / a legacy env-var-ref-name that isn't "v1:"
//   ciphertext) THROWS — the run fails closed (runOne's B2 wrapper records 'error'). NEVER fall back to
//   treating the leaf as a raw/plaintext value. Until an encrypted value is seeded, the monitor has no creds.
//
// ★ PROVISIONING CEILING: values are set via the editor/write-endpoint (encrypted with CRED_ENC_KEY) — there
//   is still no per-monitor secret vault; the single symmetric key gates all of them.
import { loadCredEncKey, decryptCredValue } from './crypto.js';

/** credentialRole -> CIPHERTEXT ("v1:…", CredCrypto v1). Only the DECRYPTED value is secret. */
export type LoginCredentialValues = Record<string, string>;

/** The env-var name the shim's credential(role) reads: SW_CRED_<ROLE>, ROLE upper-cased. */
export function credentialEnvKey(role: string): string {
  return `SW_CRED_${role.toUpperCase()}`;
}

/**
 * DECRYPT a monitor's login credentials to { role: plaintext }. Loads CRED_ENC_KEY once (only when there ARE
 * values — a monitor with none needs no key). FAIL-CLOSED: a missing/invalid key or any leaf that doesn't
 * decrypt (corrupt ciphertext / wrong key / a legacy ref-name) THROWS — the run fails closed rather than
 * running with a wrong or absent credential. The plaintext appears ONLY in the returned map; never logged.
 */
export function resolveLoginCredentials(enc: LoginCredentialValues | null | undefined): Record<string, string> {
  if (!enc || Object.keys(enc).length === 0) return {};
  const key = loadCredEncKey(); // fail-closed if CRED_ENC_KEY absent/invalid
  const out: Record<string, string> = {};
  for (const [role, ciphertext] of Object.entries(enc)) {
    try {
      out[role] = decryptCredValue(ciphertext, key);
    } catch {
      // NAME-only — never the value/ciphertext. Re-throw so the run fails closed (no partial/empty creds).
      throw new Error(`[login-creds] role "${role}" did not decrypt (corrupt ciphertext, wrong key, or a legacy ref-name) — failing closed`);
    }
  }
  return out;
}

/**
 * Credential ROLES whose value is a NON-SECRET identifier — safe to appear in CLEARTEXT in traces/logs.
 * A shop-flow TEST-ACCOUNT username is a login identifier (like a throwaway email), not a secret; redacting
 * it hid what username was actually typed and blocked debugging the failing shop-flow login. Everything NOT
 * listed here (password + any future role) STAYS redacted — fail-CLOSED, so a new secret role is never
 * silently leaked; only an explicitly-declared non-secret role becomes visible. Compared case-insensitively
 * (roles are upper-cased into SW_CRED_<ROLE>).
 */
export const NON_SECRET_CRED_ROLES: ReadonlySet<string> = new Set(['username']);

/**
 * The subset of resolved credential VALUES that must be scrubbed from traces/logs: every role EXCEPT the
 * NON_SECRET_CRED_ROLES. So the password (and any unrecognised role) is registered for redaction while the
 * username identifier is left visible. This feeds ONLY the redactors (run/step/zip) — it is NOT the publish
 * path, so every role (username included) is still injected to the spec via SW_CRED_<ROLE>.
 */
export function redactableCredValues(resolved: Record<string, string>): string[] {
  return Object.entries(resolved)
    .filter(([role]) => !NON_SECRET_CRED_ROLES.has(role.toLowerCase()))
    .map(([, value]) => value);
}

/** A published SW_CRED_<ROLE> env var + the value it had BEFORE publish (undefined = didn't exist), so the
 *  cleanup can RESTORE the prior value rather than blindly deleting — defensive if the reserved SW_CRED_*
 *  namespace ever collides with a pre-existing job env var. */
export interface CredEnvHandle {
  key: string;
  prior: string | undefined;
}

/**
 * DECRYPT + PUBLISH a monitor's login credentials for its (about-to-run) browser spec: sets
 * process.env[SW_CRED_<ROLE>] = plaintext for each role, and returns a handle per key (with the prior value)
 * so the caller can restore them in a finally. The plaintext lives in process.env only for this one run
 * (cleared in the executeBrowser finally). FAIL-CLOSED via resolveLoginCredentials (a bad leaf throws).
 */
export function applyLoginCredentials(enc: LoginCredentialValues | null | undefined): CredEnvHandle[] {
  const resolved = resolveLoginCredentials(enc);
  const handles: CredEnvHandle[] = [];
  for (const [role, value] of Object.entries(resolved)) {
    const key = credentialEnvKey(role);
    handles.push({ key, prior: process.env[key] }); // capture prior BEFORE overwrite
    process.env[key] = value;
  }
  return handles;
}

/** RESTORE the SW_CRED_<ROLE> env vars applyLoginCredentials set — call in a finally after the spec runs.
 *  Deletes a key that didn't exist before; restores one that did (so a collision leaves env as it found it). */
export function clearLoginCredentials(handles: CredEnvHandle[]): void {
  for (const { key, prior } of handles) {
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
}
