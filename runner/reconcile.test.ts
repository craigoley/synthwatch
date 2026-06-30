// Unit tests for the monitors-as-code reconcile (Phase 6b). No DB; no REAL network (the fetchManifest
// tests mock global fetch + restore it). Run via `npm test` (node --test over compiled dist). Covers:
// manifest validation, flow-name binding, the read-only drift diff, the GATED field-split apply upsert
// (Git fields overwrite, seed fields insert-only, dashboard fields never), and the strongly-consistent
// contents-API manifest fetch.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateManifest,
  flowNameFor,
  computeDrift,
  buildApplyUpsert,
  b10FieldUpdates,
  fetchManifest,
  GIT_AUTHORITATIVE_COLUMNS,
  SEED_ONLY_COLUMNS,
  type Monitor,
  type ManagedCheck,
  type SpecRunnability,
} from './reconcile.js';
import { _resetMainShaCache } from './specfetch/fetchSpec.js';

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
  sensitive: false,
  redact_patterns: null,
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
  // values order = [source_key, name, kind, target_url, flow_name, sensitive, redact_patterns, interval, enabled]
  assert.deepEqual(values, [
    'wegmans-search-product',
    'Wegmans: search → product page',
    'browser',
    'https://www.wegmans.com',
    'search-product',
    false, // sensitive default
    'null', // redact_patterns: JSON.stringify(null) — none declared
    300, // omitted suggestedIntervalSeconds -> column default 300
    false, // enabledByDefault false
  ]);
});

// --- B10: the sensitive enable gate + the redaction-policy wiring -----------
test('★ GATE: a sensitive monitor with NO redact_patterns is REJECTED (cannot be enabled)', () => {
  const bad = {
    ...VALID,
    monitors: [{ ...VALID.monitors[0], sensitive: true }], // sensitive, but no redact_patterns
  };
  assert.throws(() => validateManifest(bad), /sensitive but declares no redact_patterns/);
});

test('a sensitive monitor WITH redact_patterns validates + carries them through', () => {
  const ok = {
    ...VALID,
    monitors: [{ ...VALID.monitors[0], sensitive: true, redact_patterns: ['member-\\d+'] }],
  };
  const m = validateManifest(ok).monitors[0];
  assert.equal(m.sensitive, true);
  assert.deepEqual(m.redact_patterns, ['member-\\d+']);
});

test('validateManifest rejects an invalid regex in redact_patterns', () => {
  const bad = {
    ...VALID,
    monitors: [{ ...VALID.monitors[0], sensitive: true, redact_patterns: ['('] }],
  };
  assert.throws(() => validateManifest(bad), /invalid regex/);
});

test('buildApplyUpsert wires sensitive + redact_patterns (Git-authoritative) into INSERT + UPDATE', () => {
  const { insertColumns, updateColumns, values } = buildApplyUpsert(
    monitor({ sensitive: true, redact_patterns: ['token=[A-Z0-9]+'] }),
  );
  // both columns are inserted AND in the UPDATE SET (manifest is the source of truth → re-synced).
  for (const c of ['sensitive', 'redact_patterns']) {
    assert.ok(insertColumns.includes(c), `${c} inserted`);
    assert.ok((updateColumns as string[]).includes(c), `${c} updated (Git-authoritative)`);
  }
  // sensitive=true + the declared patterns serialized as JSONB text.
  assert.equal(values[insertColumns.indexOf('sensitive')], true);
  assert.equal(values[insertColumns.indexOf('redact_patterns')], JSON.stringify(['token=[A-Z0-9]+']));
});

// --- fetchManifest now reads STRONGLY-CONSISTENTLY via the contents API at main@HEAD (mirrors #138) ---
const realFetch = globalThis.fetch;
const MSHA = 'c'.repeat(40);
const MANIFEST_JSON = JSON.stringify({
  schemaVersion: 1,
  monitors: [
    { id: 'wegmans-search-product', name: 'X', script: 'monitors/wegmans/search-product.spec.ts', kind: 'browser' },
  ],
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.SYNTHWATCH_MONITORS_MANIFEST_URL;
});

test('★ fetchManifest (no override) reads via the GitHub contents API at main@HEAD, never raw CDN', async () => {
  _resetMainShaCache();
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    if (String(url).includes('/commits/')) return new Response(MSHA + '\n', { status: 200 });
    return new Response(MANIFEST_JSON, { status: 200 }); // /contents/manifest.json?ref=sha
  }) as unknown as typeof fetch;
  const m = await fetchManifest();
  assert.equal(m.monitors[0].id, 'wegmans-search-product');
  assert.ok(urls.some((u) => u.includes('/commits/main')), 'resolved main HEAD via the commits API');
  const contents = urls.find((u) => u.includes('/contents/manifest.json'));
  assert.ok(contents && contents.includes(`?ref=${MSHA}`), 'manifest pinned to the resolved sha (consistent)');
  assert.ok(contents!.startsWith('https://api.github.com/'), 'api.github.com, NOT raw.githubusercontent');
  assert.ok(!urls.some((u) => u.includes('raw.githubusercontent')), 'never hits the raw CDN');
});

