// The redacted/reduced sensitive failure trace (traceRedact.ts) — pure, no DB/browser.
//
// The load-bearing assertion is the LAST one: a full byte-scan of EVERY entry in the output zip for
// every planted secret (credential values, cookie/session material, bypass token, JWT). The
// entry-level tests explain WHICH mechanism catches which secret; the byte-scan proves the composed
// result. Also pinned: NDJSON lines stay valid JSON after scrubbing (the trace viewer parses every
// line), binary entries are dropped, and the fail-closed contract (corrupt / non-trace zip → false,
// nothing written).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { writeFileSync, rmSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRedactedTraceZip,
  classifyEntry,
  scrubTraceText,
  scrubPlainText,
  scrubEncodedRegions,
} from './traceRedact.js';
import { makeRedactor, IDENTITY_REDACTOR } from './redact.js';

// mkdtemp per test (the secure temp-file pattern used by traceSignals.test.ts).
function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'tredact-'));
}

// ── planted secrets (each exercised by a distinct mechanism) ──────────────────────────────────────
const CRED_USER = 'shopper@test.example'; //   known VALUE (login credential) → escaped-literal rule
const CRED_PASS = 'hunter2secret'; //          known VALUE (login credential)
const BYPASS = 'ak-bypass-9f8e7d6c'; //        known VALUE (secret request header / bypass token)
const COOKIE_VAL = 'sid=OPAQUECOOKIE123; Path=/'; // HAR header pair → structural rule 1
const SESS_TOKEN = 'OPAQUESESSION456'; //      auth-ish JSON key → structural rule 2
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sigPART'; // built-in denylist
const ALL_SECRETS = [CRED_USER, CRED_PASS, BYPASS, 'OPAQUECOOKIE123', SESS_TOKEN, 'eyJ'];

const DIAGNOSTIC = 'TimeoutError: locator .cart-total not found';

const TRACE_NDJSON = [
  // console event: diagnostic text + the typed credential + a JWT the site logged
  JSON.stringify({ type: 'console', messageType: 'error', text: `${DIAGNOSTIC} for ${CRED_USER} jwt=${JWT}` }),
  // frame-snapshot with the typed value baked into the serialized DOM + a raw Set-Cookie inline
  JSON.stringify({ type: 'frame-snapshot', html: `<input value="${CRED_PASS}"> Set-Cookie: ${COOKIE_VAL}` }),
].join('\n');

const NETWORK_NDJSON = [
  JSON.stringify({
    type: 'resource-snapshot',
    snapshot: {
      request: {
        url: 'https://www.wegmans.com/api/login?access_token=QUERYTOK99',
        method: 'POST',
        headers: [
          { name: 'x-akamai-bypass', value: BYPASS }, // caught as a known VALUE (name is not auth-ish)
          { name: 'cookie', value: COOKIE_VAL },
          { name: 'authorization', value: `Bearer ${JWT}` },
        ],
      },
      response: {
        status: 200,
        headers: [{ name: 'set-cookie', value: COOKIE_VAL }],
      },
    },
  }),
].join('\n');

// text response body: an auth-ish JSON key + a credential echoed by the API
const BODY_JSON = JSON.stringify({ sessionToken: SESS_TOKEN, greeting: `welcome ${CRED_USER}`, ok: true });

