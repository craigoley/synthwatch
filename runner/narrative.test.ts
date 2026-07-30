// Guard + fallback tests for the HOLISTIC fact pack (cost + deploy markers). The cited-numbers guard is
// load-bearing now the pack is bigger: the model may cite ONLY figures in the pack, and NO deploy
// correlation the timestamps don't support. buildFallback must cite cost/deploy when present, never fabricate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  missingFigures,
  buildFallback,
  spotCheck,
  repeatOffenderLine,
  isMonitorDefectShape,
  monitorDefectLine,
  ensureAnomaliesDelivered,
  type FactPack,
  type Narrative,
  WINDOW_DAYS,
  DEFECT_WINDOW_DAYS,
  type DefectCandidate,
} from './narrative.js';

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
    criticalFindings: [],
    cost: {
      fleetProjected: 67.64, fleetMeasured: 50.17, fleetDivergence: 0.742,
      topDrivers: [{ name: 'recipe-nav', projected: 8.85 }],
      notable: [
        { name: 'rca-demo', estimatedMonthly: 4.9, sharePct: 18.4, projected: 5.2, measured: 12.9, divergence: 2.48, divergenceFlag: true, availabilityPct: 0.0 },
      ],
    },
    deployMarkers: [
      { deployedAt: '2026-07-06T14:00:00.000Z', targetHost: 'wegmans.com', source: 'sentry-release', sha: 'abc123def456', isSha: true },
    ],
    ...over,
  };
}
const narr = (headline: string, body: string): Narrative => ({ headline, body, highlights: [] });
const narrH = (headline: string, body: string, highlights: string[]): Narrative => ({ headline, body, highlights });

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

// ── ★ THE FIX (must-go-red): a HOLISTIC fleet narrative that cites the figures in HIGHLIGHTS (not the
//    headline/body, which carry the qualitative cross-signal story) PASSES. This is the 2026-07-09 fleet
//    false-rejection: the model finished clean and cited 95.24% + 2 incidents verbatim in highlights, but
//    the old guard searched only headline+body → `missing: availability(...)` → wrongful fallback.
//    Fails on origin/main (highlights not searched), passes after the search-scope fix.
test('missingFigures: figure cited ONLY in highlights PASSES (holistic fleet narrative)', () => {
  const n = narrH(
    'Reliability-and-cost: the worst monitor bleeds on both axes.', // no "95", no "2"
    'Availability slipped week-over-week, led by the least reliable monitor which also tops projected spend.',
    ['Fleet availability 95.24%', '2 incidents opened'],
  );
  assert.deepEqual(missingFigures(n, factPack()), []);
  assert.equal(spotCheck(n, factPack()), true);
});

// ── ★ teeth intact (must-go-red the other way): OMITTING the figure from EVERY field (headline, body,
//    AND highlights) still FAILS — the fix widens the search, it does not neuter the guard. ──
test('missingFigures: figure absent from headline+body+highlights still FAILS', () => {
  const n = narrH(
    'Reliability-and-cost: the worst monitor bleeds on both axes.',
    'Availability slipped week-over-week, led by the least reliable monitor which also tops projected spend.',
    ['worst monitor drives spend'], // figure nowhere
  );
  const missing = missingFigures(n, factPack());
  assert.ok(missing.some((m) => m.startsWith('availability')), missing.join(','));
  assert.ok(missing.some((m) => m.startsWith('incidents')), missing.join(','));
  assert.equal(spotCheck(n, factPack()), false);
});

// ── ★ a WRONG availability number still FAILS (the guard checks for the CORRECT figure's presence, so an
//    incorrect one — even placed prominently in a highlight — does not satisfy it). ──
test('missingFigures: a WRONG availability figure (in a highlight) still FAILS', () => {
  const n = narrH('Fleet reliability report.', 'The fleet had a rough week.', ['Fleet availability 88.10%', '2 incidents']);
  const missing = missingFigures(n, factPack());
  assert.ok(missing.some((m) => m.startsWith('availability')), missing.join(','));
});

// ── ★ closing the latent hole: an invented $ figure hidden in a HIGHLIGHT (shown to the user) is now caught.
//    Before the fix, highlights escaped the anti-hallucination scan entirely. ──
test('missingFigures: an invented $ in a HIGHLIGHT is now rejected', () => {
  const n = narrH('Fleet 95.24% available, 2 incidents.', 'Nothing else notable.', ['Fleet spend $999/mo']);
  const missing = missingFigures(n, factPack());
  assert.ok(missing.some((m) => m.includes('invented-cost($999')), missing.join(','));
});

