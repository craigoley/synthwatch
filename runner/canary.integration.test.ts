// LIVE integration proof of the INVERTED notification canary (0088). Runs only when DATABASE_URL is set
// (skipped offline; exercised by the "Test (Node + Postgres)" job).
//
// ★ THE THREE INVARIANTS, each a must-go-red:
//   1. delivered ⇒ evidence row written, the operator EMAIL path is NOT called. (Success is quiet.)
//   2. failed    ⇒ EMAIL path called AND a runner_errors row (phase canary-delivery-failed). (Failure is loud.)
//   3. stale     ⇒ EMAIL path called AND a runner_errors row (phase canary-stale). (A silent canary is loud.)
// If any of these regressed — e.g. success started emailing again, or failure went back to silent — the
// matching test flips red. That is the whole point: the canary must be quiet iff everything is fine.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from './db.js';
import {
  runCanaryIfDue,
  checkCanaryStaleness,
  CANARY_STALE_MS,
  type CanaryDeps,
} from './canary.js';
import type { AlertPayload, DispatchResult } from './alerts.js';

const SKIP = !process.env.DATABASE_URL;

const SENT: DispatchResult = { active: 1, delivered: 1, results: [{ channelId: -1, name: '__canary__', type: 'email', ok: true }] };
const FAILED: DispatchResult = { active: 1, delivered: 0, results: [{ channelId: -1, name: '__canary__', type: 'email', ok: false, error: 'ACS 500' }] };

async function canaryChannelId(): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM channels WHERE name = '__canary__'`);
  assert.ok(rows[0], "the '__canary__' channel (migration 0088) must exist");
  return Number(rows[0].id);
}

/** Wipe canary state so each case starts clean (due-check + throttle both read this). */
async function reset(chanId: number): Promise<void> {
  await pool.query(`DELETE FROM test_send_requests WHERE channel_id = $1`, [chanId]);
  await pool.query(`DELETE FROM runner_errors WHERE phase LIKE 'canary-%'`);
}

async function canaryErrorCount(phase: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM runner_errors WHERE phase = $1`, [phase]);
  return Number(rows[0].n);
}
async function latestCanaryRow(chanId: number) {
  const { rows } = await pool.query<{ status: string; detail: string | null }>(
    `SELECT status, detail FROM test_send_requests WHERE channel_id = $1 ORDER BY id DESC LIMIT 1`, [chanId]);
  return rows[0];
}

/** deps that record whether the operator EMAIL (alertOps) fired, with a stubbed probe + fixed clock. */
function spyDeps(probe: DispatchResult, nowMs: number): CanaryDeps & { pages: AlertPayload[] } {
  const pages: AlertPayload[] = [];
  return {
    pages,
    sendProbe: async () => probe,
    alertOps: async (p: AlertPayload) => { pages.push(p); return SENT; },
    now: () => nowMs,
  };
}

// The env recipient must be present or runCanaryIfDue short-circuits to 'unconfigured' before any send.
const WITH_RECIPIENT = { skip: SKIP };
function withCanaryEmailTo<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.CANARY_EMAIL_TO;
  process.env.CANARY_EMAIL_TO = 'canary-sink@example.test';
  return fn().finally(() => { if (prev === undefined) delete process.env.CANARY_EMAIL_TO; else process.env.CANARY_EMAIL_TO = prev; });
}

// ── 1. delivered ⇒ row written, NO email ──────────────────────────────────────────────────────────────
nodeTest('delivered ⇒ evidence row is delivered and the EMAIL path is NOT called', WITH_RECIPIENT, async () => {
  await withCanaryEmailTo(async () => {
    const chanId = await canaryChannelId();
    await reset(chanId);
    const deps = spyDeps(SENT, Date.now());
    const outcome = await runCanaryIfDue(deps);
    assert.equal(outcome, 'sent');
    assert.equal(deps.pages.length, 0, '★ a HEALTHY canary must not email — that is the whole inversion');
    assert.equal((await latestCanaryRow(chanId)).status, 'delivered', 'the evidence row is written');
    assert.equal(await canaryErrorCount('canary-delivery-failed'), 0, 'no failure error on success');
    await reset(chanId);
  });
});

