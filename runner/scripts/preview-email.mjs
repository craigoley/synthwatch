/* global process, console */
// Render-check / styling playground for the alert email template (alertEmail.ts).
//
//   npm run build && node scripts/preview-email.mjs
//   open "$(...)/open-with-rca.html"   (macOS) — the script PRINTS the output dir on exit
//
// Writes the four sample alert emails (open with/without RCA, resolved, warning) into a private,
// per-run temp directory (printed on exit) so you can eyeball them in a browser while tweaking the
// palette/copy in alertEmail.ts. Pure render — sends nothing.
import { writeFileSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DASHBOARD_URL ??= 'https://synthwatch.example.com';
const here = dirname(fileURLToPath(import.meta.url));
const { buildAlertEmail } = await import(join(here, '../dist/alertEmail.js'));

// Create a PRIVATE, randomized temp dir (mkdtemp → mode 0700, unique suffix) rather than a
// predictable /tmp/synthwatch-email-samples path. A fixed name in the world-writable temp dir is the
// symlink/clobber race CodeQL js/insecure-temporary-file flags (alerts #4, #5); mkdtemp closes it.
const OUT = mkdtempSync(join(tmpdir(), 'synthwatch-email-samples-'));

const incident = (over) => ({
  incidentId: 25,
  targetUrl: 'https://rca-demo.internal/health',
  openedAt: '2026-06-23T21:10:20Z',
  locations: ['centralus', 'eastus2'],
  consecutiveFailures: 3,
  rca: null,
  ...over,
});
const rca = {
  classification: 'real-outage',
  confidence: 'high',
  summary: 'All locations returned HTTP 500 simultaneously; consistent with an origin outage.',
};
const base = (over) => ({
  checkId: 59,
  checkName: 'rca-demo',
  severity: 'critical',
  status: 'open',
  summary: 'Check "rca-demo" down (fail) from 2 of 2 locations (died at step: GET /).',
  runId: 841690,
  failedStep: 'GET /',
  screenshotUrl: null,
  incident: incident(),
  ...over,
});

const samples = {
  'open-with-rca': base({ incident: incident({ rca }) }),
  'open-no-rca': base({}),
  resolved: base({
    status: 'resolved',
    summary: 'Check "rca-demo" recovered.',
    incident: incident({ resolvedAt: '2026-06-23T23:35:05Z', rca }),
  }),
  warning: base({
    severity: 'warning',
    status: 'warn',
    summary: 'Check "rca-demo" degraded: perf budget breached (LCP 4200ms > 2500ms).',
    incident: null,
  }),
};

for (const [name, p] of Object.entries(samples)) {
  const { html, text } = buildAlertEmail(p);
  writeFileSync(join(OUT, `${name}.html`), html);
  writeFileSync(join(OUT, `${name}.txt`), text);
}
console.log(`wrote ${Object.keys(samples).length} samples to ${OUT}/*.{html,txt}`);