function writeFixtureZip(dir: string, withBinary = true): string {
  const zip = new AdmZip();
  zip.addFile('trace.trace', Buffer.from(TRACE_NDJSON, 'utf8'));
  zip.addFile('trace.network', Buffer.from(NETWORK_NDJSON, 'utf8'));
  zip.addFile('resources/aaa111.json', Buffer.from(BODY_JSON, 'utf8'));
  if (withBinary) {
    // a screencast frame (unscrubbable — MUST be dropped) + a font (unclassified → dropped)
    zip.addFile('resources/frame01.jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    zip.addFile('resources/font.woff2', Buffer.from([0x77, 0x4f, 0x46, 0x32]));
  }
  const p = join(dir, 'trace.zip');
  writeFileSync(p, zip.toBuffer());
  return p;
}

const redactor = makeRedactor(null, [CRED_USER, CRED_PASS, BYPASS]);

test('classifyEntry: NDJSON + text bodies scrub; images/fonts/unknown DROP (fail-closed default)', () => {
  assert.equal(classifyEntry('trace.trace'), 'scrub');
  assert.equal(classifyEntry('trace.network'), 'scrub');
  assert.equal(classifyEntry('trace.stacks'), 'scrub');
  assert.equal(classifyEntry('resources/ab12.html'), 'scrub');
  assert.equal(classifyEntry('resources/ab12.json'), 'scrub');
  assert.equal(classifyEntry('resources/ab12.css'), 'scrub');
  assert.equal(classifyEntry('resources/frame.jpeg'), 'drop');
  assert.equal(classifyEntry('resources/font.woff2'), 'drop');
  assert.equal(classifyEntry('resources/mystery.bin'), 'drop');
  assert.equal(classifyEntry('resources/noextension'), 'drop');
});

// ── ★★ PERCENT-ENCODED PII (decode-then-scrub) ──────────────────────────────────────────────────────
// The member identity record found by the 2026-07-29 recon is stored percent-ENCODED in a DOM snapshot,
// so a plain-form declared pattern matches NOTHING. These tests pin the decode pass AND prove it is
// load-bearing: the same input is run WITHOUT the decode step and the sentinel must SURVIVE. A redaction
// test that cannot fail proves nothing.

// The real shape, reproduced from run 1087934's trace.trace (values replaced with test data).
const IDENTITY_PLAIN =
  '{"userInfo":{"email":"member@wegmans.test","firstName":"Testy","lastName":"McTest","loyaltyNumber":104735137,"name":"Testy McTest","phoneNumber":"2065550123"}}';
const IDENTITY_ENCODED = encodeURIComponent(IDENTITY_PLAIN);
// …as it actually appears: inside a hidden input's value in a serialized DOM snapshot NDJSON line.
const SNAPSHOT_LINE = JSON.stringify({
  type: 'frame-snapshot',
  html: `["INPUT",{"__playwright_value_":"${IDENTITY_ENCODED}","type":"hidden","id":"tokenJson"}]`,
});

// The patterns a monitor would declare for the identity blob (see the monitors-manifest PR). Written in
// PLAIN form — which is the whole point: the author writes what the JSON looks like, not what it looks
// like percent-mangled.
//
// ★ The FIRST pattern takes the whole `userInfo` OBJECT rather than field-by-field. That is deliberate:
// the blob's full-name field is the generic key `"name"`, which cannot be matched on its own without
// hitting the thousands of unrelated `"name"` attributes in a serialized DOM (and every HAR header
// pair). Redacting the container catches `name` — and any field the vendor adds later — without that
// collateral. The per-field patterns that follow are defence-in-depth for the same values appearing
// outside a userInfo wrapper.
const IDENTITY_PATTERNS = [
  '"userInfo"\\s*:\\s*\\{[^{}]*\\}',
  '"loyaltyNumber"\\s*:\\s*"?\\d+"?',
  '"phoneNumber"\\s*:\\s*"[^"]*"',
  '"(firstName|lastName)"\\s*:\\s*"[^"]*"',
];
const identityRedactor = makeRedactor(IDENTITY_PATTERNS, []);

test('★★ PROVE-CAN-FAIL: the percent-encoded sentinel SURVIVES the plain scrub (decode step disabled)', () => {
  // This is the bug the decode pass exists to fix. If this assertion ever flips to "gone", the test
  // below stops proving anything — the plain pipeline would be doing the work on its own.
  const plainOnly = scrubPlainText(SNAPSHOT_LINE, identityRedactor);
  assert.ok(plainOnly.includes('104735137'), 'plain-form patterns CANNOT see percent-encoded PII');
  assert.ok(plainOnly.includes(encodeURIComponent('"loyaltyNumber"').slice(0, 12)), 'the encoded key is still there');
});

test('★★ decode-then-scrub CATCHES the percent-encoded identity blob', () => {
  const out = scrubTraceText(SNAPSHOT_LINE, identityRedactor);
  assert.ok(!out.includes('104735137'), 'loyaltyNumber must be gone');
  assert.ok(!out.includes('2065550123'), 'phoneNumber must be gone');
  assert.ok(!out.includes('Testy'), 'firstName/lastName must be gone');
  assert.ok(!out.includes('McTest'), 'surname must be gone');
  assert.match(out, /redacted/, 'and a redaction marker is present in its place');
});

test('★★ decode-then-scrub: the rewritten NDJSON line is STILL VALID JSON', () => {
  // The trace viewer parses trace.trace line-by-line; an invalid line is silently dropped.
  const out = scrubTraceText(SNAPSHOT_LINE, identityRedactor);
  const parsed = JSON.parse(out) as { type: string; html: string };
  assert.equal(parsed.type, 'frame-snapshot');
  // The rewritten run still decodes, and what it decodes to carries no PII.
  const decoded = decodeURIComponent(/"__playwright_value_":"([^"]*)"/.exec(parsed.html)![1]);
  assert.ok(!decoded.includes('104735137'));
  assert.ok(decoded.includes('redacted'), 'the decoded value shows the marker, so the trace stays legible');
});

