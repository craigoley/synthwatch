// Entry point for the daily rollup ACA Job (bicep runs `node dist/rollupMain.js`).
// Kept separate from rollup.ts so that module stays side-effect-free + importable by tests.
//
//   node dist/rollupMain.js              -> roll up yesterday (the nightly cron mode)
//   node dist/rollupMain.js --backfill   -> roll up every historical day (one-time)
//   node dist/rollupMain.js 2026-06-22   -> roll up one explicit UTC day
import { pool } from './db.js';
import { runRollup } from './rollup.js';
import { refreshAzureCost } from './azureCost.js';

import { enforceProdGuard } from './prodGuard.js';
// ★ FIRST, before ANY query: refuse a LOCAL shell pointed at prod (the June 25–26 incident
// class). Deployed jobs carry SYNTHWATCH_DEPLOYED=1 (bicep, all 8 — #197); deliberate local
// runs set SYNTHWATCH_ALLOW_PROD=1. See prodGuard.ts.
enforceProdGuard();

const arg = process.argv[2];
const opts = arg === '--backfill' ? { backfill: true } : arg ? { day: arg } : {};

runRollup(opts)
  .then(async (n) => {
    console.log(`[rollup] done: ${n} (check, day) row(s) upserted (${arg ?? 'nightly'})`);
    // Refresh the Azure Cost Management cache (azure_cost, 0090) on the daily rollup — the cost panel's
    // DOLLAR headline is Azure's number, not a modeled one. BEST-EFFORT: refreshAzureCost never throws; if
    // the pull is unavailable (role not propagated / API error) the last-good row simply ages and the UI
    // shows a deep link. Never fails the rollup. Skipped on --backfill (a one-time historical replay).
    if (arg !== '--backfill') {
      await refreshAzureCost(pool).catch((err) =>
        console.warn('[rollup] azure-cost refresh skipped:', err instanceof Error ? err.message : err),
      );
    }
  })
  .catch((err) => {
    console.error('[rollup] failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
