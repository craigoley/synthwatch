// collect() never throws (every section swallows to null), so the ONLY way a silent capture failure
// reaches the verdict is the `captureFailed` set it now returns. These tests prove the line directly at
// the source: a thrown timings section marks 'lcpMs' failed (null-because-failed); a SUCCEEDED section
// whose value is just absent leaves 'lcpMs' OUT of the set (null-because-absent). (The analysis flagged
// metrics.collect()'s swallow paths as zero-coverage — this closes that.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMetricsCapture } from './metrics.js';
import type { BrowserContext, Page } from 'playwright';

// A fake context whose CDP session is unavailable (mirrors a non-Chromium / disabled env) so the CDP
// section is skipped cleanly during setup.
const fakeContext = {
  newCDPSession: async () => {
    throw new Error('no cdp in test');
  },
} as unknown as BrowserContext;

// A fake page; `evaluate` drives both the LCP-settle poll (return ignored) and the timings read (return
// used). addInitScript/on are the only other touch points at setup.
function fakePage(evaluate: () => Promise<unknown>): Page {
  return {
    addInitScript: async () => undefined,
    on: () => undefined,
    evaluate,
  } as unknown as Page;
}

test('★ collect(): a thrown timings section marks lcpMs FAILED (null-because-failed)', async () => {
  const cap = await startMetricsCapture(fakeContext, fakePage(async () => {
    throw new Error('page navigated away');
  }));
  const { metrics, captureFailed } = await cap.collect();
  assert.equal(metrics.lcpMs, null);
  assert.ok(captureFailed.has('lcpMs'), 'a thrown timings evaluate → lcpMs is in captureFailed');
  assert.ok(captureFailed.has('ttfbMs'), 'sibling timing fields also failed together');
});

test('★ collect(): a SUCCEEDED timings section with no LCP leaves lcpMs OUT of captureFailed (the line)', async () => {
  // evaluate resolves with valid nav timings but lcp=0 (observer never fired) → nz(0)=null = ABSENT.
  const raw = {
    responseStart: 100, domContentLoadedEventEnd: 500, loadEventEnd: 800,
    fcp: 300, lcp: 0, cls: 0, inp: 0, domNodeCount: 1200,
  };
  const cap = await startMetricsCapture(fakeContext, fakePage(async () => raw));
  const { metrics, captureFailed } = await cap.collect();
  assert.equal(metrics.lcpMs, null, 'lcp genuinely absent → null');
  assert.equal(metrics.ttfbMs, 100, 'but the section SUCCEEDED — other timings captured');
  assert.equal(captureFailed.has('lcpMs'), false, '★ absent ≠ failed: lcpMs must NOT be flagged');
});
