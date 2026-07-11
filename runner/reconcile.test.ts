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
  isResolvableSpec,
  b10FieldUpdates,
  redtestAnchorUpdates,
  isRedactionStrip,
  computeApplyPlan,
  fetchManifest,
  GIT_AUTHORITATIVE_COLUMNS,
  SEED_ONLY_COLUMNS,
  CHANGED_UPDATE_COLUMNS,
  REDACTION_COLUMNS,
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
  environment: 'prod',
  rewrite_from_origin: null,
  redtest_anchor: null,
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

test('apply upsert INSERTs identity + Git-authoritative + seed-only + spec_path columns', () => {
  const { insertColumns } = buildApplyUpsert(monitor());
  assert.deepEqual(insertColumns, [
    'source_key',
    ...GIT_AUTHORITATIVE_COLUMNS,
    ...SEED_ONLY_COLUMNS,
    'spec_path', // ★ the real runtime resolution path for a browser check (appended last).
  ]);
});

test('apply upsert UPDATEs Git-authoritative columns + spec_path (seed-only stays insert-only)', () => {
  const { updateColumns } = buildApplyUpsert(monitor());
  // Git fields + spec_path are overwritten (spec_path is Git-derived → re-synced; heals an existing NULL row).
  assert.deepEqual(updateColumns, [...GIT_AUTHORITATIVE_COLUMNS, 'spec_path']);
  // ...seed fields are NOT in the UPDATE SET (insert-only — dashboard owns them after).
  for (const c of SEED_ONLY_COLUMNS) {
    assert.ok(!(updateColumns as string[]).includes(c), `seed-only column ${c} must not be updated`);
  }
});

test('★ apply upsert sets spec_path = the manifest script (INSERT + UPDATE) — the recipe-search fix', () => {
  const { insertColumns, updateColumns, values, text } = buildApplyUpsert(monitor());
  assert.ok(insertColumns.includes('spec_path'), 'spec_path inserted');
  assert.ok((updateColumns as string[]).includes('spec_path'), 'spec_path re-synced on conflict');
  assert.equal(values[insertColumns.indexOf('spec_path')], 'monitors/wegmans/search-product.spec.ts');
  assert.match(text, /spec_path = EXCLUDED\.spec_path/);
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
    'archived_at', // ★ 0071: reversible archive is DASHBOARD-OWNED — reconcile must never touch it.
  ];
  for (const c of dashboardOwned) {
    assert.ok(!insertColumns.includes(c), `${c} must not be inserted`);
    assert.ok(!updateColumns.includes(c), `${c} must not be updated`);
    assert.ok(!text.includes(c), `${c} must not appear in the upsert SQL`);
  }
});

// ★ 0071 archive safety: archived_at must be in NEITHER git-write allow-list, so a manifest apply is
// STRUCTURALLY incapable of writing it — the "survives reconcile" guarantee (a dashboard archive can never
// be silently un-archived by a git apply, the same property tags/severity/locations rely on).
test('★ archived_at is dashboard-owned: absent from every reconcile write allow-list (survives apply)', () => {
  assert.ok(
    !(GIT_AUTHORITATIVE_COLUMNS as readonly string[]).includes('archived_at'),
    'archived_at must NOT be git-authoritative (else every apply would clobber a dashboard archive)',
  );
  assert.ok(
    !(SEED_ONLY_COLUMNS as readonly string[]).includes('archived_at'),
    'archived_at must NOT be seed-only',
  );
  assert.ok(!CHANGED_UPDATE_COLUMNS.includes('archived_at'), 'archived_at must NOT be in the changed-field UPDATE set');
});

