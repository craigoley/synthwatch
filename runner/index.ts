// SynthWatch runner entrypoint.
//
// Lifecycle of one Job tick (the Job fires on */5 UTC; this process runs once
// and exits):
//   1. due-filter  — find checks where now() - last_run_at >= interval_seconds
//   2. claim       — conditional UPDATE that advances last_run_at ONLY if still
//                    due. ACA runs replicas in parallel; the replica whose
//                    UPDATE returns a row owns that check, the rest skip it.
//   3. execute     — HTTP (cheap) or browser (Playwright + StepRecorder).
//   4. evaluate    — open/resolve incidents (debounced) and fire alerts.
//
// The process exits 0 even when checks fail — a failing check is data, not a Job
// failure. It exits 1 only on infrastructure errors (e.g. DB unreachable).
import { chromium, type Browser } from 'playwright';
import { pool, type Check, type RunRecord } from './db.js';
import { runHttpCheck } from './httpCheck.js';
import { StepRecorder } from './stepRecorder.js';
import { loadFlow } from './checks/index.js';
import { uploadScreenshot } from './artifacts.js';
import { evaluate } from './evaluate.js';

interface Outcome {
  ok: boolean;
  httpStatus: number | null;
  durationMs: number;
  error: string | null;
  failedStep: string | null;
  screenshot: Buffer | null;
}

// Lazily-launched shared browser, reused across all browser checks in this tick.
let browser: Browser | null = null;
async function getBrowser(): Promise<Browser> {
  if (!browser) browser = await chromium.launch();
  return browser;
}

async function main(): Promise<void> {
  const due = await findDueChecks();
  console.log(`[runner] ${due.length} check(s) due`);

  for (const candidate of due) {
    const check = await claim(candidate.id);
    if (!check) {
      // Another replica claimed it first, or it's no longer due.
      continue;
    }
    await runOne(check);
  }
}

/** Candidate due checks. Cheap pre-filter; the claim below is the real gate. */
async function findDueChecks(): Promise<{ id: number }[]> {
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM checks
      WHERE enabled
        AND (last_run_at IS NULL
             OR now() - last_run_at >= make_interval(secs => interval_seconds))`,
  );
  return rows;
}

/**
 * Atomically claim a check. The UPDATE re-checks the due condition, so only one
 * replica can win even if many run findDueChecks() at the same instant. Returns
 * the full check row if we won, or null if someone else already advanced it.
 */
async function claim(id: number): Promise<Check | null> {
  const { rows } = await pool.query<Check>(
    `UPDATE checks
        SET last_run_at = now()
      WHERE id = $1
        AND enabled
        AND (last_run_at IS NULL
             OR now() - last_run_at >= make_interval(secs => interval_seconds))
      RETURNING *`,
    [id],
  );
  return rows[0] ?? null;
}

async function runOne(check: Check): Promise<void> {
  // Insert the run row up front (pessimistically 'fail') so the StepRecorder has
  // a run_id to attach steps to, and a crash leaves an honest failure behind.
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO runs (check_id, started_at, status) VALUES ($1, now(), 'fail') RETURNING id`,
    [check.id],
  );
  const runId = rows[0].id;

  let outcome: Outcome;
  try {
    outcome =
      check.kind === 'http'
        ? await executeHttp(check)
        : await executeBrowser(check, runId);
  } catch (err) {
    // Unexpected runner error (e.g. flow loader threw). Record as a failure.
    outcome = {
      ok: false,
      httpStatus: null,
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err),
      failedStep: null,
      screenshot: null,
    };
  }

  let screenshotUrl: string | null = null;
  if (!outcome.ok && outcome.screenshot) {
    screenshotUrl = await uploadScreenshot(runId, outcome.screenshot);
  }

  await pool.query(
    `UPDATE runs
        SET status = $2, finished_at = now(), duration_ms = $3, http_status = $4,
            error_message = $5, failed_step = $6, screenshot_url = $7
      WHERE id = $1`,
    [
      runId,
      outcome.ok ? 'pass' : 'fail',
      outcome.durationMs,
      outcome.httpStatus,
      outcome.error,
      outcome.failedStep,
      screenshotUrl,
    ],
  );

  const run: RunRecord = {
    id: runId,
    check_id: check.id,
    status: outcome.ok ? 'pass' : 'fail',
    failed_step: outcome.failedStep,
    screenshot_url: screenshotUrl,
  };
  await evaluate(check, run);

  console.log(
    `[runner] check ${check.id} "${check.name}" -> ${run.status}` +
      (outcome.error ? ` (${outcome.error})` : ''),
  );
}

async function executeHttp(check: Check): Promise<Outcome> {
  const r = await runHttpCheck(check);
  return {
    ok: r.ok,
    httpStatus: r.httpStatus,
    durationMs: r.durationMs,
    error: r.error,
    failedStep: null,
    screenshot: null,
  };
}

async function executeBrowser(check: Check, runId: number): Promise<Outcome> {
  if (!check.flow_name) {
    // Schema enforces this, but TypeScript can't know that.
    return {
      ok: false, httpStatus: null, durationMs: 0,
      error: 'browser check has no flow_name', failedStep: null, screenshot: null,
    };
  }

  const start = Date.now();
  const b = await getBrowser();
  const context = await b.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(check.timeout_ms);

  try {
    const rec = new StepRecorder(runId, page, check.target_url);
    const flow = await loadFlow(check.flow_name);
    try {
      await flow(rec);
      return {
        ok: true, httpStatus: null, durationMs: Date.now() - start,
        error: null, failedStep: null, screenshot: null,
      };
    } catch (err) {
      const screenshot = await page.screenshot().catch(() => null);
      return {
        ok: false,
        httpStatus: null,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
        failedStep: rec.failedStep,
        screenshot,
      };
    }
  } finally {
    await context.close();
  }
}

main()
  .then(() => 0)
  .catch((err) => {
    console.error('[runner] fatal:', err);
    return 1;
  })
  .then(async (code) => {
    if (browser) await browser.close().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(code);
  });
