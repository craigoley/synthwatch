// ★ THE TEST THAT SHOULD HAVE CAUGHT IT — an SLO-burn alert must resolve its channels at the BURN's
// severity, NOT the check's.
//
// THE BUG (evaluate.ts maybeBurnAlert): the payload was dispatched at the burn severity (fast=critical,
// slow=warning) but the channels were resolved with `resolveChannels(check.id, check.severity)`.
// resolveChannels picks the severity-default route with `alert_routes.severity = $2 AND check_id IS NULL`,
// so the CHECK's severity chose the route. check.severity is 'critical' for nearly every check, so a SLOW
// burn — a warning-class budget ticket — resolved the CRITICAL route and paged on-call at 3am.
// Symmetrically, a FAST burn on a warning-severity check under-paged to the warning route. No test asserted
// burn routing at all, which is why it survived.
//
// ★ WHY THIS TEST CAN ACTUALLY FAIL — the whole point. Each severity route points at its OWN local webhook
// server, and the check's severity is set to the OPPOSITE of the burn's. So "routed by burn severity" and
// "routed by check severity" produce DIFFERENT observable outcomes: a real POST to a different port.
// Asserting merely "a channel was paged" would pass under the bug; asserting WHICH one is what makes this a
// gate. Must-go-red verified: with `resolveChannels(check.id, check.severity)` restored, both cases hit the
// wrong server and fail.
//
// Gated on DATABASE_URL like every other *.integration.test.ts (CI runs it on the Postgres-service job).
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { pool, type Check } from './db.js';
import { maybeBurnAlert } from './evaluate.js';

const SKIP = !process.env.DATABASE_URL;
const test = SKIP ? nodeTest.skip : nodeTest;

const SLO_TARGET = 0.99; // => burn = fail-ratio / (1 - 0.99) = fail-ratio x 100. See the seeding math below.

/** A webhook receiver that records whether it was paged. One per severity route, so the test can observe
 *  WHICH route resolveChannels picked. */
async function receiver(): Promise<{ url: string; hits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const srv: Server = createServer((req, res) => {
    hits++;
    req.resume();
    res.writeHead(200).end('ok');
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    hits: () => hits,
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
  };
}

/** `severity` is the CHECK's configured severity — deliberately set OPPOSITE the burn's in each case.
 *  kind='http' keeps the browser_needs_flow constraint out of it; maybeBurnAlert never looks at kind.
 *  min_fail_locations=1 with a single location => effectiveN=1. failure_threshold=1 => the burn floor is 1
 *  run, so every window below has a real sample. warn_renotify_seconds is left at its default (the CHECK
 *  requires > 0); last_burn_notified_at IS NULL already makes the debounce due. */
async function seedCheck(name: string, severity: 'critical' | 'warning'): Promise<Check> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO checks (name, kind, target_url, failure_threshold, severity, interval_seconds,
                         enabled, slo_target, min_fail_locations)
     VALUES ($1, 'http', 'https://example.test', 1, $2, 300, true, $3, 1)
     RETURNING id`,
    [name, severity, SLO_TARGET],
  );
  const id = Number(rows[0].id); // node-pg returns bigint as a STRING
  return { id, name, severity, slo_target: SLO_TARGET, failure_threshold: 1, min_fail_locations: 1 } as unknown as Check;
}

/** Seed `fails` failing + `passes` passing runs spread across [fromMin, toMin) minutes ago, one location. */
async function seedRuns(checkId: number, fromMin: number, toMin: number, fails: number, passes: number): Promise<void> {
  const total = fails + passes;
  const step = (toMin - fromMin) / total;
  for (let i = 0; i < total; i++) {
    const at = fromMin + step * i;
    await pool.query(
      `INSERT INTO runs (check_id, status, location, started_at, finished_at, duration_ms)
       VALUES ($1, $2, 'default', now() - make_interval(secs => $3::float8), now(), 1000)`,
      [checkId, i < fails ? 'fail' : 'pass', at * 60],
    );
  }
}

/** Point a severity-DEFAULT route (check_id IS NULL — the route the bug picked wrongly) at a webhook. */
async function routeSeverityTo(severity: 'critical' | 'warning', name: string, url: string): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO channels (name, type, config, enabled) VALUES ($1, 'webhook', $2::jsonb, true) RETURNING id`,
    [name, JSON.stringify({ url })],
  );
  await pool.query(`INSERT INTO alert_routes (severity, check_id, channel_id) VALUES ($1, NULL, $2)`, [
    severity,
    Number(rows[0].id),
  ]);
}

