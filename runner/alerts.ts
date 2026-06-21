// Alert delivery — a small channel abstraction.
//
// Every channel is enabled ONLY when its env config is present; an absent var
// means the channel is silently off. NOTHING tenant-specific lives in source
// (this repo is public OSS) — all URLs, addresses and connection strings come
// from the runner's environment.
//
// Delivery is NON-FATAL by construction: dispatchAlerts() never throws, and one
// dead channel never blocks the others or the incident. The incident is recorded
// BEFORE alerts fire (see evaluate.ts), so alerting can never become a new
// failure mode for a run.
//
// Fires on incident OPEN (alert) and RESOLVE (recovery) — both carry severity.
import { EmailClient } from '@azure/communication-email';

export interface AlertPayload {
  checkId: number;
  checkName: string;
  severity: 'critical' | 'warning';
  status: 'open' | 'resolved';
  /** Human summary; for an OPEN this carries the failure reason/step. */
  summary: string;
  runId: number;
  failedStep?: string | null;
  screenshotUrl?: string | null;
}

/** One delivery channel. Configured purely from env; send() may throw — the
 *  dispatcher isolates it. */
interface AlertChannel {
  readonly name: string;
  isConfigured(): boolean;
  send(p: AlertPayload): Promise<void>;
}

function subjectLine(p: AlertPayload): string {
  const verb = p.status === 'open' ? 'OPENED' : 'RESOLVED';
  return `[SynthWatch][${p.severity}] ${verb}: ${p.checkName}`;
}

/** Deep link to the check in the dashboard, or null if DASHBOARD_URL is unset. */
function dashboardLink(p: AlertPayload): string | null {
  const base = process.env.DASHBOARD_URL;
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}/checks/${p.checkId}`;
}

function bodyText(p: AlertPayload): string {
  const lines = [subjectLine(p), '', p.summary, `Run: #${p.runId}`];
  if (p.failedStep) lines.push(`Failed step: ${p.failedStep}`);
  if (p.screenshotUrl) lines.push(`Screenshot: ${p.screenshotUrl}`);
  const link = dashboardLink(p);
  if (link) lines.push(`Dashboard: ${link}`);
  return lines.join('\n');
}

// --- Channel: Microsoft Teams incoming webhook -----------------------------
// Env: TEAMS_WEBHOOK_URL
const teamsChannel: AlertChannel = {
  name: 'teams',
  isConfigured: () => Boolean(process.env.TEAMS_WEBHOOK_URL),
  async send(p: AlertPayload): Promise<void> {
    const url = process.env.TEAMS_WEBHOOK_URL;
    if (!url) return;
    const link = dashboardLink(p);
    const card = {
      '@type': 'MessageCard',
      '@context': 'https://schema.org/extensions',
      summary: subjectLine(p),
      // red for an incident opening, green for recovery.
      themeColor: p.status === 'open' ? 'D7263D' : '2EB67D',
      title: subjectLine(p),
      text: bodyText(p).replace(/\n/g, '\n\n'),
      ...(link
        ? {
            potentialAction: [
              {
                '@type': 'OpenUri',
                name: 'Open in SynthWatch',
                targets: [{ os: 'default', uri: link }],
              },
            ],
          }
        : {}),
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(card),
    });
    if (!res.ok) throw new Error(`Teams webhook returned ${res.status}`);
  },
};

// --- Channel: Azure Communication Services email ---------------------------
// Env: ACS_EMAIL_CONNECTION_STRING, ALERT_EMAIL_FROM, ALERT_EMAIL_TO
// (ALERT_EMAIL_TO may be a comma-separated list).
const emailChannel: AlertChannel = {
  name: 'email',
  isConfigured: () =>
    Boolean(
      process.env.ACS_EMAIL_CONNECTION_STRING &&
        process.env.ALERT_EMAIL_FROM &&
        process.env.ALERT_EMAIL_TO,
    ),
  async send(p: AlertPayload): Promise<void> {
    const connectionString = process.env.ACS_EMAIL_CONNECTION_STRING;
    const senderAddress = process.env.ALERT_EMAIL_FROM;
    const to = process.env.ALERT_EMAIL_TO;
    if (!connectionString || !senderAddress || !to) return;

    const client = new EmailClient(connectionString);
    const poller = await client.beginSend({
      senderAddress,
      content: { subject: subjectLine(p), plainText: bodyText(p) },
      recipients: { to: to.split(',').map((address) => ({ address: address.trim() })) },
    });
    await poller.pollUntilDone();
  },
};

// --- Channel: generic webhook ----------------------------------------------
// The escape hatch for xMatters / PagerDuty / Slack / anything that ingests a
// POST. Env: ALERT_WEBHOOK_URL (+ optional ALERT_WEBHOOK_AUTH_HEADER, the full
// Authorization header value, e.g. "Bearer <token>" or "Basic <base64>").
//
// Payload (application/json):
//   {
//     "event":        "open" | "resolved",
//     "severity":     "critical" | "warning",
//     "checkId":      number,
//     "checkName":    string,
//     "summary":      string,          // failure reason/step for an open
//     "runId":        number,
//     "failedStep":   string | null,
//     "screenshotUrl":string | null,
//     "dashboardUrl": string | null
//   }
const webhookChannel: AlertChannel = {
  name: 'webhook',
  isConfigured: () => Boolean(process.env.ALERT_WEBHOOK_URL),
  async send(p: AlertPayload): Promise<void> {
    const url = process.env.ALERT_WEBHOOK_URL;
    if (!url) return;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const auth = process.env.ALERT_WEBHOOK_AUTH_HEADER;
    if (auth) headers.authorization = auth;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        event: p.status,
        severity: p.severity,
        // pg returns BIGINT as a string; coerce so the JSON matches the
        // documented numeric contract.
        checkId: Number(p.checkId),
        checkName: p.checkName,
        summary: p.summary,
        runId: Number(p.runId),
        failedStep: p.failedStep ?? null,
        screenshotUrl: p.screenshotUrl ?? null,
        dashboardUrl: dashboardLink(p),
      }),
    });
    if (!res.ok) throw new Error(`webhook returned ${res.status}`);
  },
};

const CHANNELS: AlertChannel[] = [teamsChannel, emailChannel, webhookChannel];

/**
 * Fan out an incident OPEN/RESOLVE to every configured channel. Never throws:
 * each channel is awaited independently and failures are logged, so a dead
 * channel cannot fail the run or block incident recording.
 */
export async function dispatchAlerts(payload: AlertPayload): Promise<void> {
  const active = CHANNELS.filter((c) => c.isConfigured());
  if (active.length === 0) {
    console.log(
      `[alerts] ${payload.status} "${payload.checkName}" — no channels configured (skipped)`,
    );
    return;
  }

  const results = await Promise.allSettled(active.map((c) => c.send(payload)));
  results.forEach((r, i) => {
    const channel = active[i].name;
    if (r.status === 'rejected') {
      console.error(`[alerts] channel "${channel}" failed:`, r.reason);
    } else {
      console.log(
        `[alerts] channel "${channel}" delivered ${payload.status} for "${payload.checkName}"`,
      );
    }
  });
}
