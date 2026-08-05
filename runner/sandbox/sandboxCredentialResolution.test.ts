// ★★ THE ACCEPTANCE TEST THAT SHOULD HAVE EXISTED. The Tests area was built to preview the fleet's
// AUTHENTICATED monitors, and every one of those opens with `credential('username')` / `credential('password')`
// — so a preview in which credential() cannot resolve is a preview that cannot do the one job it exists for.
// It could not: the values reached the child only as SW_SANDBOX_CRED_* env vars, while credential() reads
// SW_CRED_<ROLE>, so a credentialed spec threw on its first line and never reached a navigation.
//
// ★ THE BAR IS NOT "the preview ran". It is: the credential RESOLVES, is USABLE (it round-trips through a real
//   form fill in a real browser), and the flow REACHES ITS FIRST NAVIGATION. A test that only asserted "no
//   throw" would pass on an empty string.
//
// ★ AND IT MUST BE ABLE TO FAIL. __unsafeSkipCredentialChannelForTest unwires the delivery, and the same spec
//   must then RED with the fail-closed refusal. A resolution test that stays green with the resolution removed
//   asserts nothing (the vacuous-check class from #279/#281).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { runSandboxPreview } from './runSandboxPreview.js';

// Distinctive and >3 chars, so makeRedactor's minimum-length rule does not silently skip them and a leak
// scan cannot collide with ordinary trace text.
const USER = `RESOLVE_USER_${randomBytes(8).toString('hex')}`;
const PASS = `RESOLVE_PASS_${randomBytes(8).toString('hex')}`;
const BYPASS = `RESOLVE_BYPASS_${randomBytes(8).toString('hex')}`;

/**
 * The spec under test — deliberately shaped like the fleet's real login specs (b2c-login-test,
 * authorized-user-add-to-cart, full-shop-flow all resolve both roles up front, then navigate).
 *
 * Its assertions are INSIDE the spec, so `status === 'pass'` is itself the proof: an unresolved credential
 * throws before step 1 completes, an EMPTY one fails the length check, and a value that did not survive the
 * channel fails the round-trip compare. Nothing is proven by a console.log alone.
 *
 * ★ The confirmation line is VALUE-FREE (lengths, not values) so it stays legible with redaction ON — this
 *   test must not need protections turned off to read its own result.
 */
const CREDENTIALED_SPEC = `
  import { test, expect, step, credential } from '../../lib/flow';
  test('authenticated preview', async ({ page }) => {
    let user = '';
    let pw = '';
    await step('resolve the credentials', async () => {
      user = credential('username');
      pw = credential('password');
      expect(user.length).toBeGreaterThan(0);
      expect(pw.length).toBeGreaterThan(0);
    });
    await step('first navigation', async () => {
      await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
      await expect(page).toHaveURL(/example\\.com/);
      console.log('REACHED_FIRST_NAVIGATION');
    });
    await step('the credential is USABLE in the browser', async () => {
      await page.setContent('<form><input id="u"><input id="p" type="password"></form>');
      await page.fill('#u', user);
      await page.fill('#p', pw);
      expect(await page.inputValue('#u')).toBe(user);
      expect(await page.inputValue('#p')).toBe(pw);
      console.log('CRED_USABLE user.len=' + user.length + ' pw.len=' + pw.length);
    });
  });
`;

