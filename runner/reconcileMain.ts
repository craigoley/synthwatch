// Entry point for the monitors-as-code reconcile ACA Job (a later PR adds the bicep job;
// this PR ships the code dark). Kept separate from reconcile.ts so that module stays
// side-effect-free + importable by tests (mirrors rollupMain.ts / rollup.ts).
//
//   node dist/reconcileMain.js          -> fetch manifest, DETECT drift, write reconcile_drift
//
// REPORT-ONLY: this computes + persists drift and APPLIES NOTHING to live config. The
// field-split apply upsert (reconcile.buildApplyUpsert) is gated off — a later PR enables it.
import { pool } from './db.js';
import { discoverFlows } from './flowManifest.js';
import {
  fetchManifest,
  computeDrift,
  manifestUrl,
  type ManagedCheck,
  type DriftRow,
} from './reconcile.js';

/** Read the Git-managed checks (source_key set). Unmanaged rows are intentionally excluded. */
async function loadManagedChecks(): Promise<ManagedCheck[]> {
  const { rows } = await pool.query<ManagedCheck>(
    `SELECT source_key, name, kind, target_url, flow_name
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

async function main(): Promise<void> {
  const url = manifestUrl();
  console.log(`[reconcile] fetching manifest: ${url}`);
  const manifest = await fetchManifest(url);

  const [managed, flows] = await Promise.all([loadManagedChecks(), discoverFlows()]);
  const knownFlows = new Set(flows.map((f) => f.name));

  const drift = computeDrift(manifest.monitors, managed, knownFlows);
  await persistDrift(drift);

  const byType = (t: string): number => drift.filter((d) => d.drift_type === t).length;
  console.log(
    `[reconcile] ${manifest.monitors.length} manifest monitor(s), ${managed.length} managed check(s); ` +
      `drift: ${byType('new')} new, ${byType('changed')} changed, ` +
      `${byType('missing')} missing, ${byType('orphan')} orphan`,
  );
  for (const d of drift) {
    console.log(`[reconcile]   ${d.drift_type.padEnd(7)} ${d.source_key} ${JSON.stringify(d.detail)}`);
  }
  // REPORT-ONLY: nothing is applied to `checks`. Apply lands in a later PR.
}

main()
  .catch((err) => {
    console.error('[reconcile] failed:', err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
