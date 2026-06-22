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
import { pool, type Check, type RunRecord, type TerminalStatus } from './db.js';
import { runHttpCheck } from './httpCheck.js';
import { runSslCheck } from './sslCheck.js';
import { runDnsCheck, runTcpCheck, runPingCheck } from './netChecks.js';
import { runMultistepChain } from './multistep.js';
import {
  initOtel,
  emitRunSpan,
  recordRunMetric,
  otelEnabled,
  metricsEnabled,
  shutdownOtel,
} from './otel.js';
import { StepRecorder } from './stepRecorder.js';
import { loadFlow } from './checks/index.js';
import { syncFlowManifest } from './flowManifest.js';
import { uploadScreenshot, uploadTrace } from './artifacts.js';
import os from 'node:os';
import path from 'node:path';
import { unlink } from 'node:fs/promises';
import { evaluate, perfBudgetBreach } from './evaluate.js';
import {
  startMetricsCapture,
  writeRunMetrics,
  EMPTY_METRICS,
  type RunMetrics,
} from './metrics.js';
import { isExpectationError } from './errors.js';

// A run's terminal outcome. `status` is the real taxonomy, not a boolean:
//   pass / fail / error come from execution; `warn` is derived later in runOne
//   by comparing `metrics` against the check's perf budgets.
interface Outcome {
  status: TerminalStatus;
  httpStatus: number | null;
  durationMs: number;
  error: string | null;
  failedStep: string | null;
  screenshot: Buffer | null;
  // Browser runs only: the captured Tier-1 metrics (for the perf-budget -> warn
  // comparison). null for HTTP runs (no browser, no metrics).
  metrics: RunMetrics | null;
  // SSL runs only: signed days relative to cert notAfter (+ until / - past
  // expiry). null for non-ssl runs and ssl runs with no cert obtained.
  certDaysRemaining: number | null;
  // Failed browser runs only: temp-file path of the captured Playwright trace.zip
  // (runOne uploads it, then deletes the temp file). null otherwise.
  tracePath: string | null;
}

// A 'running' row older than this is assumed orphaned by a hard crash (the ACA
// replicaTimeout is 240s, so 30 min is comfortably beyond any real run) and is
// reaped to 'error' so the failure is visible to SLA/incidents rather than
// lingering as in-flight forever.
const STALE_RUNNING = "30 minutes";

// This runner's vantage point, stamped onto every run it writes. The primary
// region leaves this unset (=> 'default') so single-region behaviour is exactly
// as before; a 2nd-region runner sets SYNTHWATCH_LOCATION (e.g. 'westus2').
const LOCATION = process.env.SYNTHWATCH_LOCATION ?? 'default';

// Lazily-launched shared browser, reused across all browser checks in this tick.
let browser: Browser | null = null;
async function getBrowser(): Promise<Browser> {
  if (!browser) browser = await chromium.launch();
  return browser;
}

