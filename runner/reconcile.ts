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
import { assertValidSpecPath, fetchContentsAtMain } from './specfetch/fetchSpec.js';

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
  // B10: declare a cart/auth monitor as sensitive + its redaction patterns. validateManifest REQUIRES
  // redact_patterns when sensitive is true (the enable gate); reconcile writes both to checks (Git-auth).
  sensitive?: boolean;
  redact_patterns?: string[];
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
  // B10: read so the scoped sync can detect + correct a check whose sensitive/redact_patterns
  // diverge from the manifest (the leak: manifest says sensitive but the live row defaulted to false).
  sensitive: boolean;
  redact_patterns: string[] | null;
}

// 'redaction_mismatch' (0049): a sensitive/redact_patterns divergence — kept SEPARATE from generic
// 'changed' so the B10 leak shape ("manifest declares sensitive, live check doesn't") is distinctly
// queryable on /reconcile/drift. #144's scoped sync auto-corrects it; this row is the audit trail.
export type DriftType = 'new' | 'changed' | 'missing' | 'orphan' | 'redaction_mismatch';

export interface DriftRow {
  source_key: string;
  drift_type: DriftType;
  detail: Record<string, unknown>;
}

// The manifest is read STRONGLY-CONSISTENTLY via the GitHub contents API at main's HEAD SHA (mirrors
// #138 — resolve /commits/main, fetch /contents/manifest.json?ref=<sha>). This kills the raw-CDN
// propagation window/flapping the hourly drift check used to suffer. An explicit
// SYNTHWATCH_MONITORS_MANIFEST_URL (a full URL — tests / a fork) is direct-fetched instead.
const MANIFEST_PATH = 'manifest.json';

/** The override URL if one is set (tests / a fork), else null = use the contents API at main@HEAD. */
export function manifestUrl(): string | null {
  return process.env.SYNTHWATCH_MONITORS_MANIFEST_URL || null;
}

// Default cadence for a monitor that omits suggestedIntervalSeconds — matches the
// checks.interval_seconds column default (300s).
const DEFAULT_INTERVAL_SECONDS = 300;

// Mirrors manifest.schema.json. Kept in code (not a JSON-schema lib) to avoid a new dep,
// the same way other runner modules hand-validate their inputs.
const ID_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const SCRIPT_RE = /^monitors\/.+\.spec\.ts$/;

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

/**
 * Resolve a check's spec_path from its source_key via the manifest (Phase 6b Option C, slice 2):
 * source_key === manifest id, and the monitor's `script` IS the spec path. Returns the validated
 * path, or null if no monitor has that id. Reuses the runtime fetch guard (assertValidSpecPath)
 * — one guard, not two; the manifest's SCRIPT_RE already validated `script` at parse time, so a
 * throw here means an internal inconsistency. The reconcile-apply step (gated) writes this to
 * checks.spec_path; the hot path then reads the column directly (no per-tick manifest fetch).
 */
export function specPathForSourceKey(monitors: Monitor[], sourceKey: string): string | null {
  const monitor = monitors.find((m) => m.id === sourceKey);
  if (!monitor) return null;
  assertValidSpecPath(monitor.script);
  return monitor.script;
}

/**
 * Non-throwing predicate: does this script resolve to a valid runtime spec_path? Reuses the runtime
 * fetch guard (assertValidSpecPath) — one source of truth for "what the runner can fetch + compile",
 * not a second regex. Used by computeApplyPlan to fail-closed (status 'blocked') instead of throwing
 * mid-plan when a browser monitor's script isn't a resolvable spec.
 */
