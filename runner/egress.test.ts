// Egress-IP capture: fail-soft (never throws/blocks a run), once-per-process cache, IP validation,
// reflector fallback. Pure — fetch is injected, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reflectEgressIp, captureEgressIp, __resetEgressCacheForTest } from './egress.js';

const okFetch = (ip: string): typeof fetch =>
  (async () => ({ ok: true, text: async () => ip + '\n' })) as unknown as typeof fetch;
const failFetch: typeof fetch = (async () => {
  throw new Error('network down');
}) as unknown as typeof fetch;
const notOkFetch: typeof fetch = (async () => ({ ok: false, text: async () => 'oops' })) as unknown as typeof fetch;
const htmlFetch: typeof fetch =
  (async () => ({ ok: true, text: async () => '<html>error</html>' })) as unknown as typeof fetch;

test('reflectEgressIp returns the trimmed IP from a reflector', async () => {
  assert.equal(await reflectEgressIp(3000, okFetch('203.0.113.7')), '203.0.113.7');
});

test('reflectEgressIp rejects a non-IP body (HTML) → null, never a garbage value', async () => {
  assert.equal(await reflectEgressIp(3000, htmlFetch), null);
});

test('★ reflectEgressIp is FAIL-SOFT: all reflectors throwing → null, no exception', async () => {
  assert.equal(await reflectEgressIp(3000, failFetch), null);
});

test('reflectEgressIp tolerates a non-200 reflector → null (no throw)', async () => {
  assert.equal(await reflectEgressIp(3000, notOkFetch), null);
});

test('★ captureEgressIp caches ONCE per process (2nd call ignores a different fetch)', async () => {
  __resetEgressCacheForTest();
  const first = await captureEgressIp(okFetch('198.51.100.42'));
  assert.equal(first, '198.51.100.42');
  // a second call with a FAILING fetch must still return the cached IP — proving one capture per process.
  const second = await captureEgressIp(failFetch);
  assert.equal(second, '198.51.100.42');
});

test('★ captureEgressIp is FAIL-SOFT: reflector failure → null (the run is unaffected)', async () => {
  __resetEgressCacheForTest();
  assert.equal(await captureEgressIp(failFetch), null);
});

test('captureEgressIp concurrent callers share ONE in-flight reflect (no hammering)', async () => {
  __resetEgressCacheForTest();
  let calls = 0;
  const counting: typeof fetch = (async () => {
    calls++;
    return { ok: true, text: async () => '192.0.2.1' };
  }) as unknown as typeof fetch;
  const [a, b, c] = await Promise.all([captureEgressIp(counting), captureEgressIp(counting), captureEgressIp(counting)]);
  assert.equal(a, '192.0.2.1');
  assert.equal(b, '192.0.2.1');
  assert.equal(c, '192.0.2.1');
  assert.equal(calls, 1, 'three concurrent callers triggered exactly ONE reflector fetch');
});
