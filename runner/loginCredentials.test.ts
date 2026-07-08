// Unit tests for the per-monitor login-credentials references-only model (0067). Mirrors the posture of
// secretHeaders: resolve { role -> ENV_VAR } from process.env, fail-soft on a missing var, never surface a
// value. Plus the per-run publish/clear lifecycle (SW_CRED_<ROLE>) and the shim's credential() accessor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveLoginCredentials,
  applyLoginCredentials,
  clearLoginCredentials,
  credentialEnvKey,
} from './loginCredentials.js';
import { credential } from './specfetch/specShim.js';

// Isolate process.env mutations: snapshot the keys we touch, restore after each test.
const TOUCHED = ['B2C_TEST_USER', 'B2C_TEST_PASS', 'SW_CRED_USERNAME', 'SW_CRED_PASSWORD'];
function restoreEnv(saved: Record<string, string | undefined>) {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}
function snapshot(): Record<string, string | undefined> {
  const s: Record<string, string | undefined> = {};
  for (const k of TOUCHED) s[k] = process.env[k];
  return s;
}

test('credentialEnvKey: role -> SW_CRED_<UPPER>', () => {
  assert.equal(credentialEnvKey('username'), 'SW_CRED_USERNAME');
  assert.equal(credentialEnvKey('password'), 'SW_CRED_PASSWORD');
});

test('resolveLoginCredentials: resolves refs whose env var is set', () => {
  const saved = snapshot();
  try {
    process.env.B2C_TEST_USER = 'alice@test';
    process.env.B2C_TEST_PASS = 'hunter2';
    const out = resolveLoginCredentials({ username: 'B2C_TEST_USER', password: 'B2C_TEST_PASS' });
    assert.deepEqual(out, { username: 'alice@test', password: 'hunter2' });
  } finally {
    restoreEnv(saved);
  }
});

test('resolveLoginCredentials: FAIL-SOFT — a missing env var is skipped, not thrown', () => {
  const saved = snapshot();
  try {
    process.env.B2C_TEST_USER = 'alice@test';
    delete process.env.B2C_TEST_PASS; // unset
    const out = resolveLoginCredentials({ username: 'B2C_TEST_USER', password: 'B2C_TEST_PASS' });
    assert.deepEqual(out, { username: 'alice@test' }); // password skipped, no throw
  } finally {
    restoreEnv(saved);
  }
});

test('resolveLoginCredentials: null/empty refs -> {}', () => {
  assert.deepEqual(resolveLoginCredentials(null), {});
  assert.deepEqual(resolveLoginCredentials(undefined), {});
  assert.deepEqual(resolveLoginCredentials({}), {});
});

test('applyLoginCredentials publishes SW_CRED_<ROLE>; clearLoginCredentials removes them', () => {
  const saved = snapshot();
  try {
    process.env.B2C_TEST_USER = 'alice@test';
    process.env.B2C_TEST_PASS = 'hunter2';
    const keys = applyLoginCredentials({ username: 'B2C_TEST_USER', password: 'B2C_TEST_PASS' });
    assert.deepEqual(keys.sort(), ['SW_CRED_PASSWORD', 'SW_CRED_USERNAME']);
    assert.equal(process.env.SW_CRED_USERNAME, 'alice@test');
    assert.equal(process.env.SW_CRED_PASSWORD, 'hunter2');
    // ★ cleared → a resolved secret never lingers in process.env past the run
    clearLoginCredentials(keys);
    assert.equal(process.env.SW_CRED_USERNAME, undefined);
    assert.equal(process.env.SW_CRED_PASSWORD, undefined);
  } finally {
    restoreEnv(saved);
  }
});

test('applyLoginCredentials: no refs -> sets nothing, returns []', () => {
  assert.deepEqual(applyLoginCredentials(null), []);
});

// The spec-facing accessor: reads the published value, fail-CLOSED on an undeclared/unresolved role.
test('credential(role): returns the published value', () => {
  const saved = snapshot();
  try {
    process.env.B2C_TEST_USER = 'alice@test';
    const keys = applyLoginCredentials({ username: 'B2C_TEST_USER' });
    assert.equal(credential('username'), 'alice@test');
    clearLoginCredentials(keys);
  } finally {
    restoreEnv(saved);
  }
});

test('credential(role): throws (fail-closed) when the role was never published', () => {
  const saved = snapshot();
  try {
    delete process.env.SW_CRED_USERNAME;
    assert.throws(() => credential('username'), /credential\("username"\) is not available/);
  } finally {
    restoreEnv(saved);
  }
});
