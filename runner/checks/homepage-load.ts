// homepage-load — the simplest real browser check: load the page and assert it
// rendered. Uses only assertions that hold for any real HTML page (non-empty
// <title> and body text), so it actually passes on any live site — which also
// makes it the natural target for perf budgets (a passing browser run is what a
// perf-budget breach downgrades to 'warn'). For site-specific funnels with real
// inspected selectors, see wegmans-homepage / wegmans-search.
import type { Flow } from './index.js';
import { expect } from '../errors.js';

export const flow: Flow = async (rec) => {
  await rec.step('open homepage', async (page) => {
    await page.goto(rec.baseUrl, { waitUntil: 'load' });
  });

  await rec.step('assert document rendered', async (page) => {
    // A real page has a non-empty <title> and a body with content. expect() makes
    // an empty page a clean 'fail' (assertion), not an 'error' (exception).
    const title = await page.title();
    expect(title.trim().length > 0, 'page <title> is empty');

    const bodyText = await page.locator('body').innerText();
    expect(bodyText.trim().length > 0, 'page <body> rendered no text');
  });
};
