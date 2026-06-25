// Unit tests for the monitors-as-code reconcile (Phase 6b). Pure — no DB, no network.
// Run via `npm test` (node --test over compiled dist). Covers: manifest validation,
// flow-name binding, the read-only drift diff, and — critically — the GATED field-split
// apply upsert (Git fields overwrite, seed fields insert-only, dashboard fields never).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateManifest,
  flowNameFor,
  computeDrift,
  buildApplyUpsert,
  GIT_AUTHORITATIVE_COLUMNS,
  SEED_ONLY_COLUMNS,
  type Monitor,
  type ManagedCheck,
  type SpecRunnability,
} from './reconcile.js';

// Option C (slice 6): orphan now keys on per-spec runnability (fetchable+compilable), not baked
// modules. The monitor()'s script is the default-runnable spec; helpers build the probe map.
const SPEC = 'monitors/wegmans/search-product.spec.ts';
const runnable = (...specPaths: string[]): SpecRunnability =>
  new Map(specPaths.map((p) => [p, { runnable: true }]));

// A representative valid manifest (mirrors the real synthwatch-monitors manifest.json).
const VALID = {
  schemaVersion: 1,
  description: 'registry',
  monitors: [
    {
      id: 'wegmans-search-product',
      name: 'Wegmans: search → product page',
      script: 'monitors/wegmans/search-product.spec.ts',
      kind: 'browser',
      suggestedIntervalSeconds: 1800,
      tags: ['wegmans', 'ecommerce'],
      target: 'https://www.wegmans.com',
      enabledByDefault: false,
    },
  ],
};

// --- validateManifest -------------------------------------------------------

test('validateManifest accepts a well-formed manifest', () => {
  const m = validateManifest(VALID);
  assert.equal(m.schemaVersion, 1);
  assert.equal(m.monitors.length, 1);
  assert.equal(m.monitors[0].id, 'wegmans-search-product');
});

test('validateManifest rejects wrong schemaVersion', () => {
  assert.throws(() => validateManifest({ ...VALID, schemaVersion: 2 }), /schemaVersion/);
});

test('validateManifest rejects a bad id pattern', () => {
  const bad = { ...VALID, monitors: [{ ...VALID.monitors[0], id: 'Bad_ID' }] };
  assert.throws(() => validateManifest(bad), /\.id invalid/);
});

test('validateManifest rejects a non-browser kind', () => {
  const bad = { ...VALID, monitors: [{ ...VALID.monitors[0], kind: 'http' }] };
  assert.throws(() => validateManifest(bad), /kind invalid/);
});

test('validateManifest rejects a script outside monitors/ or not .spec.ts', () => {
  const bad = { ...VALID, monitors: [{ ...VALID.monitors[0], script: 'flows/x.ts' }] };
  assert.throws(() => validateManifest(bad), /\.script invalid/);
});

test('validateManifest rejects duplicate ids', () => {
  const bad = { ...VALID, monitors: [VALID.monitors[0], VALID.monitors[0]] };
  assert.throws(() => validateManifest(bad), /duplicate monitor id/);
});

test('validateManifest rejects suggestedIntervalSeconds < 60', () => {
  const bad = { ...VALID, monitors: [{ ...VALID.monitors[0], suggestedIntervalSeconds: 30 }] };
  assert.throws(() => validateManifest(bad), /suggestedIntervalSeconds/);
});

// --- flowNameFor ------------------------------------------------------------

test('flowNameFor derives the script basename without .spec.ts', () => {
  const m = validateManifest(VALID).monitors[0];
  assert.equal(flowNameFor(m), 'search-product');
});

// --- computeDrift -----------------------------------------------------------

const monitor = (over: Partial<Monitor> = {}): Monitor => ({
  id: 'wegmans-search-product',
  name: 'Wegmans: search → product page',
  script: 'monitors/wegmans/search-product.spec.ts',
  kind: 'browser',
  target: 'https://www.wegmans.com',
  suggestedIntervalSeconds: 1800,
  enabledByDefault: false,
  ...over,
});

const managed = (over: Partial<ManagedCheck> = {}): ManagedCheck => ({
  source_key: 'wegmans-search-product',
  name: 'Wegmans: search → product page',
  kind: 'browser',
  target_url: 'https://www.wegmans.com',
  flow_name: 'search-product',
  ...over,
});

test('drift NEW + ORPHAN when the spec is not runnable (not fetchable/compilable)', () => {
  const rows = computeDrift([monitor()], [], new Map()); // no probe -> orphan
  const types = rows.map((r) => r.drift_type).sort();
  assert.deepEqual(types, ['new', 'orphan']);
});

test('★ slice 6: a fetchable+compilable spec is NOT orphan (Option C runnable)', () => {
  const rows = computeDrift([monitor()], [], runnable(SPEC));
  assert.deepEqual(
    rows.map((r) => r.drift_type),
    ['new'], // new only — the spec runs via Option C, so NOT orphan
  );
});

