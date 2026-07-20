// Shared credential-value crypto (model B) — the SINGLE source of the AES-256-GCM contract the runner
// (decrypt-on-read) and synthwatch-api (encrypt-on-write) MUST implement byte-identically. If either side
// diverges on any detail (IV length, tag handling, envelope layout, key encoding), the runner cannot decrypt
// the api's ciphertext and every login monitor fails closed in prod. The api mirror lives at
// synthwatch-api/Infrastructure/CredCrypto.cs; the SAME known-answer vector (KAT) is asserted in BOTH repos.
//
// ── THE CONTRACT (v1) ────────────────────────────────────────────────────────────────────────────────────
//   key       : 32 raw bytes (AES-256). Delivered as env CRED_ENC_KEY = base64(32 bytes). base64-decoded both
//               sides; MUST decode to exactly 32 bytes or it's fail-closed (no plaintext fallback).
//   scheme    : AES-256-GCM. IV = 12 random bytes per value (GCM standard). Auth tag = 16 bytes. No AAD in v1.
//   stored    : "v1:" + base64( IV(12) ‖ ciphertext ‖ tag(16) ).  The "v1:" prefix lets the scheme evolve
//               without silently mis-decrypting old values (an unknown prefix is fail-closed).
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const CRED_CRYPTO_VERSION = 'v1';
const IV_LEN = 12; // GCM standard nonce
const TAG_LEN = 16; // GCM auth tag
const KEY_LEN = 32; // AES-256

/**
 * Load + validate the AES key from CRED_ENC_KEY (base64 of 32 bytes). FAIL-CLOSED: absent, non-base64, or
 * wrong length throws — the caller must NOT proceed (never store/return plaintext when the key is unusable).
 * The key itself is NEVER logged / returned in an error (the message names the env var, never its value).
 */
export function loadCredEncKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  return parseAes256Key(env.CRED_ENC_KEY, 'CRED_ENC_KEY');
}

/**
 * Parse + validate a base64 AES-256 key from `raw`, naming the source in every error via `varName`.
 * Extracted from loadCredEncKey so the SANDBOX PAYLOAD key (SW_SANDBOX_CRED_KEY — a per-run, ephemeral
 * key that is NOT CRED_ENC_KEY and NEVER unlocks stored monitor credentials) goes through the SAME strict
 * validation rather than a second, laxer parser. FAIL-CLOSED: absent, non-canonical base64, or the wrong
 * decoded length throws — the caller must NOT proceed. The key value is NEVER included in an error message.
 */
export function parseAes256Key(raw: string | undefined, varName: string): Buffer {
  if (!raw || raw.length === 0) {
    throw new Error(`${varName} is not set — cannot encrypt/decrypt credential values (fail-closed)`);
  }
  // STRICT base64 validation BEFORE decode. Node's Buffer.from(…, 'base64') is lenient (silently drops
  // invalid chars / stops at bad padding), so a malformed key that happens to decode to 32 bytes would be
  // ACCEPTED here but REJECTED by .NET's strict Convert.FromBase64String — a cross-repo divergence. Reject
  // anything that isn't canonical base64 (length %4, valid alphabet, ≤2 '=' pad) so both sides agree.
  if (raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    throw new Error(`${varName} is not valid base64 (fail-closed)`);
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_LEN) {
    throw new Error(`${varName} must decode to ${KEY_LEN} bytes (AES-256); got ${key.length} (fail-closed)`);
  }
  return key;
}

/**
 * Encrypt `plaintext` under `key` → "v1:" + base64(IV ‖ ciphertext ‖ tag). A fresh random IV each call.
 * `ivOverride` is TEST-ONLY (deterministic known-answer vectors) — never pass it in prod.
 */
export function encryptCredValue(plaintext: string, key: Buffer, ivOverride?: Buffer): string {
  const iv = ivOverride ?? randomBytes(IV_LEN);
  if (iv.length !== IV_LEN) throw new Error(`IV must be ${IV_LEN} bytes`);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 bytes
  return `${CRED_CRYPTO_VERSION}:${Buffer.concat([iv, ct, tag]).toString('base64')}`;
}

/**
 * Decrypt a "v1:"-prefixed value produced by encryptCredValue (or the api mirror) back to plaintext.
 * FAIL-CLOSED (throws) on: an unknown/absent version prefix, malformed base64, a too-short envelope, or a
 * failing auth tag (tampered ciphertext / wrong key). The caller must NOT treat a throw as "use the raw
 * string" — a failed decrypt means the value is unusable, and the run should fail loud.
 */
export function decryptCredValue(stored: string, key: Buffer): string {
  const sep = stored.indexOf(':');
  const version = sep === -1 ? '' : stored.slice(0, sep);
  if (version !== CRED_CRYPTO_VERSION) {
    throw new Error(`unsupported credential-crypto version ${JSON.stringify(version)} (expected ${CRED_CRYPTO_VERSION})`);
  }
  const buf = Buffer.from(stored.slice(sep + 1), 'base64');
  // IV + tag with (possibly empty) ciphertext between — a 0-length ciphertext (empty plaintext) is valid GCM.
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error('credential ciphertext too short / malformed (fail-closed)');
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  // authTagLength pins the expected tag to 16 bytes — reject a truncated tag (GCM forgery hardening).
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);
  // .final() throws if the tag doesn't verify — authenticated encryption catches tamper / wrong key.
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
