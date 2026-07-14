// classifyTransient must read console.messages, not just network.failed. Before this, run 963205 (check 355)
// — the ONLY monitor-side transient that ever existed — was WRONG: five first-party ERROR console messages
// (ChunkLoadError, a failed prod-API fetch, cart/cooklist mutation failures, ERR_CONNECTION_CLOSED) all
// scored zero because the classifier read network.failed only. The site was broken; the chip said "flaky".
// Pure function → no DB. The #1 test is MUST-GO-RED: run 963205's signals must be service-side (fails on
// origin/main, passes on the fix — proven by revert+rebuild).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTransient, canonicalizeConsole, type TraceSignalsLike } from './transientClass.js';

const err = (text: string, origin = 'site', sourceHost = 'www.wegmans.com') => ({ level: 'error', origin, sourceHost, text });
// The persistent first-party network noise present every run (already in the 4-run baseline).
const monitoringNoise = { url: 'https://www.wegmans.com/monitoring', thirdParty: false, resourceType: 'fetch' };
const baselineRun: TraceSignalsLike = { network: { failed: [monitoringNoise] }, console: { messages: [] } };
const BASELINE = [baselineRun, baselineRun, baselineRun, baselineRun];

// ★★ MUST-GO-RED: run 963205's ACTUAL signals (from prod ground truth) → SERVICE-SIDE. On origin/main the
// classifier reads network.failed only: the third-party entries are skipped and www.wegmans.com/monitoring is
// baseline noise ⇒ hasNewFirstParty=false ⇒ monitor-side (WRONG). On the fix the five NEW first-party console
// errors are seen ⇒ service-side. Reverting transientClass.ts flips this red.
test('★ run 963205: five NEW first-party console errors ⇒ SERVICE-SIDE (was monitor-side)', () => {
  const run963205: TraceSignalsLike = {
    network: { failed: [
      { url: 'https://cdn.segment.com/analytics.js', thirdParty: true, resourceType: 'script' },
      monitoringNoise, // first-party but persistent → in baseline
    ] },
    console: { messages: [
      err('ChunkLoadError: Failed to load chunk /_next/static/chunks/0hdjg1nu~6lq0.js'),
      err('TypeError: Failed to fetch (api.digitaldevelopment.wegmans.cloud)'),
      err('cooklist:useCooklistMutation Cooklist mutation failed'),
      err('hooks:useUpdateCarts Error updating cart'),
      err('Failed to load resource: net::ERR_CONNECTION_CLOSED'),
    ] },
  };
  assert.equal(classifyTransient(run963205, BASELINE), 'service-side',
    'the site was broken (its own JS + prod API failed) — this is SERVICE-side, not monitor noise');
});

// A first-party console error that is ALSO in the baseline (teardown noise) ⇒ NOT new ⇒ monitor-side.
test('a first-party console error present in the baseline ⇒ NOT new ⇒ monitor-side', () => {
  const chronic = err('cooklist:useCooklistMutation Cooklist mutation failed');
  const orig: TraceSignalsLike = { console: { messages: [chronic] } };
  const base = [{ console: { messages: [chronic] } }, { console: { messages: [chronic] } }];
  assert.equal(classifyTransient(orig, base), 'monitor-side');
});

// ★ Hash-collapse (user concern #2): a chunk error with a DIFFERENT 12+char hash each run must canonicalize to
// the SAME key, so a chunk failure already in the baseline is recognised as the same error (not falsely NEW).
test('chunk hashes collapse: same chunk error with different long hashes ⇒ matches baseline ⇒ monitor-side', () => {
  const orig: TraceSignalsLike = { console: { messages: [err('ChunkLoadError: Failed to load chunk /_next/static/chunks/aaaaaaaaaaaa.js')] } };
  const base = [{ console: { messages: [err('ChunkLoadError: Failed to load chunk /_next/static/chunks/bbbbbbbbbbbb.js')] } }];
  assert.equal(classifyTransient(orig, base), 'monitor-side', 'the [a-z0-9_-]{12,} hash collapses to * → same key → not new');
});

// ★ monitor-side must still be REACHABLE: a genuine paint-race with NO new first-party console/network error.
test('a paint-race with no new first-party error ⇒ monitor-side (the dimension is still alive)', () => {
  const paintRace: TraceSignalsLike = { network: { failed: [] }, console: { messages: [err('Sentry captured an exception', 'third-party', 'sentry.io')] } };
  assert.equal(classifyTransient(paintRace, [{ network: { failed: [] }, console: { messages: [] } }]), 'monitor-side');
});

