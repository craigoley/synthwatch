// The notification canary — proof the alert path can actually reach a human, INVERTED so it is quiet when
// healthy and LOUD when broken.
//
// ★ THE INVERSION (why this module exists). The #298 canary dispatched a [TEST] alert through the real path
// to every enabled channel each tick: a SUCCESS delivered a "[SynthWatch][TEST] … WARNING" to the operator's
// alert inbox (a daily nag that trains you to ignore alerts), and a FAILURE simply didn't arrive — leaving
// only a runner_errors row nobody watched. Emails-on-pass, silent-on-fail: exactly backwards. Here:
//   • delivered → write the evidence row, DO NOT email. Proof-of-life is a fact you PULL (the row / a tile).
//   • failed / throws / times out → EMAIL the real critical channels, loudly, AND write a runner_errors row.
//   • the canary itself goes silent (no successful probe in > 2× the interval) → EMAIL + runner_errors. This
//     is the subtle half: a canary that only emails on failure is ALSO silent when it stops RUNNING, which is
//     indistinguishable from health. The staleness guard closes that fake-quiet.
//
// The probe still goes through the REAL ACS email transport (dispatchAlerts → sendEmail), so it genuinely
// proves the email provider works — but it is delivered to CANARY_EMAIL_TO (a deliverability mailbox the
// operator does not watch), NOT to the alert channels. So a healthy canary never touches the operator's
// inbox; the inbox goes quiet ONLY when everything is actually fine.
//
// Evidence lives in test_send_requests, keyed to the disabled '__canary__' channel (0088) — that channel_id
// both satisfies the FK and marks a row as a canary probe (vs a user "test this channel" send).
import { pool } from './db.js';
import { INVOCATION_ID } from './runnerErrors.js';
import {
  dispatchAlerts,
  resolveChannels,
  type AlertPayload,
  type Channel,
  type DispatchResult,
} from './alerts.js';

// ~daily, with slack so a missed tick still fires the next day. A probe is only sent when the last one is
// older than this (a healthy canary sends once/day, not every 5-min tick).
export const CANARY_INTERVAL_MS = 20 * 60 * 60 * 1000;
// The canary is "stale" — has stopped SUCCEEDING — once the newest delivered probe is older than this. 2×
// the interval tolerates one missed daily send before paging, so a single slow/long tick isn't a false red.
export const CANARY_STALE_MS = 2 * CANARY_INTERVAL_MS;

/** Recipient of the deliverability probe (env, alongside ALERT_EMAIL_FROM / ACS_EMAIL_CONNECTION_STRING). A
 *  mailbox the operator does NOT watch: a healthy canary lands here, not in the alert inbox. Unset ⇒ the
 *  email canary is disabled (surfaced as a throttled runner_errors row, never a silent no-op). */
function canaryRecipient(): string | undefined {
  const v = process.env.CANARY_EMAIL_TO?.trim();
  return v ? v : undefined;
}

/** The probe payload — a [TEST] send to the canary mailbox (checkId 0, no incident; flagged test). */
function probePayload(): AlertPayload {
  return {
    checkId: 0,
    checkName: 'Notification canary',
    severity: 'warning',
    status: 'open',
    summary:
      'Scheduled deliverability canary — proves the SynthWatch email transport can deliver. ' +
      'This is recorded, not paged: a healthy canary never reaches the alert inbox.',
    runId: null,
    test: true,
  };
}

/** A LOUD, REAL (not [TEST]) alert to the critical channels — the notifier itself is broken. */
function failurePayload(summary: string): AlertPayload {
  return {
    checkId: 0,
    checkName: 'Notification canary',
    severity: 'critical',
    status: 'open',
    summary,
    runId: null,
    test: false,
  };
}

/**
 * Injectable seams so tests can force delivered/failed/stale and assert whether the operator EMAIL fired —
 * without touching ACS or the wall clock. Defaults are the real implementations.
 *   sendProbe — delivers the probe to CANARY_EMAIL_TO through the REAL dispatch path.
 *   alertOps  — pages the REAL critical channels (resolveChannels(0,'critical')) through the same path.
 *   now       — the clock, for the staleness window.
 */
export interface CanaryDeps {
  sendProbe(to: string): Promise<DispatchResult>;
  alertOps(payload: AlertPayload): Promise<DispatchResult>;
  now(): number;
}

export const realCanaryDeps: CanaryDeps = {
  sendProbe(to: string): Promise<DispatchResult> {
    // A synthetic email channel targeting the canary mailbox — in-memory only (dispatchAlerts never reads the
    // DB for the channel it is handed), so its id/name are cosmetic. The transport (ACS conn string + sender)
    // still comes from env: this is the REAL send path, just aimed at the deliverability mailbox.
    const channel: Channel = {
      id: -1,
      name: '__canary__',
      type: 'email',
      config: { to: [to] },
      enabled: true,
    };
    return dispatchAlerts(probePayload(), [channel]);
  },
  async alertOps(payload: AlertPayload): Promise<DispatchResult> {
    // The operator's REAL critical channels — checkId 0 resolves to just the severity-default 'critical' route.
    const channels = await resolveChannels(0, 'critical');
    return dispatchAlerts(payload, channels);
  },
  now: () => Date.now(),
};