test('apply upsert conflict-targets source_key and seeds the right values', () => {
  const { text, values } = buildApplyUpsert(monitor({ suggestedIntervalSeconds: undefined }));
  assert.match(text, /ON CONFLICT \(source_key\) WHERE source_key IS NOT NULL DO UPDATE/);
  // values order = [source_key, name, kind, target_url, flow_name, sensitive, redact_patterns,
  //                 environment, rewrite_from_origin, interval, enabled, spec_path]
  assert.deepEqual(values, [
    'wegmans-search-product',
    'Wegmans: search → product page',
    'browser',
    'https://www.wegmans.com',
    'search-product',
    false, // sensitive default
    'null', // redact_patterns: JSON.stringify(null) — none declared
    'prod', // environment (0059) — omitted -> 'prod'
    null, // rewrite_from_origin (0060) — omitted -> null (no S2 rewrite)
    300, // omitted suggestedIntervalSeconds -> column default 300
    false, // enabledByDefault false
    'monitors/wegmans/search-product.spec.ts', // spec_path = the manifest script
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
  const { updates, blockedStrips } = b10FieldUpdates(
    [monitor({ sensitive: true, redact_patterns: ['eyJ[A-Za-z0-9_-]+', '[Bb]earer\\s+\\S+'] })],
    [managed({ sensitive: false, redact_patterns: null })], // the leak: manifest says sensitive, DB defaulted false
  );
  assert.equal(updates.length, 1);
  assert.equal(blockedStrips.length, 0);
  assert.equal(updates[0].source_key, 'wegmans-search-product');
  assert.equal(updates[0].sensitive, true);
  assert.equal(updates[0].intentionalStrip, false); // false→true is NOT a strip
  assert.equal(updates[0].redact_patterns, JSON.stringify(['eyJ[A-Za-z0-9_-]+', '[Bb]earer\\s+\\S+']));
});

test('b10FieldUpdates: a check ALREADY matching the manifest → NO update (untouched)', () => {
  assert.deepEqual(
    b10FieldUpdates(
      [monitor({ sensitive: true, redact_patterns: ['x'] })],
      [managed({ sensitive: true, redact_patterns: ['x'] })],
    ),
    { updates: [], blockedStrips: [] },
  );
  // a non-sensitive monitor + non-sensitive check (the default fleet) → also untouched.
  assert.deepEqual(b10FieldUpdates([monitor()], [managed()]), { updates: [], blockedStrips: [] });
});

test('★ b10FieldUpdates write carries source_key + the 2 B10 columns (+ the strip flag, not written)', () => {
  // The DB UPDATE in reconcileMain uses ONLY source_key + sensitive + redact_patterns; intentionalStrip is
  // log-only metadata, never a column.
  const u = b10FieldUpdates([monitor({ sensitive: true, redact_patterns: ['x'] })], [managed({ sensitive: false })])
    .updates[0];
  assert.deepEqual(Object.keys(u).sort(), ['intentionalStrip', 'redact_patterns', 'sensitive', 'source_key']);
});

test('★ FULL git-authoritative apply stays OFF: b10FieldUpdates IGNORES name/target/etc.', () => {
  // name + target_url diverge, but sensitive matches → the scoped sync produces NO update
  // (it does NOT apply name/target — that is the still-gated full apply).
  assert.deepEqual(
    b10FieldUpdates(
      [monitor({ name: 'NEW name', target: 'https://changed.example', sensitive: false })],
      [managed({ name: 'OLD name', target_url: 'https://old.example', sensitive: false })],
    ),
    { updates: [], blockedStrips: [] },
  );
});

// --- ★ B10 WRITE-PATH STRIP GUARD (the fix) -----------------------------------------------------------
test('isRedactionStrip: ONLY live-true→want-false is a strip', () => {
  assert.equal(isRedactionStrip(false, true), true); // sensitive true→false = strip
  assert.equal(isRedactionStrip(true, false), false); // false→true (enabling) = NOT a strip
  assert.equal(isRedactionStrip(true, true), false); // stays sensitive (e.g. pattern edit) = NOT a strip
  assert.equal(isRedactionStrip(false, false), false); // stays non-sensitive = NOT a strip
});

test('★ STRIP without allowance → REFUSED (not applied, surfaced in blockedStrips, check stays sensitive)', () => {
  // wegmans-search-product is NOT in REDACTION_STRIP_ALLOWANCE.
  const { updates, blockedStrips } = b10FieldUpdates(
    [monitor({ id: 'wegmans-search-product', sensitive: false, redact_patterns: undefined })],
    [managed({ source_key: 'wegmans-search-product', sensitive: true, redact_patterns: ['eyJ\\S+'] })],
  );
  assert.deepEqual(updates, [], 'the strip is NOT applied — the check is left sensitive=true');
  assert.deepEqual(blockedStrips, ['wegmans-search-product'], 'and is surfaced for logging');
});

test('★ STRIP with allowance → APPLIED as an intentional strip', () => {
  // meals2go-browse-menu IS in REDACTION_STRIP_ALLOWANCE.
  const { updates, blockedStrips } = b10FieldUpdates(
    [monitor({ id: 'meals2go-browse-menu', sensitive: false, redact_patterns: undefined })],
    [managed({ source_key: 'meals2go-browse-menu', sensitive: true, redact_patterns: ['eyJ\\S+'] })],
  );
  assert.equal(blockedStrips.length, 0);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].sensitive, false);
  assert.equal(updates[0].intentionalStrip, true);
  assert.equal(updates[0].redact_patterns, JSON.stringify(null)); // patterns cleared with the strip
});

