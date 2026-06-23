// Alert delivery — dashboard-managed channels (v1).
//
// THE SPLIT: a channel's TARGET (recipients / webhook URL) + the ROUTING (which alert
// -> which channel) live in the DB (channels + alert_routes tables, dashboard-managed).
// Only the TRANSPORT CREDENTIAL — the ACS email connection string — stays an infra
// secret in env (ACS_EMAIL_CONNECTION_STRING). resolveChannels() reads the DB; the
// caller passes the resolved Channel[] to dispatchAlerts(). (Previously recipients/URL
// came from env — that conflation is what this removes.)
//
// Vendor chat/paging (PagerDuty/Slack/...) is reached via a webhook channel whose URL
// points at the vendor's inbound endpoint.
//
// Delivery is NON-FATAL: dispatchAlerts() never throws, and one dead channel never
// blocks the others or the incident (recorded BEFORE alerts fire — see evaluate.ts).
// Fires on incident OPEN / RESOLVE and the warn path.
import { EmailClient } from '@azure/communication-email';
import { pool } from './db.js';

// Hard ceiling on any single outbound send. dispatchAlerts is awaited in the run
// tick, and Promise.allSettled isolates REJECTIONS but not HANGS — a webhook (or
// ACS endpoint) that accepts the TCP connection and never responds would otherwise
// wedge the whole tick indefinitely. Guarded parse: only a FINITE POSITIVE override
// wins — NaN ("abc"), 0, or a negative (which would make AbortSignal.timeout reject
// immediately / throw) all fall back to the 10s default.
const ALERT_TIMEOUT_MS = (() => {
  const n = Number(process.env.ALERT_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 10000;
})();

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
 * A delivery channel — a TARGET loaded from the DB `channels` table (NOT env). `config`
 * holds the target: email -> {to, from}; webhook -> {url, authHeader?}. The transport
 * SECRET (ACS connection string) still comes from env — only targets + routing are DB.
 * `type` drives which send fn runs.
 */
export interface Channel {
  id: number;
  name: string;
  type: 'email' | 'webhook';
  config: { to?: string[]; from?: string; url?: string; authHeader?: string };
  enabled: boolean;
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

// --- Delivery: Azure Communication Services email --------------------------
// Transport SECRET (ACS connection string) from env; sender + recipients from the
// channel's DB config. Builder is exported so a test can assert the recipients without
// touching ACS.
export function buildEmailMessage(from: string, to: string[], p: AlertPayload) {
  return {
    senderAddress: from,
    content: { subject: subjectLine(p), plainText: bodyText(p) },
    recipients: { to: to.map((address) => ({ address: address.trim() })) },
  };
}

async function sendEmail(c: Channel, p: AlertPayload): Promise<void> {
  const connectionString = process.env.ACS_EMAIL_CONNECTION_STRING;
  const from = c.config.from;
  const to = c.config.to ?? [];
  if (!connectionString || !from || to.length === 0) return;
  const client = new EmailClient(connectionString);
  // Bound the whole send (initial POST + poll) — a hung ACS endpoint must not stall
  // the tick. The rejection is isolated by dispatchAlerts.
  await withTimeout(
    (async () => {
      const poller = await client.beginSend(buildEmailMessage(from, to, p));
      await poller.pollUntilDone();
    })(),
    ALERT_TIMEOUT_MS,
    'ACS email send',
  );
}

// --- Delivery: generic webhook ---------------------------------------------
// URL (+ optional full Authorization header) from the channel's DB config. The URL may
// embed a token (acceptable for v1). Payload (application/json):
//   { event, severity, checkId, checkName, summary, runId|null, failedStep, screenshotUrl, dashboardUrl }
async function sendWebhook(c: Channel, p: AlertPayload): Promise<void> {
  const url = c.config.url;
  if (!url) return;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (c.config.authHeader) headers.authorization = c.config.authHeader;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    // Bound the request — a webhook that accepts TCP but never responds would
    // otherwise hang the tick (allSettled isolates rejections, not hangs).
    signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    body: JSON.stringify({
      event: p.status,
      severity: p.severity,
      checkId: Number(p.checkId),
      checkName: p.checkName,
      summary: p.summary,
      runId: p.runId == null ? null : Number(p.runId),
      failedStep: p.failedStep ?? null,
      screenshotUrl: p.screenshotUrl ?? null,
      dashboardUrl: dashboardLink(p),
    }),
  });
  if (!res.ok) throw new Error(`webhook returned ${res.status}`);
}

