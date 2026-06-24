// Rich HTML alert email (open / resolved / warn). Email is a HOSTILE rendering env:
//   - TABLE layout (role="presentation"), NEVER flex/grid (clients don't support them).
//   - INLINE styles only (Gmail strips <style>/<head> CSS).
//   - System font stack; explicit colors that read in light AND dark mode.
//   - Bulletproof button = a table-cell <a> with padding + bg-color.
// Returns BOTH html and a plaintext alternative (multipart/alternative).
//
// Designed to be EASY TO TWEAK: all palette + copy live in small helpers at the top.
import type { AlertPayload } from './alerts.js';

// --- palette (tweak here) ---------------------------------------------------
const INK = '#1a1a1a';
const MUTED = '#667085';
const BORDER = '#e4e7ec';
const CARD = '#ffffff';
const PAGE = '#f2f4f7';
const WHITE = '#ffffff';
// Header/button colour by event. Resolved = green regardless of severity (a recovery);
// open/warn = severity colour. Chosen dark enough that WHITE text reads in light + dark.
const RED = '#b42318';
const AMBER = '#b54708';
const GREEN = '#067647';

const FONT =
  "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

interface Theme {
  color: string;
  label: string; // OPENED | RESOLVED | WARNING
}
function theme(p: AlertPayload): Theme {
  // Enrichment follow-up — still the same (open) incident's severity colour, but labelled
  // RCA READY so it reads as an update, not a fresh page.
  if (p.rcaReady) return { color: p.severity === 'warning' ? AMBER : RED, label: 'RCA READY' };
  if (p.status === 'resolved') return { color: GREEN, label: 'RESOLVED' };
  if (p.status === 'warn') return { color: AMBER, label: 'WARNING' };
  return { color: p.severity === 'warning' ? AMBER : RED, label: 'OPENED' };
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Readable timestamp in UTC (email recipients span timezones; UTC is unambiguous). */
function fmtTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/** "2h 5m", "12m", "45s" between two ISO times — for the resolved duration. */
function fmtDuration(fromIso?: string | null, toIso?: string | null): string | null {
  if (!fromIso || !toIso) return null;
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** The "View incident" link: the incident detail page if we have an incident id, else
 *  the check page. Null when DASHBOARD_URL is unset (the button is then omitted). */
export function viewLink(p: AlertPayload): string | null {
  const base = process.env.DASHBOARD_URL;
  if (!base) return null;
  const root = base.replace(/\/+$/, '');
  return p.incident?.incidentId
    ? `${root}/incidents/${p.incident.incidentId}`
    : `${root}/checks/${p.checkId}`;
}

// One label/value row in the facts table.
function factRow(label: string, value: string): string {
  return (
    `<tr>` +
    `<td style="padding:6px 16px 6px 0;color:${MUTED};font-size:13px;white-space:nowrap;vertical-align:top">${esc(label)}</td>` +
    `<td style="padding:6px 0;color:${INK};font-size:13px;font-weight:600">${value}</td>` +
    `</tr>`
  );
}

function facts(p: AlertPayload): string {
  const inc = p.incident ?? undefined;
  const rows: string[] = [];
  rows.push(factRow('Severity', esc(p.severity)));
  const when = fmtTime(inc?.openedAt);
  if (when) rows.push(factRow(p.status === 'resolved' ? 'Started' : 'When', when));
  if (p.status === 'resolved') {
    const dur = fmtDuration(inc?.openedAt, inc?.resolvedAt);
    if (dur) rows.push(factRow('Duration', esc(dur)));
  }
  if (inc?.locations && inc.locations.length > 0) {
    rows.push(factRow('Locations', esc(inc.locations.join(', '))));
  }
  if (inc?.consecutiveFailures != null && p.status !== 'resolved') {
    rows.push(factRow('Failures', `${inc.consecutiveFailures} consecutive`));
  }
  if (inc?.targetUrl) {
    rows.push(factRow('Target', `<span style="word-break:break-all">${esc(inc.targetUrl)}</span>`));
  }
  if (p.failedStep) rows.push(factRow('Failed step', esc(p.failedStep)));
  if (p.runId != null && p.status !== 'resolved') rows.push(factRow('Run', `#${p.runId}`));
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${rows.join('')}</table>`;
}

/** RCA summary block — "Likely: real outage (high confidence)" + a line. Only when present. */
function rcaBlock(p: AlertPayload): string {
  const rca = p.incident?.rca;
  if (!rca) return '';
  const cls = esc(rca.classification.replace(/-/g, ' '));
  const conf = esc(rca.confidence);
  const line = rca.summary ? `<div style="margin-top:6px;color:${INK};font-size:13px;line-height:1.5">${esc(rca.summary)}</div>` : '';
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:20px 0 4px">` +
    `<tr><td style="background:#f8f9fc;border:1px solid ${BORDER};border-radius:8px;padding:14px 16px">` +
    `<div style="color:${MUTED};font-size:11px;letter-spacing:.04em;text-transform:uppercase;font-weight:700">AI root-cause</div>` +
    `<div style="margin-top:4px;color:${INK};font-size:14px;font-weight:600">Likely: ${cls} <span style="color:${MUTED};font-weight:500">(${conf} confidence)</span></div>` +
    line +
    `</td></tr></table>`
  );
}

function button(p: AlertPayload, t: Theme): string {
  const url = viewLink(p);
  if (!url) return '';
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 4px">` +
    `<tr><td align="center" bgcolor="${t.color}" style="border-radius:8px">` +
    `<a href="${esc(url)}" target="_blank" ` +
    `style="display:inline-block;padding:12px 28px;font-family:${FONT};font-size:14px;font-weight:600;color:${WHITE};text-decoration:none;border-radius:8px">` +
    `View incident &rarr;</a>` +
    `</td></tr></table>`
  );
}

