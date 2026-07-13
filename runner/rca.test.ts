// RCA fact-pack + cite-validation + abstain tests. All DETERMINISTIC (no DB, no live model): the pure
// functions renderFactPack / validateCites / evidenceThin / deterministicResult / extractTraceFacts are the
// unit under test. The headline is the ★★ 955866 ACCEPTANCE TEST — the real run whose surface error_message
// ("Add to Cart affordance not found (NET-NEW selector…)") BAITS the wrong answer while the true cause (a
// first-party Product API "Failed to fetch") sits in trace_signals.console, which the OLD fact pack omitted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderFactPack,
  validateCites,
  evidenceThin,
  deterministicResult,
  extractTraceFacts,
  type RcaFacts,
} from './rca.js';

// ── The REAL run 955866 as an RcaFacts (from the 2026-07-13 recon; console verbatim from runs.trace_signals) ──
const ERR_955866 =
  '[full-shop-flow] STEP-FAIL add-bread url=www.wegmans.com/shop/product/32939-Red-White-Blue- ' +
  'f=li0sgn0cart0chk0ful1slot0oos0 c=[control,Delivery] :: add-bread: Add to Cart affordance not found ' +
  '(NET-NEW selector — verify from diag) — expected element to be visible within 20000ms';

function facts955866(withConsole: boolean): RcaFacts {
  const firstPartyConsole = withConsole
    ? [
        { origin: 'site', level: 'error', sourceHost: 'www.wegmans.com', text: 'Product API Error: TypeError: Failed to fetch (api.digitaldevelopment.wegmans.cloud)' },
        { origin: 'site', level: 'error', sourceHost: 'www.wegmans.com', text: 'TypeError: Failed to fetch (api.digitaldevelopment.wegmans.cloud)' },
        { origin: 'site', level: 'error', sourceHost: 'www.wegmans.com', text: 'hooks:useUpdateCarts Error updating cart TypeError: Cannot read properties of undefined' },
        { origin: 'site', level: 'error', sourceHost: 'www.wegmans.com', text: 'cooklist:useCooklist Cooklist query failed' },
        { origin: 'site', level: 'error', sourceHost: 'myaccount.wegmans.com', text: 'Pattern attribute value is not a valid regular expression' },
      ]
    : [];
  return {
    checkName: 'Wegmans: full authenticated pickup shopping flow',
    kind: 'browser',
    targetUrl: 'https://www.wegmans.com',
    sensitive: false,
    runStatus: 'error',
    httpStatus: null,
    durationMs: 266699,
    failedStep: 'add-bread',
    errorMessage: ERR_955866,
    steps: [
      { index: 0, name: 'login', status: 'pass', error: null },
      { index: 1, name: 'select-store-mckinley', status: 'pass', error: null },
      { index: 2, name: 'baseline-clear-cart', status: 'pass', error: null },
      { index: 3, name: 'add-milk', status: 'pass', error: null },
      { index: 4, name: 'add-eggs', status: 'pass', error: null },
      { index: 5, name: 'add-bread', status: 'error', error: ERR_955866 },
      { index: 6, name: 'clear-cart (teardown)', status: 'pass', error: null },
      { index: 7, name: 'logout (teardown)', status: 'pass', error: null },
    ],
    recent: ['pass', 'pass', 'pass', 'pass', 'pass'],
    verdict: { failing: 1, total: 1 },
    firstPartyConsole,
    thirdPartyConsoleErrorCount: withConsole ? 11 : 0,
    netFailed: [],
  };
}

// ── ★★ THE 955866 ACCEPTANCE TEST — BEFORE/AFTER the console in the fact pack ──────────────────────────────