/**
 * A channel is DELIVERABLE when enabled AND its transport is available: email needs the
 * ACS connection string (env) + a sender + >=1 recipient; webhook needs a URL. (The
 * target came from the DB; the transport secret from env.)
 */
export function channelDeliverable(c: Channel): boolean {
  if (!c.enabled) return false;
  if (c.type === 'email') {
    return Boolean(
      process.env.ACS_EMAIL_CONNECTION_STRING && c.config.from && c.config.to && c.config.to.length > 0,
    );
  }
  if (c.type === 'webhook') return Boolean(c.config.url);
  return false;
}

interface ChannelRow { id: string; name: string; type: string; config: unknown; enabled: boolean }
function mapChannel(r: ChannelRow): Channel {
  const cfg = (typeof r.config === 'object' && r.config !== null ? r.config : {}) as Channel['config'];
  return { id: Number(r.id), name: r.name, type: r.type as Channel['type'], config: cfg, enabled: r.enabled };
}

/**
 * Resolve the channel set for an alert on (checkId, severity) from the DB:
 *   - a PER-CHECK route (alert_routes.check_id = checkId) OVERRIDES, if any exist;
 *   - else the SEVERITY default (alert_routes.severity = severity, check_id IS NULL).
 * Override (per-check REPLACES the severity default), not union. De-duped by channel id;
 * only enabled channels returned (transport/deliverability is checked at dispatch).
 */
export async function resolveChannels(checkId: number, severity: 'critical' | 'warning'): Promise<Channel[]> {
  const perCheck = await pool.query<ChannelRow>(
    `SELECT ch.id, ch.name, ch.type, ch.config, ch.enabled
       FROM alert_routes r JOIN channels ch ON ch.id = r.channel_id
      WHERE r.check_id = $1 AND ch.enabled`,
    [checkId],
  );
  const rows = perCheck.rows.length > 0
    ? perCheck.rows
    : (
        await pool.query<ChannelRow>(
          `SELECT ch.id, ch.name, ch.type, ch.config, ch.enabled
             FROM alert_routes r JOIN channels ch ON ch.id = r.channel_id
            WHERE r.severity = $1 AND r.check_id IS NULL AND ch.enabled`,
          [severity],
        )
      ).rows;
  const seen = new Set<number>();
  const out: Channel[] = [];
  for (const r of rows) {
    const c = mapChannel(r);
    if (!seen.has(c.id)) {
      seen.add(c.id);
      out.push(c);
    }
  }
  return out;
}

/**
 * Fan out an alert to the resolved channels (from resolveChannels) that are also
 * DELIVERABLE (transport available — see channelDeliverable). A routed channel whose
 * transport is missing (e.g. email with no ACS connection string yet) is silently
 * skipped, same as before — but the TARGET now came from the DB, not env.
 *
 * Never throws: each send is awaited independently and failures are logged, so a dead
 * channel cannot fail the run or block incident recording.
 *
 * Returns {active, delivered}: how many were tried and how many succeeded — lets the
 * warn path avoid stamping "notified" when every channel failed (retry next tick).
 */
export interface DispatchResult {
  active: number;
  delivered: number;
}

export async function dispatchAlerts(
  payload: AlertPayload,
  channels: Channel[],
): Promise<DispatchResult> {
  const active = channels.filter(channelDeliverable);
  if (active.length === 0) {
    console.log(
      `[alerts] ${payload.status} "${payload.checkName}" — no deliverable channels (skipped)`,
    );
    return { active: 0, delivered: 0 };
  }

  const results = await Promise.allSettled(
    active.map((c) => (c.type === 'email' ? sendEmail(c, payload) : sendWebhook(c, payload))),
  );
  let delivered = 0;
  results.forEach((r, i) => {
    const ch = active[i];
    if (r.status === 'rejected') {
      console.error(`[alerts] channel "${ch.name}" (${ch.type}) failed:`, r.reason);
    } else {
      delivered++;
      console.log(
        `[alerts] channel "${ch.name}" (${ch.type}) delivered ${payload.status} for "${payload.checkName}"`,
      );
    }
  });
  return { active: active.length, delivered };
}