test('★★ REPLACE-ONLY-ON-CHANGE: an encoded run with no PII keeps its ORIGINAL bytes', () => {
  // A 38MB trace is almost entirely innocuous encoded text (URLs, query strings). Re-encoding all of it
  // would be gratuitous churn, so a run that scrubs to itself must come back byte-identical.
  const innocuous = JSON.stringify({
    url: 'https://www.wegmans.com/shop/search?q=milk%20and%20eggs&sort=relevance%3Adesc',
  });
  assert.equal(scrubEncodedRegions(innocuous, identityRedactor), innocuous);
});

test('★★ decode pass never crosses a JSON string boundary (the run charset excludes " and \\)', () => {
  // Two adjacent encoded values in one line: scrubbing the first must not consume the second's quotes.
  const line = JSON.stringify({ a: encodeURIComponent(IDENTITY_PLAIN), b: 'keep%20me', c: 42 });
  const out = scrubTraceText(line, identityRedactor);
  const parsed = JSON.parse(out) as { a: string; b: string; c: number };
  assert.equal(parsed.b, 'keep%20me', 'the untouched sibling value is byte-identical');
  assert.equal(parsed.c, 42);
  assert.ok(!parsed.a.includes('104735137'));
});

test('★★ malformed percent-encoding is left UNTOUCHED rather than guessed at (documented trade)', () => {
  const bad = 'value=%ZZnot-really-encoded%and-a-lone-percent';
  assert.equal(scrubEncodedRegions(bad, identityRedactor), bad);
  // A lone '%' with no hex pair is not even a candidate — cheap-reject path, no decode attempted.
  assert.equal(scrubEncodedRegions('100% plain text', identityRedactor), '100% plain text');
});

test('★★ the decode pass composes with the KNOWN-VALUE rules (an encoded credential is caught too)', () => {
  // Not just declared patterns: a typed credential that the browser stored URL-encoded is now caught,
  // which the plain escaped-literal rule could not see. CRED_USER is the right probe here — it contains
  // an '@', so its encoded form genuinely differs from its plain form (CRED_PASS is alphanumeric and
  // percent-encodes to ITSELF, so it would be caught by the plain pass and prove nothing).
  const encodedUser = encodeURIComponent(CRED_USER);
  assert.notEqual(encodedUser, CRED_USER, 'probe must actually change under encoding');
  const line = JSON.stringify({ body: `user=${encodedUser}` });
  assert.ok(scrubPlainText(line, redactor).includes(encodedUser), 'plain scrub misses the encoded form');
  const out = scrubTraceText(line, redactor);
  assert.ok(!out.includes(encodedUser), 'encoded credential value must be scrubbed');
  assert.ok(!out.includes(CRED_USER), 'and it must not appear decoded either');
  JSON.parse(out); // still valid JSON
});

test('scrubTraceText: HAR header pair — cookie/set-cookie/authorization VALUES redacted, JSON stays valid', () => {
  const out = scrubTraceText(NETWORK_NDJSON, redactor);
  const parsed = JSON.parse(out.split('\n')[0]) as {
    snapshot: {
      request: { url: string; headers: Array<{ name: string; value: string }> };
      response: { headers: Array<{ name: string; value: string }> };
    };
  };
  for (const h of [...parsed.snapshot.request.headers, ...parsed.snapshot.response.headers]) {
    assert.ok(!h.value.includes('OPAQUECOOKIE123') && !h.value.includes(BYPASS) && !h.value.includes('eyJ'),
      `header "${h.name}" value scrubbed (got: ${h.value})`);
    assert.ok(h.name.length > 0, 'header NAME kept (useful signal)');
  }
  // the query-param token (built-in denylist) is gone too, the url path survives
  assert.ok(!out.includes('QUERYTOK99'));
  assert.ok(out.includes('/api/login'));
});

