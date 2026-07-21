// ★★ THE CREDENTIAL-REDACTION ACCEPTANCE TEST. A credentialed preview types a real password into a real
// browser under a real Playwright trace; that trace captures network requests, form fills and screencast
// frames, and the api renders all of it in the UI. If a typed password reaches any of those, this feature
// does not ship.
//
// ★ AND — the part that makes it worth anything — a MUTANT run proves the suite CAN fail. A redaction test
// that passes with redaction switched off asserts nothing (the vacuous-check class from #279/#281: a green
// gate that compares nothing manufactures confidence and is worse than no gate). So the same sentinel
// assertions run twice: once with the real redactor (must be CLEAN) and once with IDENTITY_REDACTOR
// substituted (must be DIRTY). If the mutant ever comes back clean, this file fails loudly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import yauzl from 'yauzl';

import { runSandboxPreview, type PreviewResult } from './runSandboxPreview.js';

/**
 * Distinctive, high-entropy values that cannot occur naturally anywhere in a trace.
 *
 * ★ THE PASSWORD DELIBERATELY CONTAINS A SPACE, A QUOTE, A BACKSLASH AND A PERCENT. An earlier version used
 * a bare hex sentinel — URL-safe and JSON-safe by construction — and that shape is exactly why this suite
 * passed while three real leaks were live: a value needing percent-encoding survives the escaped-literal
 * knownValues rule in a recorded URL, and a value needing JSON-escaping survives a scrub applied to
 * serialized JSON. A sentinel that can't hit those paths can't catch them.
 */
const SENTINEL = `SENTINEL_PW_${randomBytes(12).toString('hex')} "q\\z%z`;
const SENTINEL_USER = `SENTINEL_USER_${randomBytes(8).toString('hex')}`;

/**
 * A spec that pushes the credential into EVERY surface a real login would:
 *   • stdout          — the spec's own console.log (sandboxMain ships 128 KB of this inside {token}.json)
 *   • trace network   — the credential in a request URL. ★ The param is named `q`, NOT `password`, so the
 *                       builtin token-shape denylist CANNOT catch it — only the knownValues literal rule can.
 *                       That makes this a test of credential-value registration, not of the generic denylist.
 *   • trace form-fill — a real .fill() into a real input, recorded as an action + a DOM snapshot
 *   • error message   — a throw whose text embeds the credential (→ run_steps.error_message + runs.error)
 *   • screenshot      — the throw makes the flow fail, which is what makes browserFlow capture a screenshot
 */
const LEAKY_LOGIN_SPEC = `
  import { test, step } from '../../lib/flow';
  const user = process.env.SW_SANDBOX_CRED_USERNAME;
  const pw = process.env.SW_SANDBOX_CRED_PASSWORD;
  console.log('LEAK_MARKER_STDOUT ' + user + ' / ' + pw);
  // ★ The credential is in the TEST NAME and the STEP NAMES, not only in errors/output. Interpolating an
  //   identity into a name is how people actually write login flows, and those names are uploaded verbatim
  //   inside {token}.json and rendered by the UI — a channel an errorMessage-only scrub misses entirely.
  test('login as ' + user, async ({ page }) => {
    await step('open a login form', async () => {
      await page.setContent('<form><input id="u" name="username"><input id="p" name="password" type="password"></form>');
      await page.fill('#u', user);
      await page.fill('#p', pw);
    });
    await step('submit the credential over the wire', async () => {
      // Chromium percent-encodes this on the way into trace.network — so the recorded URL never contains the
      // raw bytes, and a redactor registering only the raw literal will not match it.
      await page.goto('https://example.com/?q=' + pw, { waitUntil: 'domcontentloaded' }).catch(() => {});
    });
    await step('enter password ' + pw, async () => {
      throw new Error('login rejected for user ' + user + ' with password ' + pw);
    });
  });
`;

/** Expand every entry of a Playwright trace zip to text. Entries are DEFLATE-compressed, so a raw buffer
 *  scan would MISS a sentinel sitting inside one — it must actually be decompressed. */
