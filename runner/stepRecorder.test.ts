// B10: a sensitive monitor's per-step error_message is SCRUBBED — sensitive VALUES (Bearer/JWT/GUID/token,
// per the monitor's redact_patterns + the builtin denylist) become <redacted>, but the DIAGNOSTIC text is
// KEPT (so the failure stays debuggable, and the RCA AI funnel still gets a real-but-scrubbed signal). A
// non-sensitive monitor is byte-for-byte unchanged (IDENTITY_REDACTOR).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { StepRecorder, type RecordedStep } from './stepRecorder.js';
import { makeRedactor, IDENTITY_REDACTOR, type Redactor } from './redact.js';
import { ExpectationError } from './errors.js';

function recorder(redact: Redactor): { rec: StepRecorder; steps: RecordedStep[] } {
  const steps: RecordedStep[] = [];
  const rec = new StepRecorder(
    1,
    null as unknown as Page,
    'about:blank',
    async (s) => {
      steps.push(s); // terminal sink: collect the finalized step
    },
    async () => {}, // running marker: no-op
    redact,
  );
  return { rec, steps };
}

test('B10: a sensitive monitor SCRUBS the token from a per-step error but KEEPS the diagnostic text', async () => {
  // the monitor's redactor (built-in denylist + check 221's declared GUID/JWT/Bearer/token patterns).
  const redact = makeRedactor([
    '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}',
    'eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+',
    '[Bb]earer\\s+[A-Za-z0-9._~+/-]+=*',
  ]);
  const { rec, steps } = recorder(redact);
  const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJndWVzdCJ9.abc123_DEF-456';
  await assert.rejects(() =>
    rec.step('load-menu', async () => {
      // a real diagnostic that ALSO echoes the guest Bearer + a session GUID.
      throw new Error(`TimeoutError: locator '.cuisine-tile' not found; req had Authorization: Bearer ${TOKEN}; sid=550e8400-e29b-41d4-a716-446655440000`);
    }),
  );
  assert.equal(steps.length, 1);
  assert.equal(steps[0].status, 'error');
  const msg = String(steps[0].errorMessage);
  // ★ diagnostic SURVIVES:
  assert.ok(msg.includes("locator '.cuisine-tile' not found"), 'the diagnostic reason is kept');
  assert.ok(msg.startsWith('TimeoutError'), 'the error class is kept');
  // ★ sensitive VALUES GONE:
  assert.ok(!msg.includes(TOKEN), 'the JWT/Bearer token is NOT present');
  assert.ok(!msg.includes('eyJ'), 'no JWT fragment survives');
  assert.ok(!msg.includes('550e8400-e29b-41d4-a716-446655440000'), 'the GUID is NOT present');
  assert.ok(msg.includes('<redacted'), 'the scrubbed value is marked <redacted>');
});

test('a non-sensitive monitor persists the REAL per-step error (byte-for-byte unchanged)', async () => {
  const { rec, steps } = recorder(IDENTITY_REDACTOR);
  await assert.rejects(() =>
    rec.step('open', async () => {
      throw new ExpectationError('boom detail');
    }),
  );
  assert.equal(steps[0].errorMessage, 'boom detail');
});
