// Monitors-as-code config reconcile (Phase 6b) — PURE module, no top-level side effects
// so it's importable by tests; the entry point lives in reconcileMain.ts (mirrors the
// rollup.ts / rollupMain.ts split).
//
// WHAT THIS DOES (this PR): fetch synthwatch-monitors' manifest.json over HTTPS (no clone),
// validate it against the manifest schema, and DIFF it against live `checks` — read-only.
// It DETECTS drift; it APPLIES NOTHING to config. The field-split apply upsert
// (buildApplyUpsert) is built + unit-tested here but is NOT invoked by reconcileMain — a
// later PR flips it on. Detect-first mirrors the RCA "page, don't silently act" posture.
//
// SOURCE-OF-TRUTH SPLIT (the load-bearing decision — recorded in the 6b design):
//   GIT-AUTHORITATIVE  (apply overwrites every run): name, kind, target_url, flow_name
//   SEED-ONLY          (apply INSERTs, never UPDATEs): interval_seconds, enabled
//   DASHBOARD-OWNED    (apply never writes): severity, thresholds, routing, tags, locations
// The manifest itself declares this split ("the SCRIPT lives here; the MONITORING CONFIG —
// interval, locations, alerting, enabled — lives in SynthWatch's DB"). So Git and the
// dashboard own DISJOINT fields; the reconcile keeps a strict column allow-list to honor it.
//
// IDENTITY: manifest `id` -> checks.source_key (NOT flow_name — they deliberately differ).

/** A monitor entry from synthwatch-monitors' manifest.json (kind is browser-only today). */
export interface Monitor {
  id: string;
  name: string;
  script: string; // 'monitors/.../<name>.spec.ts'
  kind: 'browser';
  suggestedIntervalSeconds?: number;
  tags?: string[];
  description?: string;
  target?: string;
  enabledByDefault?: boolean;
}

export interface Manifest {
  schemaVersion: 1;
  description?: string;
  monitors: Monitor[];
}

/** The Git-managed `checks` columns the reconcile reads (source_key IS NOT NULL rows). */
export interface ManagedCheck {
  source_key: string;
  name: string;
  kind: string;
  target_url: string;
  flow_name: string | null;
}

export type DriftType = 'new' | 'changed' | 'missing' | 'orphan';

export interface DriftRow {
  source_key: string;
  drift_type: DriftType;
  detail: Record<string, unknown>;
}

// The default raw-manifest URL. Overridable (tests / a fork) via env. Raw HTTPS read of
// `main` — no git clone, which config-only reconcile doesn't need (it reads manifest.json,
// not the .spec.ts files).
export const DEFAULT_MANIFEST_URL =
  'https://raw.githubusercontent.com/craigoley/synthwatch-monitors/main/manifest.json';

export function manifestUrl(): string {
  return process.env.SYNTHWATCH_MONITORS_MANIFEST_URL || DEFAULT_MANIFEST_URL;
}

// Default cadence for a monitor that omits suggestedIntervalSeconds — matches the
// checks.interval_seconds column default (300s).
const DEFAULT_INTERVAL_SECONDS = 300;

// Mirrors manifest.schema.json. Kept in code (not a JSON-schema lib) to avoid a new dep,
// the same way other runner modules hand-validate their inputs.
const ID_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const SCRIPT_RE = /^monitors\/.+\.spec\.ts$/;
// The runner's flow-name allowlist (checks/index.ts loadFlow): a derived flow_name that
// can't match this can never be a real flow module -> it will read as 'orphan'.
const FLOW_NAME_RE = /^[a-z0-9-]+$/;

/**
 * The runner flow_name a manifest monitor binds to = the script's basename without the
 * `.spec.ts` suffix (e.g. 'monitors/wegmans/search-product.spec.ts' -> 'search-product').
 * This is the manifest->runner binding convention. Whether a compiled module with that name
 * actually EXISTS in the runner image is the orphan check (see computeDrift); spec execution
 * itself is deferred to a later phase.
 */
export function flowNameFor(monitor: Monitor): string {
  const base = monitor.script.split('/').pop() ?? monitor.script;
  return base.replace(/\.spec\.ts$/, '');
}

