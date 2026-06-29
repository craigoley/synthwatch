// B10 redaction + artifact-persistence policy (pure, no DB/browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRedactor,
  IDENTITY_REDACTOR,
  tracePersistPlan,
  sensitiveErrorMessage,
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
