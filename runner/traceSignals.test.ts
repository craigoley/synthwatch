// Parity tests for the trace-signals extraction — uses the SAME fixtures + assertions as the API's
// SynthWatch.Api.Tests/TraceSignalsTests.cs, so a regression on either side is caught. The console
// extension-noise filter is the load-bearing one. Plus the runner-wrapper semantics (null on no-trace /
// corrupt zip, since trace_signals is nullable = "not extracted").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { writeFileSync, rmSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractNetwork, extractConsole, extractTraceSignals } from './traceSignals.js';
import { makeRedactor, IDENTITY_REDACTOR } from './redact.js';

const TARGET = 'www.wegmans.com';

// A unique, unguessable temp dir per use (mkdtemp) — the SECURE temp-file pattern (a predictable
// tmpdir()/<name> in a shared dir is a symlink/race vector; matches production loadCompiledSpec).
// Caller writes a file inside the returned dir and rmSync(dir, { recursive }) in finally.
function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'tsig-'));
}

// ── trace.trace console fixture: 2 info/log chatter, 5 extension-noise, 3 real (2 site + 1 third-party) ──
const CONSOLE_NDJSON = [
  '{"type":"console","messageType":"error","text":"component:SiteHeaderSearch:helpers Invalid discovery pages storage data","location":{"url":"https://www.wegmans.com/_next/static/chunks/x.js"}}',
  '{"type":"console","messageType":"warning","text":"[Meta Pixel] - Duplicate Pixel ID: 376538596548029.","location":{"url":"https://www.wegmans.com/"}}',
  '{"type":"console","messageType":"info","text":"[LaunchDarkly] client initialized","location":{"url":"https://www.wegmans.com/chunk.js"}}',
  '{"type":"console","messageType":"log","text":"[SignalR] Initial tab visibility: visible","location":{"url":"https://bot.emplifi.io/x"}}',
  '{"type":"console","messageType":"error","text":"Failed to load Grammarly-check.js","location":{"url":"chrome-extension://kbfnbcaeplbcioak/Grammarly-check.js"}}',
  '{"type":"console","messageType":"error","text":"Uncaught Error in recorder.contentScripts.inject","location":{"url":"chrome-extension://aaaa/recorder.js"}}',
  '{"type":"console","messageType":"warning","text":"Unchecked runtime.lastError: The message port closed before a response was received.","location":{"url":""}}',
  '{"type":"console","messageType":"error","text":"DEFAULT root logger initialized","location":{"url":""}}',
  '{"type":"console","messageType":"error","text":"AAA-init: extension boot","location":{"url":""}}',
  '{"type":"console","messageType":"error","text":"WebSocket connection to \'wss://realtime-c.astutebot.com/eventHub\' failed","location":{"url":"https://realtime-c.astutebot.com/lib.js"}}',
  '{"type":"frame-snapshot"}',
].join('\n');

// ── trace.network fixture: 5 resource-snapshots (+ a non-network line to skip) ──
const NETWORK_NDJSON = [
  '{"type":"resource-snapshot","snapshot":{"_resourceType":"document","time":594,"timings":{"wait":451},"request":{"url":"https://www.wegmans.com/","method":"GET"},"response":{"status":200,"_transferSize":43165,"content":{"size":235353,"mimeType":"text/html"},"headers":[{"name":"content-encoding","value":"gzip"}]}}}',
  '{"type":"resource-snapshot","snapshot":{"_resourceType":"script","time":1026,"timings":{"wait":700},"request":{"url":"https://www.wegmans.com/_next/static/chunks/big.js","method":"GET"},"response":{"status":200,"_transferSize":50000,"content":{"size":120000,"mimeType":"application/javascript"},"headers":[]}}}',
  '{"type":"resource-snapshot","snapshot":{"_resourceType":"image","time":300,"timings":{"wait":100},"request":{"url":"https://images.wegmans.com/hero.jpg","method":"GET"},"response":{"status":200,"_transferSize":2205000,"content":{"size":2205000,"mimeType":"image/jpeg"},"headers":[]}}}',
  '{"type":"resource-snapshot","snapshot":{"_resourceType":"fetch","time":200,"timings":{"wait":150},"request":{"url":"https://images.wegmans.com/api/x","method":"GET"},"response":{"status":404,"_transferSize":500,"content":{"size":0,"mimeType":"application/json"},"headers":[]}}}',
  '{"type":"resource-snapshot","snapshot":{"_resourceType":"script","time":1499,"timings":{"wait":-1},"request":{"url":"blob:https://www.wegmans.com/abc","method":"GET"},"response":{"status":200,"_transferSize":0,"content":{"size":10,"mimeType":"application/javascript"},"headers":[]}}}',
  '{"type":"context-options"}',
].join('\n');

