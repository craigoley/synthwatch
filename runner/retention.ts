// Row retention — bounds the unbounded growth of the runs family (Layer 0 telemetry).
// Run by the daily retention ACA job (see retentionMain.ts + infra bicep). Pure module (no
// top-level side effects) so it's importable by tests; the entry point lives in retentionMain.ts.
//
// WHAT: delete runs older than RETENTION_DAYS. run_steps + run_metrics ride ON DELETE CASCADE
// (schema.sql) so a runs delete cleans its children in the same statement. daily_check_rollup
// holds the long-horizon per-(check,day) series INDEPENDENT of raw runs, so pruning raw rows
// loses NO trend data (the rollup already captured every completed day ~89 days before it becomes
// prune-eligible — retention window 90d >> rollup lag 1d).
//
// ★ WINDOW ALIGNED TO THE BLOB LIFECYCLE: RETENTION_DAYS MUST stay equal to
// infra/main.bicep `artifactRetentionDays` (default 90). The blob lifecycle expires the
// traces/ + run-*.png artifacts after 90d; before this job the runs ROWS lived forever, so
// runs.trace_url/screenshot_url dangled at deleted blobs. Deleting the rows on the SAME 90d
// clock makes rows and blobs expire TOGETHER — the row is gone before/with its blob, so the
// dangling-ref window closes. Change one, change the other.
//
// ★ REPORT SAFETY: the max report/SLA window is 90d (sla_availability_90d; the 7/30/90d reports
// recompute percentiles from RAW). started_at < now()-90d is EXACTLY the complement of every
// <=90d window, so retention only deletes rows no report/SLA view can still read. No degradation.
//
// ★ INCIDENTS SURVIVE (do NOT cascade): incidents.opened_run_id/resolved_run_id -> runs(id) is
// RESTRICT (no ON DELETE clause, schema.sql:347-348), NOT cascade. An incident's evidence run is
// long-horizon MTTR history worth keeping. So retention EXCLUDES any run pinned by an incident:
// this both preserves the incident + its drill-down run AND avoids the FK RESTRICT that would
// otherwise BLOCK the whole delete. Incident-pinned runs are a tiny, bounded set (incidents are
// rare). Their blobs still expire at 90d — a pre-existing dangling-ref the dashboard 404-handles.
import { pool } from './db.js';

// ★ MUST equal infra/main.bicep `artifactRetentionDays` (default 90) — rows + blobs expire together.
export const RETENTION_DAYS = 90;

// Bounded delete: prune in batches so a large first-run backlog doesn't take a long lock or blow up
// WAL in one statement. Oldest-first, looped until a partial (< batch) batch means nothing remains.
export const RETENTION_BATCH_SIZE = 5000;

export interface RetentionOptions {
  /** Age cutoff in days (default RETENTION_DAYS). Runs with started_at < now()-days are eligible. */
  retentionDays?: number;
  /** Rows deleted per batch (default RETENTION_BATCH_SIZE). */
  batchSize?: number;
  /** Safety cap on batch iterations (default 10_000) — a backstop against an unexpected non-converging loop. */
  maxBatches?: number;
}

export interface RetentionResult {
  deleted: number;
  batches: number;
  retentionDays: number;
}

/**
 * Delete runs older than the window, in bounded oldest-first batches. CASCADE removes each run's
 * run_steps/run_metrics; incident-pinned runs are excluded (see module header). Idempotent + safe
 * to re-run: a run only becomes eligible by aging past the cutoff, never by re-running.
 */
export async function runRetention(opts: RetentionOptions = {}): Promise<RetentionResult> {
  const retentionDays = opts.retentionDays ?? RETENTION_DAYS;
  const batchSize = opts.batchSize ?? RETENTION_BATCH_SIZE;
  const maxBatches = opts.maxBatches ?? 10_000;

  let deleted = 0;
  let batches = 0;

  for (;;) {
    if (batches >= maxBatches) {
      console.warn(
        `[retention] hit maxBatches=${maxBatches} (deleted ${deleted} so far) — stopping; next run continues.`,
      );
      break;
    }

    const { rowCount } = await pool.query(
      `WITH victims AS (
         SELECT r.id
           FROM runs r
          WHERE r.started_at < now() - make_interval(days => $1::int)
            -- Incident-pinned runs SURVIVE (RESTRICT FK + MTTR history — see module header).
            AND NOT EXISTS (
              SELECT 1 FROM incidents i
               WHERE i.opened_run_id = r.id OR i.resolved_run_id = r.id
            )
          ORDER BY r.started_at
          LIMIT $2::int
       )
       DELETE FROM runs WHERE id IN (SELECT id FROM victims)`,
      [retentionDays, batchSize],
    );

    const n = rowCount ?? 0;
    deleted += n;
    batches += 1;
    if (n > 0) {
      console.log(`[retention] batch ${batches}: deleted ${n} run(s) (cumulative ${deleted})`);
    }
    // A partial batch (fewer than batchSize) means the eligible set is exhausted.
    if (n < batchSize) break;
  }

  return { deleted, batches, retentionDays };
}
