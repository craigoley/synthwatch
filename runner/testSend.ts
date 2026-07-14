// Channel test-sends — drained at runner startup, delivered through the EXACT real alert
// path (dispatchAlerts -> sendEmail/sendWebhook). The whole point: a "test" must prove the
// REAL path works, so this writes NO new send code — it builds a [TEST] payload and hands
// it to dispatchAlerts, the same function real alerts use.
//
// Flow: the API writes a 'pending' test_send_requests row + triggers `az containerapp job
// start` (no env override -> all secretRefs preserved). The runner drains pending rows
// here BEFORE the check loop and marks each delivered/failed. The on-demand start makes it
// ~seconds; a normal cron tick also drains as a fallback.
import { pool } from './db.js';
import { INVOCATION_ID } from './runnerErrors.js';
import {
  dispatchAlerts,
  getChannelById,
  channelDeliverabilityReason,
  type AlertPayload,
} from './alerts.js';

// ★ CANARY (0082): re-enqueue a scheduled test-send if the last one is older than this. The notifier is
// otherwise the only unmonitored component — 27 incidents opened and nothing had ever PROVEN a channel
// delivers. A canary that reds (writes runner_errors on failure, below) fixes that.
const CANARY_INTERVAL_MS = 20 * 60 * 60 * 1000; // ~daily, with slack so a missed tick still fires next day

/**
 * If no channel test-send has been requested within CANARY_INTERVAL_MS, enqueue one per enabled channel.
 * Delivered on the next drainTestSends through the REAL dispatch path; a failure writes runner_errors (see
 * finish()). Best-effort + idempotent-enough: a rare duplicate canary across region runners is harmless.
 */
export async function maybeEnqueueCanary(): Promise<number> {
  const { rows } = await pool.query<{ last: Date | null }>(
    `SELECT max(requested_at) AS last FROM test_send_requests`,
  );
  const last = rows[0]?.last;
  if (last && Date.now() - new Date(last).getTime() < CANARY_INTERVAL_MS) return 0;
  const { rowCount } = await pool.query(
    `INSERT INTO test_send_requests (channel_id) SELECT id FROM channels WHERE enabled`,
  );
  if (rowCount) console.log(`[canary] enqueued ${rowCount} scheduled channel canary send(s)`);
  return rowCount ?? 0;
}

/** A [TEST] alert payload — checkId 0, no incident; only the content is flagged test. */
function testPayload(channelName: string): AlertPayload {
  return {
    checkId: 0,
    checkName: `Channel test — ${channelName}`,
    severity: 'warning',
    status: 'open',
    summary:
      `This is a TEST alert from SynthWatch. If you received it, the "${channelName}" ` +
      `channel is configured correctly and real alerts will reach you. No incident occurred.`,
    runId: null,
    test: true,
  };
}

async function finish(id: number, status: 'delivered' | 'failed', detail: string): Promise<void> {
  await pool.query(
    `UPDATE test_send_requests SET status = $2, detail = $3, completed_at = now() WHERE id = $1`,
    [id, status, detail.slice(0, 500)],
  );
  // ★ LOUD (0082): a failed test/canary send must red, not vanish — surface it in runner_errors so a broken
  // notifier is caught by the same "who watches the watcher" path as a failed real alert.
  if (status === 'failed') {
    await pool.query(
      `INSERT INTO runner_errors (invocation_id, phase, check_id, message)
       VALUES ($1, 'test-send-failed', NULL, $2)`,
      [INVOCATION_ID, `channel test/canary send ${id} FAILED delivery: ${detail.slice(0, 300)}`],
    );
  }
}

/**
 * Drain pending channel test-sends. Returns how many were processed (0 = none pending, the
 * normal-tick case). Each row is sent through the real dispatch path and marked
 * delivered/failed with a reason. Race-safe across region runners: the `status = 'pending'`
 * guard + row locks mean a row claimed by one runner is skipped by the other.
 */
export async function drainTestSends(): Promise<number> {
  const claimed = await pool.query<{ id: string; channel_id: string }>(
    `UPDATE test_send_requests SET status = 'sending'
      WHERE status = 'pending'
      RETURNING id, channel_id`,
  );
  if (claimed.rows.length === 0) return 0;

  for (const req of claimed.rows) {
    const id = Number(req.id);
    const channelId = Number(req.channel_id);
    try {
      const channel = await getChannelById(channelId);
      if (!channel) {
        await finish(id, 'failed', `channel ${channelId} not found`);
        continue;
      }
      // Pre-check transport so a not-deliverable channel gets a clear reason (dispatch
      // would otherwise silently skip it).
      const reason = channelDeliverabilityReason(channel);
      if (reason) {
        await finish(id, 'failed', reason);
        continue;
      }
      // THE REAL PATH — the same dispatchAlerts real alerts use, to this one channel.
      const res = await dispatchAlerts(testPayload(channel.name), [channel]);
      if (res.delivered > 0) {
        await finish(id, 'delivered', `sent via ${channel.type} to "${channel.name}"`);
      } else {
        await finish(id, 'failed', res.results[0]?.error ?? 'send failed (no detail)');
      }
    } catch (e) {
      await finish(id, 'failed', e instanceof Error ? e.message : String(e));
    }
  }
  return claimed.rows.length;
}
