// ★★ THE PAYLOAD-CHANNEL ACCEPTANCE TEST. The channel exists for ONE reason: ACA persists a jobs/start env
// override VERBATIM in job execution history (OBSERVED on synthwatch-sandbox), so a credential must never
// ride the env. These tests pin the properties that make the blob channel safer than the thing it replaces:
//   1. the ciphertext blob is DELETED BEFORE any uploaded code executes (not after, not by lifecycle);
//   2. a failed delete FAILS THE RUN rather than executing beside a live ciphertext;
//   3. the ARM-env half (the key) is worthless without the blob half, and vice versa;
//   4. the legacy env path still works (so the runner can deploy before the api cuts over) — PR4 deletes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { encryptCredValue, parseAes256Key } from '../crypto.js';
import { runSandboxPreview } from './runSandboxPreview.js';
import { buildSandboxEnv } from './sandboxEnv.js';
import {
  credentialValues,
  decodeSandboxPayload,
  isCredentialedRun,
  resolveSandboxPayload,
  type SandboxPayload,
} from './sandboxPayload.js';

const KEY_B64 = randomBytes(32).toString('base64');
const KEY = parseAes256Key(KEY_B64, 'TEST_KEY');
const TOKEN = 'a'.repeat(32);

function sealed(payload: SandboxPayload, key = KEY): string {
  return encryptCredValue(JSON.stringify(payload), key);
}

/**
 * Flip a bit in the GCM auth tag of a sealed envelope.
 * ★ NOT by appending junk to the base64 — Node's decoder STOPS AT THE PADDING, so `sealed + 'TAMPER'`
 * decodes to the original bytes and verifies fine. That is the exact leniency crypto.ts's strict base64
 * validation exists to guard against; a tamper test built that way asserts nothing.
 */
function tampered(envelope: string): string {
  const bytes = Buffer.from(envelope.slice('v1:'.length), 'base64');
  bytes[bytes.length - 1] ^= 0xff;
  return `v1:${bytes.toString('base64')}`;
}

/** deps whose fetch records into a shared ordered log, so callers can assert WHEN the delete happened. */
function recordingDeps(log: string[], ciphertext: string | null) {
  return {
    fetchAndDeletePayload: async (t: string) => {
      log.push(`fetch:${t}`);
      log.push('delete'); // the real impl awaits the blob delete before returning; this stands in for it
      return ciphertext;
    },
  };
}

// ── ORDERING: delete-on-read lands BEFORE the uploaded spec executes ─────────────────────────────────────
// ★ This is the property, not an implementation detail: preview concurrency is 3 on a SHARED container, so
// a hostile spec must never be running while a neighbour's ciphertext is still resident.
test('★ the payload blob is DELETED before a single line of the uploaded spec runs', async () => {
  const log: string[] = [];
  const spec = `
    import { test } from '../../lib/flow';
    console.log('__SPEC_EXECUTED__');
    test('probe', async () => {});
  `;
  const env = { SW_SANDBOX_RESULT_TOKEN: TOKEN, SW_SANDBOX_CRED_KEY: KEY_B64 } as NodeJS.ProcessEnv;

  // Compose EXACTLY as sandboxMain does: resolve (fetch → delete → decrypt) fully, then execute.
  const resolved = await resolveSandboxPayload(env, recordingDeps(log, sealed({ spec })));
  assert.equal(resolved.source, 'payload-blob');

  const r = await runSandboxPreview(resolved.payload.spec, { targetUrl: 'https://example.com', timeoutMs: 30_000 });
  if (r.stdout.includes('__SPEC_EXECUTED__')) log.push('spec-executed');

  assert.deepEqual(log, [`fetch:${TOKEN}`, 'delete', 'spec-executed'], 'delete must precede execution');
});

// ── FAIL-CLOSED: a delete that did not land must abort the run ───────────────────────────────────────────
test('★ a payload that could not be read AND deleted FAILS the run — it never falls back to the legacy env', async () => {
  const env = {
    SW_SANDBOX_RESULT_TOKEN: TOKEN,
    SW_SANDBOX_CRED_KEY: KEY_B64,
    // Even with a perfectly good legacy spec sitting right there, the declared channel wins and fails closed:
    // falling back would execute uploaded code while the ciphertext is still resident.
    SW_SANDBOX_SPEC_B64: Buffer.from("import { test } from '../../lib/flow'; test('x', async () => {});").toString('base64'),
  } as NodeJS.ProcessEnv;

  await assert.rejects(
    () => resolveSandboxPayload(env, recordingDeps([], null)),
    /could not be read AND deleted — refusing to execute/,
    'a null fetch (absent blob OR a failed delete) must abort, not degrade to the legacy path',
  );
});