// ── ★★ THE GATE ─────────────────────────────────────────────────────────────────────────────────────────
test('★★ a spec calling credential("username")/credential("password") RESOLVES them and REACHES its first navigation', async () => {
  const r = await runSandboxPreview(CREDENTIALED_SPEC, {
    targetUrl: 'https://example.com',
    timeoutMs: 90_000,
    credentials: { username: USER, password: PASS },
  });

  // The in-spec assertions are the real proof; a non-pass means one of them missed (or credential() threw).
  assert.equal(r.status, 'pass', `expected a PASS; status=${r.status} error=${r.error} stderr=${r.stderr}`);
  assert.equal(r.ok, true);

  // Named checkpoints, so a failure says WHICH stage regressed rather than "it didn't pass".
  assert.ok(r.stdout.includes('REACHED_FIRST_NAVIGATION'), '★ the flow must reach its FIRST NAVIGATION');
  assert.ok(r.stdout.includes('CRED_USABLE'), '★ the credential must be USABLE, not merely non-throwing');
  assert.ok(
    r.stdout.includes(`user.len=${USER.length}`) && r.stdout.includes(`pw.len=${PASS.length}`),
    '★ the values that arrived must be the FULL typed values, not truncated or empty',
  );

  // All three steps ran and passed — nothing was skipped past.
  const steps = r.steps ?? [];
  assert.deepEqual(
    steps.map((s) => s.name),
    ['resolve the credentials', 'first navigation', 'the credential is USABLE in the browser'],
  );
  assert.ok(steps.every((s) => s.status === 'pass'), `every step must pass: ${JSON.stringify(steps)}`);

  // ★ Redaction is ON by default for a credentialed run and stays on — resolution did not cost protection.
  //   (The full sentinel sweep lives in sandboxCredentialRedaction.test.ts; this is the guard against
  //   "we made it resolve by turning the sensitive treatment off".)
  for (const surface of [r.stdout, r.stderr, r.error ?? '', JSON.stringify(r.steps ?? [])]) {
    assert.ok(!surface.includes(USER), 'the username must still be scrubbed from preview output');
    assert.ok(!surface.includes(PASS), 'the password must still be scrubbed from preview output');
  }
});

// ── ★★ PROVE-CAN-FAIL: unwire the resolution, the SAME spec must RED with the refusal ───────────────────
test('★★ PROVE-CAN-FAIL: with the credential channel unwired the same spec REDS with the fail-closed refusal', async () => {
  const r = await runSandboxPreview(CREDENTIALED_SPEC, {
    targetUrl: 'https://example.com',
    timeoutMs: 90_000,
    credentials: { username: USER, password: PASS },
    // Credentials are still supplied — ONLY the delivery is removed. So this isolates the wiring, not the input.
    __unsafeSkipCredentialChannelForTest: true,
    // ★ Redaction OFF so the refusal MESSAGE is readable verbatim. The message is value-free by construction
    //   (it names roles, never values), so nothing is exposed by reading it raw — and with redaction on, a
    //   role name that happened to be a substring of a credential could be scrubbed and mask the assertion.
    redactCredentials: false,
  });

  assert.notEqual(r.status, 'pass', '★ THE GATE IS VACUOUS: the spec passed with the credential channel UNWIRED');
  assert.ok(
    !r.stdout.includes('REACHED_FIRST_NAVIGATION'),
    '★ THE GATE IS VACUOUS: the flow reached its navigation without any credential being delivered',
  );
  const text = `${r.error ?? ''}\n${r.stdout}\n${r.stderr}\n${JSON.stringify(r.steps ?? [])}`;
  assert.match(text, /credential\("username"\) is not available/, 'the refusal must name the role');
  assert.match(text, /preview\/sandbox run/, 'and identify it as a preview miss, not a live-run misconfiguration');
});

// ── FAIL-CLOSED: a preview with NO credentials still refuses, with a message that says what to do ────────
test('★ a preview with NO credentials supplied still throws the clear fail-closed refusal', async () => {
  const r = await runSandboxPreview(CREDENTIALED_SPEC, { targetUrl: 'https://example.com', timeoutMs: 90_000 });

  assert.notEqual(r.status, 'pass', 'an uncredentialed preview of a credentialed spec must not pass');
  const text = `${r.error ?? ''}\n${r.stdout}\n${r.stderr}\n${JSON.stringify(r.steps ?? [])}`;
  assert.match(text, /credential\("username"\) is not available/);
  assert.match(text, /no credentials were supplied/, 'it must say the preview supplied none…');
  assert.match(text, /Credentials panel of the Tests area/, '…and where to type them');
  // ★ It must NOT still claim the sandbox can never receive credentials — that was true before this wiring
  //   and is now false; leaving it would send an operator to a LIVE run they no longer need.
  assert.ok(!/never receives SW_CRED/.test(text), 'the stale "the sandbox never receives credentials" claim must be gone');
});

// ── A ROLE THE UI DOES NOT COLLECT: named, not silently empty ────────────────────────────────────────────
test('★ an unknown role refuses with a message naming what WAS supplied (roles only, never values)', async () => {
  const spec = `
    import { test, credential } from '../../lib/flow';
    const totp = credential('totp');
    test('never reached', async () => {});
  `;
  const r = await runSandboxPreview(spec, {
    targetUrl: 'https://example.com',
    timeoutMs: 60_000,
    credentials: { username: USER, password: PASS },
    redactCredentials: false, // read the message verbatim; it is value-free by construction
  });

  const text = `${r.error ?? ''}\n${r.stdout}\n${r.stderr}`;
  assert.match(text, /credential\("totp"\) is not available/);
  assert.match(text, /supplied \[username, password\]/, 'the miss must say which roles DID arrive');
  // ★ The diagnostic names ROLES. If it ever started echoing values this would catch it.
  assert.ok(!text.includes(USER) && !text.includes(PASS), 'the diagnostic must never carry a credential VALUE');
});

