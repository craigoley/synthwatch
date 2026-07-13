// B3-2 stage 2 — the transient classifier. ★ The must-go-reds are the safety property B3-3 depends on:
// 355's Wegmans "Failed to fetch" is SERVICE-side (must NOT burn the monitor budget); 222's paint-race is
// MONITOR-side (does); a signal-less transient is INDETERMINATE (burns nothing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTransient, type TraceSignalsLike } from './transientClass.js';

// A settled baseline run whose ONLY first-party failures are persistent RSC-prefetch cancellations — the
// teardown noise present in (almost) every run of monitor 222.
const rscNoise: TraceSignalsLike = {
  network: {
    failed: [
      { url: 'https://synthwatch-dashboard.vercel.app/checks/342?_rsc=aaa', thirdParty: false, resourceType: 'fetch' },
      { url: 'https://synthwatch-dashboard.vercel.app/checks/33?_rsc=aaa', thirdParty: false, resourceType: 'fetch' },
      { url: 'https://edge.adobedc.net/ee/v2', thirdParty: true, resourceType: 'fetch' }, // third-party — ignored
    ],
  },
};

test('★ MONITOR-side: a paint-race red whose only first-party failures are PERSISTENT _rsc noise (in baseline)', () => {
  // 222's transient: the SAME _rsc prefetch failures as the baseline (only the ?_rsc= hash differs → stripped).
  const transient: TraceSignalsLike = {
    network: {
      failed: [
        { url: 'https://synthwatch-dashboard.vercel.app/checks/342?_rsc=zzz', thirdParty: false, resourceType: 'fetch' },
        { url: 'https://synthwatch-dashboard.vercel.app/checks/33?_rsc=zzz', thirdParty: false, resourceType: 'fetch' },
      ],
    },
  };
  // query stripped → same host+path as baseline → NOT new → the monitor cried wolf.
  assert.equal(classifyTransient(transient, [rscNoise, rscNoise, rscNoise]), 'monitor-side');
});

test('★ SERVICE-side: a NEW first-party fetch failure that debuts in the transient (355 Wegmans)', () => {
  // 355's transient: a www.wegmans.com fetch FAILED — a host+path NOT present in the passing baseline.
  const transient: TraceSignalsLike = {
    network: {
      failed: [
        { url: 'https://www.wegmans.com/api/cart/add?sku=bread', thirdParty: false, resourceType: 'fetch' },
        { url: 'https://o4508.ingest.us.sentry.io/x', thirdParty: true, resourceType: 'fetch' }, // third-party — ignored
      ],
    },
  };
  // the baseline (passing runs) never failed that first-party path → NEW → the monitor caught a real blip.
  const cleanBaseline: TraceSignalsLike = { network: { failed: [] } };
  assert.equal(classifyTransient(transient, [cleanBaseline, cleanBaseline]), 'service-side');
});

test('★ INDETERMINATE: no trace_signals at all (http/dns/ssl transient, or a strand) — never guess', () => {
  assert.equal(classifyTransient(null, [rscNoise]), 'indeterminate');
  assert.equal(classifyTransient(undefined, []), 'indeterminate');
});

test('monitor-side: trace_signals present but NO first-party network failures (a pure assertion fail)', () => {
  const assertionOnly: TraceSignalsLike = { network: { failed: [] } };
  assert.equal(classifyTransient(assertionOnly, [assertionOnly]), 'monitor-side');
});

test('service-side needs a NEW first-party — a first-party failure ALSO in the baseline stays monitor-side', () => {
  const withFp: TraceSignalsLike = {
    network: { failed: [{ url: 'https://www.wegmans.com/shop?x=1', thirdParty: false, resourceType: 'fetch' }] },
  };
  const baselineHasIt: TraceSignalsLike = {
    network: { failed: [{ url: 'https://www.wegmans.com/shop?x=2', thirdParty: false, resourceType: 'fetch' }] },
  };
  // same host+path (query stripped) already in baseline → not new → monitor-side.
  assert.equal(classifyTransient(withFp, [baselineHasIt]), 'monitor-side');
});

test('non-service resource failures (image/ping/websocket) are NOT a service-side signal', () => {
  const noiseOnly: TraceSignalsLike = {
    network: {
      failed: [
        { url: 'https://www.wegmans.com/pixel.gif', thirdParty: false, resourceType: 'image' },
        { url: 'wss://www.wegmans.com/live', thirdParty: false, resourceType: 'websocket' },
      ],
    },
  };
  // a failed first-party image/ws is telemetry/transport noise, not a service non-response → monitor-side.
  assert.equal(classifyTransient(noiseOnly, [{ network: { failed: [] } }]), 'monitor-side');
});
