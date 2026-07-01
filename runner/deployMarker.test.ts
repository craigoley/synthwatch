import test from 'node:test';
import assert from 'node:assert/strict';

import { extractDeployMarker } from './deployMarker.js';

const SHA = '70d6c6f3913186848af7568b20384dce9c3669d0';
const baggageMeta = (rel: string) =>
  `<meta name="baggage" content="sentry-environment=Production,sentry-release=${rel},sentry-public_key=abc">`;

test('ladder prefers the sentry-release SHA over an etag when BOTH are present', () => {
  const m = extractDeployMarker({ etag: '"93718211"' }, baggageMeta(SHA));
  assert.equal(m?.source, 'sentry-release');
  assert.equal(m?.value, SHA);
  assert.equal(m?.is_sha, true); // 40-hex → a real commit id
});

test('falls back to etag when only an etag is present on an HTML document (is_sha=false)', () => {
  const m = extractDeployMarker({ etag: 'W/"93718211"', 'content-type': 'text/html; charset=utf-8' }, '<html>no markers here</html>');
  assert.equal(m?.source, 'etag');
  assert.equal(m?.value, '93718211'); // W/ + quotes stripped
  assert.equal(m?.is_sha, false);
});

// ★★ THE FALSE-POSITIVE GUARD (etag rung): the etag content-hash justification holds ONLY for the root HTML
// document. A JSON/API endpoint's etag is header-only and often per-request → a phantom deploys row EVERY run.
// The rung is gated on content-type text/html, so a non-HTML (or unknown-type) etag produces NO marker.
test('★ an etag on a NON-HTML (JSON/API) response produces NO marker (phantom-deploy guard)', () => {
  assert.equal(extractDeployMarker({ etag: '"abc123"', 'content-type': 'application/json' }, null), null);
  // no content-type at all → response kind unknown → not trusted for the etag rung
  assert.equal(extractDeployMarker({ etag: '"abc123"' }, null), null);
});

test('returns null when neither a known body marker nor an etag exists (amore/nextdoor today)', () => {
  assert.equal(extractDeployMarker({ 'content-type': 'text/html' }, '<html><body>hi</body></html>'), null);
  assert.equal(extractDeployMarker(undefined, null), null);
});

test('picks a Next.js buildId when present (deploy-stable, not a SHA)', () => {
  const m = extractDeployMarker({}, '<script>{"buildId":"abc123XYZ","other":1}</script>');
  assert.equal(m?.source, 'next-build-id');
  assert.equal(m?.value, 'abc123XYZ');
  assert.equal(m?.is_sha, false);
});

test('a <meta name="commit"> is a SHA marker; a <meta name="version"> is a valid non-SHA marker', () => {
  const commit = extractDeployMarker({}, '<meta name="commit" content="a1b2c3d">');
  assert.equal(commit?.source, 'meta:commit');
  assert.equal(commit?.is_sha, true);

  const ver = extractDeployMarker({}, '<meta name="version" content="1.4.2">');
  assert.equal(ver?.source, 'meta:version');
  assert.equal(ver?.value, '1.4.2');
  assert.equal(ver?.is_sha, false);
});

// ★★ THE FALSE-POSITIVE GUARD: per-request-volatile sources must NEVER produce a marker (a phantom-deploy on
// every run). None of these are on the curated allowlist, so extraction returns null.
test('★ volatile per-request headers/values produce NO marker (the false-positive guard)', () => {
  assert.equal(extractDeployMarker({ 'x-vercel-id': 'iad1::abcde-1700000000-deadbeef' }, '<html></html>'), null);
  assert.equal(extractDeployMarker({ 'cf-ray': '8a1b2c3d4e5f-IAD' }, '<html></html>'), null);
  assert.equal(extractDeployMarker({ 'x-request-id': 'req_9f8e7d' }, '<html></html>'), null);
  assert.equal(extractDeployMarker({ 'set-cookie': 'sid=abc; Path=/', date: 'Tue, 01 Jul 2026 00:00:00 GMT' }, '<html></html>'), null);
  // a NON-allowlisted meta (csrf token / viewport) is not a deploy marker
  assert.equal(extractDeployMarker({}, '<meta name="csrf-token" content="Xk9f2s"><meta name="viewport" content="width=device-width">'), null);
});

test('sentry-release that is NOT hex (a tag/version) still records, is_sha=false', () => {
  const m = extractDeployMarker({}, baggageMeta('v2026.06.30-1'));
  assert.equal(m?.source, 'sentry-release');
  assert.equal(m?.value, 'v2026.06.30-1');
  assert.equal(m?.is_sha, false);
});