// ── ★ THE ISOLATION PROPERTY THE STDIN CHANNEL BOUGHT ────────────────────────────────────────────────────
test('★ credentials resolve in-process and appear NOWHERE in the child process.env', async () => {
  const dump = `
    import { test, credential } from '../../lib/flow';
    const u = credential('username');
    const p = credential('password');
    const b = credential('bypassToken');
    console.log('__RESOLVED__' + [u.length, p.length, b.length].join(','));
    console.log('__ENVDUMP__' + JSON.stringify(process.env));
    test('probe', async () => {});
  `;
  // ★ REDACTION OFF, DELIBERATELY. With it on, the redactor would scrub any credential found in the env dump
  //   and this test would report CLEAN on a leak it was staring at — the exact vacuity class the sentinel
  //   suite exists to prevent. Absence must be proven against RAW output.
  const r = await runSandboxPreview(dump, {
    targetUrl: 'https://example.com',
    timeoutMs: 60_000,
    credentials: { username: USER, password: PASS, bypassToken: BYPASS },
    redactCredentials: false,
  });

  // NON-VACUITY: all three really resolved, so "absent from env" is a contrast and not a spec that never ran.
  assert.ok(
    r.stdout.includes(`__RESOLVED__${USER.length},${PASS.length},${BYPASS.length}`),
    `all three roles must have resolved in-process; stdout=${r.stdout.slice(0, 400)} stderr=${r.stderr}`,
  );

  const line = r.stdout.split('\n').find((l) => l.startsWith('__ENVDUMP__'));
  assert.ok(line, 'the spec printed its env');
  const childEnv = JSON.parse(line!.slice('__ENVDUMP__'.length)) as Record<string, string>;

  // (a) By VALUE — catches a publication under any name, including a renamed or derived one.
  for (const [label, value] of [['username', USER], ['password', PASS], ['bypassToken', BYPASS]] as const) {
    for (const [k, v] of Object.entries(childEnv)) {
      assert.ok(!String(v).includes(value), `LEAK: the ${label} is in the child env as ${k}`);
    }
  }
  // (b) By NAME — the two namespaces that must never carry a preview credential.
  for (const k of Object.keys(childEnv)) {
    assert.ok(!k.startsWith('SW_CRED_'), `LEAK: ${k} — the fleet credential namespace must be empty in a preview`);
    assert.ok(!k.startsWith('SW_SANDBOX_CRED_'), `LEAK: ${k} — credentials travel on stdin, not the env`);
  }
  // (c) VERCEL_BYPASS_TOKEN specifically: the user's typed token must NOT be published under the platform
  //     secret's name. That name is on PROD_SECRET_ENV_NAMES and sandboxIsolation.test.ts asserts its absence;
  //     satisfying a spec by occupying it would have quietly retired a passing security assertion.
  assert.ok(!('VERCEL_BYPASS_TOKEN' in childEnv), 'the user token must not occupy the platform secret name');
});

// ── UNCREDENTIALED RUNS ARE BIT-FOR-BIT UNCHANGED (pass-1 behaviour preserved) ───────────────────────────
test('★ an uncredentialed preview is unaffected — no credential machinery touches it', async () => {
  const plain = `
    import { test, step, expect } from '../../lib/flow';
    test('plain', async ({ page }) => {
      await step('open the page', async () => { await page.goto('https://example.com', { waitUntil: 'domcontentloaded' }); });
      await step('assert the URL', async () => { await expect(page).toHaveURL(/example\\.com/); });
    });
  `;
  const r = await runSandboxPreview(plain, { targetUrl: 'https://example.com', timeoutMs: 60_000 });

  assert.equal(r.status, 'pass', `stderr=${r.stderr}`);
  assert.ok(r.trace && r.trace.byteLength > 0, 'still keeps its raw trace');
  assert.ok(!r.stdout.includes('<redacted>'), 'still redacts nothing');
});