// ★★ THE load-bearing test: extension noise dropped, real site errors kept, chatter dropped.
test('console filter drops extension noise + keeps real site errors (parity)', () => {
  const c = extractConsole(CONSOLE_NDJSON, TARGET);
  assert.equal(c.droppedInfoLog, 2); // LaunchDarkly info + SignalR log
  assert.equal(c.droppedExtensionNoise, 5); // Grammarly, recorder, message-port, DEFAULT root logger, AAA-init
  assert.equal(c.messages.length, 3); // 2 site + 1 third-party real

  const site = c.messages.filter((m) => m.text.includes('Invalid discovery pages storage data'));
  assert.equal(site.length, 1);
  assert.equal(site[0].level, 'error');
  assert.equal(site[0].origin, 'site');

  assert.equal(c.messages.filter((m) => m.text.includes('astutebot') && m.origin === 'third-party').length, 1);

  for (const needle of ['Grammarly', 'recorder.contentScripts', 'message port closed', 'DEFAULT root logger', 'AAA-init']) {
    assert.equal(c.messages.some((m) => m.text.includes(needle)), false, `extension noise leaked: ${needle}`);
  }
});

test('console filter dedupes repeated lines', () => {
  const dup = Array(4)
    .fill('{"type":"console","messageType":"error","text":"same boom","location":{"url":"https://www.wegmans.com/a"}}')
    .join('\n');
  assert.equal(extractConsole(dup, TARGET).messages.length, 1);
});

test('console messages are hard-capped at 40 for a pathological trace', () => {
  const lines = Array.from(
    { length: 500 },
    (_, i) => `{"type":"console","messageType":"error","text":"distinct site error number ${i}","location":{"url":"https://www.wegmans.com/p${i}"}}`,
  ).join('\n');
  assert.ok(extractConsole(lines, TARGET).messages.length <= 40);
});

test('network summary: counts, top-N, third-party grouping (parity)', () => {
  const n = extractNetwork(NETWORK_NDJSON, TARGET);
  assert.equal(n.totalRequests, 5); // context-options skipped
  assert.equal(n.wireKb, Math.trunc((43165 + 50000 + 2205000 + 500 + 0) / 1024));
  assert.equal(n.thirdPartyCount, 3); // 2× images.wegmans.com + the blob: (no host)

  assert.equal(n.failed.length, 1);
  assert.equal(n.failed[0].status, 404);
  assert.equal(n.slowest[0].timeMs, 1499); // blob script slowest
  assert.equal(n.largest[0].size, 2205000); // hero image largest

  assert.equal(n.uncompressed.length, 1); // only big.js (text, no encoding, > floor)
  assert.ok(n.uncompressed[0].url.includes('big.js'));

  assert.equal(n.topThirdParties.length, 1); // host-less blob: excluded
  assert.equal(n.topThirdParties[0].host, 'images.wegmans.com');
  assert.equal(n.topThirdParties[0].count, 2);

  assert.deepEqual(n.mutations, []); // GET-only fixture → mutations is an EMPTY list (matches C# empty, not absent)
});

// ── mutations (POST/PUT/PATCH/DELETE) — parity with C# TraceExtractor.ExtractNetwork Mutations ──────────────
// GET (document) + one of each mutating method + a trailing GET. Mutating methods captured in FIRST-SEEN order,
// GETs excluded, shape {method,url,status}, matching MutationDto(Method,Url,Status).
const MUTATION_NDJSON = [
  '{"type":"resource-snapshot","snapshot":{"_resourceType":"document","time":10,"timings":{"wait":5},"request":{"url":"https://www.wegmans.com/","method":"GET"},"response":{"status":200,"_transferSize":100,"content":{"size":50}}}}',
  '{"type":"resource-snapshot","snapshot":{"_resourceType":"fetch","time":20,"timings":{"wait":5},"request":{"url":"https://www.wegmans.com/api/cart","method":"POST"},"response":{"status":201,"_transferSize":100,"content":{"size":50}}}}',
  '{"type":"resource-snapshot","snapshot":{"_resourceType":"fetch","time":30,"timings":{"wait":5},"request":{"url":"https://www.wegmans.com/api/cart/1","method":"PUT"},"response":{"status":200,"_transferSize":100,"content":{"size":50}}}}',
  '{"type":"resource-snapshot","snapshot":{"_resourceType":"fetch","time":40,"timings":{"wait":5},"request":{"url":"https://www.wegmans.com/api/cart/1","method":"PATCH"},"response":{"status":200,"_transferSize":100,"content":{"size":50}}}}',
  '{"type":"resource-snapshot","snapshot":{"_resourceType":"fetch","time":50,"timings":{"wait":5},"request":{"url":"https://www.wegmans.com/api/cart/1","method":"DELETE"},"response":{"status":204,"_transferSize":100,"content":{"size":50}}}}',
  '{"type":"resource-snapshot","snapshot":{"_resourceType":"fetch","time":60,"timings":{"wait":5},"request":{"url":"https://www.wegmans.com/api/logo","method":"GET"},"response":{"status":200,"_transferSize":100,"content":{"size":50}}}}',
].join('\n');

