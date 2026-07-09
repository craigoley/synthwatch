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
import { buildRedactedTraceZip, classifyEntry, scrubTraceText } from './traceRedact.js';
import { makeRedactor } from './redact.js';

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

test('★ buildRedactedTraceZip: binary entries dropped, text kept, and NO planted secret survives ANYWHERE', () => {
  const dir = tmpDir();
  try {
    const src = writeFixtureZip(dir);
    const dest = join(dir, 'trace.redacted.zip');
    assert.equal(buildRedactedTraceZip(src, dest, redactor), true);

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

test('buildRedactedTraceZip fail-closed: a corrupt zip → false, dest not left behind', () => {
  const dir = tmpDir();
  try {
    const src = join(dir, 'corrupt.zip');
    writeFileSync(src, Buffer.from('this is not a zip'));
    const dest = join(dir, 'out.zip');
    assert.equal(buildRedactedTraceZip(src, dest, redactor), false);
    assert.equal(existsSync(dest), false, 'no partial output left for the caller to upload');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildRedactedTraceZip fail-closed: a valid zip that is NOT a Playwright trace → false', () => {
  const dir = tmpDir();
  try {
    const zip = new AdmZip();
    zip.addFile('readme.txt', Buffer.from('no trace entries here'));
    const src = join(dir, 'nottrace.zip');
    writeFileSync(src, zip.toBuffer());
    const dest = join(dir, 'out.zip');
    assert.equal(buildRedactedTraceZip(src, dest, redactor), false);
    assert.equal(existsSync(dest), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildRedactedTraceZip fail-closed: a missing source file → false', () => {
  const dir = tmpDir();
  try {
    assert.equal(buildRedactedTraceZip(join(dir, 'nope.zip'), join(dir, 'out.zip'), redactor), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
