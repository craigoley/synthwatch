// Unit tests for the per-monitor login-credentials MODEL B (0068): the leaf is CIPHERTEXT (CredCrypto v1),
// decrypted at run time with CRED_ENC_KEY — fail-CLOSED on a bad key / corrupt / legacy-ref leaf. Plus the
// per-run SW_CRED_<ROLE> publish/clear lifecycle and the shim's credential() accessor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveLoginCredentials,
  applyLoginCredentials,
  clearLoginCredentials,
  credentialEnvKey,
} from './loginCredentials.js';
import { credential } from './specfetch/specShim.js';
import { encryptCredValue, loadCredEncKey } from './crypto.js';

const TEST_KEY_B64 = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64');
const TOUCHED = ['CRED_ENC_KEY', 'SW_CRED_USERNAME', 'SW_CRED_PASSWORD'];
function snapshot(): Record<string, string | undefined> {
  const s: Record<string, string | undefined> = {};
  for (const k of TOUCHED) s[k] = process.env[k];
  return s;
}
function restoreEnv(saved: Record<string, string | undefined>) {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}
/** Encrypt a plaintext under the test key → the "v1:…" ciphertext the DB column would hold. */
function enc(plaintext: string): string {
  return encryptCredValue(plaintext, loadCredEncKey({ CRED_ENC_KEY: TEST_KEY_B64 }));
}

test('credentialEnvKey: role -> SW_CRED_<UPPER>', () => {
  assert.equal(credentialEnvKey('username'), 'SW_CRED_USERNAME');
  assert.equal(credentialEnvKey('password'), 'SW_CRED_PASSWORD');
});

test('resolveLoginCredentials: DECRYPTS each ciphertext leaf', () => {
  const saved = snapshot();
  try {
    process.env.CRED_ENC_KEY = TEST_KEY_B64;
    const out = resolveLoginCredentials({ username: enc('alice@test'), password: enc('hunter2') });
    assert.deepEqual(out, { username: 'alice@test', password: 'hunter2' });
  } finally {
    restoreEnv(saved);
  }
});

test('resolveLoginCredentials: FAIL-CLOSED on a leaf that is not v1 ciphertext (e.g. a legacy ref-name)', () => {
  const saved = snapshot();
  try {
    process.env.CRED_ENC_KEY = TEST_KEY_B64;
    // 'B2C_TEST_USER' is a legacy ref-name, not "v1:" ciphertext → decrypt throws → resolve throws.
    assert.throws(() => resolveLoginCredentials({ username: 'B2C_TEST_USER' }), /did not decrypt/);
  } finally {
    restoreEnv(saved);
  }
});

test('resolveLoginCredentials: FAIL-CLOSED when CRED_ENC_KEY is absent (has values)', () => {
  const saved = snapshot();
  try {
    delete process.env.CRED_ENC_KEY;
    assert.throws(() => resolveLoginCredentials({ username: 'v1:whatever' }), /CRED_ENC_KEY is not set/);
  } finally {
    restoreEnv(saved);
  }
});

test('resolveLoginCredentials: null/empty -> {} (no key required)', () => {
  const saved = snapshot();
  try {
    delete process.env.CRED_ENC_KEY; // no key needed when there are no values
    assert.deepEqual(resolveLoginCredentials(null), {});
    assert.deepEqual(resolveLoginCredentials(undefined), {});
    assert.deepEqual(resolveLoginCredentials({}), {});
  } finally {
    restoreEnv(saved);
  }
});

test('applyLoginCredentials publishes decrypted SW_CRED_<ROLE>; clearLoginCredentials removes them', () => {
  const saved = snapshot();
  try {
    process.env.CRED_ENC_KEY = TEST_KEY_B64;
    const handles = applyLoginCredentials({ username: enc('alice@test'), password: enc('hunter2') });
    assert.deepEqual(handles.map((h) => h.key).sort(), ['SW_CRED_PASSWORD', 'SW_CRED_USERNAME']);
    assert.equal(process.env.SW_CRED_USERNAME, 'alice@test');
    assert.equal(process.env.SW_CRED_PASSWORD, 'hunter2');
    clearLoginCredentials(handles); // ★ decrypted secret never lingers past the run
    assert.equal(process.env.SW_CRED_USERNAME, undefined);
    assert.equal(process.env.SW_CRED_PASSWORD, undefined);
  } finally {
    restoreEnv(saved);
  }
});

test('applyLoginCredentials: no values -> sets nothing, returns []', () => {
  assert.deepEqual(applyLoginCredentials(null), []);
});

test('clearLoginCredentials RESTORES a pre-existing SW_CRED_ value (not a blind delete)', () => {
  const saved = snapshot();
  try {
    process.env.CRED_ENC_KEY = TEST_KEY_B64;
    process.env.SW_CRED_USERNAME = 'preexisting'; // reserved-namespace collision (documented off-limits)
    const handles = applyLoginCredentials({ username: enc('alice@test') });
    assert.equal(process.env.SW_CRED_USERNAME, 'alice@test'); // overwritten for the run
    clearLoginCredentials(handles);
    assert.equal(process.env.SW_CRED_USERNAME, 'preexisting'); // ★ restored, not deleted
  } finally {
    restoreEnv(saved);
  }
});

test('credential(role): returns the published (decrypted) value; throws fail-closed when unpublished', () => {
  const saved = snapshot();
  try {
    process.env.CRED_ENC_KEY = TEST_KEY_B64;
    const handles = applyLoginCredentials({ username: enc('alice@test') });
    assert.equal(credential('username'), 'alice@test');
    clearLoginCredentials(handles);
    assert.throws(() => credential('username'), /credential\("username"\) is not available/);
  } finally {
    restoreEnv(saved);
  }
});
