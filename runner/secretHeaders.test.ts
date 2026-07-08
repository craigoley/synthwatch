// Unit tests for per-monitor SECRET headers — MODEL B (0068): the leaf is CIPHERTEXT, decrypted ONCE
// (decryptSecretHeaders, fail-closed), then host-filtered per request (firstPartyHeaders, the anti-leak gate).
import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptSecretHeaders, firstPartyHeaders, isFirstParty } from './secretHeaders.js';
import { encryptCredValue, loadCredEncKey } from './crypto.js';

const TARGET_HOST = 'www.wegmans.com';
const TARGET = 'https://www.wegmans.com';
const SECRET = 's3cr3t-api-key-value';
const TEST_KEY_B64 = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 7)).toString('base64');

function enc(plaintext: string): string {
  return encryptCredValue(plaintext, loadCredEncKey({ CRED_ENC_KEY: TEST_KEY_B64 }));
}
function withKey<T>(fn: () => T): T {
  const prev = process.env.CRED_ENC_KEY;
  process.env.CRED_ENC_KEY = TEST_KEY_B64;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CRED_ENC_KEY;
    else process.env.CRED_ENC_KEY = prev;
  }
}

// ── decryptSecretHeaders (once, fail-closed) ──
test('decryptSecretHeaders: DECRYPTS each ciphertext leaf', () => {
  withKey(() => {
    assert.deepEqual(decryptSecretHeaders({ 'x-api-key': enc(SECRET) }), { 'x-api-key': SECRET });
  });
});

test('decryptSecretHeaders: FAIL-CLOSED on a leaf that is not v1 ciphertext (legacy ref-name)', () => {
  withKey(() => {
    assert.throws(() => decryptSecretHeaders({ 'x-api-key': 'WEGMANS_API_KEY' }), /did not decrypt/);
  });
});

test('decryptSecretHeaders: FAIL-CLOSED when CRED_ENC_KEY is absent (has values)', () => {
  const prev = process.env.CRED_ENC_KEY;
  delete process.env.CRED_ENC_KEY;
  try {
    assert.throws(() => decryptSecretHeaders({ 'x-api-key': 'v1:whatever' }), /CRED_ENC_KEY is not set/);
  } finally {
    if (prev !== undefined) process.env.CRED_ENC_KEY = prev;
  }
});

test('decryptSecretHeaders: null / empty -> {} (no key required)', () => {
  const prev = process.env.CRED_ENC_KEY;
  delete process.env.CRED_ENC_KEY;
  try {
    assert.deepEqual(decryptSecretHeaders(null), {});
    assert.deepEqual(decryptSecretHeaders({}), {});
  } finally {
    if (prev !== undefined) process.env.CRED_ENC_KEY = prev;
  }
});

// ── firstPartyHeaders (per-request host filter; the anti-leak gate) ──
test('firstPartyHeaders: injects for a first-party request (exact host + subdomain)', () => {
  const vals = { 'x-api-key': SECRET };
  assert.deepEqual(firstPartyHeaders(vals, `${TARGET}/shop`, TARGET_HOST), { 'x-api-key': SECRET });
  assert.deepEqual(firstPartyHeaders(vals, 'https://api.www.wegmans.com/v1', TARGET_HOST), { 'x-api-key': SECRET });
});

// ★★ THE ANTI-LEAK MUST-GO-RED: a THIRD-PARTY request never carries the secret. Removing the isFirstParty
// guard in firstPartyHeaders makes this fail — the secret would spray to analytics/CDNs.
test('★ ANTI-LEAK: a THIRD-PARTY host NEVER receives the secret header', () => {
  const vals = { 'x-api-key': SECRET };
  assert.deepEqual(firstPartyHeaders(vals, 'https://www.google-analytics.com/collect', TARGET_HOST), {});
  // a lookalike suffix must NOT match (wegmans.com.attacker.example is not a subdomain of www.wegmans.com)
  assert.deepEqual(firstPartyHeaders(vals, 'https://wegmans.com.attacker.example/x', TARGET_HOST), {});
});

test('firstPartyHeaders: empty values -> {} (nothing to inject)', () => {
  assert.deepEqual(firstPartyHeaders({}, `${TARGET}/`, TARGET_HOST), {});
});

test('isFirstParty: exact host + subdomain match; unrelated + lookalike do not', () => {
  assert.equal(isFirstParty('www.wegmans.com', 'www.wegmans.com'), true);
  assert.equal(isFirstParty('api.www.wegmans.com', 'www.wegmans.com'), true);
  assert.equal(isFirstParty('www.google-analytics.com', 'www.wegmans.com'), false);
  assert.equal(isFirstParty('wegmans.com.attacker.example', 'www.wegmans.com'), false);
  assert.equal(isFirstParty(null, 'www.wegmans.com'), false);
  assert.equal(isFirstParty('www.wegmans.com', null), false);
});
