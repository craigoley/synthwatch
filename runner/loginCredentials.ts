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
import { MARKER_USERNAME, type KnownValue } from './redact.js';

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
 * The ONE credential role whose value is a login IDENTIFIER rather than a secret, and is therefore even
 * ELIGIBLE for the cleartext allowance below. Every other role (password + any future role) is ALWAYS
 * registered for redaction — fail-CLOSED, so a new secret role can never be silently exposed. Compared
 * case-insensitively (roles are upper-cased into SW_CRED_<ROLE>).
 */
const IDENTIFIER_CRED_ROLE = 'username';

/**
 * ★ PER-CHECK cleartext allowance for the `username` credential value, keyed by checks.source_key.
 *
 * The original exemption was GLOBAL and rested on one premise: "a shop-flow TEST-ACCOUNT username is a
 * login identifier (like a throwaway email), not a secret" — redacting it hid what username was actually
 * typed and blocked debugging a failing credentialed login. That premise is TRUE for a dedicated
 * throwaway account and FALSE for a named person's corporate address, and the global set could not tell
 * the difference. The 2026-07-29 classification recon measured both cases in retained trace zips:
 *   • wegmans-authorized-user-add-to-cart → sreordertest@gmail.com, a dedicated test account with
 *     firstName/lastName/loyaltyNumber/phoneNumber all UNPOPULATED. Premise holds; allowance granted.
 *   • wegmans-full-shop-flow             → a named employee's @wegmans.com address, whose account
 *     carries a real name, phone number and loyalty number. Premise FAILS; NOT listed, so the value is
 *     scrubbed to MARKER_USERNAME (which still proves the configured credential was typed — see there).
 *
 * DEFAULT IS REDACT: a check absent from this set (or with no source_key at all — an unmanaged/hand-made
 * check) gets its username scrubbed. So the exemption is now something a reviewer GRANTS per monitor
 * with the account's contents in hand, not something every credentialed monitor inherits by default.
 *
 * Seam choice mirrors reconcile.ts REDACTION_STRIP_ALLOWANCE deliberately — same reasoning applies: it is
 * (a) in-repo + reviewable in a PR diff, (b) per-monitor not global, (c) auditable via git blame on this
 * constant, and it keeps the privacy decision in the RUNNER (where the redactor lives) rather than
 * splitting it cross-repo into a new synthwatch-monitors manifest field + schema. To grant the allowance:
 * confirm the account has no real-person identity fields populated, then add its source_key here in a
 * reviewed PR.
 */
export const CRED_USERNAME_CLEARTEXT_ALLOWANCE: ReadonlySet<string> = new Set<string>([
  // Dedicated throwaway (sreordertest@gmail.com): name / phone / loyalty all unpopulated — measured
  // across its retained trace zips, which carry the email and nothing else identifying.
  'wegmans-authorized-user-add-to-cart',
]);

/** Whether this check may keep its username in CLEARTEXT. Fail-closed: no source_key ⇒ redact. */
export function isUsernameCleartextAllowed(sourceKey: string | null | undefined): boolean {
  return typeof sourceKey === 'string' && CRED_USERNAME_CLEARTEXT_ALLOWANCE.has(sourceKey);
}

/**
 * The resolved credential VALUES to register with the redactors (run/step/zip), each with the marker it
 * scrubs to. This feeds ONLY the redactors — it is NOT the publish path, so every role (username
 * included) is still injected to the spec via SW_CRED_<ROLE> regardless of what this returns.
 *
 *  • any role except `username`  → registered with the generic `<redacted>` marker (fail-closed).
 *  • `username`, check NOT in the allowance → registered with MARKER_USERNAME, so it is scrubbed but
 *    still legible as "the configured username was typed here".
 *  • `username`, check IN the allowance → NOT registered, i.e. left in cleartext (today's behaviour,
 *    now scoped to the monitors where the throwaway-account premise actually holds).
 */
export function redactableCredValues(
  resolved: Record<string, string>,
  sourceKey?: string | null,
): KnownValue[] {
  const usernameCleartext = isUsernameCleartextAllowed(sourceKey);
  const out: KnownValue[] = [];
  for (const [role, value] of Object.entries(resolved)) {
    if (role.toLowerCase() !== IDENTIFIER_CRED_ROLE) {
      out.push(value); // secret (or unknown → fail-closed): generic marker
    } else if (!usernameCleartext) {
      out.push({ value, marker: MARKER_USERNAME }); // scrubbed-but-present
    }
  }
  return out;
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