// ── 2. failed ⇒ EMAIL + runner_errors ─────────────────────────────────────────────────────────────────
nodeTest('failed ⇒ EMAIL path called AND a runner_errors row (canary-delivery-failed)', WITH_RECIPIENT, async () => {
  await withCanaryEmailTo(async () => {
    const chanId = await canaryChannelId();
    await reset(chanId);
    const deps = spyDeps(FAILED, Date.now());
    const outcome = await runCanaryIfDue(deps);
    assert.equal(outcome, 'failed');
    assert.equal(deps.pages.length, 1, '★ a BROKEN notifier must page — this is the alert that matters');
    assert.equal(deps.pages[0].severity, 'critical');
    assert.equal(deps.pages[0].test, false, 'the failure page is a REAL alert, not a [TEST]');
    assert.equal((await latestCanaryRow(chanId)).status, 'failed', 'the failure is recorded, not silent');
    assert.equal(await canaryErrorCount('canary-delivery-failed'), 1, 'the durable runner_errors trail is written');
    await reset(chanId);
  });
});

// ── 2b. the probe THROWING is the same as failed (timeout/hang) ───────────────────────────────────────
nodeTest('probe throws ⇒ treated as failed: EMAIL + runner_errors', WITH_RECIPIENT, async () => {
  await withCanaryEmailTo(async () => {
    const chanId = await canaryChannelId();
    await reset(chanId);
    const pages: AlertPayload[] = [];
    const deps: CanaryDeps = {
      sendProbe: async () => { throw new Error('ACS timed out after 10000ms'); },
      alertOps: async (p) => { pages.push(p); return SENT; },
      now: () => Date.now(),
    };
    assert.equal(await runCanaryIfDue(deps), 'failed');
    assert.equal(pages.length, 1, 'a hung/throwing send still pages');
    assert.equal(await canaryErrorCount('canary-delivery-failed'), 1);
    await reset(chanId);
  });
});

// ── 3. staleness ⇒ EMAIL fires when the canary has not SUCCEEDED in > 2× the interval ─────────────────
nodeTest('no successful canary in > 2× interval ⇒ staleness EMAIL + runner_errors (canary-stale)', WITH_RECIPIENT, async () => {
  const chanId = await canaryChannelId();
  await reset(chanId);
  // Seed a delivery that is well older than the staleness window — the canary "stopped succeeding".
  await pool.query(
    `INSERT INTO test_send_requests (channel_id, status, requested_at, completed_at)
     VALUES ($1, 'delivered', now() - interval '3 days', now() - interval '3 days')`, [chanId]);
  const deps = spyDeps(SENT, Date.now());
  const outcome = await checkCanaryStaleness(deps);
  assert.equal(outcome, 'stale-alerted');
  assert.equal(deps.pages.length, 1, '★ a canary that went silent must page — else absence reads as health');
  assert.equal(deps.pages[0].severity, 'critical');
  assert.equal(await canaryErrorCount('canary-stale'), 1, 'the staleness is durably recorded');

  // Throttle: an immediate re-check does NOT double-page (a persistent stale state pages ~once/interval).
  const deps2 = spyDeps(SENT, Date.now());
  assert.equal(await checkCanaryStaleness(deps2), 'stale-throttled');
  assert.equal(deps2.pages.length, 0, 'no duplicate page within the cooldown');
  await reset(chanId);
});

// ── 3b. a FRESH delivery is NOT stale (the healthy steady state) ──────────────────────────────────────
nodeTest('a recent successful canary ⇒ fresh, no page', WITH_RECIPIENT, async () => {
  const chanId = await canaryChannelId();
  await reset(chanId);
  await pool.query(`INSERT INTO test_send_requests (channel_id, status, completed_at) VALUES ($1, 'delivered', now())`, [chanId]);
  const deps = spyDeps(SENT, Date.now());
  assert.equal(await checkCanaryStaleness(deps), 'fresh');
  assert.equal(deps.pages.length, 0);
  await reset(chanId);
});

// ── 4. unconfigured (CANARY_EMAIL_TO unset) ⇒ OFF but VISIBLE, never a silent no-op ───────────────────
nodeTest('CANARY_EMAIL_TO unset ⇒ unconfigured + a runner_errors row (not a silent gap)', { skip: SKIP }, async () => {
  const chanId = await canaryChannelId();
  await reset(chanId);
  const prev = process.env.CANARY_EMAIL_TO;
  delete process.env.CANARY_EMAIL_TO;
  try {
    const deps = spyDeps(SENT, Date.now());
    assert.equal(await runCanaryIfDue(deps), 'unconfigured');
    assert.equal(deps.pages.length, 0, 'nothing to page — the transport recipient is missing');
    assert.equal(await canaryErrorCount('canary-misconfigured'), 1, 'a disabled canary is surfaced, not hidden');
  } finally {
    if (prev === undefined) delete process.env.CANARY_EMAIL_TO; else process.env.CANARY_EMAIL_TO = prev;
    await reset(chanId);
  }
});
