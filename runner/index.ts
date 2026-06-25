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
import { loadFlow, type Flow } from './checks/index.js';
import { getCompiledSpecFromPool } from './specfetch/specCache.js';
import { loadCompiledSpec } from './specfetch/compileSpec.js';
import { specToFlow } from './specfetch/specShim.js';
import { syncFlowManifest } from './flowManifest.js';
import { drainTestSends } from './testSend.js';
import { uploadScreenshot, uploadTrace, uploadBaselineScreenshot } from './artifacts.js';
import os from 'node:os';
import path from 'node:path';
import { unlink } from 'node:fs/promises';
import { evaluate, maybeBurnAlert, perfBudgetBreach } from './evaluate.js';
import {
  startMetricsCapture,
  writeRunMetrics,
  EMPTY_METRICS,
  type RunMetrics,
} from './metrics.js';
import { isExpectationError } from './errors.js';
import { runWithRetry } from './retry.js';

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
  // PASSING browser runs only: the screenshot to store as the check's RCA visual-diff
  // baseline (runOne uploads it to a stable per-check key). null otherwise.
  baselineScreenshot: Buffer | null;
}

// A 'running' row older than this is assumed orphaned by a hard crash (the ACA
// replicaTimeout is 240s, so 30 min is comfortably beyond any real run) and is
// reaped to 'error' so the failure is visible to SLA/incidents rather than
// lingering as in-flight forever.
const STALE_RUNNING = "30 minutes";

// Fixed backoff between fast-retry attempts — a short pause so an instant re-run
// doesn't just hit the same in-flight transient blip. Fixed (not exponential): retry
// counts are tiny and the tick is time-bounded by the ACA replicaTimeout.
const RETRY_BACKOFF_MS = 2000;

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

  // Drain on-demand channel test-sends FIRST. An API-triggered start carries no env
  // override (to preserve secretRefs), so the request is a DB row, not an arg. If any were
  // processed, this run was (almost certainly) a test-triggered start -> send + exit fast,
  // skipping the check loop. A normal cron tick finds none pending and proceeds. (A cron
  // tick that happens to drain one skips its checks this tick; the next tick recovers.)
  const tests = await drainTestSends().catch((err) => {
    console.error('[test-send] drain failed (non-fatal):', err);
    return 0;
  });
  if (tests > 0) {
    console.log(`[test-send] processed ${tests} test-send(s); skipping the check loop this run`);
    return;
  }

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

/**
 * Candidate due checks FOR THIS LOCATION. ENFORCED assignment: the INNER JOIN means a
 * check is a candidate ONLY if it has a check_locations cursor for THIS region — a
 * check not assigned here is simply not selected (no lazy-insert auto-creates one;
 * see claim()). Due when the cursor is NULL (freshly seeded => due-now) or aged past
 * interval_seconds. Cheap pre-filter; claim() is the real (atomic) gate.
 */
async function findDueChecks(): Promise<{ id: number }[]> {
  const { rows } = await pool.query<{ id: number }>(
    `SELECT c.id
       FROM checks c
       JOIN check_locations cl
         ON cl.check_id = c.id AND cl.location = $1
      WHERE c.enabled
        AND (cl.last_run_at IS NULL
             OR now() - cl.last_run_at >= make_interval(secs => c.interval_seconds))`,
    [LOCATION],
  );
  return rows;
}

/**
 * Atomically claim a check FOR THIS LOCATION — ENFORCED: UPDATE the EXISTING
 * (check_id, $LOCATION) cursor only; NO lazy-insert. If the check has no cursor for
 * this region (not assigned here), zero rows update -> claim returns null and the
 * check does NOT run here. The UPDATE advances last_run_at only if still due (NULL =>
 * due-now, preserving #68's IS NULL arm; a freshly-seeded cursor claims on its first
 * tick), so concurrent replicas of the SAME region race the row and exactly one wins
 * (READ COMMITTED re-checks the predicate against the winner's new last_run_at). Keyed
 * on (check_id, $LOCATION) => a DIFFERENT region claims its own cursor independently.
 * Mirrors checks.last_run_at for legacy readers. Returns the check row if we won, else null.
 */