test('★ 955866: the WHY (a first-party Failed-to-fetch) is in the fact pack ONLY WITH the console; the baiting error_message is always there', () => {
  const withC = renderFactPack(facts955866(true));
  const without = renderFactPack(facts955866(false));

  // WITH the console: the true cause is present, and so is the refuting sibling-step evidence.
  assert.ok(withC.text.includes('Failed to fetch (api.digitaldevelopment.wegmans.cloud)'), 'console why present');
  assert.ok(withC.text.includes('"add-milk" [pass]') && withC.text.includes('"add-eggs" [pass]'), 'siblings passed');
  assert.ok(withC.text.includes('"add-bread" [error]'), 'the failing step');
  assert.ok(withC.citeIndex.has('console:www.wegmans.com'), 'the console host is citable');
  assert.ok(withC.citeIndex.has('step:add-milk') && withC.citeIndex.has('run_steps'));

  // WITHOUT the console (the OLD fact pack): the WHY is GONE, but the baiting message remains.
  assert.ok(!without.text.includes('Failed to fetch'), 'the console why is absent from the old fact pack');
  assert.ok(!without.citeIndex.has('console:www.wegmans.com'), 'no console host to cite');
  assert.ok(without.text.includes('Add to Cart affordance not found (NET-NEW selector'), 'the bait is still there');
});

test('★★ MUST-GO-RED: the TRUE hedged answer is DISCARDED without the console, but SURVIVES with it — while the WRONG (selector) answer survives either way', () => {
  const withC = renderFactPack(facts955866(true));
  const without = renderFactPack(facts955866(false));

  // The TRUE answer (955866): the cause claim is grounded in the console fingerprint.
  const trueObserved = [
    'add-bread timed out waiting for the Add-to-Cart affordance [cite: error_message]',
    'milk and eggs were added earlier in this same run [cite: run_steps]',
    'a first-party Product API "Failed to fetch (api.digitaldevelopment.wegmans.cloud)" was captured [cite: console:www.wegmans.com]',
  ];
  // WITH the console → all cites resolve → the true answer ships.
  assert.deepEqual(validateCites(trueObserved, withC.citeIndex), []);
  // WITHOUT the console → the console cite cannot resolve → the true answer is DISCARDED (this is the gap).
  assert.ok(
    validateCites(trueObserved, without.citeIndex).some((v) => v.startsWith('unresolved-cite: console:www.wegmans.com')),
    'without the console the true cause is ungroundable → discarded',
  );

  // The WRONG answer the error_message baits (selector-drift) cites only the message — which resolves in BOTH
  // packs. So WITHOUT the console, the surviving answer is the WRONG one. That is the confabulation this fixes.
  const wrongObserved = ['the Add-to-Cart affordance was not found — a NET-NEW selector [cite: error_message]'];
  assert.deepEqual(validateCites(wrongObserved, without.citeIndex), [], 'the bait survives without the console');
  assert.deepEqual(validateCites(wrongObserved, withC.citeIndex), []);
});

// ── Cite-validation: resolve-or-discard ────────────────────────────────────────────────────────────────────

test('★ cite-validation MUST-GO-RED: an observed claim citing an artifact NOT in the fact pack is a violation (→ discard)', () => {
  const { citeIndex } = renderFactPack(facts955866(true));
  // fabricated host not captured on this run:
  assert.ok(
    validateCites(['origin is down [cite: network:evil.example.com]'], citeIndex).includes('unresolved-cite: network:evil.example.com'),
  );
  // an observed item with NO cite at all is invalid:
  assert.ok(validateCites(['the page looked broken'], citeIndex).some((v) => v.startsWith('no-cite:')));
  // a fully-grounded observed set has zero violations:
  assert.deepEqual(validateCites(['failed at add-bread [cite: failed_step]'], citeIndex), []);
});

// ── Abstain: thin evidence → insufficient evidence, EMPTY inferred, never a confident cause ─────────────────