async function cleanup(checkId: number, channelNames: string[]): Promise<void> {
  if (checkId) await pool.query(`DELETE FROM checks WHERE id = $1`, [checkId]); // cascades runs
  await pool.query(`DELETE FROM channels WHERE name = ANY($1)`, [channelNames]); // cascades alert_routes
}

test('★ a SLOW burn (warning) on a CRITICAL-severity check pages the WARNING route, not the critical one', async () => {
  const crit = await receiver();
  const warn = await receiver();
  const names = ['__burnroute_crit_slow__', '__burnroute_warn_slow__'];
  let checkId = 0;
  try {
    await routeSeverityTo('critical', names[0], crit.url);
    await routeSeverityTo('warning', names[1], warn.url);
    // ★ check.severity = 'critical' — the fleet default — but the burn is SLOW => warning-class.
    // Routed by BURN severity -> the warning receiver. Routed by CHECK severity -> the critical one.
    const check = await seedCheck('__burnroute_slow__', 'critical');
    checkId = check.id;

    // SLOW, per slo_burn_status (0055): 6h AND 30m both >= 6x, while 1h stays UNDER the 14.4x fast trip.
    //   last 30m : 1 fail / 15 pass  => ratio .0625 => burn  6.25  >= 6     ✓ 30m
    //              nothing else within 1h, so 1h sees the same 16 runs:
    //                                     burn 6.25 <  14.4  ✓ NOT fast
    //   1h-5h    : 5 fail / 45 pass  => 6h totals 6 down / 66 => burn 9.09  >= 6  ✓ 6h
    await seedRuns(check.id, 1, 29, 1, 15);
    await seedRuns(check.id, 65, 300, 5, 45);

    await maybeBurnAlert(check);

    assert.equal(warn.hits(), 1, 'the WARNING route was paged — a slow burn is a warning-class budget ticket');
    assert.equal(crit.hits(), 0, '★ the CRITICAL route must NOT be paged — this is the 3am false page');
  } finally {
    await cleanup(checkId, names);
    await crit.close();
    await warn.close();
  }
});

test('★ a FAST burn (critical) on a WARNING-severity check pages the CRITICAL route (no under-paging)', async () => {
  const crit = await receiver();
  const warn = await receiver();
  const names = ['__burnroute_crit_fast__', '__burnroute_warn_fast__'];
  let checkId = 0;
  try {
    await routeSeverityTo('critical', names[0], crit.url);
    await routeSeverityTo('warning', names[1], warn.url);
    // ★ The mirror image: check.severity = 'warning' but the burn is FAST => critical-class.
    // Routed by BURN severity -> the critical receiver. Routed by CHECK severity -> the warning one
    // (a real fast burn quietly under-paging).
    const check = await seedCheck('__burnroute_fast__', 'warning');
    checkId = check.id;

    // FAST: the 1h window all-fail => ratio 1.0 => burn 100 >= 14.4.
    await seedRuns(check.id, 1, 30, 10, 0);

    await maybeBurnAlert(check);

    assert.equal(crit.hits(), 1, 'the CRITICAL route was paged — a fast burn must reach on-call');
    assert.equal(warn.hits(), 0, '★ the WARNING route must NOT absorb a fast burn (the under-page)');
  } finally {
    await cleanup(checkId, names);
    await crit.close();
    await warn.close();
  }
});