test('classifyEntry: the REAL playwright@1.61.1 layout (empirical probe) — bodies keep their mime extension', () => {
  // Observed from an actual trace recorded with the runner's exact tracing options: response bodies
  // are resources/<sha1>.<mime-ext>; screencast frames are resources/page@<hash>-<ts>.jpeg.
  assert.equal(classifyEntry('resources/22b046e63a43a269aadb15ac311fcd0f6afc0dcd.html'), 'scrub');
  assert.equal(classifyEntry('resources/567574ebe23fc34cf3d9ded15e7838d5a087bcf5.css'), 'scrub');
  assert.equal(classifyEntry('resources/ba78b8520a074ee569ec13d0c5ce12b01d71508c.json'), 'scrub');
  assert.equal(classifyEntry('resources/4e8639220cd5c5c5c9e8e6bd0153d162f0caf426.png'), 'drop');
  assert.equal(classifyEntry('resources/page@2cb82aac3db7cd28d24431415a9e3d76-1783616044541.jpeg'), 'drop');
});

test('★ AUTHISH anchoring: ordinary English keys keep their values; genuinely auth-shaped keys lose them', () => {
  // IDENTITY monitor redactor isolates the STRUCTURAL rules (rule 2: auth-ish JSON key).
  const body = JSON.stringify({
    residence: 'keep-1', // contains "sid" as a substring — must NOT be redacted (was, pre-anchor)
    consideration: 'keep-2',
    president: 'keep-3',
    inside: 'keep-4',
    author: 'keep-5', // contains "auth" as a substring — must NOT be redacted (was, pre-anchor)
    authority: 'keep-6',
    sid: 'gone-1',
    'x-sid': 'gone-2',
    sessid: 'gone-3',
    sessionToken: 'gone-4',
    authorization: 'gone-5',
    auth: 'gone-6',
    'x-auth-key': 'gone-7',
    oauth_state: 'gone-8', // OAuth state IS a CSRF-class token — deliberately still redacted
  });
  const out = JSON.parse(scrubTraceText(body, IDENTITY_REDACTOR)) as Record<string, string>;
  for (const k of ['residence', 'consideration', 'president', 'inside', 'author', 'authority']) {
    assert.ok(out[k].startsWith('keep-'), `"${k}" is not auth-shaped — its value must survive (got: ${out[k]})`);
  }
  for (const k of ['sid', 'x-sid', 'sessid', 'sessionToken', 'authorization', 'auth', 'x-auth-key', 'oauth_state']) {
    assert.equal(out[k], '<redacted>', `"${k}" is auth-shaped — its value must be redacted`);
  }
});

test('scrubTraceText: auth-ish JSON key in a response body redacted; non-auth fields untouched', () => {
  const out = scrubTraceText(BODY_JSON, redactor);
  const parsed = JSON.parse(out) as { sessionToken: string; greeting: string; ok: boolean };
  assert.equal(parsed.sessionToken, '<redacted>');
  assert.equal(parsed.ok, true);
  assert.ok(!parsed.greeting.includes(CRED_USER), 'the echoed credential VALUE is scrubbed');
  assert.ok(parsed.greeting.includes('welcome'), 'non-secret text survives');
});

test('scrubTraceText: diagnostic console text SURVIVES while values are scrubbed (store-more posture)', () => {
  const out = scrubTraceText(TRACE_NDJSON, redactor);
  assert.ok(out.includes(DIAGNOSTIC), 'the failure diagnostic is kept');
  for (const s of ALL_SECRETS) assert.ok(!out.includes(s), `secret ${s.slice(0, 8)}… gone`);
  for (const line of out.split('\n')) JSON.parse(line); // every NDJSON line still parses
});

// ── ★ escape-awareness: a header VALUE containing a JSON-escaped quote must not break the line ─────
// The trace viewer JSON.parses every NDJSON line, so a rewrite that leaves an unescaped " corrupts
// the line and the event is silently dropped (the #232 "Could not load trace" root cause). Rules 1-2
// were already escape-aware (JSON_STR); rule 3 (the raw inline "set-cookie: …" form) was the outlier.