/** The disabled '__canary__' channel id (0088) — the FK anchor + discriminator for canary evidence rows. */
async function canaryChannelId(): Promise<number | null> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM channels WHERE name = '__canary__'`,
  );
  return rows[0] ? Number(rows[0].id) : null;
}

/** Write a runner_errors row for a canary problem — the DURABLE, greppable trail (the email is best-effort;
 *  if the email transport is what's broken, this row is the only record that survives log rotation). */
async function recordCanaryError(phase: string, message: string): Promise<void> {
  await pool.query(
    `INSERT INTO runner_errors (invocation_id, phase, check_id, message)
     VALUES ($1, $2, NULL, $3)`,
    [INVOCATION_ID, phase, message.slice(0, 500)],
  );
}

/** True if a runner_errors row for `phase` was written within CANARY_INTERVAL_MS — the alert cooldown, so a
 *  persistent problem pages ~once/interval instead of every 5-min tick. */
async function alertedRecently(phase: string, nowMs: number): Promise<boolean> {
  const { rows } = await pool.query<{ last: Date | null }>(
    `SELECT max(occurred_at) AS last FROM runner_errors WHERE phase = $1`,
    [phase],
  );
  const last = rows[0]?.last;
  return !!last && nowMs - new Date(last).getTime() < CANARY_INTERVAL_MS;
}

export type CanaryOutcome = 'sent' | 'failed' | 'not-due' | 'unconfigured';

/**
 * Send the scheduled canary probe IF it is due (last probe older than the interval). Delivered ⇒ record the
 * evidence row and STOP (no email). Failed/threw ⇒ record the row, page the critical channels, and write a
 * runner_errors row. Non-fatal by construction: a canary problem must never break the tick.
 */
export async function runCanaryIfDue(deps: CanaryDeps = realCanaryDeps): Promise<CanaryOutcome> {
  const nowMs = deps.now();
  const chanId = await canaryChannelId();
  if (chanId == null) {
    // The 0088 seed is missing — the canary can't record. Surface it (throttled) rather than fail silently.
    if (!(await alertedRecently('canary-misconfigured', nowMs))) {
      await recordCanaryError('canary-misconfigured', "'__canary__' channel missing — run migration 0088");
    }
    return 'unconfigured';
  }

  const to = canaryRecipient();
  if (!to) {
    // Unset CANARY_EMAIL_TO ⇒ the email canary is OFF. Never a silent no-op: leave a throttled runner_errors
    // row so "the canary isn't configured" is a one-grep fact, not an invisible gap.
    if (!(await alertedRecently('canary-misconfigured', nowMs))) {
      await recordCanaryError(
        'canary-misconfigured',
        'CANARY_EMAIL_TO unset on the runner — the notification email canary is disabled',
      );
    }
    return 'unconfigured';
  }

  // Due-check: skip if a canary probe was requested within the interval (healthy = once/day, not once/tick).
  const { rows } = await pool.query<{ last: Date | null }>(
    `SELECT max(requested_at) AS last FROM test_send_requests WHERE channel_id = $1`,
    [chanId],
  );
  const last = rows[0]?.last;
  if (last && nowMs - new Date(last).getTime() < CANARY_INTERVAL_MS) return 'not-due';

  // Claim an evidence row up-front (status 'sending') so a crash mid-send is reaped to 'failed' by the
  // existing stale-'sending' sweep (reapStaleRunning) rather than leaking.
  const { rows: ins } = await pool.query<{ id: string }>(
    `INSERT INTO test_send_requests (channel_id, status) VALUES ($1, 'sending') RETURNING id`,
    [chanId],
  );
  const rowId = Number(ins[0].id);

  let result: DispatchResult;
  try {
    result = await deps.sendProbe(to);
  } catch (e) {
    result = { active: 1, delivered: 0, results: [{ channelId: -1, name: '__canary__', type: 'email', ok: false, error: e instanceof Error ? e.message : String(e) }] };
  }

  if (result.delivered > 0) {
    // ★ SUCCESS = quiet. Record the fact; do NOT email. (A dashboard tile can read this row as "last canary OK".)
    await pool.query(
      `UPDATE test_send_requests SET status = 'delivered', detail = $2, completed_at = now() WHERE id = $1`,
      [rowId, `delivered via ACS to canary mailbox`],
    );
    console.log('[canary] probe delivered — recorded, no email (healthy)');
    return 'sent';
  }

  // ★ FAILURE = loud. Record the row, then page the REAL channels + write the durable runner_errors row.
  const detail =
    result.active === 0
      ? 'no deliverable email transport (ACS connection string / sender missing)'
      : result.results.find((r) => !r.ok)?.error ?? 'send failed (no detail)';
  await pool.query(
    `UPDATE test_send_requests SET status = 'failed', detail = $2, completed_at = now() WHERE id = $1`,
    [rowId, detail.slice(0, 500)],
  );
  const summary =
    `The notification canary FAILED to deliver a test email: ${detail}. Real alerts may not be reaching ` +
    `anyone — check ACS_EMAIL_CONNECTION_STRING / ALERT_EMAIL_FROM / CANARY_EMAIL_TO on the runner.`;
  await recordCanaryError('canary-delivery-failed', `canary probe ${rowId} FAILED: ${detail}`);
  // Best-effort page (never throws — dispatchAlerts isolates failures). If the email transport is what's
  // broken, this email won't arrive either — which is exactly why the runner_errors row above is written first.
  try {
    await deps.alertOps(failurePayload(summary));
  } catch (e) {
    console.error('[canary] failure page threw (non-fatal):', e);
  }
  console.error(`[canary] probe FAILED — paged + runner_errors written: ${detail}`);
  return 'failed';
}

/**
 * Pure staleness decision (exported for offline unit tests). Stale = the canary has stopped SUCCEEDING:
 *   • a delivery exists but the newest is older than CANARY_STALE_MS, OR
 *   • nothing has ever delivered but the canary has been ATTEMPTING for longer than the window.
 * A just-deployed runner (no delivery, no old attempt) is NOT stale — it hasn't had its first probe yet.
 * Args are epoch-ms or null.
 */
export function decideStale(lastDeliveredMs: number | null, firstAttemptMs: number | null, nowMs: number): boolean {
  if (lastDeliveredMs != null) return nowMs - lastDeliveredMs > CANARY_STALE_MS;
  return firstAttemptMs != null && nowMs - firstAttemptMs > CANARY_STALE_MS;
}

export type StalenessResult = 'fresh' | 'stale-alerted' | 'stale-throttled' | 'no-baseline';

/**
 * Staleness guard — the fake-quiet killer. A canary that only emails on FAILURE is ALSO silent when it stops
 * RUNNING (dead scheduler, broken due-logic, disabled canary): no failure email, no success email —
 * indistinguishable from health. This EMAILS if no probe has SUCCEEDED within CANARY_STALE_MS.
 *
 * Fresh-deploy guard: with no delivered probe yet, it only pages once the canary has been ATTEMPTING for
 * longer than the window (an old attempt with no delivery) — so a just-deployed runner isn't cried stale
 * before its first probe. Throttled to ~once/interval. Non-fatal.
 */
export async function checkCanaryStaleness(deps: CanaryDeps = realCanaryDeps): Promise<StalenessResult> {
  const nowMs = deps.now();
  const chanId = await canaryChannelId();
  if (chanId == null) return 'no-baseline';

  const { rows } = await pool.query<{ last_delivered: Date | null; first_attempt: Date | null }>(
    `SELECT max(completed_at) FILTER (WHERE status = 'delivered') AS last_delivered,
            min(requested_at)                                     AS first_attempt
       FROM test_send_requests
      WHERE channel_id = $1`,
    [chanId],
  );
  const lastDelivered = rows[0]?.last_delivered ? new Date(rows[0].last_delivered).getTime() : null;
  const firstAttempt = rows[0]?.first_attempt ? new Date(rows[0].first_attempt).getTime() : null;

  if (!decideStale(lastDelivered, firstAttempt, nowMs)) {
    return lastDelivered == null && firstAttempt == null ? 'no-baseline' : 'fresh';
  }

  if (await alertedRecently('canary-stale', nowMs)) return 'stale-throttled';

  const ageH = lastDelivered != null ? Math.round((nowMs - lastDelivered) / 3_600_000) : null;
  const summary =
    (ageH != null
      ? `No successful notification canary in ~${ageH}h`
      : `The notification canary has never succeeded despite running for over ${Math.round(CANARY_STALE_MS / 3_600_000)}h`) +
    ` (expected every ~${Math.round(CANARY_INTERVAL_MS / 3_600_000)}h). The canary may have stopped running or ` +
    `the email transport is down — if the email provider is dead, alerts are NOT reaching anyone.`;
  await recordCanaryError('canary-stale', summary);
  try {
    await deps.alertOps(failurePayload(summary));
  } catch (e) {
    console.error('[canary] staleness page threw (non-fatal):', e);
  }
  console.error(`[canary] STALE — paged + runner_errors written: ${summary}`);
  return 'stale-alerted';
}
