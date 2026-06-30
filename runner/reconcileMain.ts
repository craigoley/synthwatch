// Entry point for the monitors-as-code reconcile ACA Job (a later PR adds the bicep job;
// this PR ships the code dark). Kept separate from reconcile.ts so that module stays
// side-effect-free + importable by tests (mirrors rollupMain.ts / rollup.ts).
//
//   node dist/reconcileMain.js          -> fetch manifest, DETECT drift, write reconcile_drift
//
// REPORT-ONLY: this computes + persists drift and APPLIES NOTHING to live config. The
// field-split apply upsert (reconcile.buildApplyUpsert) is gated off — a later PR enables it.
import { pool } from './db.js';
import {
  fetchManifest,
  computeDrift,
  b10FieldUpdates,
  computeApplyPlan,
  manifestUrl,
  type Monitor,
  type ManagedCheck,
  type DriftRow,
  type ApplyPlanRow,
} from './reconcile.js';
import { activeLocations } from './locations.js';
import { probeSpecsFromPool, type SpecProbe } from './specfetch/specCache.js';

/** Read the Git-managed checks (source_key set). Unmanaged rows are intentionally excluded. */
async function loadManagedChecks(): Promise<ManagedCheck[]> {
  const { rows } = await pool.query<ManagedCheck>(
    `SELECT source_key, name, kind, target_url, flow_name, sensitive, redact_patterns
       FROM checks
      WHERE source_key IS NOT NULL`,
  );
  return rows;
}

/**
 * Replace the drift snapshot with the current set, atomically. A full reload (DELETE +
 * re-INSERT) inside ONE transaction on ONE pooled client: the table always reflects the
 * latest run with no stale rows, and readers never see a partial snapshot. Single-client
 * (not pool.query per statement) keeps the whole batch on one connection.
 */
