// B10 redaction + artifact-persistence policy (pure, no DB/browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRedactor,
  IDENTITY_REDACTOR,
  tracePersistPlan,
  sensitiveErrorMessage,
  scrubError,
} from './redact.js';

// ── the redactor: built-in token denylist (always on for sensitive) ──────────────────────────────
test('redactor scrubs the VALUE of auth/session query params (keeps the key)', () => {
  const r = makeRedactor(null);
  assert.equal(
    r('https://x.com/cart?session=abc123XYZ&qty=2'),
    'https://x.com/cart?session=<redacted>&qty=2',
    'session token value redacted; qty untouched',
  );
  assert.equal(r('/a?access_token=TOK&b=1'), '/a?access_token=<redacted>&b=1');
  assert.equal(r('/a?csrf_token=zzz'), '/a?csrf_token=<redacted>');
});

test('redactor scrubs a JWT and a Bearer token anywhere', () => {
  const r = makeRedactor(null);
  assert.equal(
    r('auth header eyJhbG.eyJzdWI.sIgNaTuRe done'),
    'auth header <redacted-jwt> done',
  );
  assert.equal(r('Authorization: Bearer abc.def-123'), 'Authorization: Bearer <redacted>');
});

test('redactor applies DECLARED patterns on top of the denylist', () => {
  const r = makeRedactor(['member-\\d+', 'loyalty=[A-Z0-9]+']);
  assert.equal(r('user member-4821 has loyalty=GOLD7'), 'user <redacted> has <redacted>');
  // denylist still applies alongside declared patterns:
  assert.equal(r('?token=X member-9'), '?token=<redacted> <redacted>');
});

test('an INVALID declared regex is skipped (non-fatal), the rest still apply', () => {
  const r = makeRedactor(['(', 'secretword']); // '(' is an invalid regex
  assert.equal(r('a secretword b'), 'a <redacted> b');
});

// ── #232 defect-2: KNOWN VALUES registered as escaped-literal rules (the bare typed credential) ──────
test('redactor scrubs a registered known VALUE wherever it appears (bare, not just key=value)', () => {
  const r = makeRedactor(null, ['hunter2pass', 'alice@test.com']);
  // bare in an error_message / console line — what the declared session-token patterns MISS
  assert.equal(r('TimeoutError: expected input to equal hunter2pass'), 'TimeoutError: expected input to equal <redacted>');
  assert.equal(r('login as alice@test.com failed'), 'login as <redacted> failed');
});

test('known-value registration escapes regex-special chars (no pattern injection / no crash)', () => {
  const r = makeRedactor(null, ['a.b*c(d)']); // regex-special value must match literally
  assert.equal(r('got a.b*c(d) here'), 'got <redacted> here');
  assert.equal(r('got aXbYcZdZ here'), 'got aXbYcZdZ here'); // NOT treated as a regex
});

test('known values: empty/short (<3) are skipped so a stray char cannot over-redact', () => {
  const r = makeRedactor(null, ['', 'ab', 'realvalue']);
  assert.equal(r('ab realvalue ab'), 'ab <redacted> ab'); // 'ab' (len 2) not registered; 'realvalue' is
});

test('known values compose with declared patterns + denylist', () => {
  const r = makeRedactor(['member-\\d+'], ['topsecret']);
  assert.equal(r('member-7 typed topsecret with ?token=X'), '<redacted> typed <redacted> with ?token=<redacted>');
});

test('IDENTITY_REDACTOR is a no-op (non-sensitive monitors are byte-for-byte unchanged)', () => {
  const s = 'https://x.com/cart?session=abc123&token=zzz';
  assert.equal(IDENTITY_REDACTOR(s), s);
});

// ── the artifact-persistence plan: a SENSITIVE monitor persists NO trace artifacts ───────────────
test('tracePersistPlan: a sensitive monitor persists NOTHING, any status', () => {
  for (const status of ['fail', 'error', 'pass', 'warn'] as const) {
    assert.deepEqual(tracePersistPlan(true, status), {
      failureTrace: false,
      successBaseline: false,
      failureScreenshot: false,
      baselineScreenshot: false,
    }, `sensitive + ${status} → no zips, no screenshots`);
  }
});

test('tracePersistPlan: a NON-sensitive monitor follows the normal status rules (unchanged)', () => {
  assert.deepEqual(tracePersistPlan(false, 'fail'), {
    failureTrace: true, successBaseline: false, failureScreenshot: true, baselineScreenshot: false,
  });
  assert.deepEqual(tracePersistPlan(false, 'error'), {
    failureTrace: true, successBaseline: false, failureScreenshot: true, baselineScreenshot: false,
  });
  assert.deepEqual(tracePersistPlan(false, 'pass'), {
    failureTrace: false, successBaseline: true, failureScreenshot: false, baselineScreenshot: true,
  });
  assert.deepEqual(tracePersistPlan(false, 'warn'), {
    failureTrace: false, successBaseline: true, failureScreenshot: false, baselineScreenshot: false,
  });
});

test('sensitiveErrorMessage keeps only the safe status + static step name', () => {
  assert.equal(
    sensitiveErrorMessage('fail', 'open the product'),
    'fail at step "open the product" — error details redacted (sensitive monitor)',
  );
  assert.equal(sensitiveErrorMessage('error', null), 'error — error details redacted (sensitive monitor)');
});

// ── scrubError: the run-level error_message fix — scrub VALUES, keep diagnostic text ───────────────
test('★ scrubError keeps the failure reason but <redacted>s a Bearer/JWT/GUID in the error', () => {
  const redact = makeRedactor([
    '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}',
    'eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+',
    '[Bb]earer\\s+[A-Za-z0-9._~+/-]+=*',
  ]);
  const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJndWVzdCJ9.abc123_DEF-456';
  const out = scrubError(
    redact,
    'error',
    'load-menu',
    `Error: Cannot find module './meals2go-browse-menu.js'; Authorization: Bearer ${TOKEN}; sid=550e8400-e29b-41d4-a716-446655440000`,
  );
  // ★ real failure reason VISIBLE:
  assert.ok(out.includes("Cannot find module './meals2go-browse-menu.js'"), 'the diagnostic reason survives');
  // ★ sensitive values GONE:
  assert.ok(!out.includes(TOKEN) && !out.includes('eyJ'), 'no JWT/Bearer token survives');
  assert.ok(!out.includes('550e8400-e29b-41d4-a716-446655440000'), 'no GUID survives');
  assert.ok(out.includes('<redacted'), 'scrubbed values are marked <redacted>');
});

test('scrubError falls back to the generic placeholder ONLY when scrubbing leaves nothing readable', () => {
  // a message that is ENTIRELY a token → scrub empties it → fallback keeps status + failedStep.
  const redact = makeRedactor(['eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+']);
  const out = scrubError(redact, 'error', 'login', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig_TOKEN');
  assert.equal(out, 'error at step "login" — error details redacted (sensitive monitor)');
});

test('scrubError on a NON-sensitive identity redactor is a no-op pass-through', () => {
  assert.equal(scrubError(IDENTITY_REDACTOR, 'error', null, 'plain diagnostic'), 'plain diagnostic');
});