test('network mutations: POST/PUT/PATCH/DELETE captured (method+url+status), GETs excluded, first-seen order (parity)', () => {
  const n = extractNetwork(MUTATION_NDJSON, TARGET);
  // exact shape + order: mirrors C# reqs.Where(MutatingMethods).Take(12).Select(new MutationDto(Method,Url,Status)).
  assert.deepEqual(n.mutations, [
    { method: 'POST', url: 'https://www.wegmans.com/api/cart', status: 201 },
    { method: 'PUT', url: 'https://www.wegmans.com/api/cart/1', status: 200 },
    { method: 'PATCH', url: 'https://www.wegmans.com/api/cart/1', status: 200 },
    { method: 'DELETE', url: 'https://www.wegmans.com/api/cart/1', status: 204 },
  ]);
});

test('network mutations are capped at 12 in first-seen order (parity with C# MutationCap)', () => {
  const lines = Array.from(
    { length: 15 },
    (_, i) => `{"type":"resource-snapshot","snapshot":{"_resourceType":"fetch","time":${i},"timings":{"wait":1},"request":{"url":"https://www.wegmans.com/api/x${i}","method":"POST"},"response":{"status":200,"_transferSize":1,"content":{"size":1}}}}`,
  ).join('\n');
  const n = extractNetwork(lines, TARGET);
  assert.equal(n.mutations.length, 12); // 15 POSTs → capped at 12
  assert.equal(n.mutations[0].url, 'https://www.wegmans.com/api/x0'); // first-seen kept
  assert.equal(n.mutations[11].url, 'https://www.wegmans.com/api/x11'); // the 13th–15th dropped
});

// ★ PARITY: the mutation url is stored RAW to byte-match C# (MutationDto stores r.Url; FromZip has no redactor).
// It must NOT be redacted even for a sensitive monitor — redacting here (as #169 did) diverges from C# on a
// sensitive input. (The regular network urls in `slim` still redact — that's a separate, established choice.)
test('the mutation url is stored RAW (not redacted), byte-matching C#, even under a redactor', () => {
  const ndjson =
    '{"type":"resource-snapshot","snapshot":{"_resourceType":"fetch","time":10,"timings":{"wait":5},"request":{"url":"https://www.wegmans.com/shop/cart?session=SECRET123&item=42","method":"POST"},"response":{"status":201,"_transferSize":100,"content":{"size":50}}}}';
  const RAW = 'https://www.wegmans.com/shop/cart?session=SECRET123&item=42';
  // even with a real redactor (the sensitive path), the mutation url is UNCHANGED — parity with C#.
  const withRedactor = extractNetwork(ndjson, TARGET, makeRedactor(null));
  assert.equal(withRedactor.mutations[0].url, RAW);
  // and identical without one (non-sensitive) — both paths agree with C#'s raw url.
  const plain = extractNetwork(ndjson, TARGET, IDENTITY_REDACTOR);
  assert.equal(plain.mutations[0].url, RAW);
});

