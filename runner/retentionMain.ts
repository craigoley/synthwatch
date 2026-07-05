// Entry point for the daily row-retention ACA Job (bicep runs `node dist/retentionMain.js`).
// Kept separate from retention.ts so that module stays side-effect-free + importable by tests
// (mirrors rollupMain.ts / rollup.ts).
//
//   node dist/retentionMain.js   -> prune runs older than RETENTION_DAYS (cascades children)
import { pool } from './db.js';
import { runRetention } from './retention.js';
import { recordFatal } from './runnerErrors.js';

import { enforceProdGuard } from './prodGuard.js';
// ★ FIRST, before ANY query (this entrypoint DELETEs — the scariest local-against-prod shape):
// refuse a LOCAL shell pointed at prod. Deployed jobs carry the universal SYNTHWATCH_DEPLOYED=1
// marker (bicep, all 8 jobs — #197) and pass silently; a deliberate local run sets
// SYNTHWATCH_ALLOW_PROD=1. log+exit, not throw — a throw would reach recordFatal → a prod INSERT.
enforceProdGuard();

runRetention()
  .then((r) => {
    console.log(
      `[retention] done: deleted ${r.deleted} run(s) older than ${r.retentionDays}d in ${r.batches} batch(es)`,
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