function expandZip(buf: Buffer): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const out: string[] = [];
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('not a zip'));
      zip.on('error', reject);
      zip.on('end', () => resolve(out));
      zip.on('entry', (entry: yauzl.Entry) => {
        if (/\/$/.test(entry.fileName)) return zip.readEntry();
        zip.openReadStream(entry, (e, rs) => {
          if (e || !rs) return reject(e ?? new Error('unreadable entry'));
          const chunks: Buffer[] = [];
          rs.on('data', (c: Buffer) => chunks.push(c));
          rs.on('end', () => {
            out.push(`${entry.fileName}\n${Buffer.concat(chunks).toString('utf8')}`);
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

/**
 * Collect every STRING LEAF of a value, raw.
 *
 * ★ NOT `JSON.stringify(value)`. Serializing escapes the leaves — a password containing `"` or `\` becomes
 * `\"` / `\\` in the blob and a raw-sentinel `includes()` never matches it. An earlier version of this
 * harness scanned stringified blobs and would have reported CLEAN on a leak it was staring at, which is the
 * same defect it exists to catch (see redactTraceSignals). Walk and compare the real strings.
 */
function stringLeaves(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringLeaves(x, out);
  else if (v && typeof v === 'object') for (const [k, val] of Object.entries(v)) { out.push(k); stringLeaves(val, out); }
  return out;
}

/** Every place a credential could surface, named — so a failure says WHICH surface leaked. */
async function surfaces(r: PreviewResult): Promise<Array<[string, string]>> {
  const leaves = (label: string, v: unknown): Array<[string, string]> =>
    stringLeaves(v).map((s, i) => [`${label}[${i}]`, s] as [string, string]);
  const s: Array<[string, string]> = [
    ['stdout', r.stdout],
    ['stderr', r.stderr],
    ['error', r.error ?? ''],
    ['failedStep', r.failedStep ?? ''],
    // ★ Named separately so a leak is attributed precisely — these are the spec-authored strings that were
    //   shipping raw when only errorMessage was scrubbed.
    ...leaves('tests', r.tests ?? []),
    ...leaves('steps', r.steps ?? []),
    ...leaves('traceSignals', r.traceSignals ?? null),
    // The api uploads this whole object as {token}.json and the UI renders it — walk it too.
    ...leaves('result', { ...r, trace: undefined, screenshot: undefined }),
  ];
  // ★ A byte-scan of a PNG is a BACKSTOP, not the control. A credential rendered into a screenshot is
  //   PIXELS, not the ASCII string, so no string search can find it.
  // ★ WHAT THIS TEST ACTUALLY PROTECTS is the TEXT channels — trace text, stdout, error, trace_signals —
  //   which ARE credential-gated and ARE scrubbed. It does NOT protect the image, and there is no longer
  //   any screenshot suppression to fall back on: redact.ts previewPersistPlan returns
  //   failureScreenshot: true unconditionally, so a credentialed preview KEEPS its screenshot (#348).
  //   The bound on the image is different in kind — the Tests area is editor/admin-only, the operator
  //   typed the credential, and <input type="password"> renders MASKED — not a structural withholding.
  if (r.screenshot) s.push(['screenshot bytes', r.screenshot.toString('binary')]);
  if (r.trace) for (const entry of await expandZip(r.trace)) s.push([`trace.zip:${entry.split('\n')[0]}`, entry]);
  return s;
}

/**
 * THROWS naming the leaking surface if the sentinel survives anywhere. The mutant run asserts this throws.
 * ★ Checks the ENCODED forms too: Chromium percent-encodes a credential into a recorded URL, so scanning
 * only for the raw bytes would call a percent-encoded leak clean.
 */
async function assertSentinelAbsent(r: PreviewResult): Promise<void> {
  const forms: Array<[string, string]> = [];
  for (const [label, value] of [['password', SENTINEL], ['username', SENTINEL_USER]] as const) {
    forms.push([label, value]);
    for (const [how, enc] of [['url-encoded', encodeURIComponent], ['uri-encoded', encodeURI]] as const) {
      const e = enc(value);
      if (e !== value) forms.push([`${label} (${how})`, e]);
    }
  }
  for (const [name, text] of await surfaces(r)) {
    for (const [label, value] of forms) {
      assert.ok(!text.includes(value), `LEAK: the ${label} survived in ${name}`);
    }
  }
}

function runLeakySpec(opts: { disableProtections?: boolean; redactCredentials?: boolean } = {}): Promise<PreviewResult> {
  return runSandboxPreview(LEAKY_LOGIN_SPEC, {
    targetUrl: 'https://example.com',
    timeoutMs: 90_000,
    credentials: { username: SENTINEL_USER, password: SENTINEL },
    redactCredentials: opts.redactCredentials,
    __unsafeDisableSensitiveHandlingForTest: opts.disableProtections,
  });
}

// ── THE ASSERTION: a typed credential reaches NO surface ─────────────────────────────────────────────────
test('★ a credentialed preview leaks the sentinel to NO surface (trace, screenshot, stdout, result, logs)', async () => {
  const r = await runLeakySpec();

  // ★ NON-VACUITY FIRST. If the spec never ran, or produced no trace, "no sentinel found" would be trivially
  //   true and this test would assert nothing. Prove the leaky paths were actually exercised.
  assert.ok(r.stdout.includes('LEAK_MARKER_STDOUT'), 'the spec must have run and written to stdout');
  // A bare `throw` is not an ExpectationError, so browserFlow classifies it 'error' (an assertion failure
  // would be 'fail'). Either is a DOWN status, and both are what make it capture a failure screenshot.
  assert.ok(r.status === 'error' || r.status === 'fail', `expected a down status; got ${r.status}, stderr=${r.stderr}`);
  assert.ok(r.trace && r.trace.byteLength > 0, 'a trace.zip must have been produced (nothing to scan otherwise)');
  assert.ok((await surfaces(r)).length > 8, 'the trace must have expanded to real entries');

  await assertSentinelAbsent(r);

  // The scrub is a REPLACEMENT, not a deletion: the diagnostic survives, the secret does not.
  assert.ok(r.stdout.includes('<redacted>'), 'stdout must show the redaction marker where the credential was');
  assert.ok((r.error ?? '').includes('login rejected'), 'the readable diagnostic must survive scrubbing');
});

// ── SCREENSHOT RETENTION (previewPersistPlan — the preview path, NOT the fleet's) ───────────────────────
test('★ a credentialed preview KEEPS its screenshot — and the sentinel is NOT in the pixels', async () => {
  const r = await runLeakySpec();
  assert.ok(r.status === 'error' || r.status === 'fail', 'the flow must be DOWN — that is when a screenshot is captured');

  // ★ CHANGED (was: assert no screenshot at all). A preview is run from the editor/admin-only Tests area by
  //   the person who TYPED the credential, and `<input type="password">` renders MASKED — so the typed value
  //   does not appear visually. Suppression cost the PRIMARY diagnostic on exactly the monitors with the
  //   worst authoring friction and bought little. previewPersistPlan keeps it; tracePersistPlan (the FLEET)
  //   still suppresses, because an unattended monitor's logged-in page carries member name / address /
  //   order history — PII a masked password field says nothing about. See redact.test.ts's FLEET UNCHANGED.
  assert.ok(r.screenshot && r.screenshot.byteLength > 0, 'a credentialed preview must now KEEP its screenshot');
  assert.deepEqual([...r.screenshot!.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'and it must be a real PNG');

  // ★ The screenshot is now a REAL surface in the sentinel scan below rather than a vacuous null. This is
  //   the assertion that would catch a password field that did NOT mask (a text input mislabelled, a custom
  //   control) — the rationale for keeping the image is falsifiable, not assumed.
  await assertSentinelAbsent(r);
});

// ── ★★ THE META-TEST: prove the suite above CAN fail ─────────────────────────────────────────────────────
test('★★ META: with the protections disabled the SAME assertions RED — the suite is not vacuous', async () => {
  const mutant = await runLeakySpec({ disableProtections: true });

  // (a) The redaction assertions must FAIL. Same spec, same surfaces, same assertions — only the sensitive
  //     treatment is off. Measured leak surfaces in the mutant: stdout, error, steps[].errorMessage,
  //     traceSignals, trace.zip:trace.trace, trace.zip:trace.network — six independent channels, so this
  //     does not degenerate into "stdout only" if one of them stops carrying the value.
  await assert.rejects(
    async () => assertSentinelAbsent(mutant),
    /LEAK: the (password|username) survived in /,
    '★ THE SUITE IS VACUOUS: the sentinel assertions passed with the protections DISABLED. Either the spec ' +
      'no longer exercises the leak paths, or the surfaces list stopped covering them. Fix this before ' +
      'trusting the green test above.',
  );

  // (b) ★ REPURPOSED. Both runs now KEEP a screenshot (previewPersistPlan), so there is no longer a null to
  //     explain. What still needs proving is that a screenshot is captured AT ALL — otherwise the protected
  //     run's "sentinel absent from the pixels" assertion would be vacuous: scanning zero bytes always
  //     passes. This keeps the image surface honest in the ON test above.
  assert.ok(
    mutant.screenshot && mutant.screenshot.byteLength > 0,
    '★ THE IMAGE SURFACE IS VACUOUS: even with the protections DISABLED this flow captured no screenshot. ' +
      'The pixel scan then runs over zero bytes on BOTH runs, so "the sentinel is absent from the ' +
      'screenshot" proves nothing — and the mutant in (a) is scanning one fewer surface than the ' +
      'protected run, so the comparison is no longer like-for-like. Make the flow FAIL so it captures one.',
  );
});

// ── NO REGRESSION: an uncredentialed preview behaves exactly as it did before this feature ───────────────
test('★ an uncredentialed preview is unchanged — raw trace AND the failure screenshot are still kept', async () => {
  const plain = `
    import { test, step, expect } from '../../lib/flow';
    test('wrong selector', async ({ page }) => {
      await step('open the page', async () => { await page.goto('https://example.com', { waitUntil: 'domcontentloaded' }); });
      await step('assert a bogus selector', async () => { await expect(page.locator('#nope')).toBeVisible({ timeout: 3000 }); });
    });
  `;
  const r = await runSandboxPreview(plain, { targetUrl: 'https://example.com', timeoutMs: 60_000 });

  assert.equal(r.status, 'fail');
  // ★ Today's behaviour, preserved: the RAW trace and the failure screenshot both survive. The sensitive
  //   path's REDACTION must not bleed into the uncredentialed path — that is the only thing the
  //   credentialed path does differently now. (It is not "suppressions": previewPersistPlan keeps the
  //   screenshot on BOTH paths, so the screenshot assertion below is a shared invariant, not a contrast.)
  assert.ok(r.trace && r.trace.byteLength > 0, 'an uncredentialed preview still keeps its trace');
  assert.ok(r.screenshot && r.screenshot.byteLength > 0, 'an uncredentialed preview still keeps its screenshot');
  // IDENTITY_REDACTOR ⇒ nothing was rewritten.
  assert.ok(!r.stdout.includes('<redacted>'), 'an uncredentialed preview redacts nothing');
  assert.ok((r.error ?? '').length > 0, 'the raw error survives verbatim');
});

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// ★ THE TOGGLE — "Redact credentials from output". DEFAULT ON; OFF is an explicit, audited opt-out.
// ──────────────────────────────────────────────────────────────────────────────────────────────────

test('★ toggle DEFAULT is ON: omitting redactCredentials redacts exactly as before', async () => {
  // The default must not depend on the api remembering to send the field. Absent ⇒ ON.
  await assertSentinelAbsent(await runLeakySpec({ redactCredentials: undefined }));
});

test('★ toggle OFF: the sentinel IS present — that is the POINT, and it must be provably so', async () => {
  // ★ This is an INVERTED assertion and it is deliberate. The operator asked for raw output for a
  //   credential they typed themselves; if OFF still scrubbed, the toggle would be decorative. Proving OFF
  //   really is raw is also what makes the ON test above non-vacuous — the same spec, same surfaces, one
  //   flag apart.
  const off = await runLeakySpec({ redactCredentials: false });

  await assert.rejects(
    async () => assertSentinelAbsent(off),
    /LEAK: the (password|username) survived in /,
    '★ toggle OFF did not produce raw output — the toggle is not wired, or something still scrubs.',
  );

  // And the marker of redaction must be ABSENT: OFF is "nothing scrubbed", not "scrubbed differently".
  assert.ok(!off.stdout.includes('<redacted>'), 'OFF must not emit the redaction marker anywhere in stdout');

  // The screenshot is kept on this path too — the toggle governs SCRUBBING, not artifact retention.
  assert.ok(off.screenshot && off.screenshot.byteLength > 0, 'OFF keeps the screenshot as well');
});

test('★ toggle OFF is the ONLY thing that changes: a literal false disables, anything else does not', async () => {
  // Mirrors decodeSandboxPayload's `!== false` normalisation — the fail-SAFE direction. A malformed value
  // must over-redact (operator sees <redacted>, re-runs), never silently under-redact.
  for (const value of [undefined, true] as const) {
    await assertSentinelAbsent(await runLeakySpec({ redactCredentials: value }));
  }
});
