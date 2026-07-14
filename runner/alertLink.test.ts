import test from 'node:test';
import assert from 'node:assert/strict';

import { buildWebhookPayload, type AlertPayload } from './alerts.js';
import { viewLink } from './alertEmail.js';

// ★ THE POINT: an operator paged at 2am must land on the ANSWER — the incident detail page
// (/incidents/{id}, the OBSERVED·FACTS / INFERRED·HYPOTHESIS panel) — NOT the check config page.
// A deep link that 404s is worse than none, so these assertions pin: present when we can build it,
// well-formed (parses, points at /incidents/{id}), the /checks fallback only when there's no
// incident, absent (null) when DASHBOARD_URL is unset, and identical between email and webhook.

const BASE = 'https://dash.synthwatch.test';

/** Set DASHBOARD_URL for the duration of fn, then restore (viewLink reads it at call time). */
function withDashboardUrl<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.DASHBOARD_URL;
  if (value === undefined) delete process.env.DASHBOARD_URL;
  else process.env.DASHBOARD_URL = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.DASHBOARD_URL;
    else process.env.DASHBOARD_URL = prev;
  }
}

const openPayload = (incidentId: number | null): AlertPayload => ({
  checkId: 42,
  checkName: 'wegmans.com SSL',
  severity: 'critical',
  status: 'open',
  summary: 'certificate expired',
  runId: 999,
  failedStep: 'TLS handshake',
  incident: incidentId == null ? null : { incidentId },
});

test('an OPEN alert with an incident deep-links the delivered webhook payload to /incidents/{id}', () => {
  withDashboardUrl(BASE, () => {
    const link = buildWebhookPayload(openPayload(7001)).dashboardUrl;
    assert.equal(link, `${BASE}/incidents/7001`);
    // well-formed: parses, and the path is the incident page (NOT /checks)
    const u = new URL(link!);
    assert.equal(u.pathname, '/incidents/7001');
    assert.ok(!link!.includes('/checks/'), 'must not point at the check config page');
  });
});

test('the webhook link is IDENTICAL to the email link (shared viewLink — cannot drift)', () => {
  withDashboardUrl(BASE, () => {
    const p = openPayload(7002);
    assert.equal(buildWebhookPayload(p).dashboardUrl, viewLink(p));
  });
});

test('with NO incident (a warn), the link falls back to the /checks page', () => {
  withDashboardUrl(BASE, () => {
    const p: AlertPayload = { ...openPayload(null), status: 'warn' };
    assert.equal(buildWebhookPayload(p).dashboardUrl, `${BASE}/checks/42`);
  });
});

test('DASHBOARD_URL unset → dashboardUrl is null (omit the link; never emit a broken one)', () => {
  withDashboardUrl(undefined, () => {
    assert.equal(buildWebhookPayload(openPayload(7003)).dashboardUrl, null);
  });
});

test('a trailing slash on DASHBOARD_URL is normalized (no double slash in the deep link)', () => {
  withDashboardUrl(`${BASE}/`, () => {
    assert.equal(buildWebhookPayload(openPayload(7004)).dashboardUrl, `${BASE}/incidents/7004`);
  });
});

test('the incidentId stays a separate field AND the link is the incident page (both present)', () => {
  withDashboardUrl(BASE, () => {
    const payload = buildWebhookPayload(openPayload(7005));
    assert.equal(payload.incidentId, 7005, 'raw id retained for receiver-side correlation');
    assert.equal(payload.dashboardUrl, `${BASE}/incidents/7005`, 'and the clickable link is the answer page');
  });
});
