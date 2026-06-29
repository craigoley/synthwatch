// Unit tests for the contents-API-at-pinned-SHA spec fetch (replaces the raw-CDN path that flapped).
// Mocks global fetch: /commits/main -> the bare sha; /contents/<spec>?ref=<sha> -> the spec source.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { conditionalFetchSpec, assertValidSpecPath, _resetMainShaCache } from './fetchSpec.js';

const SHA = 'a'.repeat(40);
const SPEC = 'monitors/wegmans/search-product.spec.ts';
const realFetch = globalThis.fetch;

interface Call {
  url: string;
  headers: Record<string, string>;
}
let calls: Call[] = [];

function installFetch(opts: { sha?: string; body?: string; contentsStatus?: number } = {}): void {
  const sha = opts.sha ?? SHA;
  calls = [];
  globalThis.fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} });
    if (String(url).includes('/commits/')) return new Response(sha + '\n', { status: 200 });
    return new Response(opts.body ?? 'export const x = 1;', { status: opts.contentsStatus ?? 200 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  _resetMainShaCache();
  delete process.env.GITHUB_TOKEN;
  delete process.env.SYNTHWATCH_MONITORS_TOKEN;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('resolves main sha + fetches content AT that sha (lastSha=null → fetched)', async () => {
  installFetch({ sha: SHA, body: 'SPEC SOURCE' });
  const r = await conditionalFetchSpec(SPEC, null);
  assert.equal(r.kind, 'fetched');
  if (r.kind === 'fetched') {
    assert.equal(r.source, 'SPEC SOURCE');
    assert.equal(r.etag, SHA, 'etag carries the commit sha');
  }
  const contents = calls.find((c) => c.url.includes('/contents/'));
  assert.ok(contents, 'a contents fetch happened');
  assert.ok(contents!.url.includes(`?ref=${SHA}`), 'content pinned to the resolved sha (consistent)');
  assert.ok(contents!.url.startsWith('https://api.github.com/'), 'uses the API, not raw.githubusercontent');
});

test('★ unchanged when main still points at the last sha (no content fetch)', async () => {
  installFetch({ sha: SHA });
  const r = await conditionalFetchSpec(SPEC, SHA); // lastSha === resolved sha
  assert.equal(r.kind, 'unchanged');
  assert.equal(calls.filter((c) => c.url.includes('/contents/')).length, 0, 'no content fetch when unchanged');
});

test('★ a CHANGED sha (a merge) → fetches the NEW content (deterministic merge→run)', async () => {
  const NEWSHA = 'b'.repeat(40);
  installFetch({ sha: NEWSHA, body: 'NEW SPEC' });
  const r = await conditionalFetchSpec(SPEC, SHA); // we last had SHA; main moved to NEWSHA
  assert.equal(r.kind, 'fetched');
  if (r.kind === 'fetched') {
    assert.equal(r.source, 'NEW SPEC');
    assert.equal(r.etag, NEWSHA);
  }
});

test('★ rate-limit guard: main sha resolved ONCE per process (memoised across specs in a tick)', async () => {
  installFetch({ sha: SHA });
  await conditionalFetchSpec('monitors/a/a.spec.ts', null);
  await conditionalFetchSpec('monitors/b/b.spec.ts', null);
  await conditionalFetchSpec('monitors/c/c.spec.ts', null);
  assert.equal(
    calls.filter((c) => c.url.includes('/commits/')).length,
    1,
    'one commits-API call for 3 specs in a tick (≈12/hr, well under the 60/hr anon cap)',
  );
});

test('an auth token is sent when present (rate-limit headroom)', async () => {
  process.env.GITHUB_TOKEN = 'ghp_test';
  installFetch({ sha: SHA });
  await conditionalFetchSpec(SPEC, null);
  assert.ok(calls.length > 0 && calls.every((c) => c.headers.authorization === 'Bearer ghp_test'));
});

test('no token → no Authorization header (anon works; public repo)', async () => {
  installFetch({ sha: SHA });
  await conditionalFetchSpec(SPEC, null);
  assert.ok(calls.every((c) => !('authorization' in c.headers)));
});

test('a non-200 content fetch throws (the cache layer degrades to last-good)', async () => {
  installFetch({ contentsStatus: 404 });
  await assert.rejects(() => conditionalFetchSpec(SPEC, null), /spec fetch failed: 404/);
});

test('assertValidSpecPath still guards traversal', () => {
  assert.throws(() => assertValidSpecPath('monitors/../etc/passwd.spec.ts'), /invalid spec path/);
});