/** The HTML body — table layout, inline styles, system fonts, severity-coloured header. */
export function alertHtml(p: AlertPayload): string {
  const t = theme(p);
  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    // color-scheme hints so dark-mode clients don't aggressively re-tint the card.
    `<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">` +
    `</head>` +
    `<body style="margin:0;padding:0;background:${PAGE}">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${PAGE}">` +
    `<tr><td align="center" style="padding:24px 12px">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:${CARD};border:1px solid ${BORDER};border-radius:12px;overflow:hidden">` +
    // severity header bar
    `<tr><td style="background:${t.color};padding:18px 24px;font-family:${FONT}">` +
    `<span style="display:inline-block;background:rgba(255,255,255,.22);color:${WHITE};font-size:11px;font-weight:700;letter-spacing:.06em;padding:3px 9px;border-radius:6px">${esc(p.severity.toUpperCase())}</span>` +
    `<span style="color:${WHITE};font-size:12px;font-weight:700;letter-spacing:.06em;margin-left:8px;opacity:.92">${t.label}</span>` +
    `<div style="color:${WHITE};font-size:20px;font-weight:700;margin-top:8px;line-height:1.3">${esc(p.checkName)}</div>` +
    `</td></tr>` +
    // body
    `<tr><td style="padding:22px 24px;font-family:${FONT}">` +
    `<div style="color:${INK};font-size:15px;line-height:1.5;margin-bottom:16px">${esc(p.summary)}</div>` +
    facts(p) +
    rcaBlock(p) +
    button(p, t) +
    `</td></tr>` +
    // footer
    `<tr><td style="padding:14px 24px;border-top:1px solid ${BORDER};font-family:${FONT};color:${MUTED};font-size:12px">` +
    `SynthWatch &middot; synthetic monitoring` +
    `</td></tr>` +
    `</table></td></tr></table></body></html>`
  );
}

/** Plaintext alternative (multipart) — some clients/users get text only. */
export function alertText(p: AlertPayload): string {
  const t = theme(p);
  const inc = p.incident ?? undefined;
  const lines = [`[SynthWatch][${p.severity}] ${t.label}: ${p.checkName}`, '', p.summary, ''];
  const when = fmtTime(inc?.openedAt);
  if (when) lines.push(`${p.status === 'resolved' ? 'Started' : 'When'}: ${when}`);
  if (p.status === 'resolved') {
    const dur = fmtDuration(inc?.openedAt, inc?.resolvedAt);
    if (dur) lines.push(`Duration: ${dur}`);
  }
  if (inc?.locations?.length) lines.push(`Locations: ${inc.locations.join(', ')}`);
  if (inc?.consecutiveFailures != null && p.status !== 'resolved') lines.push(`Failures: ${inc.consecutiveFailures} consecutive`);
  if (inc?.targetUrl) lines.push(`Target: ${inc.targetUrl}`);
  if (p.failedStep) lines.push(`Failed step: ${p.failedStep}`);
  if (p.runId != null && p.status !== 'resolved') lines.push(`Run: #${p.runId}`);
  if (inc?.rca) lines.push('', `AI root-cause — Likely: ${inc.rca.classification.replace(/-/g, ' ')} (${inc.rca.confidence} confidence)${inc.rca.summary ? `\n${inc.rca.summary}` : ''}`);
  const url = viewLink(p);
  if (url) lines.push('', `View incident: ${url}`);
  return lines.join('\n');
}

/** Build the email body (html + plaintext alternative) for an alert. */
export function buildAlertEmail(p: AlertPayload): { html: string; text: string } {
  return { html: alertHtml(p), text: alertText(p) };
}