// ── no regression on the 31 per-monitor narratives: a figure cited in the BODY with empty highlights
//    (the shape that already passes today) still passes. ──
test('missingFigures: figure in body with empty highlights still PASSES (per-monitor shape)', () => {
  const n = narr('search-autocomplete 95.24% available this week.', '2 incidents, both resolved.');
  assert.deepEqual(missingFigures(n, factPack()), []);
});

// ── ★ CASE 2 (2026-07-09 fleet fallback AFTER #244's scope fix): the model wrote a genuinely HOLISTIC,
//    finish_reason=stop narrative but reported the fleet metric only as its WoW DELTA ("+11.36 pts w/w")
//    + per-monitor availabilities — OMITTING the fleet AGGREGATE the guard requires. The remedy is the
//    SYSTEM_PROMPT (require the literal aggregate); these tests LOCK the guard contract the prompt targets:
//    the delta must NOT satisfy the aggregate check, a compliant narrative passes, a wrong one fails. ──
test('missingFigures: delta-only (WoW pts, per-monitor avails) OMITTING the aggregate still FAILS (CASE 2)', () => {
  // Mirrors the discarded output: delta +11.36, per-monitor 99.46 / 0 — but never the aggregate 95.24.
  const n = narrH(
    'rca-demo is unavailable AND over-cost; Meals2Go incidents did not drive fleet spend.',
    'Availability improved +11.36 pts w/w with no correlated deploy in-window. rca-demo sits at 0 while search holds 99.46.',
    ['availabilityPts +11.36', 'rca-demo availabilityPct 0', 'search availabilityPct 99.46'],
  );
  const missing = missingFigures(n, factPack());
  assert.ok(missing.some((m) => m.startsWith('availability')), `expected availability missing, got: ${missing.join(',')}`);
  assert.equal(spotCheck(n, factPack()), false);
});

test('missingFigures: the AGGREGATE stated literally in any field PASSES (delta may accompany it)', () => {
  // Same holistic story, but now ALSO anchors the literal aggregate 95.24% (in a highlight) alongside the delta.
  const n = narrH(
    'rca-demo is unavailable AND over-cost; fleet availability held at 95.24%.',
    'Fleet availability 95.24% (+11.36 pts w/w), no correlated deploy in-window. rca-demo at 0, search 99.46.',
    ['Fleet availability 95.24%', 'availabilityPts +11.36'],
  );
  assert.deepEqual(missingFigures(n, factPack()), []);
  assert.equal(spotCheck(n, factPack()), true);
});

