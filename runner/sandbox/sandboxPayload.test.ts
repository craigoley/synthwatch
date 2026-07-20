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
