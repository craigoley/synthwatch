// Guard + fallback tests for the HOLISTIC fact pack (cost + deploy markers). The cited-numbers guard is
// load-bearing now the pack is bigger: the model may cite ONLY figures in the pack, and NO deploy
// correlation the timestamps don't support. buildFallback must cite cost/deploy when present, never fabricate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missingFigures, buildFallback, spotCheck, type FactPack, type Narrative } from './narrative.js';

const EMPTY_PERIOD = {
  from: '2026-07-01', to: '2026-07-08', up: 100, down: 5, availabilityPct: 95.24, downtimeMin: 12,
  incidents: 2, p50: 400, p95: 1200, p99: 3000, latencyN: 90, lcpP75: null,
};

function factPack(over: Partial<FactPack> = {}): FactPack {
  return {
    scopeType: 'fleet', scopeKey: '', scopeName: 'Fleet', window: '7d',
    current: { ...EMPTY_PERIOD },
    previous: { ...EMPTY_PERIOD, availabilityPct: 98.0, incidents: 1 },
    deltas: { availabilityPts: -2.76, downtimeMin: 8, incidents: 1, p95Pct: 10 },
    incidentList: [],
    anomalies: [],
    cost: {
      fleetProjected: 67.64, fleetMeasured: 50.17, fleetDivergence: 0.742,
      topDrivers: [{ name: 'recipe-nav', projected: 8.85 }],
      notable: [
        { name: 'rca-demo', projected: 5.2, measured: 12.9, divergence: 2.48, divergenceFlag: true, availabilityPct: 0.0 },
      ],
    },
    deployMarkers: [
      { deployedAt: '2026-07-06T14:00:00.000Z', targetHost: 'wegmans.com', source: 'sentry-release', sha: 'abc123def456', isSha: true },
    ],
    ...over,
  };
}
const narr = (headline: string, body: string): Narrative => ({ headline, body, highlights: [] });

// ── the guard must PASS a faithful holistic narrative ──
test('missingFigures: passes prose citing real pack cost + a real deploy sha', () => {
  const n = narr(
    'rca-demo 95% available but $12.90/mo measured vs $5.20 projected — pure waste.',
    'Fleet 95.24% (2 incidents). rca-demo cost divergence 2.48×. An incident began ~20 min after the deploy abc123 (wegmans.com).',
  );
  assert.deepEqual(missingFigures(n, factPack()), []);
  assert.equal(spotCheck(n, factPack()), true);
});

// ── ★ must-go-red: an out-of-pack $ number is rejected ──
test('missingFigures: REJECTS an invented $ figure not in the pack', () => {
  const n = narr('Fleet 95.24% available, 2 incidents.', 'Fleet is burning $999/mo — investigate.');
  const missing = missingFigures(n, factPack());
  assert.ok(missing.some((m) => m.includes('invented-cost($999')), missing.join(','));
  assert.equal(spotCheck(n, factPack()), false);
});

// ── ★ must-go-red: an unsupported deploy sha (not an in-window marker) is rejected ──
test('missingFigures: REJECTS a deploy correlation to an sha not in the markers', () => {
  const n = narr('Fleet 95.24% available, 2 incidents.', 'The outage began after the deploy deadbeef1234.');
  const missing = missingFigures(n, factPack());
  assert.ok(missing.some((m) => m.includes('unsupported-deploy-sha(deadbeef1234')), missing.join(','));
});

test('missingFigures: a real sha PREFIX is accepted (model may cite a short prefix)', () => {
  const n = narr('Fleet 95.24% available, 2 incidents.', 'Incident began 20 min after deploy abc123.');
  assert.deepEqual(missingFigures(n, factPack()), []);
});

test('missingFigures: still rejects filler missing availability + incidents', () => {
  const n = narr('All systems nominal.', 'Everything looks fine this week.');
  const missing = missingFigures(n, factPack());
  assert.ok(missing.some((m) => m.startsWith('availability')));
  assert.ok(missing.some((m) => m.startsWith('incidents')));
});

// ── fallback: cite cost/deploy when present, omit gracefully when absent ──
test('buildFallback: cites fleet cost + the divergent monitor + deploy count when present', () => {
  const fb = buildFallback(factPack());
  assert.match(fb.body, /\$67\.64\/mo/);
  assert.match(fb.body, /rca-demo/);
  assert.match(fb.body, /2\.48×/);
  assert.match(fb.body, /1 deploy/);
});

test('buildFallback: NO fabricated cost/deploy when absent (cost null, no markers)', () => {
  const fb = buildFallback(factPack({ cost: null, deployMarkers: [] }));
  assert.doesNotMatch(fb.body, /\$/);      // no $ fabricated
  assert.doesNotMatch(fb.body, /deploy/i); // no deploy fabricated
  // the guard accepts the fallback (it cites availability + incidents, no invented figures)
  assert.deepEqual(missingFigures(fb, factPack({ cost: null, deployMarkers: [] })), []);
});