test('★ rule 3 must-go-red: a raw inline set-cookie value with an ESCAPED QUOTE stays VALID JSON', () => {
  // Inside a JSON string, a literal " is escaped as \". The runner-side string below therefore has \\"
  // so the ON-DISK NDJSON line contains set-cookie: sess=a\"b; path=/ — a valid JSON string.
  const line = JSON.stringify({ type: 'console', text: 'resp header set-cookie: sess=a"b; path=/' });
  assert.doesNotThrow(() => JSON.parse(line), 'precondition: input line is valid JSON');
  assert.ok(line.includes('\\"'), 'precondition: the value carries a JSON-escaped quote');

  const out = scrubTraceText(line, IDENTITY_REDACTOR); // isolate the structural rules

  // THE crux — revert rule 3 to [^"'\r\n]+ and this line becomes {"…set-cookie: <redacted>"b; path=/"}
  // (the escaping backslash eaten, the bare " closes the string early) → JSON.parse throws.
  let parsed: { text: string };
  assert.doesNotThrow(() => {
    parsed = JSON.parse(out) as { text: string };
  }, 'redacted NDJSON line must remain valid JSON (viewer JSON.parses every line)');

  // escape-aware ≠ under-redaction: the whole cookie value (through the escaped quote) is gone.
  assert.match(parsed!.text, /set-cookie: <redacted>$/, 'value redacted, up to the closing quote');
  assert.doesNotMatch(parsed!.text, /sess=a/, 'the raw cookie value must not survive');
});

test('rule 3 regression: a normal inline header value (no escaped quote) still redacts, JSON valid', () => {
  const line = JSON.stringify({ type: 'console', text: 'resp header set-cookie: session=PLAINABC123; path=/' });
  const out = scrubTraceText(line, IDENTITY_REDACTOR);
  const parsed = JSON.parse(out) as { text: string };
  assert.match(parsed.text, /set-cookie: <redacted>/);
  assert.doesNotMatch(parsed.text, /PLAINABC123/);
});

test('rules 1-2 escape-aware: HAR pair + auth-ish JSON key with escaped quotes stay valid, values gone', () => {
  const har = JSON.stringify({ name: 'set-cookie', value: 'sid=x"y; Secure' });
  const key = JSON.stringify({ access_token: 'ab"cd.ef' });
  const outHar = JSON.parse(scrubTraceText(har, IDENTITY_REDACTOR)) as { name: string; value: string };
  const outKey = JSON.parse(scrubTraceText(key, IDENTITY_REDACTOR)) as { access_token: string };
  assert.equal(outHar.value, '<redacted>');
  assert.equal(outHar.name, 'set-cookie', 'header name preserved');
  assert.equal(outKey.access_token, '<redacted>');
});

