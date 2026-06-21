// wegmans-homepage — a REAL homepage flow for https://www.wegmans.com/.
//
// Selectors verified against the LIVE DOM on 2026-06-21 (web-first role locators,
// not guessed). Inspected facts:
//   - <title> contains "Wegmans"
//   - getByRole('banner')     -> the site header
//   - getByRole('searchbox')  -> accessible name "What can we help you find?"
//   - getByRole('navigation') -> primary nav with links (Stores, Pharmacy, ...)
//   - the page is rich (~11.8k nodes once hydrated), so LCP is distinctly later
//     than FCP.
//
// Wegmans is a JS-hydrated SPA: at the 'load' event only a small shell exists
// (~hundreds of nodes); the header/search box/content appear after hydration.
// So this flow WAITS (web-first) for the search box before asserting — which also
// lets the page render enough for LCP to settle past FCP. Set the check's
// target_url to https://www.wegmans.com/.
import type { Flow } from './index.js';
import { expect } from '../errors.js';

export const flow: Flow = async (rec) => {
  await rec.step('open homepage', async (page) => {
    await page.goto(rec.baseUrl, { waitUntil: 'load' });
  });

  await rec.step('wait for search box (hydration)', async (page) => {
    // Auto-waits until the real UI is present. A genuine never-appears is a
    // Playwright timeout => 'error' (page failed to render), distinct from the
    // assertion 'fail's below.
    await page.getByRole('searchbox').first().waitFor({ state: 'visible', timeout: 20000 });
  });

  await rec.step('assert homepage rendered', async (page) => {
    const title = await page.title();
    expect(/wegmans/i.test(title), `unexpected page title: "${title}"`);
    expect(await page.getByRole('banner').first().isVisible(), 'site header (banner) not visible');
    const navLinks = await page.getByRole('navigation').first().getByRole('link').count();
    expect(navLinks > 0, 'primary navigation rendered no links');
  });
};
