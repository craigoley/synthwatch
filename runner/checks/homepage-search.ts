// TEMPLATE FLOW — homepage search funnel.
//
// ⚠️  PLACEHOLDER SELECTORS. Every selector and assertion below is a guess. They
//     WILL NOT match a real site. Before relying on this check you MUST:
//       1. Open the target site and inspect the real DOM.
//       2. Replace the selectors (the `#search`, `text=...`, etc.) with real ones.
//       3. Adjust the steps to match the actual funnel you want to monitor.
//
// What this template DOES demonstrate (and what you should keep) is the shape:
// every action is wrapped in rec.step('<human name>', async (page) => { ... }).
// That wrapping is what makes the funnel telemetry structural — if a step
// throws, run_steps records exactly where, and the run stops there.
import type { Flow } from './index.js';

export const flow: Flow = async (rec) => {
  await rec.step('open homepage', async (page) => {
    await page.goto(rec.baseUrl, { waitUntil: 'domcontentloaded' });
  });

  await rec.step('focus search box', async (page) => {
    // PLACEHOLDER selector — replace with the real search input.
    await page.click('#search');
  });

  await rec.step('type query', async (page) => {
    // PLACEHOLDER selector — replace with the real search input.
    await page.fill('#search', 'synthetic monitoring');
  });

  await rec.step('submit search', async (page) => {
    await page.keyboard.press('Enter');
    // PLACEHOLDER selector — wait for whatever marks "results loaded".
    await page.waitForSelector('.search-results', { timeout: 15000 });
  });

  await rec.step('assert results present', async (page) => {
    // PLACEHOLDER selector — assert at least one result rendered.
    const count = await page.locator('.search-results .result').count();
    if (count === 0) {
      throw new Error('no search results rendered');
    }
  });
};
