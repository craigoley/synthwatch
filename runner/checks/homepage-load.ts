// homepage-load — the simplest real browser check: load the page and assert it
// rendered. Uses only assertions that hold for any real HTML page (non-empty
// <title> and body text), so it actually passes on any live site — which also
// makes it the natural target for perf budgets (a passing browser run is what a
// perf-budget breach downgrades to 'warn'). For site-specific funnels with real
// inspected selectors, see wegmans-homepage / wegmans-search.
import { defineFlow, type FlowMeta } from './index.js';

export const meta: FlowMeta = {
  description: 'Loads any page and asserts it rendered (non-empty title + body).',
};

export const flow = defineFlow(async ({ page, step, baseUrl, expect }) => {
  await step('open homepage', async () => {
    await page.goto(baseUrl, { waitUntil: 'load' });
  });

  await step('assert document rendered', async () => {
    // A real page has a non-empty <title> and a body with content. expect() makes
    // an empty page a clean 'fail' (assertion), not an 'error' (exception).
    const title = await page.title();
    expect(title.trim().length > 0, 'page <title> is empty');

    const bodyText = await page.locator('body').innerText();
    expect(bodyText.trim().length > 0, 'page <body> rendered no text');
  });
});