test('★ buildRedactedTraceZip: binary entries dropped, text kept, and NO planted secret survives ANYWHERE', async () => {
  const dir = tmpDir();
  try {
    const src = writeFixtureZip(dir);
    const dest = join(dir, 'trace.redacted.zip');
    assert.equal(await buildRedactedTraceZip(src, dest, redactor), true);

    const out = new AdmZip(dest);
    const names = out.getEntries().map((e) => e.entryName).sort();
    assert.deepEqual(names, ['resources/aaa111.json', 'trace.network', 'trace.trace'],
      'screencast jpeg + font dropped; all text entries kept');

    // THE invariant: full byte-scan of every output entry for every planted secret.
    for (const e of out.getEntries()) {
      const text = e.getData().toString('utf8');
      for (const s of ALL_SECRETS) {
        assert.ok(!text.includes(s), `entry ${e.entryName} must not contain ${s.slice(0, 8)}…`);
      }
    }
    // and it is still a debuggable trace: the diagnostic survives in trace.trace
    assert.ok(out.getEntry('trace.trace')!.getData().toString('utf8').includes(DIAGNOSTIC));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildRedactedTraceZip fail-closed: a corrupt zip → false, dest not left behind', async () => {
  const dir = tmpDir();
  try {
    const src = join(dir, 'corrupt.zip');
    writeFileSync(src, Buffer.from('this is not a zip'));
    const dest = join(dir, 'out.zip');
    assert.equal(await buildRedactedTraceZip(src, dest, redactor), false);
    assert.equal(existsSync(dest), false, 'no partial output left for the caller to upload');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildRedactedTraceZip fail-closed: a valid zip that is NOT a Playwright trace → false', async () => {
  const dir = tmpDir();
  try {
    const zip = new AdmZip();
    zip.addFile('readme.txt', Buffer.from('no trace entries here'));
    const src = join(dir, 'nottrace.zip');
    writeFileSync(src, zip.toBuffer());
    const dest = join(dir, 'out.zip');
    assert.equal(await buildRedactedTraceZip(src, dest, redactor), false);
    assert.equal(existsSync(dest), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildRedactedTraceZip fail-closed: a missing source file → false', async () => {
  const dir = tmpDir();
  try {
    assert.equal(await buildRedactedTraceZip(join(dir, 'nope.zip'), join(dir, 'out.zip'), redactor), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ★ MEMORY-BOUNDED (the B2 point): a DROPPED entry (screencast frame) that is FAR larger than the
// container has headroom must NOT be pulled into memory. The old in-memory build did `new AdmZip(srcPath)`
// — loading the ENTIRE zip, jpegs included — which is exactly what OOM-killed the runner on a long run.
// The streaming build skips dropped entries WITHOUT decompressing them, so peak memory tracks the kept
// TEXT entries only, not the (dominant) screencast bulk. Here the dropped jpeg is 160 MiB of INCOMPRESSIBLE
// random bytes (so the on-disk zip is really ~160 MiB, not squashed by deflate); we assert the run's own
// RSS growth stays well under that. MUST-GO-RED under the old AdmZip code: loading the 160 MiB entry grows
// RSS by ≥160 MiB, blowing the bound.
test('buildRedactedTraceZip: a huge DROPPED entry is streamed past, not loaded — peak memory stays bounded', async () => {
  const dir = tmpDir();
  try {
    const BIG = 160 * 1024 * 1024; // 160 MiB, incompressible
    const src = join(dir, 'trace.zip');
    {
      // Build the fixture with AdmZip (setup only — this is NOT the code under test). Kept in its own
      // block so the 160 MiB source buffer is dead by the time we measure the function's own growth.
      const { randomBytes } = await import('node:crypto');
      const zip = new AdmZip();
      zip.addFile('trace.trace', Buffer.from(TRACE_NDJSON, 'utf8'));
      zip.addFile('trace.network', Buffer.from('{"tiny":"line"}', 'utf8'));
      zip.addFile('resources/bigframe.jpeg', randomBytes(BIG)); // dropped by classifyEntry
      writeFileSync(src, zip.toBuffer());
    }
    const dest = join(dir, 'trace.redacted.zip');

    const before = process.memoryUsage().rss;
    const ok = await buildRedactedTraceZip(src, dest, redactor);
    const grew = process.memoryUsage().rss - before;

    assert.equal(ok, true, 'streams to a valid redacted zip despite the huge dropped entry');
    const out = new AdmZip(dest);
    const names = out.getEntries().map((e) => e.entryName).sort();
    assert.deepEqual(names, ['trace.network', 'trace.trace'], 'the 160 MiB jpeg is dropped; text kept');
    // Bounded: the streamed run must not have pulled the 160 MiB entry into memory. Generous half-size
    // ceiling absorbs GC/allocator noise while still catching a whole-zip load (which would add ≥160 MiB).
    assert.ok(
      grew < BIG / 2,
      `RSS grew ${(grew / 1048576).toFixed(1)} MiB during redaction of a 160 MiB-dropped-entry trace — expected « the entry size (streaming, not whole-zip load)`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// ★ keepImages — the PREVIEW-ONLY divergence, and the guard that it can never become the FLEET's.
// ──────────────────────────────────────────────────────────────────────────────────────────────────

test('★ FLEET DEFAULT IS FROZEN: no opts ⇒ image entries still DROPPED (regression guard for keepImages)', async () => {
  // ★ THIS IS THE POINT OF THE PARAMETER TEST. `keepImages` exists so a credentialed PREVIEW can keep its
  //   screencast frames. A fleet sensitive monitor must NEVER get them: its logged-in pages carry member
  //   name / address / order history — PII that is not masked the way <input type="password"> is, that
  //   nobody asked to see, and that would land in 90d-retained artifacts. If someone flips the default, or
  //   threads the preview's `true` into the fleet call in runner/index.ts, THIS test reds.
  const dir = tmpDir();
  try {
    const src = writeFixtureZip(dir);
    const dest = join(dir, 'fleet.redacted.zip');
    assert.equal(await buildRedactedTraceZip(src, dest, redactor), true);
    const names = new AdmZip(dest).getEntries().map((e) => e.entryName).sort();
    assert.deepEqual(names, ['resources/aaa111.json', 'trace.network', 'trace.trace'],
      'FLEET: jpeg + font dropped — unchanged by the keepImages parameter existing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ FLEET DEFAULT IS FROZEN: an explicitly non-true keepImages is still the fleet path', async () => {
  // Only a literal `true` opts in. A stray `undefined`/`false`/omitted-object must not widen the fleet.
  const dir = tmpDir();
  try {
    const src = writeFixtureZip(dir);
    for (const [label, opts] of [
      ['{}', {}],
      ['{keepImages: false}', { keepImages: false }],
      ['{keepImages: undefined}', { keepImages: undefined }],
    ] as const) {
      const dest = join(dir, `fleet-${label.replace(/\W/g, '')}.zip`);
      assert.equal(await buildRedactedTraceZip(src, dest, redactor, opts), true);
      const names = new AdmZip(dest).getEntries().map((e) => e.entryName).sort();
      assert.deepEqual(names, ['resources/aaa111.json', 'trace.network', 'trace.trace'], `${label} ⇒ fleet default`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ PREVIEW: keepImages keeps the screencast jpeg VERBATIM — and still scrubs every text entry', async () => {
  const dir = tmpDir();
  try {
    const src = writeFixtureZip(dir);
    const dest = join(dir, 'preview.redacted.zip');
    assert.equal(await buildRedactedTraceZip(src, dest, redactor, { keepImages: true }), true);

    const out = new AdmZip(dest);
    const names = out.getEntries().map((e) => e.entryName).sort();
    assert.deepEqual(names, ['resources/aaa111.json', 'resources/frame01.jpeg', 'trace.network', 'trace.trace'],
      'jpeg KEPT for the preview; the font (not an image) is STILL dropped — allowlist, not "not text"');

    // The jpeg survives byte-identical: an image cannot be text-scrubbed, and mangling it would defeat
    // the point of keeping it.
    const jpeg = out.getEntries().find((e) => e.entryName === 'resources/frame01.jpeg');
    assert.deepEqual(jpeg?.getData(), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), 'jpeg passed through verbatim');

    // ★ AND THE TEXT IS STILL SCRUBBED. keepImages relaxes IMAGE retention only — it must not weaken the
    //   text scrub by one byte, or "optional images" would have silently become "optional redaction".
    for (const e of out.getEntries()) {
      if (e.entryName.endsWith('.jpeg')) continue; // binary; scanned for secrets below via the text path only
      const text = e.getData().toString('utf8');
      for (const s of ALL_SECRETS) {
        assert.ok(!text.includes(s), `secret survived in ${e.entryName} with keepImages on`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ★★ THE AUTHISH GAP: SECRET HEADERS THAT NO FRAGMENT MATCHES ─────────────────────────────────────
// FOUND IN PROD 2026-08-05: `x-vercel-protection-bypass` rode trace.network in CLEARTEXT on every
// retained trace of a sensitive check (3,230 occurrences in one measured run, 90-day retention). The
// structural rules key on AUTHISH FRAGMENTS and this name contains none of them; its sibling
// `x-vercel-set-bypass-cookie` was redacted only by the accident of containing "cookie". Auditing all
// 52 request-header names a real trace persists found a second: `ocp-apim-subscription-key` (AUTHISH's
// `api[_-]?key` does not match "apim-subscription-key" — "api" is followed by "m").
const VERCEL_TOKEN = 'K4gTbDwgVERCELtokenSENTINEL';
const APIM_KEY = 'b90c7176APIMkeySENTINEL';

/** A trace.network line shaped exactly as Playwright writes it: a HAR request with a header array. */
const harLineWith = (headers: Array<[string, string]>): string =>
  JSON.stringify({
    type: 'resource-snapshot',
    snapshot: {
      request: {
        method: 'GET',
        url: 'https://www.wegmans.com/cart',
        headers: headers.map(([name, value]) => ({ name, value })),
      },
      response: { status: 200, headers: [] },
    },
  });

test('★ SECRET HEADER by exact NAME is redacted — the fragment list never matched it', () => {
  const line = harLineWith([
    ['x-vercel-protection-bypass', VERCEL_TOKEN],
    ['ocp-apim-subscription-key', APIM_KEY],
    ['user-agent', 'HeadlessChrome/151'], // an ordinary header must survive
  ]);
  // IDENTITY_REDACTOR: the STRUCTURAL rule alone must do it, with no known-value help.
  const out = scrubPlainText(line, IDENTITY_REDACTOR);
  assert.ok(!out.includes(VERCEL_TOKEN), 'the Vercel bypass token must not survive');
  assert.ok(!out.includes(APIM_KEY), 'the APIM subscription key must not survive');
  assert.ok(out.includes('HeadlessChrome/151'), 'an ordinary header value must NOT be over-redacted');
  assert.doesNotThrow(() => JSON.parse(out), 'the NDJSON line must stay valid JSON for the trace viewer');
});

test('★ PROVE-CAN-FAIL: without the secret-header rule the token SURVIVES — the test is not vacuous', () => {
  // Reconstruct the PRE-FIX behaviour exactly: the AUTHISH fragment rules, minus the exact-name rule.
  // If this ever comes back clean, the assertion above is proving nothing.
  const AUTHISH = '(?:token|session|sess[_-]?id|\\bsid\\b|jwt|bearer|authorization|oauth|\\bauth\\b|secret|password|passwd|pwd|api[_-]?key|cookie|csrf|xsrf|signature)';
  const JSON_STR = '(?:[^"\\\\]|\\\\.)*';
  const preFix = (t: string): string =>
    t.replace(new RegExp(`("name"\\s*:\\s*"[\\w-]*${AUTHISH}[\\w-]*"\\s*,\\s*"value"\\s*:\\s*")${JSON_STR}(")`, 'gi'), '$1<redacted>$2');

  const line = harLineWith([
    ['x-vercel-protection-bypass', VERCEL_TOKEN],
    ['ocp-apim-subscription-key', APIM_KEY],
    ['x-vercel-set-bypass-cookie', 'true'],
  ]);
  const before = preFix(line);
  assert.ok(before.includes(VERCEL_TOKEN), '★ VACUOUS: the pre-fix rules already redacted the Vercel token');
  assert.ok(before.includes(APIM_KEY), '★ VACUOUS: the pre-fix rules already redacted the APIM key');
  // …and the sibling WAS caught pre-fix, purely because its name contains "cookie" — the accident that
  // made this leak look covered.
  assert.ok(!before.includes('"value":"true"'), 'the -cookie sibling was already redacted by accident');
});

test('★ the VALUE half survives a header RENAME — registering the token scrubs it under any name', () => {
  // The durable half: runner/index.ts registers bypassToken() as a knownValue, so the value is scrubbed
  // wherever it appears. Model a header Vercel renamed tomorrow, which no name list could anticipate.
  const renamed = harLineWith([['x-vercel-edge-bypass-v2', VERCEL_TOKEN]]);
  const nameOnly = scrubPlainText(renamed, IDENTITY_REDACTOR);
  assert.ok(nameOnly.includes(VERCEL_TOKEN), 'a renamed header is invisible to the name list — as expected');
  const withValue = scrubPlainText(renamed, makeRedactor(null, [VERCEL_TOKEN]));
  assert.ok(!withValue.includes(VERCEL_TOKEN), 'but registering the VALUE catches it under any name');
});

test('★★ END-TO-END: a REAL zip built with the header present contains no occurrence of the token', async () => {
  const dir = tmpDir();
  try {
    const src = join(dir, 'trace.zip');
    const dest = join(dir, 'out.zip');
    const zip = new AdmZip();
    // A trace.network with the header in BOTH shapes it really occurs in, plus a raw inline form.
    zip.addFile('trace.trace', Buffer.from(TRACE_NDJSON, 'utf8'));
    zip.addFile(
      'trace.network',
      Buffer.from(
        [
          harLineWith([['x-vercel-protection-bypass', VERCEL_TOKEN], ['ocp-apim-subscription-key', APIM_KEY]]),
          JSON.stringify({ type: 'note', text: `x-vercel-protection-bypass: ${VERCEL_TOKEN}` }),
        ].join('\n'),
        'utf8',
      ),
    );
    writeFileSync(src, zip.toBuffer());

    // The zip redactor as index.ts now builds it: declared patterns + credential values + the token VALUE.
    const ok = await buildRedactedTraceZip(src, dest, makeRedactor(null, [CRED_PASS, VERCEL_TOKEN]));
    assert.equal(ok, true, 'the redacted zip must build');

    // BYTE-SCAN every entry of the OUTPUT zip — the load-bearing assertion.
    const out = new AdmZip(dest);
    for (const entry of out.getEntries()) {
      const text = entry.getData().toString('utf8');
      assert.ok(!text.includes(VERCEL_TOKEN), `LEAK: the Vercel token survived in ${entry.entryName}`);
      assert.ok(!text.includes(APIM_KEY), `LEAK: the APIM key survived in ${entry.entryName}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
