// Unit tests for the S2 host-rewrite primitive (pure — no browser, no Playwright).
//   (1) INERT: no compiled rewrite → resolveRewrite returns null for every URL (byte-identical proof).
//   (2) ACTIVE: primary-origin navigation + subresource rewritten (path/query/hash preserved);
//       a THIRD-PARTY origin (algolia) is left UNCHANGED.
//   (3) FAIL-LOUD: a malformed / protocol-crossing origin throws, never silently no-ops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseOrigin,
  compileHostRewrite,
  rewriteRequestUrl,
  resolveRewrite,
  hostRewriteFor,
} from './hostRewrite.js';

const PROD = 'https://app.example.com';
const STAGING = 'https://staging.example.com';
const pair = () => compileHostRewrite({ fromOrigin: PROD, toOrigin: STAGING });

// A representative request set spanning the navigation + subresource + third-party shapes.
const NAV = 'https://app.example.com/cart?ref=home#top';
const SUBRESOURCE = 'https://app.example.com/assets/app.9f2.js';
const ALGOLIA = 'https://xyz-dsn.algolia.net/1/indexes/*/queries';
const OPENTABLE = 'https://www.opentable.com/widget/reservation/loader?rid=123';

// ── (1) INERT: no rewrite compiled → every URL passes through untouched ──────────────────────────────
test('(1) inert: resolveRewrite(url, null) is null for nav, subresource, and third-party → byte-identical', () => {
  for (const u of [NAV, SUBRESOURCE, ALGOLIA, OPENTABLE]) {
    assert.equal(resolveRewrite(u, null), null, `expected no rewrite for ${u}`);
  }
});

// ── (2) ACTIVE: primary origin rewritten, third-party untouched ──────────────────────────────────────
test('(2a) primary-origin NAVIGATION is rewritten host+port only — path, query, and hash preserved', () => {
  const rw = pair();
  assert.equal(resolveRewrite(NAV, rw), 'https://staging.example.com/cart?ref=home#top');
});

test('(2b) primary-origin SUBRESOURCE (the assertion surface) is rewritten too — not half-rewritten', () => {
  const rw = pair();
  assert.equal(resolveRewrite(SUBRESOURCE, rw), 'https://staging.example.com/assets/app.9f2.js');
});

test('(2c) THIRD-PARTY origins (algolia, opentable) are NEVER rewritten', () => {
  const rw = pair();
  // ★ MUST-GO-RED: the exclusion is the `u.origin !== from.origin → null` guard in rewriteRequestUrl.
  // Delete it (rewrite every request) and these two assertions fail — Algolia would get redirected to
  // staging. That is the whole point of the exact-origin match.
  assert.equal(resolveRewrite(ALGOLIA, rw), null);
  assert.equal(resolveRewrite(OPENTABLE, rw), null);
});

test('(2d) origin match normalizes the default port (explicit :443 still matches, still rewrites)', () => {
  const rw = pair();
  assert.equal(
    resolveRewrite('https://app.example.com:443/checkout', rw),
    'https://staging.example.com/checkout',
  );
});

test('(2e) a non-default target port is carried through', () => {
  const rw = compileHostRewrite({ fromOrigin: PROD, toOrigin: 'https://staging.example.com:8443' });
  assert.equal(resolveRewrite(NAV, rw), 'https://staging.example.com:8443/cart?ref=home#top');
});

test('(2f) an unparseable request URL is left alone (returns null, does not throw)', () => {
  assert.equal(resolveRewrite('not a url', pair()), null);
});

// ── (3) FAIL-LOUD: malformed / protocol-crossing origins throw, never silently no-op ─────────────────
test('(3a) a malformed toOrigin THROWS at compile — not a silent no-op that would run against prod', () => {
  assert.throws(() => compileHostRewrite({ fromOrigin: PROD, toOrigin: 'staging.example.com' }), /malformed origin/);
});

test('(3b) a protocol-crossing pair (https→http) THROWS — route.continue cannot change protocol', () => {
  assert.throws(
    () => compileHostRewrite({ fromOrigin: PROD, toOrigin: 'http://staging.example.com' }),
    /protocol mismatch/,
  );
});

test('(3c) parseOrigin rejects a bare host, a non-http scheme, and a URL carrying a path', () => {
  assert.throws(() => parseOrigin('staging.example.com'), /malformed origin/);
  assert.throws(() => parseOrigin('ftp://staging.example.com'), /must be http/);
  assert.throws(() => parseOrigin('https://staging.example.com/some/path'), /carries a path/);
  // a bare origin (root path normalized to "/") is accepted
  assert.equal(parseOrigin('https://staging.example.com').origin, STAGING);
});

test('(3d) rewriteRequestUrl on a matching origin preserves protocol (https stays https)', () => {
  const { from, to } = pair();
  const out = rewriteRequestUrl('https://app.example.com/x', from, to);
  assert.ok(out!.startsWith('https://'), 'protocol must be preserved');
});

// ── (4) hostRewriteFor — the S3 check→pair glue ──────────────────────────────────────────────────────
test('(4a) hostRewriteFor: no FROM origin (prod check) → undefined (S2 inert)', () => {
  assert.equal(hostRewriteFor(null, 'https://preview.commerce.wegmans.com/checkout'), undefined);
  assert.equal(hostRewriteFor(undefined, 'https://preview.commerce.wegmans.com'), undefined);
  assert.equal(hostRewriteFor('', 'https://preview.commerce.wegmans.com'), undefined);
});

test('(4b) hostRewriteFor: FROM origin + a target_url → {from, to=origin(target)} (path on target stripped)', () => {
  const rw = hostRewriteFor('https://www.wegmans.com', 'https://preview.commerce.wegmans.com/checkout?step=1');
  assert.deepEqual(rw, { fromOrigin: 'https://www.wegmans.com', toOrigin: 'https://preview.commerce.wegmans.com' });
  // and it compiles + rewrites end-to-end
  const compiled = compileHostRewrite(rw!);
  assert.equal(resolveRewrite('https://www.wegmans.com/cart', compiled), 'https://preview.commerce.wegmans.com/cart');
});

test('(4c) hostRewriteFor: a malformed target_url is passed RAW → compileHostRewrite fail-louds (no silent no-rewrite against prod)', () => {
  const rw = hostRewriteFor('https://www.wegmans.com', 'not a url');
  assert.equal(rw!.toOrigin, 'not a url'); // raw, not swallowed
  assert.throws(() => compileHostRewrite(rw!), /malformed origin/);
});
