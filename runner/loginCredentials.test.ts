// Unit tests for the per-monitor login-credentials MODEL B (0068): the leaf is CIPHERTEXT (CredCrypto v1),
// decrypted at run time with CRED_ENC_KEY — fail-CLOSED on a bad key / corrupt / legacy-ref leaf. Plus the
// per-run SW_CRED_<ROLE> publish/clear lifecycle and the shim's credential() accessor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveLoginCredentials,
  applyLoginCredentials,
  clearLoginCredentials,
  credentialEnvKey,
  redactableCredValues,
  CRED_USERNAME_CLEARTEXT_ALLOWANCE,
} from './loginCredentials.js';
import { credential } from './specfetch/specShim.js';
import { setSpecCredentials, __clearSpecCredentialsForTest } from './specfetch/specCredentials.js';
import { encryptCredValue, loadCredEncKey } from './crypto.js';
import { makeRedactor, MARKER_USERNAME } from './redact.js';

const TEST_KEY_B64 = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64');
const TOUCHED = ['CRED_ENC_KEY', 'SW_CRED_USERNAME', 'SW_CRED_PASSWORD', 'SW_SANDBOX'];
function snapshot(): Record<string, string | undefined> {
  const s: Record<string, string | undefined> = {};
  for (const k of TOUCHED) s[k] = process.env[k];
  return s;
}
function restoreEnv(saved: Record<string, string | undefined>) {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}
/** Encrypt a plaintext under the test key → the "v1:…" ciphertext the DB column would hold. */
function enc(plaintext: string): string {
  return encryptCredValue(plaintext, loadCredEncKey({ CRED_ENC_KEY: TEST_KEY_B64 }));
}

test('credentialEnvKey: role -> SW_CRED_<UPPER>', () => {
  assert.equal(credentialEnvKey('username'), 'SW_CRED_USERNAME');
  assert.equal(credentialEnvKey('password'), 'SW_CRED_PASSWORD');
});

test('resolveLoginCredentials: DECRYPTS each ciphertext leaf', () => {
  const saved = snapshot();
  try {
    process.env.CRED_ENC_KEY = TEST_KEY_B64;
    const out = resolveLoginCredentials({ username: enc('alice@test'), password: enc('hunter2') });
    assert.deepEqual(out, { username: 'alice@test', password: 'hunter2' });
  } finally {
    restoreEnv(saved);
  }
});

test('resolveLoginCredentials: FAIL-CLOSED on a leaf that is not v1 ciphertext (e.g. a legacy ref-name)', () => {
  const saved = snapshot();
  try {
    process.env.CRED_ENC_KEY = TEST_KEY_B64;
    // A bare env-var ref-name (legacy model-A shape), not "v1:" ciphertext → decrypt throws → resolve throws.
    assert.throws(() => resolveLoginCredentials({ username: 'LEGACY_ENV_REF' }), /did not decrypt/);
  } finally {
    restoreEnv(saved);
  }
});

test('resolveLoginCredentials: FAIL-CLOSED when CRED_ENC_KEY is absent (has values)', () => {
  const saved = snapshot();
  try {
    delete process.env.CRED_ENC_KEY;
    assert.throws(() => resolveLoginCredentials({ username: 'v1:whatever' }), /CRED_ENC_KEY is not set/);
  } finally {
    restoreEnv(saved);
  }
});

test('resolveLoginCredentials: null/empty -> {} (no key required)', () => {
  const saved = snapshot();
  try {
    delete process.env.CRED_ENC_KEY; // no key needed when there are no values
    assert.deepEqual(resolveLoginCredentials(null), {});
    assert.deepEqual(resolveLoginCredentials(undefined), {});
    assert.deepEqual(resolveLoginCredentials({}), {});
  } finally {
    restoreEnv(saved);
  }
});

test('applyLoginCredentials publishes decrypted SW_CRED_<ROLE>; clearLoginCredentials removes them', () => {
  const saved = snapshot();
  try {
    process.env.CRED_ENC_KEY = TEST_KEY_B64;
    const handles = applyLoginCredentials({ username: enc('alice@test'), password: enc('hunter2') });
    assert.deepEqual(handles.map((h) => h.key).sort(), ['SW_CRED_PASSWORD', 'SW_CRED_USERNAME']);
    assert.equal(process.env.SW_CRED_USERNAME, 'alice@test');
    assert.equal(process.env.SW_CRED_PASSWORD, 'hunter2');
    clearLoginCredentials(handles); // ★ decrypted secret never lingers past the run
    assert.equal(process.env.SW_CRED_USERNAME, undefined);
    assert.equal(process.env.SW_CRED_PASSWORD, undefined);
  } finally {
    restoreEnv(saved);
  }
});