async function persistDrift(rows: DriftRow[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM reconcile_drift');
    for (const r of rows) {
      await client.query(
        `INSERT INTO reconcile_drift (source_key, drift_type, detail, detected_at)
         VALUES ($1, $2, $3::jsonb, now())`,
        [r.source_key, r.drift_type, JSON.stringify(r.detail)],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Persist the dry-run apply plan (Phase 0). UPSERT on (source_key, drift_type) so a re-compute updates the
 * plan in place — and, in Phase 1, an approve/reject state on that row survives the re-run; plus DELETE any
 * plan whose drift resolved (no longer in the set). Idempotent. This is the ONLY write Phase 0 adds, and it
 * touches ONLY reconcile_apply_plan — never checks/check_locations.
 */
async function persistApplyPlan(plans: ApplyPlanRow[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (plans.length === 0) {
      await client.query('DELETE FROM reconcile_apply_plan');
    } else {
      // Drop plans whose (source_key, drift_type) is no longer a current drift.
      const keys = plans.map((p) => `${p.source_key} ${p.drift_type}`);
      await client.query(
        `DELETE FROM reconcile_apply_plan WHERE (source_key || ' ' || drift_type) <> ALL($1::text[])`,
        [keys],
      );
      for (const p of plans) {
        await client.query(
          `INSERT INTO reconcile_apply_plan (source_key, drift_type, status, plan, computed_at)
           VALUES ($1, $2, $3, $4::jsonb, now())
           ON CONFLICT (source_key, drift_type)
             DO UPDATE SET
               -- ★ Phase 1: PRESERVE a human/apply decision across a re-compute — only re-set the
               -- auto-computed disposition (pending/auto/blocked/noop). Without this, the next reconcile
               -- tick would reset an 'approved'/'applied' plan back to 'pending' and lose the decision.
               status = CASE
                 WHEN reconcile_apply_plan.status IN ('approved', 'rejected', 'applied')
                   THEN reconcile_apply_plan.status
                 ELSE EXCLUDED.status
               END,
               plan = EXCLUDED.plan,
               computed_at = now()`,
          [p.source_key, p.drift_type, p.status, JSON.stringify(p.plan)],
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Replace the spec-catalog snapshot with the current manifest, atomically (full reload, same
 * pattern as persistDrift). One row per manifest monitor — the manifest's suggested defaults plus
 * the runnability probe already computed this pass (no re-probe). This is the read-only inventory
 * the API serves at GET /api/specs; it is NEVER applied to `checks`.
 */
async function persistSpecCatalog(
  monitors: Monitor[],
  probes: Map<string, SpecProbe>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM spec_catalog');
    for (const m of monitors) {
      const probe = probes.get(m.script);
      await client.query(
        `INSERT INTO spec_catalog
           (source_key, name, spec_path, kind, target, suggested_interval_seconds,
            tags, description, enabled_by_default, runnable, not_runnable_reason, probed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, now())`,
        [
          m.id,
          m.name,
          m.script,
          m.kind,
          m.target ?? null,
          m.suggestedIntervalSeconds ?? null,
          JSON.stringify(m.tags ?? []),
          m.description ?? null,
          m.enabledByDefault ?? false,
          probe?.runnable ?? false,
          // not runnable (or never probed) -> a reason; runnable -> null
          probe?.runnable ? null : (probe?.reason ?? 'spec not probed'),
        ],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  console.log(`[reconcile] fetching manifest: ${manifestUrl() ?? 'GitHub contents API (main@HEAD)'}`);
  const manifest = await fetchManifest();

  // ★ Option C (slice 6): orphan = a manifest spec that ISN'T fetchable+compilable from main
  // (no longer "no baked-in module"). Probe every manifest spec (fetch+compile) for runnability;
  // the SAME pass WARMS spec_cache (a successful probe upserts compiled_js + last_good), so this
  // front-loads the runtime cache before checks run the fetch path.
  const specPaths = manifest.monitors.map((m) => m.script);
  const [managed, specRunnable] = await Promise.all([
    loadManagedChecks(),
    probeSpecsFromPool(specPaths),
  ]);

  const drift = computeDrift(manifest.monitors, managed, specRunnable);
  await persistDrift(drift);

  // ★ RECONCILE-APPLY PHASE 0 (DRY-RUN): compute the apply PLAN per drift + persist it to
  // reconcile_apply_plan. ★★ NOTHING is applied to checks/check_locations — buildApplyUpsert /
  // assignDefaultLocations are NOT executed (computeApplyPlan only RENDERS their SQL). The ONLY new write
  // is the plan record. Never-throw: a plan-compute failure must not break the detect path that works.
  try {
    const plans = computeApplyPlan(manifest.monitors, drift, await activeLocations());
    await persistApplyPlan(plans);
    const blocked = plans.filter((p) => p.status === 'blocked').length;
    console.log(
      `[reconcile] apply-plan (DRY-RUN): computed ${plans.length} plan(s)` +
        (blocked > 0 ? `, ${blocked} BLOCKED (redaction-strip)` : '') +
        ' — NOTHING applied to checks/check_locations',
    );
  } catch (err) {
    console.warn('[reconcile] apply-plan compute failed (non-fatal; detect path unaffected):', err);
  }

  // ★ SCOPED B10 SYNC — the ONLY thing reconcile writes to `checks`. The full git-authoritative apply
  // (buildApplyUpsert) stays GATED OFF; this corrects ONLY the sensitive/redact_patterns SAFETY control
  // so a manifest-declared sensitive monitor actually redacts (the leak otherwise stays unwired). The
  // UPDATE touches exactly those two columns — no schedule/location/URL/name is applied here.
  const b10 = b10FieldUpdates(manifest.monitors, managed);
  for (const u of b10) {
    await pool.query(`UPDATE checks SET sensitive = $2, redact_patterns = $3::jsonb WHERE source_key = $1`, [
      u.source_key,
      u.sensitive,
      u.redact_patterns,
    ]);
    console.log(`[reconcile] B10 sync: ${u.source_key} -> sensitive=${u.sensitive}, redact_patterns corrected`);
  }
  console.log(
    b10.length === 0
      ? '[reconcile] B10 sync: all checks already match the manifest (no sensitive/redact_patterns drift).'
      : `[reconcile] B10 sync: corrected ${b10.length} check(s) (sensitive/redact_patterns only).`,
  );

  // Snapshot the full manifest (every spec + its probe result) for the read-only catalog
  // (GET /api/specs). Reuses the probe just computed — no second fetch/compile.
  await persistSpecCatalog(manifest.monitors, specRunnable);

  const runnableCount = [...specRunnable.values()].filter((p) => p.runnable).length;
  console.log(
    `[reconcile] spec probe+warm: ${runnableCount}/${specPaths.length} runnable (fetchable+compilable)`,
  );
  console.log(`[reconcile] spec_catalog: wrote ${manifest.monitors.length} spec row(s) (full reload)`);
  for (const [path, probe] of specRunnable) {
    if (!probe.runnable) console.log(`[reconcile]   NOT runnable: ${path} — ${probe.reason}`);
  }

  const byType = (t: string): number => drift.filter((d) => d.drift_type === t).length;
  console.log(
    `[reconcile] ${manifest.monitors.length} manifest monitor(s), ${managed.length} managed check(s); ` +
      `drift: ${byType('new')} new, ${byType('changed')} changed, ` +
      `${byType('missing')} missing, ${byType('orphan')} orphan`,
  );
  for (const d of drift) {
    console.log(`[reconcile]   ${d.drift_type.padEnd(7)} ${d.source_key} ${JSON.stringify(d.detail)}`);
  }
  // REPORT-ONLY for drift: nothing is applied to `checks`. Apply lands in a later PR.
  // (The spec probe above ALSO warmed spec_cache — slice 5's separate warm pass is now folded
  // into the probe, since both need the same fetch+compile of each manifest spec.)
}

main()
  .catch((err) => {
    console.error('[reconcile] failed:', err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
