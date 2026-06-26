// Parity tests for the trace-signals extraction — uses the SAME fixtures + assertions as the API's
// SynthWatch.Api.Tests/TraceSignalsTests.cs, so a regression on either side is caught. The console
// extension-noise filter is the load-bearing one. Plus the runner-wrapper semantics (null on no-trace /
// corrupt zip, since trace_signals is nullable = "not extracted").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractNetwork, extractConsole, extractTraceSignals } from './traceSignals.js';

const TARGET = 'www.wegmans.com';

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
});

test('extractTraceSignals parses a real zip (both streams) + derives targetHost from the URL', () => {
  const zip = new AdmZip();
  zip.addFile('trace.network', Buffer.from(NETWORK_NDJSON));
  zip.addFile('trace.trace', Buffer.from(CONSOLE_NDJSON));
  // an unrelated multi-MB entry that must NOT be read (we only touch the two NDJSON entries):
  zip.addFile('resources/blob.bin', Buffer.alloc(64));
  const path = join(tmpdir(), `tsig-${process.pid}-ok.zip`);
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
    rmSync(path, { force: true });
  }
});

test('extractTraceSignals is non-fatal: corrupt zip -> null (trace_signals stays null)', () => {
  const path = join(tmpdir(), `tsig-${process.pid}-bad.zip`);
  writeFileSync(path, Buffer.from([1, 2, 3, 4])); // not a zip
  try {
    assert.equal(extractTraceSignals(path, 'https://www.wegmans.com/'), null);
  } finally {
    rmSync(path, { force: true });
  }
});

test('extractTraceSignals -> null when the zip has no trace entries (not a Playwright trace)', () => {
  const zip = new AdmZip();
  zip.addFile('unrelated.txt', Buffer.from('hi'));
  const path = join(tmpdir(), `tsig-${process.pid}-empty.zip`);
  zip.writeZip(path);
  try {
    assert.equal(extractTraceSignals(path, 'https://www.wegmans.com/'), null);
  } finally {
    rmSync(path, { force: true });
  }
});
