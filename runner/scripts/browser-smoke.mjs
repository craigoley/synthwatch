// In-image browser smoke test — the gap that let #368 ship a 100%-down prod (2026-07-25).
//
// THE GAP: the runner image inherits its browsers from the pinned Playwright BASE IMAGE
// (Dockerfile `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`), so a MINOR bump of the npm `playwright`
// version without a matching base-image bump leaves the image with the WRONG chrome-headless-shell
// revision. `npm ci` still succeeds (it never downloads the browser), CI's Test job runs
// npm-installed Playwright on the GH runner (its OWN matching browsers), and the deploy verify checks
// image-roll/env — NONE of them launch a browser IN THE BUILT IMAGE. So the mismatch ships green and
// only surfaces at runtime as `browserType.launch: Executable doesn't exist at .../chromium_headless_shell-<rev>/...`.
//
// THIS TEST closes it: run INSIDE the built image (browser-smoke.yml `docker run`) and reproduce the
// runner's EXACT launch — a bare `chromium.launch()` from 'playwright' (index.ts getBrowser()), which
// resolves the chrome-headless-shell binary the same way a real check does. If the image's bundled
// browser revision doesn't match the installed Playwright, this fails EXACTLY as prod did — at PR time.
//
// Keep this in lockstep with how the runner launches (runner/index.ts:157 `chromium.launch()`): if the
// runner ever passes a channel/executablePath/headless option that changes which binary is resolved,
// mirror it here, or the smoke stops exercising the real path.
import { chromium } from 'playwright';

const t0 = Date.now();
let browser;
try {
  // Byte-for-byte the runner's getBrowser() call — no options, so Playwright resolves the default
  // chrome-headless-shell for the installed version. This is the line that threw in the outage.
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('about:blank');
  const two = await page.evaluate(() => 1 + 1);
  if (two !== 2) {
    console.error('browser-smoke: FAIL — page.evaluate returned', two, '(expected 2)');
    process.exit(1);
  }
  const ms = Date.now() - t0;
  console.log(
    `browser-smoke: OK — chromium.launch() + newPage + evaluate succeeded in ${ms}ms. ` +
      'The image\'s bundled browser matches the installed Playwright (base-image ⇄ npm pairing is correct).',
  );
  process.exit(0);
} catch (err) {
  // The outage signature lands here. Name it loudly so a CI failure reads as "the pairing is wrong",
  // not a mysterious flake — this is a DETERMINISTIC config error, never transient.
  console.error('browser-smoke: FAIL — chromium.launch() threw. This is the #368-class base-image ⇄ npm');
  console.error('  Playwright MISMATCH (the image lacks the browser revision the installed Playwright wants).');
  console.error('  Fix: pin runner/Dockerfile FROM ...playwright:vX.Y.Z-noble to the SAME version as the');
  console.error('  `playwright` dependency in runner/package.json, and confirm that vX.Y.Z-noble tag exists on mcr.');
  console.error(String(err && err.stack ? err.stack : err));
  process.exit(1);
} finally {
  if (browser) await browser.close().catch(() => {});
}