/** Validate a parsed manifest against the schema invariants; throw on the first violation. */
export function validateManifest(raw: unknown): Manifest {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('manifest is not an object');
  }
  const m = raw as Record<string, unknown>;
  if (m.schemaVersion !== 1) {
    throw new Error(`unsupported schemaVersion: ${JSON.stringify(m.schemaVersion)} (expected 1)`);
  }
  if (!Array.isArray(m.monitors)) {
    throw new Error('manifest.monitors is not an array');
  }

  const seen = new Set<string>();
  const monitors: Monitor[] = m.monitors.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`monitors[${i}] is not an object`);
    }
    const e = entry as Record<string, unknown>;
    const where = `monitors[${i}]`;

    if (typeof e.id !== 'string' || !ID_RE.test(e.id)) {
      throw new Error(`${where}.id invalid: ${JSON.stringify(e.id)} (must match ${ID_RE})`);
    }
    if (seen.has(e.id)) throw new Error(`duplicate monitor id: ${e.id}`);
    seen.add(e.id);

    if (typeof e.name !== 'string' || e.name.length < 1 || e.name.length > 120) {
      throw new Error(`${where}.name invalid (1-120 chars): ${JSON.stringify(e.name)}`);
    }
    if (typeof e.script !== 'string' || !SCRIPT_RE.test(e.script)) {
      throw new Error(`${where}.script invalid: ${JSON.stringify(e.script)} (must match ${SCRIPT_RE})`);
    }
    if (e.kind !== 'browser') {
      throw new Error(`${where}.kind invalid: ${JSON.stringify(e.kind)} (only 'browser' supported)`);
    }
    if (
      e.suggestedIntervalSeconds !== undefined &&
      (!Number.isInteger(e.suggestedIntervalSeconds) || (e.suggestedIntervalSeconds as number) < 60)
    ) {
      throw new Error(`${where}.suggestedIntervalSeconds invalid (integer >= 60)`);
    }
    if (e.tags !== undefined && (!Array.isArray(e.tags) || !e.tags.every((t) => typeof t === 'string'))) {
      throw new Error(`${where}.tags invalid (array of strings)`);
    }
    if (e.target !== undefined && typeof e.target !== 'string') {
      throw new Error(`${where}.target invalid (string)`);
    }
    if (e.enabledByDefault !== undefined && typeof e.enabledByDefault !== 'boolean') {
      throw new Error(`${where}.enabledByDefault invalid (boolean)`);
    }
    if (e.description !== undefined && typeof e.description !== 'string') {
      throw new Error(`${where}.description invalid (string)`);
    }

    return {
      id: e.id,
      name: e.name,
      script: e.script,
      kind: 'browser',
      suggestedIntervalSeconds: e.suggestedIntervalSeconds as number | undefined,
      tags: e.tags as string[] | undefined,
      description: e.description as string | undefined,
      target: e.target as string | undefined,
      enabledByDefault: e.enabledByDefault as boolean | undefined,
    };
  });

  return { schemaVersion: 1, description: m.description as string | undefined, monitors };
}

/** Fetch + validate the manifest over HTTPS. Throws on network / non-200 / invalid. */
export async function fetchManifest(url = manifestUrl()): Promise<Manifest> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`manifest fetch failed: ${res.status} ${res.statusText} (${url})`);
  }
  const raw: unknown = await res.json();
  return validateManifest(raw);
}

/**
 * Diff the manifest against the Git-managed checks, READ-ONLY. Returns a drift row per
 * (source_key, drift_type) — a monitor can yield several (e.g. NEW and ORPHAN). Unmanaged
 * checks (source_key NULL) are never passed in, so they're invisible to reconcile by design.
 */