export function isResolvableSpec(script: string): boolean {
  try {
    assertValidSpecPath(script);
    return true;
  } catch {
    return false;
  }
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
    if (e.sensitive !== undefined && typeof e.sensitive !== 'boolean') {
      throw new Error(`${where}.sensitive invalid (boolean)`);
    }
    if (e.redact_patterns !== undefined) {
      if (!Array.isArray(e.redact_patterns) || !e.redact_patterns.every((p) => typeof p === 'string')) {
        throw new Error(`${where}.redact_patterns invalid (array of strings)`);
      }
      for (const p of e.redact_patterns as string[]) {
        try {
          new RegExp(p);
        } catch {
          throw new Error(`${where}.redact_patterns: invalid regex ${JSON.stringify(p)}`);
        }
      }
    }
    // ★ B10 ENABLE GATE: "redaction REQUIRED before enable." A monitor marked sensitive MUST declare
    // redact_patterns — a sensitive-but-unwired entry is REJECTED here, so it never reconciles into
    // checks, never gets a check_locations row, and therefore can NEVER run. (The built-in token
    // denylist still applies at runtime, but the declared patterns are the monitor's own redaction.)
    if (e.sensitive === true && (!Array.isArray(e.redact_patterns) || e.redact_patterns.length === 0)) {
      throw new Error(
        `${where} is marked sensitive but declares no redact_patterns — B10 requires a sensitive monitor to declare redaction before it can be enabled.`,
      );
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
      sensitive: e.sensitive as boolean | undefined,
      redact_patterns: e.redact_patterns as string[] | undefined,
    };
  });

  return { schemaVersion: 1, description: m.description as string | undefined, monitors };
}

/** Fetch + validate the manifest. Default: strongly-consistent via the GitHub contents API at main's
 *  HEAD SHA (no raw-CDN lag). An explicit override URL (env) is direct-fetched. Throws on net/non-200/
 *  invalid-JSON/schema. */