test('missingFigures: a WRONG fleet aggregate (85% not 95.24%) still FAILS (teeth intact)', () => {
  const n = narrH('Fleet availability was 85% this week.', '2 incidents, no correlated deploy.', ['Fleet availability 85%']);
  const missing = missingFigures(n, factPack());
  assert.ok(missing.some((m) => m.startsWith('availability')), `expected availability missing, got: ${missing.join(',')}`);
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

// ── ★ REPEAT-OFFENDER DELIVERY + THE MONITOR-DEFECT DISCRIMINATOR (2026-07-30) ──────────────────────
// The signal already fired: the repeat-offender line reached fact_pack.anomalies in 10 of 38 stored
// narratives — and ZERO narrative bodies. Detection was never the problem; DELIVERY and NAMING were.
// Every number below is MEASURED (14d window, 2026-07-30), not invented.

test('★ the repeat-offender line NAMES the group — step, count, incident ids, window', () => {
  // Check 355's real 7d groups after #378: add-bread [185,187] and verify-cart-4 [219,223].
  const line = repeatOffenderLine('monitor', { n: 2, step: 'verify-cart-4', ids: [219, 223], check_name: null }, '7d');
  assert.match(line, /verify-cart-4/, 'the STEP is named — this is what makes it a work item');
  assert.match(line, /#219, #223/, 'the incident ids are named');
  assert.match(line, /2 incidents/);
  assert.match(line, /7d/, 'the window is stated');

  // ★ MUST-GO-RED vs the OLD text: two DIFFERENT groups on ONE monitor used to render IDENTICALLY.
  const other = repeatOffenderLine('monitor', { n: 2, step: 'add-bread', ids: [185, 187], check_name: null }, '7d');
  assert.notEqual(line, other, 'the two real groups must now be distinguishable');
  const oldText = (n: number) => `Repeat offender: ${n} incidents with the same failure signature.`;
  assert.equal(oldText(2), oldText(2), 'the old text was identical for both — the defect being fixed');
});

test('★ a fleet-scope line also names the MONITOR (a fleet report groups across checks)', () => {
  const fleet = repeatOffenderLine('fleet', { n: 3, step: 'verify-cart-4', ids: [175, 219, 223], check_name: 'Wegmans: full authenticated pickup shopping flow' }, '30d');
  assert.match(fleet, /Wegmans: full authenticated pickup shopping flow \/ verify-cart-4/);
  const mon = repeatOffenderLine('monitor', { n: 3, step: 'verify-cart-4', ids: [175, 219, 223], check_name: 'Wegmans: full authenticated pickup shopping flow' }, '30d');
  assert.ok(!mon.includes('Wegmans:'), 'a monitor-scope report already knows whose it is');
});

test('a non-stepped check still produces a readable line (step is nullable)', () => {
  assert.match(
    repeatOffenderLine('monitor', { n: 2, step: null, ids: [1, 2], check_name: null }, '7d'),
    /no step — non-stepped check/,
  );
});

// ── the discriminator: same signature = monitor defect; many signatures = flaky target ──────────────
const c = (step: string, fails: number, signatures: number, windowRuns: number): DefectCandidate =>
  ({ checkId: 355, checkName: null, step, fails, signatures, windowRuns });

test('★★ MEASURED: check 355 verify-cart-4 IS monitor-defect-shaped; its flaky siblings are NOT', () => {
  // 43 failures / 2 signatures over 602 countable runs → 21.5 per signature, 7.14% of the window.
  assert.equal(isMonitorDefectShape(c('verify-cart-4', 43, 2, 602)), true);

  // Real siblings from the same check + window. Each fails the RATIO — their errors DRIFT, which is what
  // genuinely intermittent target behaviour looks like.
  assert.equal(isMonitorDefectShape(c('add-bananas', 7, 2, 602)), false, 'ratio 3.5');
  assert.equal(isMonitorDefectShape(c('clear-cart (teardown)', 7, 3, 602)), false, 'ratio 2.3');
  assert.equal(isMonitorDefectShape(c('checkout-pickup', 6, 3, 602)), false, 'ratio 2.0');
  assert.equal(isMonitorDefectShape(c('add-eggs', 3, 2, 602)), false, 'ratio 1.5 and under the volume floor');
});

test('★★ MEASURED: check 396 — 101 failures, ONE signature, 75% of its window — is the clearest case', () => {
  assert.equal(isMonitorDefectShape(c('Open cart and verify item', 101, 1, 134)), true);
  assert.equal(isMonitorDefectShape(c('Add item to cart', 28, 1, 134)), true);
});

test('★★ THE SHARE GUARD IS LOAD-BEARING — a ratio alone over-fires (real case: check 192)', () => {
  // Check 192 "assert a downloadable menu PDF is present": 5 failures, 1 signature, 669 runs.
  // It CLEARS the volume floor (5 >= 5) AND the ratio (5.0 >= 5) — only the share term excludes it.
  const menu = c('assert a downloadable menu PDF is present', 5, 1, 669);
  assert.ok(menu.fails >= 5, 'clears the volume floor');
  assert.ok(menu.fails / menu.signatures >= 5, 'clears the ratio');
  assert.equal(isMonitorDefectShape(menu), false, '…and is still correctly excluded, by SHARE (0.75%)');

  // Same shape as the select-store-mckinley case the guard was specified against (5 fails / 1 sig / 602).
  assert.equal(isMonitorDefectShape(c('select-store-mckinley', 5, 1, 602)), false, 'share 0.83% — excluded');

  // MUST-GO-RED: drop the share term and check 192 would fire. This is what the guard is buying.
  const withoutShare = (x: DefectCandidate) => x.fails >= 5 && x.fails / x.signatures >= 5;
  assert.equal(withoutShare(menu), true, 'without the share term this over-fires on a thin, intermittent history');
});

test('★ the volume floor holds: a high ratio on tiny volume is not a pattern', () => {
  assert.equal(isMonitorDefectShape(c('one-off', 4, 1, 20)), false, '4 failures — under the floor despite 20% share');
  assert.equal(isMonitorDefectShape(c('one-off', 1, 1, 2)), false, '1 failure at 50% share is not a pattern');
});

test('★ degenerate inputs make NO claim (never divide by zero into a confident verdict)', () => {
  assert.equal(isMonitorDefectShape(c('x', 10, 0, 100)), false, 'no signatures measured');
  assert.equal(isMonitorDefectShape(c('x', 10, 1, 0)), false, 'no window measured');
});

test('★ the monitor-defect line states the measurement AND the action (fix the check)', () => {
  const line = monitorDefectLine(c('verify-cart-4', 43, 2, 602), 14);
  assert.match(line, /verify-cart-4/);
  assert.match(line, /43×/);
  assert.match(line, /2 distinct error signatures/);
  assert.match(line, /21\.5 failures per signature/);
  assert.match(line, /7\.1% of 602 runs/);
  assert.match(line, /14d/);
  assert.match(line, /Fix the check before investigating the target/, 'the ACTION — no RCA class says this');
});

// ── the delivery guarantee ───────────────────────────────────────────────────────────────────────────
const narrative = (over: Partial<Narrative> = {}): Narrative =>
  ({ headline: 'h', body: 'b', highlights: [], ...over });

test('★★ DELIVERY: a criticalFinding the prose DROPS is appended to highlights', () => {
  const fp = factPack({
    criticalFindings: [{ token: 'verify-cart-4', line: 'LIKELY MONITOR DEFECT: verify-cart-4 failed 43× …' }],
  });
  // The model wrote a perfectly nice narrative that never mentions the step — the measured real behaviour
  // (10 of 38 narratives had the anomaly in the fact pack; 0 bodies mentioned it).
  const out = ensureAnomaliesDelivered(narrative({ body: 'Availability dipped; cost is flat.' }), fp);
  assert.equal(out.highlights.length, 1, 'the finding is now in a field the dashboard renders');
  assert.match(out.highlights[0], /LIKELY MONITOR DEFECT: verify-cart-4/);
  // Non-destructive: the model's own prose is untouched.
  assert.equal(out.body, 'Availability dipped; cost is flat.');
  assert.equal(out.headline, 'h');
});

test('★ DELIVERY is idempotent — prose that ALREADY names the step is not duplicated', () => {
  const fp = factPack({
    criticalFindings: [{ token: 'verify-cart-4', line: 'LIKELY MONITOR DEFECT: verify-cart-4 failed 43× …' }],
  });
  for (const n of [
    narrative({ body: 'verify-cart-4 keeps failing the same assertion — fix the check.' }),
    narrative({ headline: 'verify-cart-4 is the story' }),
    narrative({ highlights: ['verify-cart-4 43× one signature'] }),
  ]) {
    const out = ensureAnomaliesDelivered(n, fp);
    assert.deepEqual(out.highlights, n.highlights, 'already delivered → nothing appended');
  }
});

test('★ DELIVERY: no criticalFindings → the narrative is returned untouched', () => {
  const n = narrative({ highlights: ['a'] });
  assert.equal(ensureAnomaliesDelivered(n, factPack({ criticalFindings: [] })), n, 'same object, no copy');
});

test('★ DELIVERY reaches the FALLBACK path too (buildFallback slices highlights to 5)', () => {
  // Five other anomalies would push a 6th out of buildFallback's highlights slice; the guarantee restores it.
  const fp = factPack({
    anomalies: ['a1', 'a2', 'a3', 'a4', 'a5', 'LIKELY MONITOR DEFECT: verify-cart-4 failed 43× …'],
    criticalFindings: [{ token: 'verify-cart-4', line: 'LIKELY MONITOR DEFECT: verify-cart-4 failed 43× …' }],
  });
  const fb = buildFallback(fp);
  const delivered = ensureAnomaliesDelivered(fb, fp);
  assert.ok(
    [delivered.headline, delivered.body, ...delivered.highlights].join(' ').includes('verify-cart-4'),
    'the deterministic output carries it too',
  );
});

// ── ★ THE MONITOR-DEFECT WINDOW IS ITS OWN, LONGER HORIZON (2026-07-30) ─────────────────────────────
// Availability deltas answer "what changed recently" (7d). The defect discriminator answers "is this
// check trustworthy at all", and a wrong assertion stays wrong for weeks. Check 396 is the proof: 101
// failures, ONE signature, 75% of its window — and INVISIBLE at 7d because they fell on 07-17..07-20.

test('★ the two windows are DIFFERENT constants — do not unify them', () => {
  assert.equal(WINDOW_DAYS, 7, 'the report window stays short: it measures CHANGE');
  assert.equal(DEFECT_WINDOW_DAYS, 30, 'the defect window is long: it measures TRUSTWORTHINESS');
  assert.ok(
    DEFECT_WINDOW_DAYS > WINDOW_DAYS,
    'a monitor broken for four days three weeks ago is still a broken monitor — 7d cannot see it',
  );
});

test('★★ check 396 FIRES at 30d and is INVISIBLE at 7d — the reason this window exists', () => {
  // MEASURED: 101 failures / 1 signature over the 134 countable runs it has in a 30d window.
  const at30 = { checkId: 396, checkName: 'Wegmans Authorized User Add to Cart', step: 'Open cart and verify item', fails: 101, signatures: 1, windowRuns: 134 };
  assert.equal(isMonitorDefectShape(at30), true, '75.4% of runs failing identically — the loudest defect in the fleet');
  assert.equal(isMonitorDefectShape({ ...at30, step: 'Add item to cart', fails: 28 }), true, '20.9% — its second step');

  // At 7d those failures are OUTSIDE the window entirely: zero failures reach the predicate, so it
  // cannot fire however broken the check is. That is the gap the longer horizon closes.
  assert.equal(isMonitorDefectShape({ ...at30, fails: 0, windowRuns: 0 }), false, 'invisible at 7d');
});

test('★★ check 192 stays EXCLUDED at BOTH windows — the share guard survives the window change', () => {
  // 5 failures / 1 signature at both horizons; only the denominator grows. It clears the volume floor
  // AND the ratio at both, so the SHARE term is the only thing excluding it — at either window.
  const at7 = { checkId: 192, checkName: 'Amore', step: 'assert a downloadable menu PDF is present', fails: 5, signatures: 1, windowRuns: 669 };
  const at30 = { ...at7, windowRuns: 2248 };
  for (const [label, c] of [['7d', at7], ['30d', at30]] as const) {
    assert.ok(c.fails >= 5, `${label}: clears the volume floor`);
    assert.ok(c.fails / c.signatures >= 5, `${label}: clears the ratio`);
    assert.equal(isMonitorDefectShape(c), false, `${label}: still excluded, by SHARE alone`);
  }
  // A longer window makes the exclusion STRONGER, not weaker: 0.75% -> 0.22%.
  assert.ok((100 * at30.fails) / at30.windowRuns < (100 * at7.fails) / at7.windowRuns);

  // MUST-GO-RED at both windows: drop the share term and 192 fires either way.
  const withoutShare = (c: DefectCandidate) => c.fails >= 5 && c.fails / c.signatures >= 5;
  assert.equal(withoutShare(at7), true, 'without share: over-fires at 7d');
  assert.equal(withoutShare(at30), true, 'without share: over-fires at 30d too');
});

test('★ at 30d the share term excludes MORE, not less — it is what makes the long horizon safe', () => {
  // The high-frequency monitors that only become candidates at 30d: thousands of runs a month, so a
  // handful of identical failures is genuine intermittency. All clear volume AND ratio; all excluded.
  const highFrequency: DefectCandidate[] = [
    { checkId: 77, checkName: null, step: 'open the first dinner recipe', fails: 11, signatures: 1, windowRuns: 5532 },
    { checkId: 81, checkName: null, step: 'assert the homepage rendered', fails: 10, signatures: 1, windowRuns: 11537 },
    { checkId: 80, checkName: null, step: 'open meals2go.com landing', fails: 6, signatures: 1, windowRuns: 6116 },
    { checkId: 194, checkName: null, step: 'assert both location links are present', fails: 5, signatures: 1, windowRuns: 3749 },
  ];
  for (const c of highFrequency) {
    assert.ok(c.fails >= 5 && c.fails / c.signatures >= 5, `check ${c.checkId} clears volume + ratio`);
    assert.equal(isMonitorDefectShape(c), false, `check ${c.checkId} excluded by share`);
  }
  // Fleet measurement: 8 candidates clear volume+ratio at 30d, only 3 clear all three.
  const all = [...highFrequency,
    { checkId: 192, checkName: null, step: 'menu pdf', fails: 5, signatures: 1, windowRuns: 2248 },
    { checkId: 396, checkName: null, step: 'Open cart and verify item', fails: 101, signatures: 1, windowRuns: 134 },
    { checkId: 396, checkName: null, step: 'Add item to cart', fails: 28, signatures: 1, windowRuns: 134 },
    { checkId: 355, checkName: null, step: 'verify-cart-4', fails: 45, signatures: 2, windowRuns: 783 },
  ];
  assert.equal(all.filter((c) => c.fails >= 5 && c.fails / c.signatures >= 5).length, 8, 'clear volume+ratio');
  assert.equal(all.filter(isMonitorDefectShape).length, 3, 'clear all three — unchanged from the 7d calibration');
});

test('★ the line states the DEFECT window, not the report window', () => {
  const line = monitorDefectLine(
    { checkId: 355, checkName: null, step: 'verify-cart-4', fails: 45, signatures: 2, windowRuns: 783 },
    DEFECT_WINDOW_DAYS,
  );
  assert.match(line, /30d/, 'a reader must not think this is a 7d figure');
  assert.ok(!line.includes(' 7d'), 'the report window must not leak into the defect line');
});
