// Entry point for the daily rollup ACA Job (bicep runs `node dist/rollupMain.js`).
// Kept separate from rollup.ts so that module stays side-effect-free + importable by tests.
//
//   node dist/rollupMain.js              -> roll up yesterday (the nightly cron mode)
//   node dist/rollupMain.js --backfill   -> roll up every historical day (one-time)
//   node dist/rollupMain.js 2026-06-22   -> roll up one explicit UTC day
import { pool } from './db.js';
import { runRollup } from './rollup.js';

const arg = process.argv[2];
const opts = arg === '--backfill' ? { backfill: true } : arg ? { day: arg } : {};

runRollup(opts)
  .then((n) => {
    console.log(`[rollup] done: ${n} (check, day) row(s) upserted (${arg ?? 'nightly'})`);
  })
  .catch((err) => {
    console.error('[rollup] failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