export function computeDrift(
  monitors: Monitor[],
  managedChecks: ManagedCheck[],
  knownFlows: Set<string>,
): DriftRow[] {
  const byId = new Map(monitors.map((m) => [m.id, m]));
  const byKey = new Map(managedChecks.map((c) => [c.source_key, c]));
  const rows: DriftRow[] = [];

  for (const m of monitors) {
    const flow = flowNameFor(m);

    // ORPHAN — the bound flow has no compiled runner module (or isn't a valid flow name).
    // "Git defines a monitor the runner can't run yet" (spec execution deferred).
    if (!FLOW_NAME_RE.test(flow) || !knownFlows.has(flow)) {
      rows.push({
        source_key: m.id,
        drift_type: 'orphan',
        detail: { flow_name: flow, reason: 'no compiled runner flow module for this monitor' },
      });
    }

    const existing = byKey.get(m.id);
    if (!existing) {
      // NEW — manifest id with no live (managed) check. Apply WOULD insert it.
      rows.push({
        source_key: m.id,
        drift_type: 'new',
        detail: { name: m.name, kind: m.kind, target_url: m.target ?? null, flow_name: flow },
      });
      continue;
    }

    // CHANGED — compare ONLY Git-authoritative fields (interval/enabled/severity/tags/
    // locations are seed-only or dashboard-owned and must NOT count as drift).
    const diff: Record<string, { git: unknown; live: unknown }> = {};
    if (existing.name !== m.name) diff.name = { git: m.name, live: existing.name };
    if (existing.kind !== m.kind) diff.kind = { git: m.kind, live: existing.kind };
    if (m.target !== undefined && existing.target_url !== m.target) {
      diff.target_url = { git: m.target, live: existing.target_url };
    }
    if (existing.flow_name !== flow) diff.flow_name = { git: flow, live: existing.flow_name };
    if (Object.keys(diff).length > 0) {
      rows.push({ source_key: m.id, drift_type: 'changed', detail: { fields: diff } });
    }
  }

  // MISSING — a Git-managed check whose manifest id is gone. Apply WOULD soft-disable
  // (enabled=false), NEVER hard-delete.
  for (const c of managedChecks) {
    if (!byId.has(c.source_key)) {
      rows.push({
        source_key: c.source_key,
        drift_type: 'missing',
        detail: { name: c.name, action: 'would soft-disable (enabled=false); never hard-delete' },
      });
    }
  }

  return rows;
}

// --- Field-split policy (the strict column allow-list), as data so tests can assert on it.
/** Git-authoritative: overwritten on every apply (INSERT and UPDATE). */
export const GIT_AUTHORITATIVE_COLUMNS = ['name', 'kind', 'target_url', 'flow_name'] as const;
/** Git-seeds-then-dashboard-owns: written on INSERT only, never in the UPDATE SET. */
export const SEED_ONLY_COLUMNS = ['interval_seconds', 'enabled'] as const;

/**
 * Build the field-split apply upsert for one monitor. GATED — built + unit-tested here but
 * NOT invoked by reconcileMain this PR (detect-first). The returned column sets make the
 * source-of-truth split assertable without a DB:
 *   - source_key (identity) + GIT_AUTHORITATIVE + SEED_ONLY are inserted.
 *   - ON CONFLICT (source_key) updates ONLY the GIT_AUTHORITATIVE columns.
 *   - SEED_ONLY columns are insert-only (absent from the UPDATE SET).
 *   - DASHBOARD-OWNED columns appear nowhere (reconcile never writes them).
 */
export function buildApplyUpsert(monitor: Monitor): {
  text: string;
  values: unknown[];
  insertColumns: string[];
  updateColumns: string[];
} {
  const flow = flowNameFor(monitor);
  // INSERT column order: identity, then Git-authoritative, then seed-only.
  const insertColumns = ['source_key', ...GIT_AUTHORITATIVE_COLUMNS, ...SEED_ONLY_COLUMNS];
  const values: unknown[] = [
    monitor.id, // source_key
    monitor.name,
    monitor.kind,
    monitor.target ?? null,
    flow,
    monitor.suggestedIntervalSeconds ?? DEFAULT_INTERVAL_SECONDS,
    monitor.enabledByDefault ?? false,
  ];
  const placeholders = insertColumns.map((_, i) => `$${i + 1}`).join(', ');
  // ON CONFLICT updates the Git-authoritative columns ONLY (seed-only + dashboard-owned excluded).
  const updateColumns = [...GIT_AUTHORITATIVE_COLUMNS];
  const setClause = updateColumns.map((c) => `${c} = EXCLUDED.${c}`).join(', ');

  const text =
    `INSERT INTO checks (${insertColumns.join(', ')})\n` +
    `VALUES (${placeholders})\n` +
    `ON CONFLICT (source_key) DO UPDATE SET ${setClause}`;

  return { text, values, insertColumns, updateColumns };
}
