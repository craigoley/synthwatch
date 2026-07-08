// Credential-value crypto tests (model B, v1 AES-256-GCM). The KAT below is the CROSS-REPO CONTRACT: the
// SAME key+IV+plaintext must produce the SAME "STORED" string in synthwatch-api/tests (CredCryptoTests). If
// the two sides ever diverge, the runner can't decrypt the api's ciphertext — so this vector is asserted in
// BOTH repos (change it in lockstep or not at all).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptCredValue, decryptCredValue, loadCredEncKey } from './crypto.js';

// ── KNOWN-ANSWER VECTOR (must be byte-identical to the .NET CredCryptoTests) ──────────────────────────────
const KAT = {
  keyB64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=', // 32 bytes: 0x00..0x1f
  ivB64: 'AAECAwQFBgcICQoL', // 12 bytes: 0x00..0x0b
  plaintext: 'correct horse battery staple',
  stored: 'v1:AAECAwQFBgcICQoLJG2kaaCGtjvlLuX41MkaDPei4kaJWywIWReJ4O6At8GgxQlkvg7OPAnd3D8=',
};
const KEY = Buffer.from(KAT.keyB64, 'base64');
const IV = Buffer.from(KAT.ivB64, 'base64');

test('KAT: fixed key+IV+plaintext → the exact stored envelope (cross-repo contract)', () => {
  assert.equal(encryptCredValue(KAT.plaintext, KEY, IV), KAT.stored);
});

test('KAT: decrypt the fixed envelope → the original plaintext', () => {
  assert.equal(decryptCredValue(KAT.stored, KEY), KAT.plaintext);
});

test('round-trip: random IV each call, both decrypt back; two encrypts of the same value differ', () => {
  const a = encryptCredValue('s3cr3t-p@ss word!', KEY);
  const b = encryptCredValue('s3cr3t-p@ss word!', KEY);
  assert.notEqual(a, b, 'random IV → distinct ciphertexts for the same plaintext');
  assert.equal(decryptCredValue(a, KEY), 's3cr3t-p@ss word!');
  assert.equal(decryptCredValue(b, KEY), 's3cr3t-p@ss word!');
});

test('round-trip: unicode + empty string', () => {
  for (const v of ['', 'café ☕ π', 'a'.repeat(4096)]) {
    assert.equal(decryptCredValue(encryptCredValue(v, KEY), KEY), v);
  }
});

// ── fail-closed ───────────────────────────────────────────────────────────────────────────────────────────
test('decrypt FAILS on a tampered tag (authenticated encryption catches it)', () => {
  const stored = encryptCredValue('do-not-forge', KEY);
  const body = Buffer.from(stored.slice(3), 'base64');
  body[body.length - 1] ^= 0xff; // flip a tag byte
  const tampered = `v1:${body.toString('base64')}`;
  assert.throws(() => decryptCredValue(tampered, KEY));
});

test('decrypt FAILS with the wrong key (no plaintext leak / no silent pass)', () => {
  const stored = encryptCredValue('secret', KEY);
  const wrong = Buffer.alloc(32, 0xaa);
  assert.throws(() => decryptCredValue(stored, wrong));
});

test('decrypt FAILS on an unknown/absent version prefix (fail-closed, not raw passthrough)', () => {
  assert.throws(() => decryptCredValue('v2:AAAA', KEY), /unsupported credential-crypto version/);
  assert.throws(() => decryptCredValue('plaintext-no-prefix', KEY));
});

test('loadCredEncKey: absent / bad-length → throws; NAME only, never the value', () => {
  assert.throws(() => loadCredEncKey({ CRED_ENC_KEY: '' }), /CRED_ENC_KEY is not set/);
  assert.throws(() => loadCredEncKey({}), /CRED_ENC_KEY is not set/);
  assert.throws(() => loadCredEncKey({ CRED_ENC_KEY: Buffer.alloc(16).toString('base64') }), /must decode to 32 bytes/);
  // a valid 32-byte key loads
  assert.equal(loadCredEncKey({ CRED_ENC_KEY: KAT.keyB64 }).length, 32);
  // the error text never contains the (bad) key value
  try {
    loadCredEncKey({ CRED_ENC_KEY: 'SHORTKEYVALUE' });
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(!String((e as Error).message).includes('SHORTKEYVALUE'));
  }
});
