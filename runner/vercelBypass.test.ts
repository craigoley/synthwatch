import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BYPASS_HEADER,
  SET_BYPASS_COOKIE_HEADER,
  SET_BYPASS_COOKIE_VALUE,
  PROTECTED_BYPASS_HOSTS,
  isProtectedHost,
  bypassHeaderFor,
  browserHeaderAdditions,
} from './vercelBypass.js';

// Set/clear the fleet secret around a test body (the secret is read from process.env at call time).
function withToken<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.VERCEL_BYPASS_TOKEN;
  if (value === undefined) delete process.env.VERCEL_BYPASS_TOKEN;
  else process.env.VERCEL_BYPASS_TOKEN = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.VERCEL_BYPASS_TOKEN;
    else process.env.VERCEL_BYPASS_TOKEN = prev;
  }
}

const PROTECTED = 'https://www.wegmans.com/checkout';
const THIRD_PARTY = 'https://www.google-analytics.com/collect?v=2'; // a subresource a page loads — MUST NOT get the token
const TOKEN = 'tok_test_ABC123';

test('the protected allow-set is the known Vercel-protected Wegmans hosts', () => {
  for (const h of ['www.wegmans.com', 'wegmans.com', 'www.meals2go.com', 'meals2go.com']) {
    assert.equal(isProtectedHost(h), true, `${h} should be protected`);
  }
  assert.equal(isProtectedHost('www.google-analytics.com'), false);
  assert.equal(isProtectedHost('synthwatch-api.azurewebsites.net'), false);
  assert.equal(isProtectedHost('httpbin.org'), false);
  assert.equal(isProtectedHost(null), false);
});

// ── HTTP path (bypassHeaderFor) ──────────────────────────────────────────────────────────────────────────
test('HTTP: a protected host + token set → the bypass header is returned', () => {
  withToken(TOKEN, () => {
    const h = bypassHeaderFor(PROTECTED);
    assert.deepEqual(h, [BYPASS_HEADER, TOKEN]);
  });
});

test('HTTP: a NON-protected host + token set → NO header (host-scoping)', () => {
  withToken(TOKEN, () => {
    assert.equal(bypassHeaderFor('https://httpbin.org/get'), null);
    assert.equal(bypassHeaderFor('https://synthwatch-api.azurewebsites.net/health'), null);
  });
});

test('HTTP: token UNSET → NO header, no throw (fail-soft, even for a protected host)', () => {
  withToken(undefined, () => assert.equal(bypassHeaderFor(PROTECTED), null));
  withToken('', () => assert.equal(bypassHeaderFor(PROTECTED), null)); // empty secret = unset
});

test('HTTP: a malformed url → NO header, no throw', () => {
  withToken(TOKEN, () => assert.equal(bypassHeaderFor('not a url'), null));
});

// ── Browser path (browserHeaderAdditions) ────────────────────────────────────────────────────────────────
test('browser: protected-host request → request_headers merged AND the bypass token + set-bypass-cookie added', () => {
  withToken(TOKEN, () => {
    const add = browserHeaderAdditions(PROTECTED, { 'x-monitor': 'synthwatch' });
    assert.deepEqual(add, {
      'x-monitor': 'synthwatch',
      [BYPASS_HEADER]: TOKEN,
      [SET_BYPASS_COOKIE_HEADER]: SET_BYPASS_COOKIE_VALUE,
    });
    assert.equal(SET_BYPASS_COOKIE_VALUE, 'true'); // Vercel docs: value is 'true' for direct in-browser testing
  });
});

test('browser: the Vercel PREVIEW host (S3 pre-prod target) is protected → gets the token + set-bypass-cookie', () => {
  withToken(TOKEN, () => {
    assert.equal(isProtectedHost('preview.commerce.wegmans.com'), true);
    const add = browserHeaderAdditions('https://preview.commerce.wegmans.com/checkout', {});
    assert.deepEqual(add, { [BYPASS_HEADER]: TOKEN, [SET_BYPASS_COOKIE_HEADER]: SET_BYPASS_COOKIE_VALUE });
  });
});

// ★★ THE ANTI-LEAK MUST-GO-RED: a request to a NON-protected host (a third-party subresource) NEVER carries
// the bypass token — proving host-scoping holds and the secret does not spray. This is the reason the browser
// path uses per-request matching instead of context-wide extraHTTPHeaders.
test('★ browser ANTI-LEAK: a THIRD-PARTY request never carries the bypass token NOR set-bypass-cookie (only request_headers, if any)', () => {
  withToken(TOKEN, () => {
    // request_headers still merge for all hosts (the non-secret gap-fix)…
    const withCustom = browserHeaderAdditions(THIRD_PARTY, { 'x-monitor': 'synthwatch' });
    assert.deepEqual(withCustom, { 'x-monitor': 'synthwatch' });
    assert.equal(Object.prototype.hasOwnProperty.call(withCustom, BYPASS_HEADER), false, 'token must NOT be on a third-party request');
    // ★ MUST-GO-RED: set-bypass-cookie is gated on the token (`if (bypass)`). Ungate it (add it for every
    // request) and this assertion fails — a third-party host would be told to set the bypass cookie.
    assert.equal(Object.prototype.hasOwnProperty.call(withCustom, SET_BYPASS_COOKIE_HEADER), false, 'set-bypass-cookie must NOT be on a third-party request');
    // …and with no custom headers, a third-party request gets NOTHING (route.continue untouched).
    assert.equal(browserHeaderAdditions(THIRD_PARTY, {}), null);
  });
});

test('browser: request_headers merged for ALL hosts even without a token (the gap-fix, independent of the secret)', () => {
  withToken(undefined, () => {
    assert.deepEqual(browserHeaderAdditions(THIRD_PARTY, { 'x-monitor': 'synthwatch' }), { 'x-monitor': 'synthwatch' });
    assert.deepEqual(browserHeaderAdditions(PROTECTED, { 'x-monitor': 'synthwatch' }), { 'x-monitor': 'synthwatch' }); // no token → no bypass, still merges custom
  });
});

test('browser: no custom headers + non-protected host → null (nothing to inject, route.continue untouched)', () => {
  withToken(TOKEN, () => assert.equal(browserHeaderAdditions(THIRD_PARTY, {}), null));
});

test('browser: no custom headers + protected host + token → the bypass header + set-bypass-cookie', () => {
  withToken(TOKEN, () =>
    assert.deepEqual(browserHeaderAdditions(PROTECTED, {}), {
      [BYPASS_HEADER]: TOKEN,
      [SET_BYPASS_COOKIE_HEADER]: SET_BYPASS_COOKIE_VALUE,
    }),
  );
});

test('the allow-set constant is a Set of lowercased hostnames (editable, host-matched)', () => {
  assert.ok(PROTECTED_BYPASS_HOSTS instanceof Set);
  for (const h of PROTECTED_BYPASS_HOSTS) assert.equal(h, h.toLowerCase());
});