export async function fetchManifest(): Promise<Manifest> {
  const override = manifestUrl();
  let raw: unknown;
  if (override) {
    const res = await fetch(override, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      throw new Error(`manifest fetch failed: ${res.status} ${res.statusText} (${override})`);
    }
    raw = await res.json();
  } else {
    const { source, sha } = await fetchContentsAtMain(MANIFEST_PATH, 'application/vnd.github.raw');
    try {
      raw = JSON.parse(source);
    } catch (err) {
      throw new Error(`manifest at ${sha} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }
  }
  return validateManifest(raw);
}

/**
 * Diff the manifest against the Git-managed checks, READ-ONLY. Returns a drift row per
 * (source_key, drift_type) — a monitor can yield several (e.g. NEW and ORPHAN). Unmanaged
 * checks (source_key NULL) are never passed in, so they're invisible to reconcile by design.
 */
/** Per-spec runnability under Option C — is the manifest's spec fetchable + compilable from
 *  main? Computed by reconcileMain (fetch+compile probe, which also warms spec_cache), keyed by
 *  spec path. Passed in so computeDrift stays pure/synchronous (mirrors the old knownFlows arg). */
export type SpecRunnability = Map<string, { runnable: boolean; reason?: string }>;

export function computeDrift(
  monitors: Monitor[],
  managedChecks: ManagedCheck[],
  specRunnable: SpecRunnability,
): DriftRow[] {
  const byId = new Map(monitors.map((m) => [m.id, m]));
  const byKey = new Map(managedChecks.map((c) => [c.source_key, c]));
  const rows: DriftRow[] = [];

  for (const m of monitors) {
    const flow = flowNameFor(m);

    // ORPHAN — Option C (slice 6) flips the meaning: "runnable" no longer means "a module is
    // BAKED into the runner image" — it means the spec is FETCHABLE + COMPILABLE from main (the
    // runner fetches+runs it at run start; #101-#105). So orphan now = a manifest spec that
    // 404s (Git declares a spec whose file is missing) or won't compile — "Git declares a spec
    // the runner can't run". A fetchable+compilable spec is NOT orphan. The probe (reconcileMain)
    // also warms spec_cache, so this pass front-loads the runtime cache.
    const probe = specRunnable.get(m.script);
    if (!probe || !probe.runnable) {
      rows.push({
        source_key: m.id,
        drift_type: 'orphan',
        detail: { spec_path: m.script, reason: probe?.reason ?? 'spec not probed' },
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

    // REDACTION_MISMATCH (B10) — a sensitive/redact_patterns divergence is its OWN drift_type, not part
    // of generic 'changed', so "manifest declares sensitive but the live check doesn't" (the leak shape)
    // is distinctly queryable/renderable on /reconcile/drift. #144's b10FieldUpdates auto-corrects it on
    // the same run; this row documents what was corrected. Same detail shape as 'changed' (per-field
    // git/live), so the endpoint + dashboard render it with the existing diff view. A monitor can yield
    // BOTH a 'changed' (name/etc.) and a 'redaction_mismatch' row — the PK is (source_key, drift_type).
    const redactionDiff: Record<string, { git: unknown; live: unknown }> = {};
    if ((m.sensitive ?? false) !== existing.sensitive) {
      redactionDiff.sensitive = { git: m.sensitive ?? false, live: existing.sensitive };
    }
    if (JSON.stringify(m.redact_patterns ?? null) !== JSON.stringify(existing.redact_patterns ?? null)) {
      redactionDiff.redact_patterns = { git: m.redact_patterns ?? null, live: existing.redact_patterns ?? null };
    }
    if (Object.keys(redactionDiff).length > 0) {
      rows.push({ source_key: m.id, drift_type: 'redaction_mismatch', detail: { fields: redactionDiff } });
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
/** Git-authoritative: overwritten on every apply (INSERT and UPDATE). B10's sensitive/redact_patterns
 *  are here (NOT seed-only/dashboard-owned) ON PURPOSE: the manifest is the single source of truth for
 *  the redaction policy, so a manifest change re-syncs it and the dashboard can't silently disable it. */
export const GIT_AUTHORITATIVE_COLUMNS = [
  'name',
  'kind',
  'target_url',
  'flow_name',
  'sensitive',
  'redact_patterns',
] as const;
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
  // ★ spec_path is the REAL runtime resolution path for a browser check: the runner fetches +
  // compiles this Git spec (executeBrowser's spec_path branch). flow_name is only a fallback to a
  // baked-in dist/checks/<name>.js, which a manifest monitor never has — so a materialize that omits
  // spec_path produces a check that can ONLY fail ("Cannot find module .../<flow_name>.js"). The
  // manifest `script` IS the spec path (validated at parse time; re-asserted here, same guard as
  // specPathForSourceKey). spec_path is appended LAST so `enabled` keeps index 8 (computeApplyPlan
  // forces it false by that index).
  assertValidSpecPath(monitor.script);
  const specPath = monitor.script;
  // INSERT column order: identity, Git-authoritative, seed-only, then spec_path.
  const insertColumns = ['source_key', ...GIT_AUTHORITATIVE_COLUMNS, ...SEED_ONLY_COLUMNS, 'spec_path'];
  const values: unknown[] = [
    monitor.id, // source_key
    monitor.name,
    monitor.kind,
    monitor.target ?? null,
    flow,
    monitor.sensitive ?? false, // sensitive
    JSON.stringify(monitor.redact_patterns ?? null), // redact_patterns (jsonb; assignment-cast from text)
    monitor.suggestedIntervalSeconds ?? DEFAULT_INTERVAL_SECONDS,
    monitor.enabledByDefault ?? false,
    specPath, // spec_path (index 9) — re-synced on conflict so an existing NULL row self-heals on re-apply.
  ];
  const placeholders = insertColumns.map((_, i) => `$${i + 1}`).join(', ');
  // ON CONFLICT updates the Git-authoritative columns + spec_path (seed-only + dashboard-owned excluded).
  // spec_path is Git-derived (the manifest script), so re-syncing it on conflict is correct and lets a
  // re-apply repair a check materialized before this fix (spec_path NULL → the manifest's spec path).
  const updateColumns = [...GIT_AUTHORITATIVE_COLUMNS, 'spec_path'];
  const setClause = updateColumns.map((c) => `${c} = EXCLUDED.${c}`).join(', ');

  const text =
    `INSERT INTO checks (${insertColumns.join(', ')})\n` +
    `VALUES (${placeholders})\n` +
    // ★ checks has a PARTIAL unique index (checks_source_key_uniq WHERE source_key IS NOT NULL) — a bare
    // ON CONFLICT (source_key) can't infer it ("no unique constraint matching"). The WHERE predicate MUST
    // match the partial index for the upsert (and Phase-1 idempotent re-apply) to work.
    `ON CONFLICT (source_key) WHERE source_key IS NOT NULL DO UPDATE SET ${setClause}`;

  return { text, values, insertColumns, updateColumns };
}

// ---------------------------------------------------------------------------
// SCOPED B10-ONLY SYNC — the ONLY thing reconcile applies to `checks` today. The full git-authoritative
// apply (buildApplyUpsert above) remains GATED OFF (it would auto-rewrite ALL config — schedules,
// locations, URLs — fleet-wide hourly; a separate deliberate decision). This corrects ONLY a SAFETY
// control: a check whose manifest declares sensitive/redact_patterns but whose live row defaulted to
// false/NULL (the B10 leak). Pure + unit-testable; reconcileMain runs the narrow UPDATE per result.
// ---------------------------------------------------------------------------

/** One scoped correction: set checks.sensitive + checks.redact_patterns for a diverging managed check.
 *  redact_patterns is JSONB text (the SAME encoding buildApplyUpsert uses: JSON.stringify, 'null' = none). */
// ★ B10 WRITE-PATH STRIP GUARD. A "redaction strip" = the LIVE check is sensitive but the manifest wants
// it NOT sensitive (sensitive true→false). Auto-stripping silently removes the redaction safety control
// from a monitor that was protecting something — so b10FieldUpdates REFUSES a strip UNLESS the source_key
// is explicitly listed here. This is the same fail-safe the plan path (computeApplyPlan) advertises, but
// moved onto the ACTUAL write path (#144 b10FieldUpdates → reconcileMain) where it was previously absent.
//
// Seam choice (in-repo runner allowlist, NOT a manifest field / env flag): it's (a) in-repo + reviewable
// in a PR diff, (b) per-monitor not global, (c) auditable via git blame on this constant — and keeps the
// security gate in the RUNNER (where the guard lives), independent of the manifest authors. The tradeoff
// vs an `allow_redaction_strip` manifest field: that would co-locate the allowance with `sensitive` but
// splits the change cross-repo (the allowance would ride in the synthwatch-monitors PR) and needs a new
// manifest field + schema. We keep the allowance HERE so this one PR carries it and the monitors pullback
// applies cleanly. To intentionally un-sensitive a monitor: add its source_key here in a reviewed PR.
export const REDACTION_STRIP_ALLOWANCE: ReadonlySet<string> = new Set<string>([
  // The meals2go monitors were marked sensitive on the rejected "guest Bearer ⇒ sensitive" premise —
  // anonymous, accountless, public flows carrying no real secret (see ANALYSIS-redaction-policy-2026-06-30.md).
  // Their manifest pullback (sensitive true→false) is intentional + pre-approved.
  'meals2go-cheese-pizza-cart',
  'meals2go-browse-menu',
]);

/**
 * A B10 redaction STRIP: the live check IS sensitive but the manifest wants it non-sensitive (true→false).
 * A false→true (un-sensitive→sensitive) or a pattern-only edit is NOT a strip. One definition, shared by
 * the write path (b10FieldUpdates) and the plan path (computeApplyPlan), so the two guards can never disagree.
 */
export function isRedactionStrip(wantSensitive: boolean, liveSensitive: boolean): boolean {
  return liveSensitive === true && wantSensitive === false;
}

export interface B10Update {
  source_key: string;
  sensitive: boolean;
  redact_patterns: string;
  /** true = an allowance-approved STRIP (live sensitive=true → manifest sensitive=false). Logged specially. */
  intentionalStrip: boolean;
}

/** Result of b10FieldUpdates: the updates to APPLY, plus the strips REFUSED because the source_key is not
 *  in REDACTION_STRIP_ALLOWANCE. The caller logs `blockedStrips` (meta-lesson B: surface, don't swallow) —
 *  the refused checks are LEFT sensitive=true. */
export interface B10FieldUpdateResult {
  updates: B10Update[];
  blockedStrips: string[];
}

/**
 * Which EXISTING managed checks need their sensitive/redact_patterns corrected to match the manifest.
 * Only diverging checks are returned (a matching check is left untouched). NEW checks (no live row) are
 * NOT created here — apply is off; this only fixes the safety field on checks that already exist.
 * ★ A redaction STRIP (sensitive true→false) is REFUSED unless allow-listed (REDACTION_STRIP_ALLOWANCE):
 *   refused strips are returned in `blockedStrips` and NOT applied; a non-strip change (false→true, or a
 *   pattern edit while staying sensitive) always applies.
 */
export function b10FieldUpdates(monitors: Monitor[], managed: ManagedCheck[]): B10FieldUpdateResult {
  const byKey = new Map(managed.map((c) => [c.source_key, c]));
  const updates: B10Update[] = [];
  const blockedStrips: string[] = [];
  for (const m of monitors) {
    const existing = byKey.get(m.id);
    if (!existing) continue;
    const wantSensitive = m.sensitive ?? false;
    const wantPatternsJson = JSON.stringify(m.redact_patterns ?? null);
    const livePatternsJson = JSON.stringify(existing.redact_patterns ?? null);
    if (existing.sensitive === wantSensitive && livePatternsJson === wantPatternsJson) continue; // already in sync
    const strip = isRedactionStrip(wantSensitive, existing.sensitive);
    if (strip && !REDACTION_STRIP_ALLOWANCE.has(m.id)) {
      // ★ refuse to auto-strip redaction. Leave the check sensitive=true; the caller surfaces it.
      blockedStrips.push(m.id);
      continue;
    }
    updates.push({
      source_key: m.id,
      sensitive: wantSensitive,
      redact_patterns: wantPatternsJson,
      intentionalStrip: strip,
    });
  }
  return { updates, blockedStrips };
}

// ---------------------------------------------------------------------------
// RECONCILE-APPLY PHASE 0 — DRY-RUN PLAN. For each drift row, compute the EXACT statement(s) apply WOULD
// run, WITHOUT executing them. Pure (buildApplyUpsert builds text+values without touching the DB;
// activeLocations is passed in). NOTHING here writes to checks/check_locations — reconcileMain persists
// the returned plans to reconcile_apply_plan only. This is the precondition for the Phase 1 approval gate.
// ---------------------------------------------------------------------------

/** A planned SQL statement apply WOULD run (rendered, not executed). */
export interface PlanStatement {
  purpose: string;
  text: string;
  values?: unknown[];
  regions?: string[]; // for the location-assignment statement
}

export type PlanDisposition = 'pending' | 'auto' | 'blocked' | 'noop';

/** The dry-run plan for one drift row (mirrors a reconcile_apply_plan row). */
export interface ApplyPlanRow {
  source_key: string;
  drift_type: DriftType;
  status: PlanDisposition;
  plan: {
    summary: string;
    disposition: PlanDisposition;
    statements: PlanStatement[];
    blockedReason?: string;
  };
}

/**
 * Compute the apply plan per drift row — the dry-run. Decisions baked in (per the approved design):
 *   new                → MATERIALIZE, enabled FORCED false (materialize-disabled), sensitive INLINE in the
 *                        INSERT (no non-sensitive window) + assign the active locations. status 'pending'.
 *   changed            → git-authoritative ON CONFLICT UPDATE of the differing field(s). status 'pending'.
 *   missing            → SOFT-DISABLE (enabled=false), never hard-delete. status 'pending'.
 *   orphan             → no apply (spec not runnable). status 'noop'.
 *   redaction_mismatch → already AUTO-applied (#144); status 'auto' (informational). ★ EXCEPT a STRIP
 *                        (manifest sensitive=false while live sensitive=true) → status 'blocked':
 *                        reconcile may NEVER remove redaction (the fail-safe).
 * Pure + never executes — buildApplyUpsert only renders SQL text+values here.
 */
export function computeApplyPlan(
  monitors: Monitor[],
  drift: DriftRow[],
  activeLocations: string[],
): ApplyPlanRow[] {
  const byId = new Map(monitors.map((m) => [m.id, m]));
  const rows: ApplyPlanRow[] = [];

  for (const d of drift) {
    const m = byId.get(d.source_key);
    if (d.drift_type === 'new') {
      if (!m) continue;
      // ★ FAIL-CLOSED spec-resolution gate (BEFORE buildApplyUpsert, which throws on a bad script): a browser
      // check resolves at runtime ONLY via its spec_path (the Git spec the runner fetches + compiles).
      // flow_name is a fallback to a baked-in dist/checks/<name>.js, which a manifest monitor never has — so
      // materializing a browser check whose script isn't a resolvable spec produces a check that can ONLY fail
      // ("Cannot find module"). Refuse it (status 'blocked') rather than ship a broken check or crash the whole
      // plan on the throw. This is the gate the recipe-search incident needed: no unresolvable browser
      // materialize ever reaches 'pending'/apply.
      if (m.kind === 'browser' && !isResolvableSpec(m.script)) {
        rows.push({
          source_key: d.source_key,
          drift_type: 'new',
          status: 'blocked',
          plan: {
            disposition: 'blocked',
            summary: 'BLOCKED: would materialize a browser check whose spec_path cannot resolve in the runner.',
            statements: [],
            blockedReason:
              `browser check spec is not resolvable (script=${JSON.stringify(m.script)}); materializing it would create a check that can only fail with "Cannot find module".`,
          },
        });
        continue;
      }
      const upsert = buildApplyUpsert(m);
      // ★ materialize-DISABLED: force `enabled` (the last insert column) to false regardless of the
      // manifest's enabledByDefault — activate only after a verified-clean run (the B10 close-out pattern).
      const values = [...upsert.values];
      const enabledIdx = upsert.insertColumns.indexOf('enabled');
      if (enabledIdx >= 0) values[enabledIdx] = false;
      const sensitive = m.sensitive ?? false;
      rows.push({
        source_key: d.source_key,
        drift_type: 'new',
        status: 'pending',
        plan: {
          disposition: 'pending',
          summary: `would MATERIALIZE check (sensitive=${sensitive} inline, enabled=FALSE) + assign locations [${activeLocations.join(', ')}]`,
          statements: [
            { purpose: 'materialize check (sensitive inline; enabled forced FALSE)', text: upsert.text, values },
            {
              purpose: 'assign default locations (after the check exists)',
              text: 'INSERT INTO check_locations (check_id, location) SELECT <new check id>, name FROM locations WHERE enabled ON CONFLICT (check_id, location) DO NOTHING',
              regions: activeLocations,
            },
          ],
        },
      });
    } else if (d.drift_type === 'changed') {
      if (!m) continue;
      const fields = Object.keys((d.detail.fields as Record<string, unknown>) ?? {});
      const upsert = buildApplyUpsert(m); // its ON CONFLICT UPDATE is exactly the changed-field sync
      rows.push({
        source_key: d.source_key,
        drift_type: 'changed',
        status: 'pending',
        plan: {
          disposition: 'pending',
          summary: `would UPDATE git-authoritative field(s) [${fields.join(', ')}] to match the manifest (ON CONFLICT)`,
          statements: [{ purpose: 'git-auth field sync (ON CONFLICT DO UPDATE)', text: upsert.text, values: upsert.values }],
        },
      });
    } else if (d.drift_type === 'redaction_mismatch') {
      const f = (d.detail.fields as Record<string, { git?: unknown; live?: unknown }>) ?? {};
      // Same strip definition the write path (b10FieldUpdates) uses. ★ An ALLOWANCE-approved strip is NOT
      // blocked — it's an intentional pullback the write path applies, so it falls through to 'auto'.
      const isBlockedStrip =
        isRedactionStrip(f.sensitive?.git === true, f.sensitive?.live === true) &&
        !REDACTION_STRIP_ALLOWANCE.has(d.source_key);
      if (isBlockedStrip) {
        rows.push({
          source_key: d.source_key,
          drift_type: 'redaction_mismatch',
          status: 'blocked',
          plan: {
            disposition: 'blocked',
            summary: 'BLOCKED: would STRIP redaction (sensitive true→false). reconcile may never un-sensitive a check.',
            statements: [],
            blockedReason:
              'reconcile cannot strip redaction (sensitive true→false) — the B10 fail-safe; only an explicit dashboard action may.',
          },
        });
      } else {
        rows.push({
          source_key: d.source_key,
          drift_type: 'redaction_mismatch',
          status: 'auto',
          plan: {
            disposition: 'auto',
            summary:
              'already AUTO-APPLIED (#144 b10FieldUpdates corrects sensitive/redact_patterns each reconcile) — informational, no human approval needed.',
            statements: [],
          },
        });
      }
    } else if (d.drift_type === 'missing') {
      rows.push({
        source_key: d.source_key,
        drift_type: 'missing',
        status: 'pending',
        plan: {
          disposition: 'pending',
          summary: 'would SOFT-DISABLE (enabled=false); never hard-delete.',
          statements: [{ purpose: 'soft-disable', text: 'UPDATE checks SET enabled = false WHERE source_key = $1', values: [d.source_key] }],
        },
      });
    } else {
      // orphan
      const reason = (d.detail.reason as string) ?? 'spec not runnable';
      rows.push({
        source_key: d.source_key,
        drift_type: 'orphan',
        status: 'noop',
        plan: { disposition: 'noop', summary: `no apply (${reason})`, statements: [] },
      });
    }
  }
  return rows;
}
