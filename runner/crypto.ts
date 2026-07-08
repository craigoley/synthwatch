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
  const raw = env.CRED_ENC_KEY;
  if (!raw || raw.length === 0) {
    throw new Error('CRED_ENC_KEY is not set — cannot encrypt/decrypt credential values (fail-closed)');
  }
  let key: Buffer;
  try {
    key = Buffer.from(raw, 'base64');
  } catch {
    throw new Error('CRED_ENC_KEY is not valid base64 (fail-closed)');
  }
  if (key.length !== KEY_LEN) {
    throw new Error(`CRED_ENC_KEY must decode to ${KEY_LEN} bytes (AES-256); got ${key.length} (fail-closed)`);
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
  const cipher = createCipheriv('aes-256-gcm', key, iv);
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
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  // .final() throws if the tag doesn't verify — authenticated encryption catches tamper / wrong key.
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
