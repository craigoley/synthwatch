// Alert delivery — a small channel abstraction.
//
// This open-source engine ships only VENDOR-NEUTRAL channels: EMAIL (Azure
// Communication Services) and a GENERIC WEBHOOK. Vendor-specific chat/paging
// channels (PagerDuty, Slack, etc.) are intentionally NOT in core — wire them
// either:
//   1. via the generic webhook (point ALERT_WEBHOOK_URL at the vendor's inbound
//      endpoint; it receives the documented JSON payload), or
//   2. in a fork, by implementing the AlertChannel interface below and adding it
//      to CHANNELS — no change to core needed.
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

// Hard ceiling on any single outbound send. dispatchAlerts is awaited in the run
// tick, and Promise.allSettled isolates REJECTIONS but not HANGS — a webhook (or
// ACS endpoint) that accepts the TCP connection and never responds would otherwise
// wedge the whole tick indefinitely. Guarded parse (NaN-safe) -> 10s default.
const ALERT_TIMEOUT_MS = Number(process.env.ALERT_TIMEOUT_MS) || 10000;

/**
 * Reject if `p` doesn't settle within `ms`. The timer is unref'd so it can't keep
 * the process alive, and a late timeout after `p` already settled is harmless (the
 * race result is fixed). Used to bound outbound sends that have no native timeout.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      t.unref?.();
    }),
  ]);
}

export interface AlertPayload {
  checkId: number;
  checkName: string;
  severity: 'critical' | 'warning';
  // Event type — controls message wording (routing is decided by the caller via
  // the alert profile). 'warn' = a degraded-but-available notice (no incident).
  status: 'open' | 'resolved' | 'warn';
  /** Human summary; for an OPEN this carries the failure reason/step. */
  summary: string;
  // The triggering run, or null for budget-level alerts (SLO burn) that aren't tied
  // to a single run — rendered as omitted rather than a bogus "Run #0".
  runId: number | null;
  failedStep?: string | null;
  screenshotUrl?: string | null;
}

/**
 * One delivery channel. Configured purely from env; send() may throw — the
 * dispatcher isolates it. This is the fork extension point: implement this and
 * add the channel to CHANNELS to support any vendor without touching core.
 */
interface AlertChannel {
  readonly name: string;
  isConfigured(): boolean;
  send(p: AlertPayload): Promise<void>;
}

function subjectLine(p: AlertPayload): string {
  const verb =
    p.status === 'open' ? 'OPENED' : p.status === 'resolved' ? 'RESOLVED' : 'WARN';
  return `[SynthWatch][${p.severity}] ${verb}: ${p.checkName}`;
}

/** Deep link to the check in the dashboard, or null if DASHBOARD_URL is unset. */
function dashboardLink(p: AlertPayload): string | null {
  const base = process.env.DASHBOARD_URL;
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}/checks/${p.checkId}`;
}

function bodyText(p: AlertPayload): string {
  const lines = [subjectLine(p), '', p.summary];
  if (p.runId != null) lines.push(`Run: #${p.runId}`);
  if (p.failedStep) lines.push(`Failed step: ${p.failedStep}`);
  if (p.screenshotUrl) lines.push(`Screenshot: ${p.screenshotUrl}`);
  const link = dashboardLink(p);
  if (link) lines.push(`Dashboard: ${link}`);
  return lines.join('\n');
}

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
    // Bound the whole send (initial POST + poll) — a hung ACS endpoint must not
    // stall the tick. The rejection is isolated by dispatchAlerts.
    await withTimeout(
      (async () => {
        const poller = await client.beginSend({
          senderAddress,
          content: { subject: subjectLine(p), plainText: bodyText(p) },
          recipients: { to: to.split(',').map((address) => ({ address: address.trim() })) },
        });
        await poller.pollUntilDone();
      })(),
      ALERT_TIMEOUT_MS,
      'ACS email send',
    );
  },
};

// --- Channel: generic webhook ----------------------------------------------
// The vendor-neutral escape hatch — point it at PagerDuty / Slack / any HTTP
// endpoint that ingests a POST. Env: ALERT_WEBHOOK_URL (+ optional
// ALERT_WEBHOOK_AUTH_HEADER, the full Authorization header value, e.g.
// "Bearer <token>" or "Basic <base64>").
//
// Payload (application/json):
//   {
//     "event":        "open" | "resolved" | "warn",
//     "severity":     "critical" | "warning",
//     "checkId":      number,
//     "checkName":    string,
//     "summary":      string,          // failure reason/step for an open
//     "runId":        number | null,    // null for budget-level (SLO burn) alerts

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
      // Bound the request — a webhook that accepts TCP but never responds would
      // otherwise hang the tick (allSettled isolates rejections, not hangs).
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
      body: JSON.stringify({
        event: p.status,
        severity: p.severity,
        // pg returns BIGINT as a string; coerce so the JSON matches the
        // documented numeric contract.
        checkId: Number(p.checkId),
        checkName: p.checkName,
        summary: p.summary,
        // null for budget-level (SLO burn) alerts not tied to a single run.
        runId: p.runId == null ? null : Number(p.runId),
        failedStep: p.failedStep ?? null,
        screenshotUrl: p.screenshotUrl ?? null,
        dashboardUrl: dashboardLink(p),
      }),
    });
    if (!res.ok) throw new Error(`webhook returned ${res.status}`);
  },
};

const CHANNELS: AlertChannel[] = [emailChannel, webhookChannel];

/**
 * Fan out an alert to the requested channels that are also CONFIGURED. The
 * caller (evaluate.ts) decides `channelNames` from the check's alert profile;
 * `undefined` means "all channels" (legacy fallback when no profile exists). A
 * channel named by a profile but missing its env config is silently skipped.
 *
 * Never throws: each channel is awaited independently and failures are logged, so
 * a dead channel cannot fail the run or block incident recording.
 */
export async function dispatchAlerts(
  payload: AlertPayload,
  channelNames?: string[],
): Promise<void> {
  const want = channelNames === undefined ? null : new Set(channelNames);
  const active = CHANNELS.filter(
    (c) => (want === null || want.has(c.name)) && c.isConfigured(),
  );
  if (active.length === 0) {
    console.log(
      `[alerts] ${payload.status} "${payload.checkName}" — no matching configured channels (skipped)`,
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