// A NEW THIRD-PARTY console error must NOT flip to service-side (only first-party is a service signal).
test('a new THIRD-PARTY console error ⇒ NOT service-side', () => {
  const orig: TraceSignalsLike = { console: { messages: [err('LaunchDarkly: brand new streaming error abc123', 'third-party', 'launchdarkly.com')] } };
  assert.equal(classifyTransient(orig, [{ console: { messages: [] } }]), 'monitor-side');
});

// A warning-level or info console message is NOT an error signal.
test('a first-party WARNING (not error) console message ⇒ not a service signal ⇒ monitor-side', () => {
  const orig: TraceSignalsLike = { console: { messages: [{ level: 'warning', origin: 'site', sourceHost: 'www.wegmans.com', text: 'deprecation notice' }] } };
  assert.equal(classifyTransient(orig, [{ console: { messages: [] } }]), 'monitor-side');
});

// ★ PARITY guard (seed of the shared golden fixture): canonicalizeConsole mirrors the C# TraceSignalsDiff.
test('canonicalizeConsole mirrors the C# canonicalizer (lowercase, strip ts/query, collapse long tokens)', () => {
  assert.equal(canonicalizeConsole('ChunkLoadError foo?_rsc=abc123def456'), '* foo'); // chunkloaderror is 14 chars → collapsed like the C# LongToken
  assert.equal(canonicalizeConsole('Error at 2026-07-08T02:19:31.000Z boom'), 'error at boom');
  assert.equal(canonicalizeConsole('load /_next/static/chunks/0123456789abcdef.js'), 'load /_next/static/chunks/*.js');
});

// ── ★ Tighten the console-feed survivors the mutation sweep found (#299's firstPartyConsoleKeys). ────────────

// :97 — 'pageerror' (an uncaught exception) is an error-class level too, not just 'error'. Kills 'pageerror'→"".
test('a NEW first-party PAGEERROR (uncaught exception) ⇒ SERVICE-SIDE', () => {
  const orig: TraceSignalsLike = { console: { messages: [{ level: 'pageerror', origin: 'site', sourceHost: 'www.wegmans.com', text: 'Uncaught TypeError: x is not a function' }] } };
  assert.equal(classifyTransient(orig, [{ console: { messages: [] } }]), 'service-side', 'pageerror is error-class — a new one is a service signal');
});

// :107 — an error-level message with EMPTY text carries no signal (no key). Kills the `!m.text` guard → false.
test('a first-party error with EMPTY text ⇒ no key ⇒ monitor-side (the !m.text guard)', () => {
  const orig: TraceSignalsLike = { console: { messages: [err('')] } };
  assert.equal(classifyTransient(orig, [{ console: { messages: [] } }]), 'monitor-side', 'an empty-text console line is not a first-party service error');
});

// :108 — the console key must be the REAL canonical text, not a constant. A NEW error vs a DIFFERENT baseline
// error must read service-side; a mutant that emits a constant key (``) would collapse both → monitor-side.
test('a NEW first-party error, DIFFERENT from a baseline error ⇒ service-side (kills a constant-key mutant)', () => {
  const orig: TraceSignalsLike = { console: { messages: [err('brand new prod API 500 on checkout')] } };
  const base = [{ console: { messages: [err('a totally different chronic cooklist error')] } }];
  assert.equal(classifyTransient(orig, base), 'service-side', 'the new error differs from the baseline error → NEW → service-side');
});

// :108 — the sourceHost is PART of the key. The SAME text from a NEW host is a new key; a mutant that drops the
// host (sourceHost && '') would collapse the two hosts → falsely monitor-side.
test('same text from a NEW host ⇒ new key ⇒ service-side (the sourceHost belongs in the key)', () => {
  const orig: TraceSignalsLike = { console: { messages: [err('Failed to fetch', 'site', 'api-new.wegmans.cloud')] } };
  const base = [{ console: { messages: [err('Failed to fetch', 'site', 'api-old.wegmans.cloud')] } }];
  assert.equal(classifyTransient(orig, base), 'service-side', 'a first-party error from a host not in the baseline is NEW');
});