test('applyLoginCredentials: no values -> sets nothing, returns []', () => {
  assert.deepEqual(applyLoginCredentials(null), []);
});

test('clearLoginCredentials RESTORES a pre-existing SW_CRED_ value (not a blind delete)', () => {
  const saved = snapshot();
  try {
    process.env.CRED_ENC_KEY = TEST_KEY_B64;
    process.env.SW_CRED_USERNAME = 'preexisting'; // reserved-namespace collision (documented off-limits)
    const handles = applyLoginCredentials({ username: enc('alice@test') });
    assert.equal(process.env.SW_CRED_USERNAME, 'alice@test'); // overwritten for the run
    clearLoginCredentials(handles);
    assert.equal(process.env.SW_CRED_USERNAME, 'preexisting'); // ★ restored, not deleted
  } finally {
    restoreEnv(saved);
  }
});

test('credential(role): returns the published (decrypted) value; throws fail-closed when unpublished', () => {
  const saved = snapshot();
  try {
    process.env.CRED_ENC_KEY = TEST_KEY_B64;
    const handles = applyLoginCredentials({ username: enc('alice@test') });
    assert.equal(credential('username'), 'alice@test');
    clearLoginCredentials(handles);
    // ★ model-B message (NOT the stale model-A "role -> ENV_VAR_NAME / set an env var on the runner"): a live-run
    //   miss points the operator at login_credentials + the dashboard Credentials panel, and states the runner
    //   publishes SW_CRED_<ROLE> automatically.
    assert.throws(() => credential('username'), /credential\("username"\) is not available/);
    assert.throws(() => credential('username'), /login_credentials\.username .* dashboard Credentials panel/);
    assert.throws(() => credential('username'), /publishes SW_CRED_USERNAME automatically/);
    let msg = '';
    try { credential('username'); } catch (e) { msg = (e as Error).message; }
    assert.ok(!/ENV_VAR_NAME/.test(msg), 'live message must not carry the stale model-A ENV_VAR_NAME language');
    assert.ok(!/env var must be set on the runner/.test(msg), 'live message must not tell the operator to set a runner env var');
  } finally {
    restoreEnv(saved);
  }
});

test('★ credential(role): the SANDBOX miss says NO CREDENTIALS WERE SUPPLIED, not "set an env var"', () => {
  // ★ CHANGED. The message used to say the sandbox "never receives SW_CRED_*" and to send the operator to a
  //   LIVE run. That is no longer true: a preview now delivers the user's typed credentials in-process
  //   (specCredentials.ts), so a miss means they typed NONE — an actionable, fixable-here condition. Keeping
  //   the old wording would have told an operator to go do a live deploy to work around a blank text field.
  const saved = snapshot();
  try {
    delete process.env.SW_CRED_USERNAME; // ensure unpublished
    process.env.SW_SANDBOX = '1';
    __clearSpecCredentialsForTest(); // and nothing installed in-process either
    let msg = '';
    try { credential('username'); } catch (e) { msg = (e as Error).message; }
    assert.match(msg, /credential\("username"\) is not available/);
    assert.match(msg, /preview\/sandbox run/);
    assert.match(msg, /no credentials were supplied/);
    assert.match(msg, /Credentials panel of the Tests area/);
    assert.ok(!/never receives SW_CRED_\*/.test(msg), 'the stale "creds never arrive in a preview" claim must be gone');
    assert.ok(!/ENV_VAR_NAME/.test(msg), 'sandbox message must not carry the stale model-A ENV_VAR_NAME language');
  } finally {
    __clearSpecCredentialsForTest();
    restoreEnv(saved);
  }
});