test('★ NON-strip changes apply regardless of the allowance (false→true; pattern-only edit)', () => {
  // false→true on a NON-allow-listed monitor still applies (enabling redaction is never blocked).
  const enable = b10FieldUpdates(
    [monitor({ id: 'wegmans-search-product', sensitive: true, redact_patterns: ['x'] })],
    [managed({ source_key: 'wegmans-search-product', sensitive: false })],
  );
  assert.equal(enable.updates.length, 1);
  assert.equal(enable.updates[0].sensitive, true);
  assert.equal(enable.updates[0].intentionalStrip, false);
  assert.equal(enable.blockedStrips.length, 0);
  // pattern-only edit while STAYING sensitive → applies (not a strip).
  const patternEdit = b10FieldUpdates(
    [monitor({ id: 'wegmans-search-product', sensitive: true, redact_patterns: ['NEW'] })],
    [managed({ source_key: 'wegmans-search-product', sensitive: true, redact_patterns: ['OLD'] })],
  );
  assert.equal(patternEdit.updates.length, 1);
  assert.equal(patternEdit.updates[0].redact_patterns, JSON.stringify(['NEW']));
  assert.equal(patternEdit.blockedStrips.length, 0);
});

test('★ plan path agrees with the write path: strip-not-allowed → blocked; strip-allowed → not blocked', () => {
  const stripDrift = (sourceKey: string) => ({
    source_key: sourceKey,
    drift_type: 'redaction_mismatch' as const,
    detail: { fields: { sensitive: { git: false, live: true } } },
  });
  // not allow-listed → the plan marks it blocked.
  const blockedPlan = computeApplyPlan([], [stripDrift('wegmans-search-product')], ['eastus2']);
  assert.equal(blockedPlan.find((r) => r.source_key === 'wegmans-search-product')?.status, 'blocked');
  // allow-listed → NOT blocked (auto — the write path applies it intentionally).
  const allowedPlan = computeApplyPlan([], [stripDrift('meals2go-browse-menu')], ['eastus2']);
  assert.notEqual(allowedPlan.find((r) => r.source_key === 'meals2go-browse-menu')?.status, 'blocked');
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

// ─── RECONCILE-APPLY PHASE 0: computeApplyPlan (DRY-RUN — renders statements, executes nothing) ───────
const REGIONS = ['eastus2', 'centralus', 'westus2'];

test('★ apply-plan: a NEW drift → materialize-DISABLED (enabled=false), sensitive INLINE, status pending', () => {
  const m = monitor({ sensitive: true, redact_patterns: ['eyJ.+'] });
  const plans = computeApplyPlan([m], [{ source_key: m.id, drift_type: 'new', detail: {} }], REGIONS);
  assert.equal(plans.length, 1);
  const p = plans[0];
  assert.equal(p.status, 'pending');
  assert.match(p.plan.summary, /MATERIALIZE/);
  assert.match(p.plan.summary, /enabled=FALSE/);
  assert.match(p.plan.summary, /sensitive=true/);
  // the materialize statement is the buildApplyUpsert INSERT, with sensitive inline + enabled forced false.
  const matStmt = p.plan.statements.find((s) => s.purpose.includes('materialize'))!;
  assert.match(matStmt.text, /INSERT INTO checks/);
  assert.match(matStmt.text, /sensitive/);
  // insert column order: source_key,name,kind,target_url,flow_name,sensitive,redact_patterns,
  //                      environment,rewrite_from_origin,interval,enabled,spec_path
  assert.equal(matStmt.values![5], true, 'sensitive=true inline in the INSERT values');
  assert.equal(matStmt.values![10], false, '★ enabled FORCED false (materialize-disabled)');
  // ★ spec_path (last) is materialized — without it the runner can only fail with "Cannot find module".
  assert.equal(matStmt.values![11], 'monitors/wegmans/search-product.spec.ts', 'spec_path inline in the INSERT values');
  // and the location-assignment statement carries the active regions.
  const locStmt = p.plan.statements.find((s) => s.purpose.includes('locations'))!;
  assert.deepEqual(locStmt.regions, REGIONS);
});

test('★ GATE: a NEW browser monitor whose script is NOT a resolvable spec is BLOCKED (never materialized)', () => {
  // A monitor that bypassed validateManifest (e.g. internal inconsistency) with a non-spec script —
  // materializing it would create a check that can only fail. computeApplyPlan must fail-closed.
  const m = monitor({ script: 'flows/not-a-spec.ts' as Monitor['script'] });
  const plan = computeApplyPlan([m], [{ source_key: m.id, drift_type: 'new', detail: {} }], REGIONS)[0];
  assert.equal(plan.status, 'blocked', 'unresolvable browser spec must NOT reach pending/apply');
  assert.equal(plan.plan.statements.length, 0, 'no materialize statement is emitted');
  assert.match(plan.plan.blockedReason ?? '', /not resolvable|Cannot find module/);
});

test('isResolvableSpec: true for a manifest spec path, false for a non-spec script', () => {
  assert.equal(isResolvableSpec('monitors/wegmans/recipe-search.spec.ts'), true);
  assert.equal(isResolvableSpec('flows/x.ts'), false);
  assert.equal(isResolvableSpec('monitors/../etc/passwd.spec.ts'), false); // traversal guarded
});

test('apply-plan: a CHANGED drift → SCOPED git-auth UPDATE listing the differing fields, status pending', () => {
  const m = monitor({ name: 'New name' });
  const plan = computeApplyPlan([m], [{ source_key: m.id, drift_type: 'changed', detail: { fields: { name: { git: 'New name', live: 'Old' } } } }], REGIONS)[0];
  assert.equal(plan.status, 'pending');
  assert.match(plan.plan.summary, /UPDATE git-authoritative field\(s\) \[name\]/);
  const stmt = plan.plan.statements[0];
  // a SCOPED UPDATE … WHERE source_key = $1 — NOT the full ON CONFLICT upsert (whose SET includes redaction).
  assert.match(stmt.text, /^UPDATE checks SET /);
  assert.match(stmt.text, /WHERE source_key = \$1$/);
  assert.match(stmt.text, /\bname = \$/);
  assert.doesNotMatch(stmt.text, /ON CONFLICT/);
});

// ★★ THE STRIP-SAFETY TEST — the reason this PR exists. A `changed` apply must be INCAPABLE of stripping
// redaction. Assert the ABSENCE of sensitive/redact_patterns from the emitted SET (a test that only checks
// "name updates" would pass even if the bypass existed).
test('★★ STRIP-SAFETY: a CHANGED apply NEVER puts sensitive/redact_patterns in the SET (strip cannot flow through)', () => {
  // Sensitive monitor with redaction; real drift is name + target_url. The changed drift NEVER carries a
  // redaction field (that is a separate redaction_mismatch row) — model the real detail shape.
  const m = monitor({ name: 'New name', target: 'https://new.example', sensitive: true, redact_patterns: ['member-\\d+'] });
  const drift = {
    source_key: m.id,
    drift_type: 'changed' as const,
    detail: { fields: { name: { git: 'New name', live: 'Old' }, target_url: { git: 'https://new.example', live: 'https://old.example' } } },
  };
  const stmt = computeApplyPlan([m], [drift], REGIONS)[0].plan.statements[0];
  // the REAL drift is in the SET …
  assert.match(stmt.text, /\bname = \$/);
  assert.match(stmt.text, /\btarget_url = \$/);
  // ★ … and redaction is provably ABSENT — executing this UPDATE leaves sensitive/redact_patterns byte-identical.
  assert.doesNotMatch(stmt.text, /\bsensitive\b/, 'sensitive must NEVER be in a changed UPDATE SET');
  assert.doesNotMatch(stmt.text, /\bredact_patterns\b/, 'redact_patterns must NEVER be in a changed UPDATE SET');
  // precise proof of the emitted values: [source_key, name, target_url, spec_path] — no redaction value present.
  assert.deepEqual(stmt.values, [m.id, 'New name', 'https://new.example', m.script]);
});

test('apply-plan: a CHANGED target_url drift (non-sensitive monitor) → SET updates target_url, still excludes redaction', () => {
  const m = monitor({ target: 'https://new.example' });
  const drift = { source_key: m.id, drift_type: 'changed' as const, detail: { fields: { target_url: { git: 'https://new.example', live: 'https://old.example' } } } };
  const stmt = computeApplyPlan([m], [drift], REGIONS)[0].plan.statements[0];
  assert.match(stmt.text, /\btarget_url = \$/);
  assert.doesNotMatch(stmt.text, /\bsensitive\b/);
  assert.doesNotMatch(stmt.text, /\bredact_patterns\b/);
});

test('CHANGED_UPDATE_COLUMNS is exactly GIT_AUTHORITATIVE_COLUMNS minus the redaction pair (single source of truth)', () => {
  assert.deepEqual([...CHANGED_UPDATE_COLUMNS], ['name', 'kind', 'target_url', 'flow_name', 'environment', 'rewrite_from_origin']);
  for (const c of REDACTION_COLUMNS) assert.equal(CHANGED_UPDATE_COLUMNS.includes(c), false);
  // every changed-updatable column IS git-authoritative (never a seed-only / dashboard-owned column)
  for (const c of CHANGED_UPDATE_COLUMNS) assert.equal((GIT_AUTHORITATIVE_COLUMNS as readonly string[]).includes(c), true);
});

test('apply-plan: a redaction_mismatch (manifest WANTS sensitive) → status "auto" (already #144), not pending', () => {
  const m = monitor({ sensitive: true });
  const plan = computeApplyPlan([m], [{ source_key: m.id, drift_type: 'redaction_mismatch', detail: { fields: { sensitive: { git: true, live: false } } } }], REGIONS)[0];
  assert.equal(plan.status, 'auto');
  assert.match(plan.plan.summary, /AUTO-APPLIED/);
  assert.equal(plan.plan.statements.length, 0, 'auto items propose no human-approval statement');
});

test('★ apply-plan: a redaction_mismatch STRIP (sensitive true→false) → status BLOCKED with reason', () => {
  const m = monitor({ sensitive: false }); // manifest dropped sensitive...
  const plan = computeApplyPlan([m], [{ source_key: m.id, drift_type: 'redaction_mismatch', detail: { fields: { sensitive: { git: false, live: true } } } }], REGIONS)[0];
  assert.equal(plan.status, 'blocked', '★ reconcile may NEVER strip redaction');
  assert.match(plan.plan.summary, /BLOCKED|STRIP/);
  assert.match(plan.plan.blockedReason ?? '', /cannot strip redaction/i);
});

test('apply-plan: a MISSING drift → soft-disable (enabled=false), never delete, status pending', () => {
  const plan = computeApplyPlan([], [{ source_key: 'gone', drift_type: 'missing', detail: { name: 'x' } }], REGIONS)[0];
  assert.equal(plan.status, 'pending');
  assert.match(plan.plan.summary, /SOFT-DISABLE/);
  assert.match(plan.plan.statements[0].text, /SET enabled = false/);
  assert.doesNotMatch(plan.plan.statements[0].text, /DELETE/);
});

test('apply-plan: an ORPHAN drift → noop (no apply, spec not runnable)', () => {
  const plan = computeApplyPlan([], [{ source_key: 'x', drift_type: 'orphan', detail: { reason: 'not fetchable: 404' } }], REGIONS)[0];
  assert.equal(plan.status, 'noop');
  assert.equal(plan.plan.statements.length, 0);
});

// --- Pre-prod-arc S3: environment + rewrite_from_origin (0059/0060) --------------------------------
test('S3: validateManifest carries environment + rewrite_from_origin through', () => {
  const src = {
    ...VALID,
    monitors: [{ ...VALID.monitors[0], environment: 'staging', target: 'https://preview.commerce.wegmans.com', rewrite_from_origin: 'https://www.wegmans.com' }],
  };
  const m = validateManifest(src).monitors[0];
  assert.equal(m.environment, 'staging');
  assert.equal(m.rewrite_from_origin, 'https://www.wegmans.com');
});

test('S3: validateManifest REJECTS a bad environment value', () => {
  const bad = { ...VALID, monitors: [{ ...VALID.monitors[0], environment: 'production' }] };
  assert.throws(() => validateManifest(bad), /environment invalid/);
});

test('S3: validateManifest REJECTS rewrite_from_origin with no target to rewrite TO', () => {
  const noTarget = { ...VALID, monitors: [{ ...VALID.monitors[0], target: undefined, rewrite_from_origin: 'https://www.wegmans.com' }] };
  assert.throws(() => validateManifest(noTarget), /rewrite_from_origin set but no target/);
});

test('S3: validateManifest REJECTS a malformed rewrite_from_origin at parse time (bare host / path)', () => {
  const bareHost = { ...VALID, monitors: [{ ...VALID.monitors[0], target: 'https://preview.commerce.wegmans.com', rewrite_from_origin: 'www.wegmans.com' }] };
  assert.throws(() => validateManifest(bareHost), /rewrite_from_origin.*malformed origin/);
  const withPath = { ...VALID, monitors: [{ ...VALID.monitors[0], target: 'https://preview.commerce.wegmans.com', rewrite_from_origin: 'https://www.wegmans.com/search' }] };
  assert.throws(() => validateManifest(withPath), /rewrite_from_origin.*carries a path/);
});

test('S3: buildApplyUpsert seeds environment + rewrite_from_origin (defaults prod/null when omitted)', () => {
  const staged = buildApplyUpsert(monitor({ environment: 'staging', target: 'https://preview.commerce.wegmans.com', rewrite_from_origin: 'https://www.wegmans.com' }));
  // environment at index 7, rewrite_from_origin at index 8 (after the redaction pair)
  assert.equal(staged.values[7], 'staging');
  assert.equal(staged.values[8], 'https://www.wegmans.com');
  const prod = buildApplyUpsert(monitor({}));
  assert.equal(prod.values[7], 'prod');
  assert.equal(prod.values[8], null);
});

test('S3: computeDrift flags a CHANGED on environment / rewrite_from_origin (manifest is source of truth)', () => {
  const m = monitor({ environment: 'staging', target: 'https://preview.commerce.wegmans.com', rewrite_from_origin: 'https://www.wegmans.com' });
  // live row is still prod / no-rewrite (e.g. materialized before S3)
  const live = managed({ target_url: 'https://preview.commerce.wegmans.com', environment: 'prod', rewrite_from_origin: null });
  const rows = computeDrift([m], [live], runnable(SPEC));
  const changed = rows.find((r) => r.drift_type === 'changed');
  assert.ok(changed, 'expected a changed row');
  const fields = (changed!.detail as { fields: Record<string, unknown> }).fields;
  assert.deepEqual(fields.environment, { git: 'staging', live: 'prod' });
  assert.deepEqual(fields.rewrite_from_origin, { git: 'https://www.wegmans.com', live: null });
});

// --- Recon #55 gap A: redtest_anchor (scoped-synced, NOT in the positional apply plan) --------------
test('redtest_anchor: validateManifest carries it through', () => {
  const src = { ...VALID, monitors: [{ ...VALID.monitors[0], redtest_anchor: '**/opentable.com/**' }] };
  assert.equal(validateManifest(src).monitors[0].redtest_anchor, '**/opentable.com/**');
});

test('redtest_anchor: validateManifest REJECTS an empty string', () => {
  const bad = { ...VALID, monitors: [{ ...VALID.monitors[0], redtest_anchor: '' }] };
  assert.throws(() => validateManifest(bad), /redtest_anchor invalid/);
});

test('★ redtest_anchor is NOT in the apply plan tuple (the #216 trap avoided)', () => {
  // buildApplyUpsert's positional values must NOT include redtest_anchor — that would shift the API
  // materialize indices again. It is scoped-synced instead, so the plan tuple is unchanged.
  assert.equal((GIT_AUTHORITATIVE_COLUMNS as readonly string[]).includes('redtest_anchor'), false);
  const { insertColumns } = buildApplyUpsert(monitor({ redtest_anchor: '**/x/**' }));
  assert.equal(insertColumns.includes('redtest_anchor'), false, 'redtest_anchor must not enter the materialize tuple');
});

test('redtestAnchorUpdates: emits a targeted update when the live anchor diverges; skips when in sync', () => {
  // manifest sets the anchor, live row is NULL -> one update
  const diverged = redtestAnchorUpdates([monitor({ redtest_anchor: '**/opentable.com/**' })], [managed({ redtest_anchor: null })]);
  assert.deepEqual(diverged, [{ source_key: 'wegmans-search-product', redtest_anchor: '**/opentable.com/**' }]);
  // already in sync -> no update
  assert.deepEqual(
    redtestAnchorUpdates([monitor({ redtest_anchor: '**/opentable.com/**' })], [managed({ redtest_anchor: '**/opentable.com/**' })]),
    [],
  );
  // manifest omits it, live NULL -> in sync, no update
  assert.deepEqual(redtestAnchorUpdates([monitor({})], [managed({ redtest_anchor: null })]), []);
  // no live check (not yet materialized) -> skipped (materialize is the separate gated concern)
  assert.deepEqual(redtestAnchorUpdates([monitor({ redtest_anchor: '**/x/**' })], []), []);
});
