// Entry point for the daily row-retention ACA Job (bicep runs `node dist/retentionMain.js`).
// Kept separate from retention.ts so that module stays side-effect-free + importable by tests
// (mirrors rollupMain.ts / rollup.ts).
//
//   node dist/retentionMain.js   -> prune runs older than RETENTION_DAYS (cascades children) +
//                                   hard-delete git-removed checks past the window (incident-deferred)
import { pool } from './db.js';
import { runRetention, purgeRemovedChecks } from './retention.js';
import { recordFatal } from './runnerErrors.js';

import { enforceProdGuard } from './prodGuard.js';
// ★ FIRST, before ANY query (this entrypoint DELETEs — the scariest local-against-prod shape):
// refuse a LOCAL shell pointed at prod. Deployed jobs carry the universal SYNTHWATCH_DEPLOYED=1
// marker (bicep, all 8 jobs — #197) and pass silently; a deliberate local run sets
// SYNTHWATCH_ALLOW_PROD=1. log+exit, not throw — a throw would reach recordFatal → a prod INSERT.
enforceProdGuard();

runRetention()
  .then(async (r) => {
    console.log(
      `[retention] done: deleted ${r.deleted} run(s) older than ${r.retentionDays}d in ${r.batches} batch(es)`,
    );
    // ★ R5-P2: after pruning old runs, hard-delete git-removed checks past the SAME window (incident-deferred).
    // Runs AFTER the run-prune so a purged check's non-incident-pinned runs are already trimmed; the check
    // delete then cascades whatever remains. A removed check whose runs are incident-pinned is deferred.
    const p = await purgeRemovedChecks();
    console.log(
      `[retention] git-removal purge done: hard-deleted ${p.purged} check(s) removed >${p.retentionDays}d ago` +
        (p.deferred > 0 ? `; deferred ${p.deferred} (incident-pinned)` : ''),
    );
  })
  .catch(async (err) => {
    // Deviation from the pure-log aux mains (rollup/narrative): a retention FAILURE is both a
    // silent-monitoring risk (unbounded growth returns unseen) AND this job DELETES data — so
    // record to the QUERYABLE runner_errors sink, not stdout-only (uncapturable under ACA/OTel-off,
    // per runnerErrors.ts). recordFatal never throws + still logs to stdout; awaited BEFORE pool.end().
    await recordFatal('retention', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