// ── ★ credential() resolves from the IN-PROCESS store in a preview — the unit-level half of the gate ─────
// The end-to-end proof (a real spec, a real browser, reaching its first navigation) is
// sandbox/sandboxCredentialResolution.test.ts. These pin the accessor's own contract.
test('★ credential(role): a PREVIEW resolves from the in-process store — with NOTHING in process.env', () => {
  const saved = snapshot();
  try {
    delete process.env.SW_CRED_USERNAME;
    delete process.env.SW_CRED_PASSWORD;
    process.env.SW_SANDBOX = '1';
    setSpecCredentials({ username: 'typed-user', password: 'typed-pass', bypassToken: 'typed-bypass' });

    assert.equal(credential('username'), 'typed-user');
    assert.equal(credential('password'), 'typed-pass');
    assert.equal(credential('bypassToken'), 'typed-bypass');
    // Case-insensitive, exactly as the fleet path is (SW_CRED_<ROLE.toUpperCase()>).
    assert.equal(credential('USERNAME'), 'typed-user');
    assert.equal(credential('BypassToken'), 'typed-bypass');

    // ★ THE POINT: resolution happened with the credential in NO environment variable, under any name.
    for (const [k, v] of Object.entries(process.env)) {
      assert.ok(!String(v).includes('typed-pass'), `the password must not be in process.env (found at ${k})`);
    }
    assert.equal(process.env.SW_CRED_USERNAME, undefined);
  } finally {
    __clearSpecCredentialsForTest();
    restoreEnv(saved);
  }
});

test('★ credential(role): an EMPTY typed value is NOT a credential — it fails closed, never returns ""', () => {
  // A blank field must not be submitted to a login form as an empty string; it must throw like an absent one.
  const saved = snapshot();
  try {
    delete process.env.SW_CRED_PASSWORD;
    process.env.SW_SANDBOX = '1';
    setSpecCredentials({ username: 'typed-user', password: '' });
    assert.throws(() => credential('password'), /credential\("password"\) is not available/);
    // …and the diagnostic names the roles that DID arrive, so the operator sees which field they left blank.
    let msg = '';
    try { credential('password'); } catch (e) { msg = (e as Error).message; }
    assert.match(msg, /supplied \[username\]/);
  } finally {
    __clearSpecCredentialsForTest();
    restoreEnv(saved);
  }
});

test('★ credential(role): the FLEET path is unchanged — env wins and the store is empty in the runner', () => {
  const saved = snapshot();
  try {
    process.env.CRED_ENC_KEY = TEST_KEY_B64;
    delete process.env.SW_SANDBOX;
    __clearSpecCredentialsForTest(); // the live runner never calls setSpecCredentials
    const handles = applyLoginCredentials({ username: enc('alice@test') });
    assert.equal(credential('username'), 'alice@test'); // resolved from SW_CRED_USERNAME, as always
    clearLoginCredentials(handles);
  } finally {
    restoreEnv(saved);
  }
});

// ── ★ the username cleartext allowance is PER-CHECK (was global) ────────────────────────────────────
// The exemption's premise — "a shop-flow TEST-ACCOUNT username is a login identifier, not a secret" —
// holds for a dedicated throwaway account and FAILS for a named person's corporate address. A global set
// could not tell those apart, so the named-employee address sat in cleartext across ~937 retained trace
// zips. It is now keyed off checks.source_key, defaulting to REDACT, with a distinct MARKER_USERNAME so
// the login debuggability the exemption bought is not silently lost.

const ALLOWED_KEY = 'wegmans-authorized-user-add-to-cart'; // verified throwaway account
const DENIED_KEY = 'wegmans-full-shop-flow'; // named employee's corporate address

test('redactableCredValues: password is ALWAYS registered with the generic marker', () => {
  for (const key of [ALLOWED_KEY, DENIED_KEY, undefined, null]) {
    const vals = redactableCredValues({ password: 'sup3r-secret-pw' }, key);
    assert.deepEqual(vals, ['sup3r-secret-pw'], `password must be redactable for source_key=${String(key)}`);
  }
});

test('redactableCredValues: ALLOWED check leaves the username in cleartext (unregistered)', () => {
  const vals = redactableCredValues({ username: 'sreordertest@gmail.test', password: 'pw-secret' }, ALLOWED_KEY);
  assert.deepEqual(vals, ['pw-secret'], 'username must NOT be registered for an allowance-granted check');
});

test('redactableCredValues: DENIED check registers the username under MARKER_USERNAME', () => {
  // Order is irrelevant (makeRedactor sorts by value length), so assert on membership.
  const vals = redactableCredValues({ username: 'a.person@wegmans.test', password: 'pw-secret' }, DENIED_KEY);
  assert.equal(vals.length, 2);
  assert.ok(vals.includes('pw-secret'), 'password registered with the generic marker');
  assert.deepEqual(
    vals.find((v) => typeof v === 'object'),
    { value: 'a.person@wegmans.test', marker: MARKER_USERNAME },
  );
});

