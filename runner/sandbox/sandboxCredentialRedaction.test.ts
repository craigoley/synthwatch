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

/** A distinctive, high-entropy value that cannot occur naturally anywhere in a trace. */
const SENTINEL = `SENTINEL_PW_${randomBytes(12).toString('hex')}`;
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
  test('login', async ({ page }) => {
    await step('open a login form', async () => {
      await page.setContent('<form><input id="u" name="username"><input id="p" name="password" type="password"></form>');
      await page.fill('#u', user);
      await page.fill('#p', pw);
    });
    await step('submit the credential over the wire', async () => {
      await page.goto('https://example.com/?q=' + pw, { waitUntil: 'domcontentloaded' }).catch(() => {});
    });
    await step('fail the way a bad login fails', async () => {
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

/** Every place a credential could surface, named — so a failure says WHICH surface leaked. */
async function surfaces(r: PreviewResult): Promise<Array<[string, string]>> {
  const s: Array<[string, string]> = [
    ['stdout', r.stdout],
    ['stderr', r.stderr],
    ['error', r.error ?? ''],
    ['failedStep', r.failedStep ?? ''],
    ['steps[].errorMessage', JSON.stringify(r.steps ?? [])],
    ['traceSignals', JSON.stringify(r.traceSignals ?? null)],
    // The api uploads this whole object as {token}.json and the UI renders it — scan it as one blob too.
    ['result JSON', JSON.stringify({ ...r, trace: undefined, screenshot: undefined })],
  ];
  // ★ A byte-scan of a PNG is a BACKSTOP, not the control. A credential rendered into a screenshot is
  //   PIXELS, not the ASCII string — no string search can find it, which is precisely why the real
  //   protection is structural SUPPRESSION (asserted separately below) rather than scrubbing.
  if (r.screenshot) s.push(['screenshot bytes', r.screenshot.toString('binary')]);
  if (r.trace) for (const entry of await expandZip(r.trace)) s.push([`trace.zip:${entry.split('\n')[0]}`, entry]);
  return s;
}

/** THROWS naming the leaking surface if the sentinel survives anywhere. The mutant run asserts this throws. */
async function assertSentinelAbsent(r: PreviewResult): Promise<void> {
  for (const [name, text] of await surfaces(r)) {
    for (const [label, value] of [['password', SENTINEL], ['username', SENTINEL_USER]] as const) {
      assert.ok(!text.includes(value), `LEAK: the ${label} survived in ${name}`);
    }
  }
}

function runLeakySpec(opts: { disableProtections?: boolean } = {}): Promise<PreviewResult> {
  return runSandboxPreview(LEAKY_LOGIN_SPEC, {
    targetUrl: 'https://example.com',
    timeoutMs: 90_000,
    credentials: { username: SENTINEL_USER, password: SENTINEL },
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

// ── SCREENSHOT SUPPRESSION (tracePersistPlan sensitive=true) ─────────────────────────────────────────────
test('★ a credentialed preview persists NO screenshot — suppression, not masking', async () => {
  const r = await runLeakySpec();
  assert.ok(r.status === 'error' || r.status === 'fail', 'the flow must be DOWN — that is when a screenshot is captured');
  // ★ page.screenshot({ mask }) is deliberately NOT used: masking blacks out only the selectors you NAMED,
  //   so a credential rendered somewhere unpredicted (an error toast, the autofill dropdown, a "signed in
  //   as…" header) survives. A failed flow normally yields a screenshot; a sensitive one must yield none.
  assert.equal(r.screenshot ?? null, null, 'a credentialed run must persist no screenshot at all');
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

  // (b) The SUPPRESSION assertion must also have something to fail against. Without this, "a credentialed
  //     run has no screenshot" could pass simply because no screenshot was ever captured — a vacuous check
  //     inside the anti-vacuity test. The mutant proves the capture really does happen, so the null in the
  //     protected run is caused by tracePersistPlan and nothing else.
  assert.ok(
    mutant.screenshot && mutant.screenshot.byteLength > 0,
    '★ THE SUPPRESSION CHECK IS VACUOUS: even unprotected, this flow captured no screenshot — so asserting ' +
      'null on the protected run proves nothing about suppression.',
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
  //   path's suppressions must not bleed into the uncredentialed path.
  assert.ok(r.trace && r.trace.byteLength > 0, 'an uncredentialed preview still keeps its trace');
  assert.ok(r.screenshot && r.screenshot.byteLength > 0, 'an uncredentialed preview still keeps its screenshot');
  // IDENTITY_REDACTOR ⇒ nothing was rewritten.
  assert.ok(!r.stdout.includes('<redacted>'), 'an uncredentialed preview redacts nothing');
  assert.ok((r.error ?? '').length > 0, 'the raw error survives verbatim');
});