test('drift CHANGED only on Git-authoritative fields (name)', () => {
  const rows = computeDrift([monitor({ name: 'New name' })], [managed({ name: 'Old name' })], runnable(SPEC));
  assert.deepEqual(
    rows.map((r) => r.drift_type),
    ['changed'],
  );
  const changed = rows[0];
  assert.deepEqual(changed.detail, { fields: { name: { git: 'New name', live: 'Old name' } } });
});

test('drift does NOT flag CHANGED for seed/dashboard-owned fields (interval/enabled)', () => {
  // Monitor suggests a different interval + enabledByDefault, but the live row diverged
  // (dashboard owns those). That is NOT drift.
  const rows = computeDrift(
    [monitor({ suggestedIntervalSeconds: 60, enabledByDefault: true })],
    [managed()], // identical Git-authoritative fields
    runnable(SPEC),
  );
  assert.deepEqual(rows, []); // no drift at all
});

test('drift MISSING: a managed check whose id left the manifest (would soft-disable)', () => {
  const rows = computeDrift([], [managed({ source_key: 'gone-monitor' })], new Map());
  assert.deepEqual(
    rows.map((r) => r.drift_type),
    ['missing'],
  );
  assert.match(String(rows[0].detail.action), /soft-disable/);
  assert.match(String(rows[0].detail.action), /never hard-delete/);
});

test('★ slice 6: ORPHAN when the spec 404s (Git declares a spec whose file is missing)', () => {
  const rows = computeDrift(
    [monitor()],
    [managed()],
    new Map([[SPEC, { runnable: false, reason: 'not fetchable: spec fetch failed: 404 Not Found' }]]),
  );
  const orphan = rows.find((r) => r.drift_type === 'orphan');
  assert.ok(orphan, 'a 404 spec is orphan');
  assert.equal(orphan!.detail.spec_path, SPEC);
  assert.match(String(orphan!.detail.reason), /not fetchable/);
});

test('★ slice 6: ORPHAN when the spec will not compile', () => {
  const rows = computeDrift(
    [monitor()],
    [managed()],
    new Map([[SPEC, { runnable: false, reason: "won't compile: esbuild parse error" }]]),
  );
  const orphan = rows.find((r) => r.drift_type === 'orphan');
  assert.ok(orphan);
  assert.match(String(orphan!.detail.reason), /won't compile/);
});

// --- buildApplyUpsert (the GATED field-split apply — the crux) ---------------

test('apply upsert INSERTs identity + Git-authoritative + seed-only columns', () => {
  const { insertColumns } = buildApplyUpsert(monitor());
  assert.deepEqual(insertColumns, [
    'source_key',
    ...GIT_AUTHORITATIVE_COLUMNS,
    ...SEED_ONLY_COLUMNS,
  ]);
});

test('apply upsert UPDATEs ONLY Git-authoritative columns (seed-only is insert-only)', () => {
  const { updateColumns } = buildApplyUpsert(monitor());
  // Git fields are overwritten...
  assert.deepEqual(updateColumns, [...GIT_AUTHORITATIVE_COLUMNS]);
  // ...seed fields are NOT in the UPDATE SET (insert-only — dashboard owns them after).
  for (const c of SEED_ONLY_COLUMNS) {
    assert.ok(!(updateColumns as string[]).includes(c), `seed-only column ${c} must not be updated`);
  }
});

test('apply upsert NEVER writes dashboard-owned columns', () => {
  const { insertColumns, updateColumns, text } = buildApplyUpsert(monitor());
  const dashboardOwned = [
    'severity',
    'failure_threshold',
    'retries',
    'timeout_ms',
    'alert_profile_id',
    'min_fail_locations',
    'slo_target',
    'assertions',
  ];
  for (const c of dashboardOwned) {
    assert.ok(!insertColumns.includes(c), `${c} must not be inserted`);
    assert.ok(!updateColumns.includes(c), `${c} must not be updated`);
    assert.ok(!text.includes(c), `${c} must not appear in the upsert SQL`);
  }
});

test('apply upsert conflict-targets source_key and seeds the right values', () => {
  const { text, values } = buildApplyUpsert(monitor({ suggestedIntervalSeconds: undefined }));
  assert.match(text, /ON CONFLICT \(source_key\) DO UPDATE/);
  // values order = [source_key, name, kind, target_url, flow_name, interval, enabled]
  assert.deepEqual(values, [
    'wegmans-search-product',
    'Wegmans: search → product page',
    'browser',
    'https://www.wegmans.com',
    'search-product',
    300, // omitted suggestedIntervalSeconds -> column default 300
    false, // enabledByDefault false
  ]);
});