// ── THE SPLIT: neither half of the channel is sufficient on its own ──────────────────────────────────────
// ★ The whole design rests on this. The key LEAKS to execution history by construction — that is acceptable
// only because the key alone decrypts nothing, and the ciphertext alone (readable by a concurrent sandbox
// with the same MI) decrypts to nothing without the key.
test('★ the ARM-env half (key) is worthless without the blob half, and the blob half without the key', async () => {
  const payload: SandboxPayload = { spec: 'x', credentials: { password: 'hunter2-the-secret' } };
  const ciphertext = sealed(payload);

  // (a) Key alone: no ciphertext ⇒ nothing to decrypt. Modelled as an absent blob → fail-closed.
  await assert.rejects(
    () => resolveSandboxPayload({ SW_SANDBOX_RESULT_TOKEN: TOKEN, SW_SANDBOX_CRED_KEY: KEY_B64 }, recordingDeps([], null)),
    /refusing to execute/,
  );

  // (b) Ciphertext alone, under a DIFFERENT key — exactly a concurrent run reading its neighbour's blob and
  //     holding only its OWN key. AES-GCM's auth tag rejects it; the plaintext never appears.
  const neighbourKey = parseAes256Key(randomBytes(32).toString('base64'), 'OTHER');
  assert.throws(() => decodeSandboxPayload(ciphertext, neighbourKey), /unable to authenticate|auth|decrypt|tag/i);

  // (c) Both halves together — and only then — yield the payload.
  const decoded = decodeSandboxPayload(ciphertext, KEY);
  assert.equal(decoded.spec, payload.spec);
  assert.deepEqual(credentialValues(decoded.credentials), ['hunter2-the-secret']);
});

// ── SHAPE: fail-closed on anything we cannot authenticate or parse, and never echo the plaintext ─────────
test('★ decodeSandboxPayload is fail-closed and never echoes the decrypted plaintext in its error', () => {
  // Tampered envelope → the GCM auth tag rejects it (see `tampered` for why a naive append proves nothing).
  assert.throws(() => decodeSandboxPayload(tampered(sealed({ spec: 'x' })), KEY));
  // Decrypts fine but is not JSON → the message names the envelope, NOT the content.
  const notJson = encryptCredValue('SUPERSECRET-not-json', KEY);
  assert.throws(
    () => decodeSandboxPayload(notJson, KEY),
    (e: Error) => /not valid JSON/.test(e.message) && !e.message.includes('SUPERSECRET'),
  );
  // Valid JSON, no spec → named field, no content.
  assert.throws(() => decodeSandboxPayload(encryptCredValue(JSON.stringify({ credentials: { password: 'p' } }), KEY), KEY), /no `spec` string/);
  // An api that grew a fourth credential field cannot smuggle it into the child env.
  const extra = encryptCredValue(JSON.stringify({ spec: 's', credentials: { password: 'p', totpSeed: 'SMUGGLED' } }), KEY);
  assert.deepEqual(Object.keys(decodeSandboxPayload(extra, KEY).credentials!).sort(), ['bypassToken', 'password', 'username']);
  assert.ok(!credentialValues(decodeSandboxPayload(extra, KEY).credentials).includes('SMUGGLED'));
});

// ── BACKWARD COMPATIBILITY: the legacy env path still runs (PR4 removes it) ──────────────────────────────
test('★ the legacy SW_SANDBOX_SPEC_B64 path still resolves, and carries no credentials by construction', async () => {
  const spec = "import { test } from '../../lib/flow'; test('legacy', async () => {});";
  const resolved = await resolveSandboxPayload(
    { SW_SANDBOX_SPEC_B64: Buffer.from(spec).toString('base64') } as NodeJS.ProcessEnv,
    recordingDeps([], null),
  );
  assert.equal(resolved.source, 'legacy-env');
  assert.equal(resolved.payload.spec, spec);
  // ★ The legacy channel IS the leaky one — a credential must never travel on it.
  assert.equal(resolved.payload.credentials, undefined);
  assert.equal(isCredentialedRun(resolved.payload.credentials), false);
});

test('★ no channel at all → a named failure, not a silent empty run', async () => {
  await assert.rejects(() => resolveSandboxPayload({} as NodeJS.ProcessEnv, recordingDeps([], null)), /no spec/);
});