test('★ ABSTAIN MUST-GO-RED: an infra_error with empty trace_signals → evidenceThin, and the result invents NO cause', () => {
  const thin: RcaFacts = {
    checkName: 'meals2go-browse-menu', kind: 'browser', targetUrl: 'https://www.meals2go.com', sensitive: false,
    runStatus: 'infra_error', httpStatus: null, durationMs: 1200,
    failedStep: null, errorMessage: 'browser.newContext: Target page, context or browser has been closed',
    steps: [], recent: ['pass', 'pass'], verdict: { failing: 1, total: 1 },
    firstPartyConsole: [], thirdPartyConsoleErrorCount: 0, netFailed: [],
  };
  assert.equal(evidenceThin(thin), true);
  const r = deterministicResult(thin, 'sig', true);
  assert.equal(r.summary, 'insufficient evidence to attribute a cause');
  assert.equal(r.confidence, 'low');
  assert.deepEqual(r.inferred, []); // ★ NEVER a cause on thin evidence

  // 955866 is NOT thin (add-bread errored + first-party console) → the model IS asked.
  assert.equal(evidenceThin(facts955866(true)), false);
  // a non-browser check whose message is a direct network observation is NOT thin (no bait risk):
  const http503 = { ...thin, kind: 'http', runStatus: 'error', httpStatus: 503 };
  assert.equal(evidenceThin(http503), false);
  const econn = { ...thin, kind: 'http', runStatus: 'error', errorMessage: 'connect ECONNREFUSED' };
  assert.equal(evidenceThin(econn), false);
});

// ── The facts-only fallback (discard / model-fail path) asserts NO cause and stays self-consistent ──────────

test('★ facts-only fallback (955866): observed is cited, inferred is EMPTY (no confabulated cause), and every cite resolves', () => {
  const facts = facts955866(true);
  const { citeIndex } = renderFactPack(facts);
  const r = deterministicResult(facts, 'sig', false);
  assert.deepEqual(r.inferred, []); // facts-only: no inferred cause
  assert.ok(r.observed.some((o) => o.includes('[cite: failed_step]')));
  assert.ok(r.observed.some((o) => o.includes('Earlier steps passed') && o.includes('[cite: run_steps]')));
  assert.equal(validateCites(r.observed, citeIndex).length, 0, 'the deterministic result cites only real artifacts');
  assert.ok(!/selector/i.test(r.summary), 'the fallback does NOT assert the baited selector cause');
});

// ── Token budget: first-party ranked + capped, third-party counted not dumped ──────────────────────────────

test('★ token budget: extractTraceFacts ranks first-party first, caps them, and only COUNTS third-party noise', () => {
  const messages = [
    ...Array.from({ length: 50 }, (_, i) => ({ level: 'error', origin: 'site', sourceHost: 'www.wegmans.com', text: `site error ${i}` })),
    ...Array.from({ length: 60 }, (_, i) => ({ level: 'error', origin: 'third-party', sourceHost: 'ad.doubleclick.net', text: `tracker ${i}` })),
    { level: 'warning', origin: 'site', sourceHost: 'www.wegmans.com', text: 'a warning (not error-class)' },
  ];
  const failed = Array.from({ length: 20 }, (_, i) => ({
    url: `https://api${i}.wegmans.cloud/x`, status: -1, resourceType: 'fetch', timeMs: 0, waitMs: 0, size: 0, wire: 0, encoding: '', thirdParty: false,
  }));
  const ts = { targetHost: 'www.wegmans.com', network: { failed } as never, console: { messages } as never } as never;

  const out = extractTraceFacts(ts, false);
  assert.equal(out.firstPartyConsole.length, 10, 'first-party console capped');
  assert.ok(out.firstPartyConsole.every((c) => c.origin === 'site' && c.level === 'error'), 'first-party error-class only');
  assert.equal(out.thirdPartyConsoleErrorCount, 60, 'third-party counted, not dumped');
  assert.equal(out.netFailed.length, 8, 'network.failed capped');

  // sensitive → host+level only, no text forwarded.
  const sens = extractTraceFacts(ts, true);
  assert.ok(sens.firstPartyConsole.every((c) => c.text === ''), 'sensitive: console text withheld');
});
