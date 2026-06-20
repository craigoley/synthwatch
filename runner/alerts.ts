// Pluggable alert channels: Azure Communication Services email, Microsoft Teams
// incoming webhook, and xMatters inbound integration.
//
// Every channel is 100% env-config driven. An absent env var means that channel
// is DISABLED — no errors, it just doesn't fire. NOTHING tenant-specific lives
// in source (this repo is public OSS); all addresses, URLs and connection
// strings come from the environment. Channels are dispatched concurrently and
// failures are isolated (one dead webhook never blocks the others).
import { EmailClient } from '@azure/communication-email';

export interface AlertPayload {
  checkName: string;
  severity: 'critical' | 'warning';
  status: 'open' | 'resolved';
  summary: string;
  runId: number;
  failedStep?: string | null;
  screenshotUrl?: string | null;
}

/** Fan out to every configured channel. Never throws. */
export async function dispatchAlerts(payload: AlertPayload): Promise<void> {
  const results = await Promise.allSettled([
    sendEmail(payload),
    sendTeams(payload),
    sendXMatters(payload),
  ]);
  for (const r of results) {
    if (r.status === 'rejected') {
      console.error('[alerts] channel failed:', r.reason);
    }
  }
}

function subjectLine(p: AlertPayload): string {
  const verb = p.status === 'open' ? 'OPENED' : 'RESOLVED';
  return `[SynthWatch][${p.severity}] ${verb}: ${p.checkName}`;
}

function bodyText(p: AlertPayload): string {
  const lines = [
    subjectLine(p),
    '',
    p.summary,
    `Run: #${p.runId}`,
  ];
  if (p.failedStep) lines.push(`Failed step: ${p.failedStep}`);
  if (p.screenshotUrl) lines.push(`Screenshot: ${p.screenshotUrl}`);
  return lines.join('\n');
}

// --- Channel 1: Azure Communication Services email -------------------------
// Requires: ACS_EMAIL_CONNECTION_STRING, ALERT_EMAIL_FROM, ALERT_EMAIL_TO
// (ALERT_EMAIL_TO may be a comma-separated list).
async function sendEmail(p: AlertPayload): Promise<void> {
  const connectionString = process.env.ACS_EMAIL_CONNECTION_STRING;
  const senderAddress = process.env.ALERT_EMAIL_FROM;
  const to = process.env.ALERT_EMAIL_TO;
  if (!connectionString || !senderAddress || !to) return; // disabled

  const client = new EmailClient(connectionString);
  const poller = await client.beginSend({
    senderAddress,
    content: {
      subject: subjectLine(p),
      plainText: bodyText(p),
    },
    recipients: {
      to: to.split(',').map((address) => ({ address: address.trim() })),
    },
  });
  await poller.pollUntilDone();
}

// --- Channel 2: Microsoft Teams incoming webhook ---------------------------
// Requires: TEAMS_WEBHOOK_URL
async function sendTeams(p: AlertPayload): Promise<void> {
  const url = process.env.TEAMS_WEBHOOK_URL;
  if (!url) return; // disabled

  const card = {
    '@type': 'MessageCard',
    '@context': 'https://schema.org/extensions',
    summary: subjectLine(p),
    themeColor: p.status === 'open' ? 'D7263D' : '2EB67D',
    title: subjectLine(p),
    text: bodyText(p).replace(/\n/g, '\n\n'),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(card),
  });
  if (!res.ok) {
    throw new Error(`Teams webhook returned ${res.status}`);
  }
}

// --- Channel 3: xMatters inbound integration -------------------------------
// Requires: XMATTERS_INBOUND_URL
// Optional: XMATTERS_AUTH_HEADER (full value for the Authorization header,
//           e.g. "Basic <base64>" or "Bearer <token>").
async function sendXMatters(p: AlertPayload): Promise<void> {
  const url = process.env.XMATTERS_INBOUND_URL;
  if (!url) return; // disabled

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const auth = process.env.XMATTERS_AUTH_HEADER;
  if (auth) headers.authorization = auth;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      // Generic inbound payload — map these to properties in your xMatters flow.
      checkName: p.checkName,
      severity: p.severity,
      status: p.status,
      summary: p.summary,
      runId: p.runId,
      failedStep: p.failedStep ?? null,
      screenshotUrl: p.screenshotUrl ?? null,
    }),
  });
  if (!res.ok) {
    throw new Error(`xMatters inbound returned ${res.status}`);
  }
}