test('fetchManifest honors an explicit override URL (direct fetch — tests/forks)', async () => {
  process.env.SYNTHWATCH_MONITORS_MANIFEST_URL = 'https://example.test/manifest.json';
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    return new Response(MANIFEST_JSON, { status: 200 });
  }) as unknown as typeof fetch;
  const m = await fetchManifest();
  assert.equal(m.monitors.length, 1);
  assert.deepEqual(urls, ['https://example.test/manifest.json'], 'direct-fetched the override; no contents API');
});

// --- ★ SCOPED B10-only sync (the leak fix) — writes ONLY sensitive + redact_patterns ----------
test('★ b10FieldUpdates: a sensitive monitor whose live check defaulted to false → corrects it', () => {
  const ups = b10FieldUpdates(
    [monitor({ sensitive: true, redact_patterns: ['eyJ[A-Za-z0-9_-]+', '[Bb]earer\\s+\\S+'] })],
    [managed({ sensitive: false, redact_patterns: null })], // the leak: manifest says sensitive, DB defaulted false
  );
  assert.equal(ups.length, 1);
  assert.equal(ups[0].source_key, 'wegmans-search-product');
  assert.equal(ups[0].sensitive, true);
  assert.equal(ups[0].redact_patterns, JSON.stringify(['eyJ[A-Za-z0-9_-]+', '[Bb]earer\\s+\\S+']));
});

test('b10FieldUpdates: a check ALREADY matching the manifest → NO update (untouched)', () => {
  assert.deepEqual(
    b10FieldUpdates(
      [monitor({ sensitive: true, redact_patterns: ['x'] })],
      [managed({ sensitive: true, redact_patterns: ['x'] })],
    ),
    [],
  );
  // a non-sensitive monitor + non-sensitive check (the default fleet) → also untouched.
  assert.deepEqual(b10FieldUpdates([monitor()], [managed()]), []);
});

test('★ b10FieldUpdates writes ONLY source_key + the 2 B10 columns (no other field)', () => {
  const u = b10FieldUpdates([monitor({ sensitive: true, redact_patterns: ['x'] })], [managed({ sensitive: false })])[0];
  assert.deepEqual(Object.keys(u).sort(), ['redact_patterns', 'sensitive', 'source_key']);
});

test('★ FULL git-authoritative apply stays OFF: b10FieldUpdates IGNORES name/target/etc.', () => {
  // name + target_url diverge, but sensitive matches → the scoped sync produces NO update
  // (it does NOT apply name/target — that is the still-gated full apply).
  assert.deepEqual(
    b10FieldUpdates(
      [monitor({ name: 'NEW name', target: 'https://changed.example', sensitive: false })],
      [managed({ name: 'OLD name', target_url: 'https://old.example', sensitive: false })],
    ),
    [],
  );
});

test('★ a B10 divergence is its OWN redaction_mismatch drift (NOT generic changed)', () => {
  const rows = computeDrift(
    [monitor({ sensitive: true, redact_patterns: ['x'] })],
    [managed({ sensitive: false, redact_patterns: null })],
    runnable(SPEC),
  );
  // ONLY a redaction_mismatch row — no 'changed' (the non-B10 git fields all match here).
  assert.deepEqual(
    rows.filter((r) => r.drift_type === 'changed' || r.drift_type === 'redaction_mismatch').map((r) => r.drift_type),
    ['redaction_mismatch'],
  );
  const mismatch = rows.find((r) => r.drift_type === 'redaction_mismatch');
  const fields = (mismatch!.detail as { fields: Record<string, { git: unknown; live: unknown }> }).fields;
  assert.deepEqual(fields.sensitive, { git: true, live: false });
  assert.ok('redact_patterns' in fields, 'redact_patterns divergence surfaced too');
});

test('★ a monitor that drifts on BOTH name and redaction yields TWO rows (changed + redaction_mismatch)', () => {
  const rows = computeDrift(
    [monitor({ name: 'New name', sensitive: true, redact_patterns: ['x'] })],
    [managed({ name: 'Old name', sensitive: false })],
    runnable(SPEC),
  );
  const types = rows
    .filter((r) => r.drift_type === 'changed' || r.drift_type === 'redaction_mismatch')
    .map((r) => r.drift_type)
    .sort();
  assert.deepEqual(types, ['changed', 'redaction_mismatch']);
  // 'changed' carries ONLY the non-B10 field (name) — B10 is split out into its own row.
  const changed = rows.find((r) => r.drift_type === 'changed');
  const cf = (changed!.detail as { fields: Record<string, unknown> }).fields;
  assert.deepEqual(Object.keys(cf), ['name']);
});

test('back-compat: a NON-B10 changed drift (name only) is unchanged — no redaction_mismatch row', () => {
  const rows = computeDrift([monitor({ name: 'New name' })], [managed({ name: 'Old name' })], runnable(SPEC));
  assert.deepEqual(
    rows.map((r) => r.drift_type),
    ['changed'],
  );
  assert.equal(rows.find((r) => r.drift_type === 'redaction_mismatch'), undefined);
});