async function main(): Promise<void> {
  // Opt-in OTLP trace export (no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set).
  initOtel();

  await reapStaleRunning();

  // Publish the deployed flows to flow_manifest for the API/dashboard. Best-effort
  // — a sync failure must never break the tick.
  await syncFlowManifest().catch((err) => console.warn('[manifest] sync failed:', err));

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

/**
 * Reap orphaned 'running' rows. Inserting 'running' on start (so the SLA
 * "exclude running" clause is real) means a hard crash mid-run would otherwise
 * leave a row stuck in-flight forever. Anything still 'running' well past the
 * replica timeout never finalized -> mark it 'error' so it surfaces as down.
 */
async function reapStaleRunning(): Promise<void> {
  const { rowCount } = await pool.query(
    `UPDATE runs
        SET status = 'error', finished_at = now(),
            error_message = COALESCE(error_message, 'runner did not finalize (stale running)')
      WHERE status = 'running'
        AND started_at < now() - make_interval(mins => $1::int)`,
    [30],
  );
  if (rowCount && rowCount > 0) {
    console.log(`[runner] reaped ${rowCount} stale running run(s) -> error (older than ${STALE_RUNNING})`);
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
  // Insert the run row as 'running' (in-flight) so the StepRecorder has a run_id
  // to attach steps to, and the SLA "exclude running" clause has real data. A
  // hard crash before the terminal update is reaped to 'error' (see main()).
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO runs (check_id, started_at, status, location) VALUES ($1, now(), 'running', $2) RETURNING id`,
    [check.id, LOCATION],
  );
  const runId = rows[0].id;

  // Wall-clock start of the executor — the OTel root span's start (durationMs anchors its end).
  const execStartMs = Date.now();
  let outcome: Outcome;
  try {
    if (check.kind === 'http') outcome = await executeHttp(check);
    else if (check.kind === 'ssl') outcome = await executeSsl(check);
    else if (check.kind === 'dns' || check.kind === 'tcp' || check.kind === 'ping')
      outcome = await executeNet(check);
    else if (check.kind === 'multistep') outcome = await executeMultistep(check, runId);
    else outcome = await executeBrowser(check, runId);
  } catch (err) {
    // Unexpected runner error (e.g. flow loader threw) -> 'error', not 'fail'.
    outcome = {
      status: 'error',
      httpStatus: null,
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err),
      failedStep: null,
      screenshot: null,
      metrics: null,
      certDaysRemaining: null,
      tracePath: null,
    };
  }

  // Derive 'warn': a run that otherwise PASSED but breached a perf budget is
  // degraded-but-available. Only browser runs have metrics to compare. This is
  // what makes the perf_budget_* columns non-inert.
  let status: TerminalStatus = outcome.status;
  let errorMessage = outcome.error;
  if (status === 'pass' && outcome.metrics) {
    const breach = perfBudgetBreach(check, outcome.metrics);
    if (breach) {
      status = 'warn';
      errorMessage = breach; // record WHY it warned
    }
  }

  let screenshotUrl: string | null = null;
  if ((status === 'fail' || status === 'error') && outcome.screenshot) {
    screenshotUrl = await uploadScreenshot(runId, outcome.screenshot);
  }

  // Upload the failure trace (non-fatal), then delete the temp file regardless.
  let traceUrl: string | null = null;
  if (outcome.tracePath) {
    traceUrl = await uploadTrace(runId, outcome.tracePath);
    await unlink(outcome.tracePath).catch(() => {});
  }

  await pool.query(
    `UPDATE runs
        SET status = $2, finished_at = now(), duration_ms = $3, http_status = $4,
            error_message = $5, failed_step = $6, screenshot_url = $7,
            cert_days_remaining = $8, trace_url = $9
      WHERE id = $1`,
    [
      runId,
      status,
      outcome.durationMs,
      outcome.httpStatus,
      errorMessage,
      outcome.failedStep,
      screenshotUrl,
      outcome.certDaysRemaining,
      traceUrl,
    ],
  );

  const run: RunRecord = {
    id: runId,
    check_id: check.id,
    status,
    error_message: errorMessage,
    failed_step: outcome.failedStep,
    screenshot_url: screenshotUrl,
    location: LOCATION,
  };
  await evaluate(check, run);

  console.log(
    `[runner] check ${check.id} "${check.name}" -> ${status}` +
      (errorMessage ? ` (${errorMessage})` : ''),
  );

  // Side-channel: emit this run as an OTel trace (root + a child span per
  // run_step). Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set; never affects the
  // run (the run is already recorded above), and fully swallowed on any error.
  if (otelEnabled() || metricsEnabled()) {
    try {
      const steps = (
        await pool.query<{
          step_index: number;
          name: string;
          status: string;
          duration_ms: number;
          started_at: Date;
          error_message: string | null;
        }>(
          `SELECT step_index, name, status, duration_ms, started_at, error_message
             FROM run_steps WHERE run_id = $1 ORDER BY step_index`,
          [runId],
        )
      ).rows;
      const otelRun = {
        checkId: check.id,
        checkName: check.name,
        checkKind: check.kind,
        method: check.method,
        targetUrl: check.target_url,
        runId,
        status,
        errorMessage,
        httpStatus: outcome.httpStatus,
        startMs: execStartMs,
        durationMs: outcome.durationMs,
        // Forward-looking for multi-location; 'default' until a location is stamped.
        location: process.env.SYNTHWATCH_LOCATION ?? 'default',
        steps: steps.map((s) => ({
          index: s.step_index,
          name: s.name,
          status: s.status,
          durationMs: s.duration_ms,
          startedAtMs: s.started_at.getTime(),
          errorMessage: s.error_message,
        })),
      };
      emitRunSpan(otelRun); // per-run/per-step trace (correlation)
      recordRunMetric(otelRun); // numeric series: duration histogram, runs, up/down
    } catch (err) {
      console.warn(`[otel] run ${runId} telemetry skipped (non-fatal):`, err);
    }
  }
}

async function executeHttp(check: Check): Promise<Outcome> {
  const r = await runHttpCheck(check);
  return {
    status: r.verdict, // 'pass' | 'fail' | 'error'
    httpStatus: r.httpStatus,
    durationMs: r.durationMs,
    error: r.error,
    failedStep: null,
    screenshot: null,
    metrics: null,
    certDaysRemaining: null,
    tracePath: null,
  };
}

async function executeMultistep(check: Check, runId: number): Promise<Outcome> {
  // The chain records its own run_steps (per step); we map its verdict + the
  // failing step onto the Outcome, exactly like a browser flow.
  const r = await runMultistepChain(check, runId);
  return {
    status: r.verdict, // 'pass' | 'fail' | 'error'
    httpStatus: null,
    durationMs: r.durationMs,
    error: r.error,
    failedStep: r.failedStep,
    screenshot: null,
    metrics: null,
    certDaysRemaining: null,
    tracePath: null,
  };
}

async function executeNet(check: Check): Promise<Outcome> {
  const r =
    check.kind === 'dns'
      ? await runDnsCheck(check)
      : check.kind === 'tcp'
        ? await runTcpCheck(check)
        : await runPingCheck(check);
  // message (resolved records / latency / reachability) is recorded in
  // error_message for visibility, on pass too — mirrors the ssl pattern.
  return {
    status: r.verdict, // 'pass' | 'fail' | 'error'
    httpStatus: null,
    durationMs: r.durationMs,
    error: r.message,
    failedStep: null,
    screenshot: null,
    metrics: null,
    certDaysRemaining: null,
    tracePath: null,
  };
}

async function executeSsl(check: Check): Promise<Outcome> {
  const r = await runSslCheck(check);
  // error_message keeps the human-readable cert line; certDaysRemaining is the
  // structured value (signed days) the API/dashboard read directly.
  return {
    status: r.verdict, // 'pass' | 'warn' | 'fail' | 'error' (warn = expiring soon)
    httpStatus: null,
    durationMs: r.durationMs,
    error: r.message,
    failedStep: null,
    screenshot: null,
    metrics: null,
    certDaysRemaining: r.daysRemaining,
    tracePath: null,
  };
}

async function executeBrowser(check: Check, runId: number): Promise<Outcome> {
  if (!check.flow_name) {
    // Schema enforces this, but TypeScript can't know that.
    return {
      status: 'error', httpStatus: null, durationMs: 0,
      error: 'browser check has no flow_name', failedStep: null,
      screenshot: null, metrics: null, certDaysRemaining: null, tracePath: null,
    };
  }

  const start = Date.now();
  const b = await getBrowser();
  const context = await b.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(check.timeout_ms);

  // Passive Tier-1 telemetry capture rides this run's own navigation. Set up
  // BEFORE the flow so the LCP observer / response listener / CDP session see
  // the whole page load; collected in the finally below.
  const capture = await startMetricsCapture(context, page);

  // Start a Playwright trace for the whole run. We KEEP it only on failure (see
  // finally) so passing runs cost no storage. sources:false avoids embedding the
  // flow source; screenshots+snapshots are the debugging value. Non-fatal.
  let tracingOn = false;
  await context.tracing
    .start({ screenshots: true, snapshots: true, sources: false })
    .then(() => {
      tracingOn = true;
    })
    .catch(() => {
      /* tracing unavailable -> no trace captured */
    });

  // Decide the verdict in the try/catch, capture metrics in the finally, then
  // assemble the Outcome after — so the perf-budget comparison upstream gets the
  // real metrics even though they're collected during teardown.
  let status: TerminalStatus;
  let error: string | null = null;
  let failedStep: string | null = null;
  let screenshot: Buffer | null = null;
  let metrics: RunMetrics;
  let tracePath: string | null = null;
  let failed = false;

  try {
    const rec = new StepRecorder(runId, page, check.target_url);
    try {
      const flow = await loadFlow(check.flow_name);
      await flow(rec);
      status = 'pass';
    } catch (err) {
      // A flow ExpectationError is a clean assertion miss ('fail'); any other
      // throw (Playwright timeout, navigation crash, loader error) is 'error'.
      failed = true;
      status = isExpectationError(err) ? 'fail' : 'error';
      error = err instanceof Error ? err.message : String(err);
      failedStep = rec.failedStep;
      screenshot = await page.screenshot().catch(() => null);
    }
  } finally {
    // Stop tracing BEFORE closing the context. Keep the trace.zip on failure
    // (write it to a temp file runOne uploads); discard it on pass. Non-fatal.
    if (tracingOn) {
      try {
        if (failed) {
          tracePath = path.join(os.tmpdir(), `sw-trace-${runId}-${Date.now()}.zip`);
          await context.tracing.stop({ path: tracePath });
        } else {
          await context.tracing.stop();
        }
      } catch (err) {
        console.warn(`[trace] run ${runId} trace stop failed:`, err);
        tracePath = null;
      }
    }

    // Persist one run_metrics row (any outcome) before tearing down the context.
    // Telemetry must never affect the verdict — swallow everything and fall back
    // to an all-null row if capture or the write itself throws.
    try {
      metrics = await capture.collect();
      await writeRunMetrics(runId, metrics);
    } catch (err) {
      console.warn(`[metrics] run ${runId} telemetry capture failed:`, err);
      metrics = EMPTY_METRICS;
      await writeRunMetrics(runId, EMPTY_METRICS).catch((e) =>
        console.warn(`[metrics] run ${runId} telemetry write failed:`, e),
      );
    }
    await context.close();
  }

  return {
    status,
    httpStatus: null,
    durationMs: Date.now() - start,
    error,
    failedStep,
    screenshot,
    metrics,
    certDaysRemaining: null,
    tracePath,
  };
}

main()
  .then(() => 0)
  .catch((err) => {
    console.error('[runner] fatal:', err);
    return 1;
  })
  .then(async (code) => {
    if (browser) await browser.close().catch(() => {});
    await shutdownOtel(); // flush batched spans (bounded; non-fatal)
    await pool.end().catch(() => {});
    process.exit(code);
  });