async function claim(id: number): Promise<Check | null> {
  const { rows } = await pool.query<Check>(
    `WITH claimed AS (
       UPDATE check_locations cl
          SET last_run_at = now()
         FROM checks c
        WHERE cl.check_id = $1
          AND cl.location = $2
          AND c.id = cl.check_id
          AND c.enabled
          AND (cl.last_run_at IS NULL
               OR now() - cl.last_run_at >= make_interval(secs => c.interval_seconds))
       RETURNING cl.check_id
     ),
     mirror AS (
       UPDATE checks SET last_run_at = now()
        WHERE id = (SELECT check_id FROM claimed)
     )
     SELECT c.* FROM checks c JOIN claimed ON claimed.check_id = c.id`,
    [id, LOCATION],
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

  const errorOutcome = (msg: string): Outcome => ({
    status: 'error',
    httpStatus: null,
    durationMs: 0,
    error: msg,
    failedStep: null,
    screenshot: null,
    metrics: null,
    certDaysRemaining: null,
    tracePath: null,
    baselineScreenshot: null,
  });

  // FAST-RETRY (mechanism 1, within ONE run): runWithRetry re-runs on a transient
  // 'error' (the check couldn't COMPLETE — network/timeout/DNS) up to `retries` times.
  // NOT retried on 'fail' (an assertion failed = a real, completed result) nor
  // pass/warn. The LAST attempt is the verdict; onBeforeRetry discards the prior
  // errored attempt's partial per-run side effects (run_steps, run_metrics, the temp
  // trace file) + backs off, so EXACTLY ONE verdict persists — the run history /
  // failure_threshold (mechanism 2, AFTER this) never sees the retried-away attempts.
  // retries=0 => no retry (pre-0021 behaviour).
  const maxAttempts = check.retries + 1;
  // Wall-clock start of the (final) executor attempt — the OTel root span's start.
  let execStartMs = Date.now();
  const outcome: Outcome = await runWithRetry<Outcome>(
    async () => {
      execStartMs = Date.now();
      try {
        if (check.kind === 'http') return await executeHttp(check);
        if (check.kind === 'ssl') return await executeSsl(check);
        if (check.kind === 'dns' || check.kind === 'tcp' || check.kind === 'ping')
          return await executeNet(check);
        if (check.kind === 'multistep') return await executeMultistep(check, runId);
        return await executeBrowser(check, runId);
      } catch (err) {
        // Unexpected runner error (e.g. flow loader threw) -> 'error', not 'fail'.
        return errorOutcome(err instanceof Error ? err.message : String(err));
      }
    },
    check.retries,
    async (prev, attempt) => {
      if (prev.tracePath) await unlink(prev.tracePath).catch(() => {});
      await pool.query(`DELETE FROM run_steps WHERE run_id = $1`, [runId]);
      await pool.query(`DELETE FROM run_metrics WHERE run_id = $1`, [runId]);
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
      console.log(
        `[runner] check ${check.id} "${check.name}" errored — fast-retry attempt ${attempt}/${maxAttempts}`,
      );
    },
  );

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

  // Store the RCA visual-diff baseline ONLY on a clean pass (not warn/fail), to a
  // stable per-check key (overwrite). Non-fatal — a baseline failure never affects
  // the run.
  if (status === 'pass' && outcome.baselineScreenshot) {
    try {
      const url = await uploadBaselineScreenshot(check.id, outcome.baselineScreenshot);
      if (url) {
        await pool.query(`UPDATE checks SET baseline_screenshot_url = $2 WHERE id = $1`, [check.id, url]);
      }
    } catch (err) {
      console.warn(`[runner] check ${check.id} baseline screenshot skipped (non-fatal):`, err);
    }
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

  // SLO error-budget burn-rate alerting (opt-in; no-op unless the check has an
  // slo_target). Self-guards: skipped if an incident is already open, in a
  // maintenance window, or debounced. Non-fatal.
  await maybeBurnAlert(check);

  console.log(
    `[runner] check ${check.id} "${check.name}" -> ${status}` +
      (errorMessage ? ` (${errorMessage})` : ''),
  );

  // Side-channel: emit this run as an OTel trace (root + a child span per
  // run_step). Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set; never affects the
  // run (the run is already recorded above), and fully swallowed on any error.
  if (otelEnabled() || metricsEnabled()) {
    try {
      // Only multistep + browser checks ever write run_steps; for http/ssl/dns/tcp/
      // ping this query is a guaranteed-empty round-trip every tick, so skip it.
      const hasSteps = check.kind === 'multistep' || check.kind === 'browser';
      const steps = !hasSteps
        ? []
        : (
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
    baselineScreenshot: null,
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
    baselineScreenshot: null,
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
    baselineScreenshot: null,
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
    baselineScreenshot: null,
  };
}

/** A non-paging infra_error Outcome (Phase 6b Option C): the runner could not OBTAIN the spec
 *  to run (fetch failed AND no last-known-good). No browser opened, no screenshot/trace — the
 *  check couldn't run, which is an INFRA problem, not a monitored-site outage. evaluate() records
 *  it + short-circuits (never opens an incident, never pages). */
function infraErrorOutcome(msg: string): Outcome {
  return {
    status: 'infra_error', httpStatus: null, durationMs: 0,
    error: msg, failedStep: null,
    screenshot: null, metrics: null, certDaysRemaining: null, tracePath: null,
    baselineScreenshot: null,
  };
}

/** A plain 'error' Outcome usable from executeBrowser (runOne has its own local errorOutcome). */
function errorOutcomeStandalone(msg: string): Outcome {
  return {
    status: 'error', httpStatus: null, durationMs: 0,
    error: msg, failedStep: null,
    screenshot: null, metrics: null, certDaysRemaining: null, tracePath: null,
    baselineScreenshot: null,
  };
}

async function executeBrowser(check: Check, runId: number): Promise<Outcome> {
  // Resolve the flow source BEFORE opening a browser. A Git-managed check (spec_path set) FETCHES
  // its Playwright spec from synthwatch-monitors via the durable cache (#101-#104): 304-reuse /
  // 200-recompile / fallback-to-last-known-good / infra-error. A legacy/dashboard check (no
  // spec_path) runs the baked-in flow_name. Resolving first means an infra-error short-circuits
  // to a non-paging infra_error WITHOUT wasting a browser context.
  let compiledJs: string | null = null;
  if (check.spec_path) {
    const resolution = await getCompiledSpecFromPool(check.spec_path);
    if (resolution.kind === 'infra-error') {
      console.warn(
        `[specfetch] check ${check.id} "${check.name}": ${resolution.reason} — recording infra_error ` +
          `(could not fetch its spec; NOT a monitor outage, will NOT page).`,
      );
      return infraErrorOutcome(`could not fetch spec ${check.spec_path}: ${resolution.reason}`);
    }
    if (resolution.origin === 'fallback-last-good') {
      console.warn(
        `[specfetch] check ${check.id} "${check.name}": ran LAST-KNOWN-GOOD spec (fetch/compile ` +
          `degraded). Monitor NOT failed; the spec-fetch path is flaky.`,
      );
    }
    compiledJs = resolution.compiledJs;
  } else if (!check.flow_name) {
    // Neither a Git spec nor a baked-in flow — schema's browser_needs_flow should prevent this.
    return errorOutcomeStandalone('browser check has no spec_path or flow_name');
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
  let baselineScreenshot: Buffer | null = null;

  try {
    const rec = new StepRecorder(runId, page, check.target_url);
    try {
      // Build the Flow: the fetched/compiled spec (run via the #101 shim) or the baked-in
      // flow_name. Both satisfy Flow = (rec) => Promise<void>; a load failure here is a normal
      // 'error' (caught below), same as the existing "loader threw" path.
      let flow: Flow;
      if (compiledJs !== null) {
        const tests = await loadCompiledSpec(compiledJs);
        if (tests.length === 0) throw new Error(`spec ${check.spec_path} defined no test()`);
        flow = specToFlow(tests[0].fn, page);
      } else {
        flow = await loadFlow(check.flow_name as string);
      }
      await flow(rec);
      status = 'pass';
      // Capture the RCA visual-diff baseline from the just-rendered page (cheap —
      // it's already rendered; we'd otherwise discard it). Non-fatal; runOne only
      // stores it if the final verdict is 'pass' (not a perf-budget 'warn').
      baselineScreenshot = await page.screenshot().catch(() => null);
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
    baselineScreenshot,
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