// ── THE KEY ALONE DECLARES THE CHANNEL — a config bug must not downgrade to the leaky path ──────────────
test('★ SW_SANDBOX_CRED_KEY without a RESULT_TOKEN FAILS CLOSED — it never falls back to the legacy env', async () => {
  const log: string[] = [];
  const env = {
    SW_SANDBOX_CRED_KEY: KEY_B64, // the api declared the payload channel…
    // …but omitted the token. Gating on `token && key` used to slide silently into the legacy branch here.
    SW_SANDBOX_SPEC_B64: Buffer.from("import { test } from '../../lib/flow'; test('x', async () => {});").toString('base64'),
  } as NodeJS.ProcessEnv;

  await assert.rejects(
    () => resolveSandboxPayload(env, recordingDeps(log, sealed({ spec: 'unused' }))),
    /SW_SANDBOX_RESULT_TOKEN is missing/,
    'a key without a token must abort — running the legacy spec would drop the credentials AND strand the ' +
      'ciphertext undeleted while its key sits in ACA execution history',
  );
  // ★ And it must not have gone looking for a blob it cannot name.
  assert.deepEqual(log, [], 'no fetch should be attempted without a token');
});

// ── TYPE CONFUSION: a non-string credential must not disable every protection while still being published ──
test('★ a non-string credential value is dropped, not passed through as a truthy non-string', () => {
  // The failure this pins: `{"password": 12345678}` used to survive decode as a number. credentialValues()
  // filtered it out of knownValues (it tests typeof), so isCredentialedRun() said FALSE → IDENTITY_REDACTOR,
  // raw trace, screenshot KEPT, stdout unscrubbed — while buildSandboxEnv's truthiness test still published
  // it to the spec. Every protection off, secret still handed over.
  const envelope = encryptCredValue(
    JSON.stringify({ spec: 's', credentials: { username: 'u', password: 12345678, bypassToken: { a: 1 } } }),
    KEY,
  );
  const decoded = decodeSandboxPayload(envelope, KEY);
  assert.equal(decoded.credentials?.password, undefined, 'a numeric password must not survive decode');
  assert.equal(decoded.credentials?.bypassToken, undefined, 'an object bypassToken must not survive decode');
  assert.equal(decoded.credentials?.username, 'u', 'the legitimate string field still comes through');
  // The two predicates that used to disagree now agree: only the string counts.
  assert.deepEqual(credentialValues(decoded.credentials), ['u']);
  assert.equal(isCredentialedRun(decoded.credentials), true);

  // …and when EVERY field is a non-string, the run is not credentialed at all (nothing to publish).
  const allBad = encryptCredValue(JSON.stringify({ spec: 's', credentials: { password: 42 } }), KEY);
  const d2 = decodeSandboxPayload(allBad, KEY);
  assert.deepEqual(credentialValues(d2.credentials), []);
  assert.equal(isCredentialedRun(d2.credentials), false);
});

// ── buildSandboxEnv must apply the SAME string predicate (the second lock) ───────────────────────────────
test('★ buildSandboxEnv publishes only STRING credentials — it cannot disagree with isCredentialedRun', () => {
  const env = buildSandboxEnv(
    {
      targetUrl: 'https://example.com',
      timeoutMs: 1000,
      // Deliberately cast: models a decode path that let a non-string through.
      credentials: { username: 'u', password: 99 as unknown as string, bypassToken: '' },
    },
    {} as NodeJS.ProcessEnv,
  );
  assert.equal(env.SW_SANDBOX_CRED_USERNAME, 'u');
  assert.ok(!('SW_SANDBOX_CRED_PASSWORD' in env), 'a non-string password must never reach the spec');
  assert.ok(!('SW_SANDBOX_CRED_BYPASS_TOKEN' in env), 'an empty token is not a credential');
});

// ── ★ redactCredentials: fail-SAFE normalisation (only a literal `false` disables) ──────────────────────
test('★ decodeSandboxPayload: redactCredentials defaults ON and only a literal false disables', () => {
  const key = randomBytes(32);
  const enc = (o: unknown): string => encryptCredValue(JSON.stringify(o), key);

  // Absent ⇒ ON. An api that has not shipped the field yet must not silently disable redaction.
  assert.equal(decodeSandboxPayload(enc({ spec: 'x' }), key).redactCredentials, true, 'absent ⇒ ON');
  assert.equal(decodeSandboxPayload(enc({ spec: 'x', redactCredentials: true }), key).redactCredentials, true);

  // The ONE disabling value.
  assert.equal(decodeSandboxPayload(enc({ spec: 'x', redactCredentials: false }), key).redactCredentials, false);

  // ★ FAIL-SAFE on every malformed shape — this is the type-confusion class that already bit the credential
  //   fields (a stringified "false", a 0, a null). Redaction is the protective state, so anything that is
  //   not the literal boolean false must resolve to ON. Under-redacting on a typo is unacceptable;
  //   over-redacting is merely annoying.
  for (const bad of ['false', 'FALSE', 0, null, '', [], {}] as const) {
    assert.equal(
      decodeSandboxPayload(enc({ spec: 'x', redactCredentials: bad }), key).redactCredentials, true,
      `redactCredentials: ${JSON.stringify(bad)} must fail SAFE (⇒ ON)`,
    );
  }
});