test('redactableCredValues: fail-CLOSED — an unlisted or NULL source_key redacts the username', () => {
  for (const key of ['some-other-monitor', undefined, null]) {
    const vals = redactableCredValues({ username: 'a@test.example', password: 'pw-secret' }, key);
    assert.ok(
      vals.some((v) => typeof v === 'object' && v.value === 'a@test.example'),
      `username must be REDACTED by default for source_key=${String(key)}`,
    );
  }
  // Only the one verified-throwaway monitor holds the allowance today.
  assert.deepEqual([...CRED_USERNAME_CLEARTEXT_ALLOWANCE], [ALLOWED_KEY]);
});

test('redactableCredValues: role match is case-insensitive; unknown roles stay generic (fail-closed)', () => {
  const vals = redactableCredValues({ Username: 'a@test.example', password: 'pw-secret', totpSecret: 'otp-secret' }, DENIED_KEY);
  assert.ok(
    vals.some((v) => typeof v === 'object' && v.value === 'a@test.example'),
    'Username (any case) is the identifier role → marked, not generic',
  );
  assert.ok(vals.includes('pw-secret'), 'password stays redactable');
  assert.ok(vals.includes('otp-secret'), 'an UNKNOWN role defaults to redactable (fail-closed)');
});

test('through makeRedactor: DENIED check scrubs the username to a DISTINCT marker (must-go-red both ways)', () => {
  const resolved = { username: 'a.person@wegmans.test', password: 'sup3r-secret-pw' };
  const src = 'shop-flow login: entered username a.person@wegmans.test with password sup3r-secret-pw';

  const denied = makeRedactor(null, redactableCredValues(resolved, DENIED_KEY))(src);
  assert.doesNotMatch(denied, /a\.person@wegmans\.test/, 'the employee address MUST NOT survive — the whole point');
  assert.doesNotMatch(denied, /sup3r-secret-pw/, 'password value MUST still be scrubbed');
  assert.match(denied, /<redacted-username>/, 'the username is scrubbed-but-PRESENT (debuggability preserved)');
  assert.match(denied, /<redacted>/, 'the password took the generic marker');

  // The other direction: the allowance really does still produce cleartext, so the marker above is the
  // per-check branch doing work and not a blanket change.
  const allowed = makeRedactor(null, redactableCredValues(resolved, ALLOWED_KEY))(src);
  assert.match(allowed, /a\.person@wegmans\.test/, 'an allowance-granted check keeps the username visible');
  assert.doesNotMatch(allowed, /<redacted-username>/, 'and emits no username marker');
});

test('the two markers are DISTINGUISHABLE — a username scrub is never confused with a secret scrub', () => {
  const redact = makeRedactor(null, redactableCredValues({ username: 'u@test.example', password: 'pw-secret' }, DENIED_KEY));
  const out = redact('user=u@test.example pass=pw-secret');
  assert.equal(out, 'user=<redacted-username> pass=<redacted>');
});

test('no regression: cookies / authorization / session tokens still redacted (built-in key rules intact)', () => {
  // The username handling only affects the credential-VALUE literal set; the built-in key-shape denylist
  // (cookie/authorization/token=/session_id=/jwt=…) is untouched.
  const redact = makeRedactor(null, redactableCredValues({ username: 'shopflow@wegmans.test', password: 'pw-secret' }, ALLOWED_KEY));
  const s = redact('set-cookie: session=abc123deadbeef; authorization: Bearer eyJraeReallyLongTokenValue; token=zzz9secret9value');
  assert.doesNotMatch(s, /abc123deadbeef/, 'session cookie value still redacted');
  assert.doesNotMatch(s, /eyJraeReallyLongTokenValue/, 'bearer token still redacted');
  assert.doesNotMatch(s, /zzz9secret9value/, 'token= value still redacted');
});

test('a marker containing $ cannot act as a String.replace substitution pattern', () => {
  // Defensive: markers are our own constants today, but makeRedactor now takes them from callers.
  const redact = makeRedactor(null, [{ value: 'secret-value', marker: '<$&$1>' }]);
  assert.equal(redact('x secret-value y'), 'x <$&$1> y');
});
