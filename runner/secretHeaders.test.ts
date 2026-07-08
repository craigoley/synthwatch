// Unit tests for per-monitor SECRET headers (references-only; the value never leaks).
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSecretHeaders, isFirstParty } from './secretHeaders.js';

const TARGET = 'https://www.wegmans.com'; // check.target_url
const TARGET_HOST = 'www.wegmans.com';
const SECRET = 's3cr3t-api-key-value';

function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

test('resolves { header -> ENV_VAR } to { header -> value } for a first-party request', () => {
  withEnv('WEGMANS_API_KEY', SECRET, () => {
    const out = resolveSecretHeaders({ 'x-api-key': 'WEGMANS_API_KEY' }, `${TARGET}/shop`, TARGET_HOST);
    assert.deepEqual(out, { 'x-api-key': SECRET });
  });
});

test('resolves for a SUBDOMAIN of the target (first-party) too', () => {
  withEnv('WEGMANS_API_KEY', SECRET, () => {
    const out = resolveSecretHeaders({ 'x-api-key': 'WEGMANS_API_KEY' }, 'https://api.www.wegmans.com/v1', TARGET_HOST);
    assert.deepEqual(out, { 'x-api-key': SECRET });
  });
});

// ★★ THE ANTI-LEAK MUST-GO-RED: a THIRD-PARTY request never carries the secret. Removing the
// isFirstParty guard in resolveSecretHeaders makes this fail — the secret would spray to analytics/CDNs.
test('★ ANTI-LEAK: a THIRD-PARTY host NEVER receives the secret header', () => {
  withEnv('WEGMANS_API_KEY', SECRET, () => {
    assert.deepEqual(
      resolveSecretHeaders({ 'x-api-key': 'WEGMANS_API_KEY' }, 'https://www.google-analytics.com/collect', TARGET_HOST),
      {},
    );
    // a lookalike suffix must NOT match (evil-wegmans.com is not a subdomain of www.wegmans.com)
    assert.deepEqual(
      resolveSecretHeaders({ 'x-api-key': 'WEGMANS_API_KEY' }, 'https://wegmans.com.attacker.example/x', TARGET_HOST),
      {},
    );
  });
});

test('FAIL-SOFT: an unset ENV_VAR is SKIPPED (no throw, header absent) — the value can never be logged (there is none)', () => {
  withEnv('WEGMANS_API_KEY', undefined, () => {
    const out = resolveSecretHeaders({ 'x-api-key': 'WEGMANS_API_KEY' }, `${TARGET}/shop`, TARGET_HOST);
    assert.deepEqual(out, {}); // skipped, not crashed
  });
});

test('mixed: a set ref resolves, an unset ref is skipped — only the resolved one is injected', () => {
  withEnv('SET_KEY', SECRET, () =>
    withEnv('UNSET_KEY', undefined, () => {
      const out = resolveSecretHeaders(
        { 'x-set': 'SET_KEY', 'x-unset': 'UNSET_KEY' },
        `${TARGET}/`,
        TARGET_HOST,
      );
      assert.deepEqual(out, { 'x-set': SECRET });
    }),
  );
});

test('null / undefined refs → {} (no secret headers configured)', () => {
  assert.deepEqual(resolveSecretHeaders(null, `${TARGET}/`, TARGET_HOST), {});
  assert.deepEqual(resolveSecretHeaders(undefined, `${TARGET}/`, TARGET_HOST), {});
});

test('the resolved VALUE is present ONLY in the returned map (not the keys) — references-only storage shape', () => {
  withEnv('WEGMANS_API_KEY', SECRET, () => {
    const refs = { 'x-api-key': 'WEGMANS_API_KEY' };
    // the STORED refs never contain the value — only the header + env-var names
    assert.equal(JSON.stringify(refs).includes(SECRET), false);
    const out = resolveSecretHeaders(refs, `${TARGET}/`, TARGET_HOST);
    assert.equal(out['x-api-key'], SECRET); // value only appears here, en route to the request header
  });
});

test('isFirstParty: exact host + subdomain match; unrelated + lookalike do not', () => {
  assert.equal(isFirstParty('www.wegmans.com', 'www.wegmans.com'), true);
  assert.equal(isFirstParty('api.www.wegmans.com', 'www.wegmans.com'), true);
  assert.equal(isFirstParty('www.google-analytics.com', 'www.wegmans.com'), false);
  assert.equal(isFirstParty('wegmans.com.attacker.example', 'www.wegmans.com'), false);
  assert.equal(isFirstParty(null, 'www.wegmans.com'), false);
  assert.equal(isFirstParty('www.wegmans.com', null), false);
});
