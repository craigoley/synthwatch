// Entry point for the report-narrative ACA Job (bicep runs `node dist/narrativeMain.js`).
// Kept separate from narrative.ts so that module stays side-effect-free + importable by
// tests. Mirrors rollupMain.ts. Opt-in: no-ops when AZURE_OPENAI_* is absent (Layer 3 dark).
//
//   node dist/narrativeMain.js   -> generate + store the 7d fleet + per-monitor narratives
import { pool } from './db.js';
import { runNarratives } from './narrative.js';

runNarratives()
  .then((n) => {
    console.log(`[narrative] done: ${n} narrative(s) upserted`);
  })
  .catch((err) => {
    console.error('[narrative] failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
