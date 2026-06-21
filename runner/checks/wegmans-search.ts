// wegmans-search — a REAL search-funnel flow for https://www.wegmans.com/.
//
// Selectors + behaviour verified against the LIVE site on 2026-06-21:
//   - getByRole('searchbox') is the site search input.
//   - Typing a query + Enter navigates to /shop/search?query=<q>.
//   - The results page renders product links containing the query term
//     (e.g. "milk" -> ~29 links).
//
// This monitors the full funnel: homepage -> search -> results. A broken search
// box surfaces as a step failure exactly where it breaks. Set the check's
// target_url to https://www.wegmans.com/ to run this flow.
import type { Flow } from './index.js';
import { expect } from '../errors.js';

const QUERY = 'milk';

export const flow: Flow = async (rec) => {
  await rec.step('open homepage', async (page) => {
    await page.goto(rec.baseUrl, { waitUntil: 'load' });
  });

  await rec.step(`search for "${QUERY}"`, async (page) => {
    // Wegmans hydrates after 'load' — wait (web-first) for the search box before
    // interacting, then drive the funnel.
    const search = page.getByRole('searchbox').first();
    await search.waitFor({ state: 'visible', timeout: 20000 });
    await search.click();
    await search.fill(QUERY);
    await search.press('Enter');
  });

  await rec.step('assert results page', async (page) => {
    // The funnel lands on the query-param results URL, then renders product
    // results ASYNCHRONOUSLY. Wait (web-first) for the URL, then for the first
    // matching result to appear — counting immediately would race the render.
    await page.waitForURL(/\/shop\/search\?query=/i, { timeout: 20000 });
    const results = page
      .getByRole('link')
      .filter({ hasText: new RegExp(QUERY, 'i') });
    await results.first().waitFor({ state: 'visible', timeout: 20000 });
    expect((await results.count()) > 0, `no search results rendered for "${QUERY}"`);
  });
};