test('extractTraceSignals parses a real zip (both streams) + derives targetHost from the URL', () => {
  const zip = new AdmZip();
  zip.addFile('trace.network', Buffer.from(NETWORK_NDJSON));
  zip.addFile('trace.trace', Buffer.from(CONSOLE_NDJSON));
  // an unrelated multi-MB entry that must NOT be read (we only touch the two NDJSON entries):
  zip.addFile('resources/blob.bin', Buffer.alloc(64));
  const dir = tmpDir();
  const path = join(dir, 'trace.zip');
  zip.writeZip(path);
  try {
    const sig = extractTraceSignals(path, 'https://www.wegmans.com/checkout');
    assert.ok(sig);
    assert.equal(sig.targetHost, 'www.wegmans.com'); // host of the target URL (no port), like Uri.Host
    assert.equal(sig.network.totalRequests, 5);
    assert.equal(sig.console.messages.length, 3);
    // shape sanity: JSON-serializable, camelCase keys present
    const json = JSON.parse(JSON.stringify(sig));
    assert.deepEqual(Object.keys(json).sort(), ['console', 'network', 'targetHost']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractTraceSignals is non-fatal: corrupt zip -> null (trace_signals stays null)', () => {
  const dir = tmpDir();
  const path = join(dir, 'bad.zip');
  writeFileSync(path, Buffer.from([1, 2, 3, 4])); // not a zip
  try {
    assert.equal(extractTraceSignals(path, 'https://www.wegmans.com/'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractTraceSignals -> null when the zip has no trace entries (not a Playwright trace)', () => {
  const zip = new AdmZip();
  zip.addFile('unrelated.txt', Buffer.from('hi'));
  const dir = tmpDir();
  const path = join(dir, 'empty.zip');
  zip.writeZip(path);
  try {
    assert.equal(extractTraceSignals(path, 'https://www.wegmans.com/'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── B10: trace_signals are SCRUBBED when a redactor is passed (sensitive monitors) ───────────────
test('extractNetwork redacts session tokens in the STORED url when given a redactor', () => {
  const ndjson = [
    '{"type":"resource-snapshot","snapshot":{"_resourceType":"fetch","time":10,"timings":{"wait":5},"request":{"url":"https://www.wegmans.com/shop/cart?session=SECRET123&item=42","method":"GET"},"response":{"status":200,"_transferSize":100,"content":{"size":50,"mimeType":"application/json"},"headers":[]}}}',
  ].join('\n');
  const redacted = extractNetwork(ndjson, TARGET, makeRedactor(null));
  assert.equal(redacted.slowest[0].url, 'https://www.wegmans.com/shop/cart?session=<redacted>&item=42');
  // host-grouping/classification still works (host carries no secret) — it's still a same-site request.
  assert.equal(redacted.totalRequests, 1);
  // ...and WITHOUT a redactor (non-sensitive) the url is byte-for-byte unchanged.
  const plain = extractNetwork(ndjson, TARGET, IDENTITY_REDACTOR);
  assert.equal(plain.slowest[0].url, 'https://www.wegmans.com/shop/cart?session=SECRET123&item=42');
});

test('extractConsole redacts a token the site logs when given a redactor', () => {
  const ndjson = [
    '{"type":"console","messageType":"error","text":"checkout failed for token=abc987ZZZ retry","location":{"url":"https://www.wegmans.com/checkout"}}',
  ].join('\n');
  const redacted = extractConsole(ndjson, TARGET, makeRedactor(null));
  assert.equal(redacted.messages.length, 1);
  assert.equal(redacted.messages[0].text, 'checkout failed for token=<redacted> retry');
  // non-sensitive: unchanged.
  const plain = extractConsole(ndjson, TARGET, IDENTITY_REDACTOR);
  assert.equal(plain.messages[0].text, 'checkout failed for token=abc987ZZZ retry');
});

// ── ★ THE CROSS-REPO PARITY ANCHOR ────────────────────────────────────────────────────────────────────────
// The golden fixture (test-fixtures/trace-signals-golden/) is the SINGLE source of truth both extractors must
// reproduce: the runner asserts here, and the API's TraceSignalsGoldenParityTests checks out THIS repo and
// asserts C# TraceExtractor.FromZip against the SAME expected.json. A divergence on EITHER side fails ITS CI.
// The golden input deliberately exercises the drift-prone ops the recon audited: roundHalfEven exact-halves
// (594.5→594, 1026.5→1026, 2.5→2 — banker's/to-even, NOT naive round-half-up), third-party grouping+order,
// console composite ordering, uncompressed, failed, AND mutations (POST/PUT/DELETE with statuses, post-Move-0).
// Resolve the golden dir across both run modes: tsx in-place (runner/) and compiled (runner/dist/).
function goldenDir(): string {
  const candidates = [
    join(import.meta.dirname, 'test-fixtures', 'trace-signals-golden'), // npx tsx --test (in-place, cwd runner/)
    join(import.meta.dirname, '..', 'test-fixtures', 'trace-signals-golden'), // tsc → dist/ then node --test
  ];
  for (const c of candidates) if (existsSync(join(c, 'expected.json'))) return c;
  throw new Error(`golden fixture dir not found (tried: ${candidates.join(', ')})`);
}

test('★ golden parity: extractTraceSignals(golden input) === expected.json (the cross-repo contract with C#)', () => {
  const dir = goldenDir();
  const zip = new AdmZip();
  zip.addFile('trace.network', readFileSync(join(dir, 'trace.network')));
  zip.addFile('trace.trace', readFileSync(join(dir, 'trace.trace')));
  const tdir = tmpDir();
  const path = join(tdir, 'golden.zip');
  zip.writeZip(path);
  try {
    // The golden was captured with a NON-sensitive (identity) redactor, so the persisted url is raw — this is
    // exactly the shape the C# FromZip (no redactor) produces, so the two extractors must byte-match here.
    const sig = extractTraceSignals(path, 'https://www.wegmans.com/checkout');
    const actual = JSON.parse(JSON.stringify(sig)); // normalize (drop undefined) for a structural compare
    const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8'));
    assert.deepEqual(actual, expected);
  } finally {
    rmSync(tdir, { recursive: true, force: true });
  }
});
