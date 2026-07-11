// SynthWatch runner entrypoint.
//
// Lifecycle of one Job tick (the Job fires on */5 UTC; this process runs once
// and exits):
//   1. due-filter  — find checks where now() - last_run_at >= interval_seconds minus the
//                    tick-slip guard (duePredicate.ts — the δ-slip cadence fix)
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
import { writeProvisionalVerdict, enrichRunTrace } from './runFinalize.js';
import { runHttpCheck } from './httpCheck.js';
import { noteDeployMarker, hostOf } from './deploys.js';
import { captureMainDocHeaders } from './browserMarker.js';
import { browserHeaderAdditions } from './vercelBypass.js';
import { decryptSecretHeaders, firstPartyHeaders } from './secretHeaders.js';
import {
  applyLoginCredentials,
  clearLoginCredentials,
  resolveLoginCredentials,
  redactableCredValues,
  type CredEnvHandle,
} from './loginCredentials.js';
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
import { getCompiledSpecFromPool, sha256 } from './specfetch/specCache.js';
import { loadCompiledSpec } from './specfetch/compileSpec.js';
import { specToFlow } from './specfetch/specShim.js';
import { compileHostRewrite, resolveRewrite, hostRewriteFor, type HostRewrite } from './specfetch/hostRewrite.js';
import { syncFlowManifest } from './flowManifest.js';
import { drainTestSends } from './testSend.js';
import {
  uploadScreenshot,
  uploadTrace,
  uploadBaselineScreenshot,
  uploadSuccessTrace,
} from './artifacts.js';
import { extractTraceSignals } from './traceSignals.js';
import { buildRedactedTraceZip } from './traceRedact.js';
import { makeRedactor, IDENTITY_REDACTOR, tracePersistPlan, scrubError } from './redact.js';
import { captureEgressIp } from './egress.js';
import os from 'node:os';
import path from 'node:path';
import { unlink } from 'node:fs/promises';
import {
  applyRunSideEffects,
  perfBudgetVerdict,
  budgetedMetricCaptureFailed,
  hasOpenIncident,
} from './evaluate.js';
import {
  startMetricsCapture,
  writeRunMetrics,
  EMPTY_METRICS,
  type RunMetrics,
} from './metrics.js';
import { isExpectationError } from './errors.js';
import { runWithRetry, effectiveRetries } from './retry.js';
import { DUE_PREDICATE_SQL } from './duePredicate.js';
import { withDeadline } from './timeBudget.js';
import { enforceProdGuard } from './prodGuard.js';
import {
  INVOCATION_ID,
  installGlobalErrorHandlers,
  recordFatal,
  setErrorContext,
} from './runnerErrors.js';

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
  // ★ B1: true when metric capture THREW (caught below → metrics fell back to EMPTY_METRICS). Lets the
  // verdict distinguish "blind, capture failed" from "captured, metric legitimately absent" — a
  // perf-budgeted run that couldn't capture must NOT pass (else the green lies).
  metricsCaptureFailed: boolean;
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
// replicaTimeout is 660s, so 30 min is comfortably beyond any real run) and is
// reaped to 'error' so the failure is visible to SLA/incidents rather than
// lingering as in-flight forever.
const STALE_RUNNING = "30 minutes";

// Fixed backoff between fast-retry attempts — a short pause so an immediate re-run doesn't just
// re-hit the same in-flight transient blip. Now that we also retry 'fail' (not just 'error'), a
// browser flow retried with too short a pause can catch the site still mid-blip — so 5s, in the
// field-standard 5–15s range, while staying small vs a 60–90s browser run. Fixed (not exponential):
// retry counts are tiny and the tick is time-bounded by the ACA replicaTimeout. (Per-check backoff
// config is a possible follow-up; a single sane default keeps this PR one concern.)
const RETRY_BACKOFF_MS = 5000;

// Whole-flow wall-clock ceiling for a BROWSER run (mirrors multistep's MAX_CHAIN_MS — that family
// fixed this exact class first). page.setDefaultTimeout bounds each ACTION (check.timeout_ms);
// without a flow ceiling, k slow-but-passing actions could run ~k × timeout_ms and ride into the
// ACA replicaTimeout kill — no verdict, a stranded 'running' row, and the rest of the tick's
// due checks silently deferred.
//
// 600s (10 min): the long authenticated flows (e.g. wegmans-full-shop-flow — login ~40s + ~40-75s
// per product × 4 products) legitimately need it, and it aligns with the SPEC's own RUN_CAP_MS =
// 600_000. This ceiling must stay ≤ the ACA replicaTimeout (infra/main.bicep, now 660s on the 3
// runner jobs): MAX_FLOW_MS above the replicaTimeout would strand the run at the ACA kill with no
// verdict. 600s leaves ~60s of the 660s replicaTimeout for teardown / trace upload (the same ratio
// the original 180/240 pair carried). Only the CEILING moves — per-action timeouts (check.timeout_ms,
// ~30s) are unchanged, so fast checks still fail fast; this only lets a genuinely long flow finish.
const MAX_FLOW_MS = 600_000;

// The ACA replicaTimeout on the 3 runner jobs (infra/main.bicep) — the HARD wall-clock a runner
// replica can live before ACA kills the process. Any run still 'running' PAST this is dead (killed),
// not in-flight. HEADER CONTRACT: this lives cross-repo in bicep and can't be type-checked here, so
// it MUST be raised in lockstep with the bicep replicaTimeout. Used by the run-now dedup below to
// decide whether an existing 'running' row is a live run to defer to; when it was hardcoded to the
// old 240s and MAX_FLOW_MS grew past it, a long flow (240s→completion) fell outside the window and a
// concurrent on-demand forceClaim would start a DUPLICATE run for the same check.
const ACA_REPLICA_TIMEOUT_S = 660;

// How fresh the per-monitor success-trace baseline must be before we SKIP re-uploading it on a pass.
// Capturing+uploading a multi-MB trace on every successful tick would be wasteful for a healthy 5-min
// monitor (288 uploads/day to maintain ONE overwritten slot); a baseline up to this stale is a fine
// "last known good" to diff against / feed AI insights. Failures are never throttled (always traced).
const SUCCESS_TRACE_REFRESH_MS = 6 * 60 * 60 * 1000; // 6h

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
  // ★ FIRST, before ANY query (the pg Pool connects lazily, so nothing has touched the DB yet):
  // refuse to run a LOCAL shell against the prod Postgres (the June 25–26 check-74 incident —
  // ~/.synthwatch.env hands prod DATABASE_URL to anything that sources it). Deployed jobs carry
  // the universal SYNTHWATCH_DEPLOYED=1 marker (bicep, all 8 jobs — #197) and pass silently; deliberate local-against-prod runs set
  // SYNTHWATCH_ALLOW_PROD=1. Refusal is log+exit, NOT throw — a throw would route through
  // recordFatal and INSERT into the prod DB, the exact write class being prevented (prodGuard.ts).
  enforceProdGuard();

  // Tick wall-clock start — the budget denominator for the loop-end summary line below (the ACA
  // replicaTimeout is 660s; a tick nearing it is about to defer work to the next tick).
  const tickStartMs = Date.now();
  // Stamp the per-invocation correlation id on stdout so an ACA log line + a runner_errors row reconcile.
  console.log(`[runner] invocation ${INVOCATION_ID} (location=${LOCATION})`);
  // ★ Egress-IP capture (static-egress-IP Phase 0): WARM the per-process egress IP now so it overlaps with
  // monitor work — by the time a run finalizes, the cached value is ready (the per-run stamp adds no latency).
  // Fail-soft: this never throws (captureEgressIp swallows all errors → null). Telemetry, not a monitor.
  void captureEgressIp();
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

  // On-demand "Run now": force-run any queued run_requests BEFORE the due-loop (forceClaim advances
  // last_run_at, so a check run here is then skipped by findDueChecks below — no double-run). Unlike
  // test-sends, we do NOT exit: a triggered tick runs the requested check(s) AND its normal due work.
  const forced = await drainRunRequests().catch((err) => {
    console.error('[run-now] drain failed (non-fatal):', err);
    return 0;
  });
  if (forced > 0) console.log(`[run-now] force-ran ${forced} on-demand check(s)`);

  const due = await findDueChecks();
  console.log(`[runner] ${due.length} check(s) due`);

  let claimed = 0;
  for (const candidate of due) {
    const check = await claim(candidate.id);
    if (!check) {
      // Another replica claimed it first, or it's no longer due.
      continue;
    }
    claimed++;
    // ★ B5: per-iteration try/catch (mirrors the on-demand drain above). runOne is try/FINALLY with NO
    // catch, so a throw AFTER its finalize block (the terminal UPDATE / evaluate / alerts / OTel) — or a
    // pool error in the 'running' INSERT — propagates and would abort the REST of this tick's due checks:
    // a silent monitoring gap (the whole fleet stops mid-tick). Catch it, record to the queryable sink
    // (runner_errors + stdout carrying the invocation/check/run context set in runOne), and CONTINUE. The
    // run row itself is already stamped 'error' by runOne's B2 finalize fallback; the check re-runs next tick.
    try {
      await runOne(check);
    } catch (err) {
      await recordFatal('due-loop', err);
    }
  }

  // Tick-budget telemetry (zero schema change): one greppable line per tick with claimed-vs-due
  // and wall-time. This is how starvation becomes VISIBLE — a replicaTimeout (660s) kill leaves no
  // queryable trace (no SIGTERM handler; the process just dies), so a tick that ran long shows up
  // here as wall-time approaching the budget, and one that was killed shows up as this line MISSING
  // for that invocation (grep the invocation id from the first log line).
  console.log(
    `[runner] tick summary: claimed ${claimed}/${due.length} due check(s), ` +
      `wall-time ${Date.now() - tickStartMs}ms (location=${LOCATION})`,
  );
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

  // ★ B4: the same claim-then-act strand exists on test_send_requests — drainTestSends claims 'sending'
  // and a crash before finish() leaves it stuck forever (the reaper previously covered ONLY runs). Sweep
  // stale 'sending' -> 'failed' so a dropped test-send is visible + not leaked. ('failed' is a valid
  // status per the test_send_requests CHECK: pending|sending|delivered|failed.)
  const { rowCount: tsReaped } = await pool.query(
    `UPDATE test_send_requests
        SET status = 'failed', completed_at = now(),
            detail = COALESCE(detail, 'runner did not finalize (stale sending)')
      WHERE status = 'sending'
        AND requested_at < now() - make_interval(mins => $1::int)`,
    [30],
  );
  if (tsReaped && tsReaped > 0) {
    console.log(`[runner] reaped ${tsReaped} stale 'sending' test-send(s) -> failed`);
  }
}

/**
 * Candidate due checks FOR THIS LOCATION. ENFORCED assignment: the INNER JOIN means a
 * check is a candidate ONLY if it has a check_locations cursor for THIS region — a
 * check not assigned here is simply not selected (no lazy-insert auto-creates one;
 * see claim()). Due when the cursor is NULL (freshly seeded => due-now) or aged past
 * the guarded threshold (interval_seconds minus the tick-slip guard — the shared
 * DUE_PREDICATE_SQL in duePredicate.ts explains the δ-slip mechanism and why the
 * guard cannot double-fire). Cheap pre-filter; claim() is the real (atomic) gate.
 *
 * ★ ORDER BY last_run_at ASC NULLS FIRST — longest-unserved first (NULL = never ran =
 * most starved). The loop is sequential and the ACA replicaTimeout (660s) can kill a
 * tick mid-list; with UNSPECIFIED order (Postgres heap order, ~stable tick-to-tick)
 * the SAME tail checks would starve on every over-budget tick. Oldest-first turns
 * persistent starvation into rotation: whatever was deferred last tick has the oldest
 * cursor, so it goes FIRST next tick. The c.id tiebreak makes intra-cohort order
 * (esp. the all-NULL never-ran group) deterministic instead of heap-order.
 */
async function findDueChecks(): Promise<{ id: number }[]> {
  const { rows } = await pool.query<{ id: number }>(
    `SELECT c.id
       FROM checks c
       JOIN check_locations cl
         ON cl.check_id = c.id AND cl.location = $1
      WHERE c.enabled
        AND c.archived_at IS NULL
        AND ${DUE_PREDICATE_SQL}
      ORDER BY cl.last_run_at ASC NULLS FIRST, c.id ASC`,
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
          AND c.archived_at IS NULL
          AND ${DUE_PREDICATE_SQL}
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

/**
 * On-demand "Run now" (mirrors drainTestSends): the API enqueues a run_requests row + fires this
 * Job immediately (ARM jobs/start), so a triggered tick runs the check NOW instead of waiting for
 * the timer. Claim each pending request with a conditional UPDATE (set status='done' WHERE
 * status='pending'), so exactly one tick/replica wins a given request and the rest skip it (the
 * rowCount gate, not row locks), then force-run each at THIS location through the normal runOne path —
 * so trace / signals / verdict / RCA flow identically. NON-FATAL: a drain failure never breaks the
 * tick. Returns how many checks were force-run.
 */
async function drainRunRequests(): Promise<number> {
  // Only consider pending requests whose check is ENABLED and ASSIGNED TO THIS LOCATION. ★ Robustness
  // fix: the old version marked EVERY pending row 'done' in one atomic UPDATE up front, THEN tried to run
  // each — so a runner that can't run a check (not assigned here / disabled) would CONSUME the request
  // without running it (a lost on-demand run for any check not assigned to whichever location ticked
  // first). Filtering to runnable-here requests first means a runner only ever claims what it can execute.
  // ★ SANDBOX (0064): the `AND c.enabled` gate is relaxed to `(c.enabled OR rr.sandbox)` so a SANDBOX-flagged
  // request may claim a PAUSED check — a NORMAL request (sandbox=false) still requires enabled (unchanged).
  // ★ ARCHIVE (0071): same shape — an ARCHIVED check refuses a NORMAL on-demand run but a SANDBOX request
  // may still validate it (mirrors the paused precedent; sandbox never opens incidents/alerts/SLO).
  const { rows: pending } = await pool.query<{ id: number; check_id: number; sandbox: boolean }>(
    `SELECT rr.id, rr.check_id, rr.sandbox
       FROM run_requests rr
       JOIN check_locations cl ON cl.check_id = rr.check_id AND cl.location = $1
       JOIN checks c           ON c.id = rr.check_id AND (c.enabled OR rr.sandbox)
                                                     AND (c.archived_at IS NULL OR rr.sandbox)
      WHERE rr.status = 'pending'
      ORDER BY rr.requested_at`,
    [LOCATION],
  );
  let ran = 0;
  for (const { id, check_id, sandbox } of pending) {
    // Atomically claim THIS request — only one tick/replica wins (a concurrent claim updates 0 rows).
    // We claim only AFTER confirming (above) this runner can run it, so a claimed row always runs here.
    const { rowCount: won } = await pool.query(
      `UPDATE run_requests SET status = 'done', completed_at = now() WHERE id = $1 AND status = 'pending'`,
      [id],
    );
    if (!won) continue; // already claimed by another tick/replica

    // Dedup: if a run is already in flight for this check here, the request is still consumed (the user's
    // "run it now" intent is satisfied by the in-flight run) — just don't start a duplicate.
    const { rowCount: running } = await pool.query(
      `SELECT 1 FROM runs
        WHERE check_id = $1 AND location = $2 AND status = 'running'
          AND started_at > now() - make_interval(secs => $3::int) LIMIT 1`,
      [check_id, LOCATION, ACA_REPLICA_TIMEOUT_S],
    );
    if (running) {
      console.log(`[run-now] check ${check_id} already running here — request consumed, skipping a duplicate run`);
      continue;
    }

    // Force-run: advance last_run_at unconditionally (so this tick's due-loop + other replicas skip it)
    // and run it. Null only on a tiny race (disabled between the SELECT and now) — already consumed, fine.
    const check = await forceClaim(check_id, sandbox);
    if (!check) continue;
    console.log(`[run-now] force-running check ${check.id} "${check.name}" (on-demand${sandbox ? ', SANDBOX — paused, evaluate() skipped' : ''})`);
    // ★ B5: per-iteration try/catch — a throw on ONE on-demand run must NOT abort the remaining drains.
    // Previously a runOne throw propagated out of the loop (caught only at the main-level .catch), dropping
    // every still-pending request this tick. The request was claimed 'done' atomically above (the race-
    // winner; run_requests.status is pending|done only, per its CHECK — no migration for an 'error' state),
    // so a failed run stays consumed and the check re-runs on its normal cron cadence; the failure is
    // logged here rather than silently aborting the siblings.
    try {
      await runOne(check, sandbox);
      ran++;
    } catch (err) {
      // ★ Mirror the due-loop (#162): record to the QUERYABLE runner_errors sink, not stdout-only. An
      // on-demand run that throws AFTER runOne's finalize was previously console.warn → invisible to
      // SELECT * FROM runner_errors (the same silent-monitoring class the due-loop closed; smaller,
      // user-initiated blast radius). recordFatal writes the row (phase='on-demand-loop') AND still logs
      // stdout with the invocation/check/run context. The drain still CONTINUES; the check re-runs on cron.
      await recordFatal('on-demand-loop', err);
    }
  }
  return ran;
}

/**
 * Like claim(), but UNCONDITIONAL (no due predicate) — for an on-demand run. Advances last_run_at
 * for (check, $LOCATION) so the normal due-loop and concurrent replicas treat it as just-run, and
 * returns the check row if it's enabled AND assigned to this location (else null).
 */
async function forceClaim(id: number, sandbox = false): Promise<Check | null> {
  // ★ SANDBOX (0064): `AND c.enabled` becomes `AND (c.enabled OR $3)` so a sandbox force-claim runs a PAUSED
  // check; $3=false (a normal on-demand run) keeps the enabled requirement. last_run_at still advances (the
  // check WAS run at this location), harmless for a paused check the due-loop ignores anyway.
  const { rows } = await pool.query<Check>(
    `WITH claimed AS (
       UPDATE check_locations cl
          SET last_run_at = now()
         FROM checks c
        WHERE cl.check_id = $1 AND cl.location = $2 AND c.id = cl.check_id AND (c.enabled OR $3)
          AND (c.archived_at IS NULL OR $3)
       RETURNING cl.check_id
     ),
     mirror AS (
       UPDATE checks SET last_run_at = now() WHERE id = (SELECT check_id FROM claimed)
     )
     SELECT c.* FROM checks c JOIN claimed ON claimed.check_id = c.id`,
    [id, LOCATION, sandbox],
  );
  return rows[0] ?? null;
}

async function runOne(check: Check, sandbox = false): Promise<void> {
  // Insert the run row as 'running' (in-flight) so the StepRecorder has a run_id
  // to attach steps to, and the SLA "exclude running" clause has real data. A
  // hard crash before the terminal update is reaped to 'error' (see main()).
  const { rows } = await pool.query<{ id: number }>(
    // ★ sandbox (0065): stamp the row so a paused-monitor validation run stays distinguishable from a real
    // run after the monitor is resumed (badge + optional SLO exclusion). Normal runs → false (unchanged).
    `INSERT INTO runs (check_id, started_at, status, location, sandbox) VALUES ($1, now(), 'running', $2, $3) RETURNING id`,
    [check.id, LOCATION, sandbox],
  );
  const runId = rows[0].id;
  // Best-effort context for the global handler: a fatal during this run is attributed to (check, run).
  setErrorContext(check.id, runId);

  // ★ B2: finalize-on-throw. runOneInner does the work + writes the terminal status; this wrapper
  // guarantees a throw BEFORE that write doesn't strand the row in 'running' ~30 min until the reaper.
  const state = { finalized: false };
  try {
    await runOneInner(check, runId, state, sandbox);
  } finally {
    // No double-write: state.finalized + `WHERE status='running'` make this a NO-OP once the terminal
    // write ran. Best-effort + own-catch — a finally that throws would hide the original error.
    if (!state.finalized) {
      await pool
        .query(
          `UPDATE runs SET status = 'error', finished_at = now(),
                  error_message = COALESCE(error_message, 'runner threw before finalizing the run')
            WHERE id = $1 AND status = 'running'`,
          [runId],
        )
        .catch((e) => console.warn(`[runner] run ${runId} B2 finalize fallback failed (non-fatal):`, e));
    }
  }
}

async function runOneInner(
  check: Check,
  runId: number,
  state: { finalized: boolean },
  sandbox = false,
): Promise<void> {
  const errorOutcome = (msg: string): Outcome => ({
    status: 'error',
    httpStatus: null,
    durationMs: 0,
    error: msg,
    failedStep: null,
    screenshot: null,
    metrics: null,
    metricsCaptureFailed: false,
    certDaysRemaining: null,
    tracePath: null,
    baselineScreenshot: null,
  });

  // FAST-RETRY (mechanism 1, within ONE run): runWithRetry re-runs on ANY failure — 'error'
  // (couldn't COMPLETE — network/timeout/DNS) OR 'fail' (an assertion missed) — up to `retries`
  // times. NOT retried on pass/warn (a success; warn = available-but-degraded). The LAST attempt
  // is the verdict; onBeforeRetry discards the prior attempt's partial per-run side effects
  // (run_steps, run_metrics, the temp trace file) REGARDLESS of its status + backs off, so EXACTLY
  // ONE verdict persists — the run history / failure_threshold (mechanism 2, AFTER this) never sees
  // the retried-away attempts (no phantom intermediate-failure metrics pollute the success-baseline
  // or trace-diff). retries=0 => no retry (pre-0021 behaviour). Retrying 'fail' lets an in-run-
  // confirmed failure page immediately (with failure_threshold=1) instead of after N scheduled ticks.
  //
  // ★ SKIP fast-retry when ALREADY confirmed-down: fast-retry absorbs a TRANSIENT blip on a HEALTHY
  // monitor — moot once the failure is SUSTAINED. If an incident is already open for this check, a
  // prior run already confirmed it's failing, so retrying ×2 every tick is wasted browser work
  // (~2-3 min/tick). effectiveRetries() drops to 0 (1 attempt) then. The FIRST failure of a healthy
  // monitor still gets full retry (no incident yet); only SUBSEQUENT failures while the incident is
  // open skip it; on recovery evaluate() resolves the incident, so the next fresh failure retries again.
  const alreadyFailing = await hasOpenIncident(check.id);
  // ★ sandbox suppresses fast-retry too: a paused-monitor validation wants the TRUE first-attempt
  // outcome (evaluate() is skipped, so there's no page to confirm) — see effectiveRetries.
  const retries = effectiveRetries(check.retries, alreadyFailing, sandbox);
  const maxAttempts = retries + 1;
  if (sandbox && check.retries > 0) {
    console.log(
      `[runner] check ${check.id} "${check.name}" SANDBOX validation — single attempt (fast-retry skipped, true first-attempt state).`,
    );
  } else if (alreadyFailing && check.retries > 0) {
    console.log(
      `[runner] check ${check.id} "${check.name}" already has an open incident — skipping fast-retry (1 attempt).`,
    );
  }
  // Capture this run's trace as the SUCCESS baseline only if the monitor's existing baseline is
  // missing or older than SUCCESS_TRACE_REFRESH_MS (throttle — see the const). Decided up front from
  // the claimed check row; failures ignore this and are always traced.
  const lastSuccessTraceMs = check.success_trace_at ? check.success_trace_at.getTime() : 0;
  const captureSuccessTrace = Date.now() - lastSuccessTraceMs > SUCCESS_TRACE_REFRESH_MS;
  // ★ #232 defect-2: resolve this run's login-credential VALUES once (stable — reads the always-present
  // ENV_VAR the ref points at, independent of the per-run SW_CRED_<ROLE> publish/clear). Registered into
  // BOTH redactors (run-level below + the step redactor in executeBrowser) as escaped-literal rules so the
  // bare typed value is scrubbed from console/error/trace_signals. Only for a sensitive monitor (a
  // non-sensitive monitor gets IDENTITY_REDACTOR — no scrubbing — so registering values would be moot).
  // redactableCredValues EXCLUDES the non-secret 'username' role (a test-account identifier), so the typed
  // username stays visible for login debugging while the password + every other role stay redacted.
  const credValues = check.sensitive ? redactableCredValues(resolveLoginCredentials(check.login_credentials)) : [];
  // Wall-clock start of the (final) executor attempt — the OTel root span's start.
  let execStartMs = Date.now();
  const { result: outcome, attempts: retryCount } = await runWithRetry<Outcome>(
    async () => {
      execStartMs = Date.now();
      try {
        if (check.kind === 'http') return await executeHttp(check);
        if (check.kind === 'ssl') return await executeSsl(check);
        if (check.kind === 'dns' || check.kind === 'tcp' || check.kind === 'ping')
          return await executeNet(check);
        if (check.kind === 'multistep') return await executeMultistep(check, runId);
        return await executeBrowser(
          check,
          runId,
          captureSuccessTrace,
          // S2/S3: re-point a pre-prod check's reused prod spec to its own target_url (undefined = no rewrite).
          hostRewriteFor(check.rewrite_from_origin, check.target_url),
          credValues, // #232 defect-2: register into the step redactor too
        );
      } catch (err) {
        // Unexpected runner error (e.g. flow loader threw) -> 'error', not 'fail'.
        return errorOutcome(err instanceof Error ? err.message : String(err));
      }
    },
    retries,
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

  // Perf-budget verdict on an otherwise-PASSED browser run (perfBudgetVerdict is pure + unit-tested):
  //   • a real breach (metric over budget)           → 'warn'  (degraded-but-available; non-inert budgets)
  //   • ★ B1 — a budget IS configured but metric capture FAILED → 'error'. The run was blind to a budget
  //     it was meant to enforce; a green that couldn't be measured is a green that lies, so it must NOT
  //     pass. (A check with no budget, or a successful capture, is unaffected.)
  let status: TerminalStatus = outcome.status;
  let errorMessage = outcome.error;
  // ★ Location-aware (3rd-region quorum PR): pass LOCATION so a distant vantage (westus2) gets latency
  // headroom — normal cross-continent RTT isn't a false breach. Page weight stays region-independent.
  const perf = perfBudgetVerdict(check, status, outcome.metrics, outcome.metricsCaptureFailed, LOCATION);
  if (perf.status !== status) {
    if (perf.status === 'error') {
      console.warn(`[runner] run ${runId} check ${check.id}: ${perf.message}`);
    }
    status = perf.status;
    errorMessage = perf.message; // record WHY it warned/errored
  }

  // ★ B10: a SENSITIVE monitor (cart/auth) redacts everything trace-derived. Build its redactor once
  // (built-in token denylist + declared patterns). For the run-level error_message: SCRUB sensitive VALUES
  // out of the REAL error (a Playwright native error can echo a Bearer/JWT/token) while KEEPING the
  // diagnostic text + failed_step — do NOT blanket-replace (that discarded WHY the monitor fails). A warn's
  // perf-breach message is generated by us (no PII) so it's left intact. Non-sensitive: unchanged.
  const sensitive = check.sensitive;
  const redact = sensitive ? makeRedactor(check.redact_patterns, credValues) : IDENTITY_REDACTOR;
  const persist = tracePersistPlan(sensitive, status);
  if (sensitive && (status === 'fail' || status === 'error')) {
    errorMessage = scrubError(redact, status, outcome.failedStep, errorMessage);
  }

  // ★ Egress-IP (static-egress-IP Phase 0): the per-process public egress IP, captured once and warmed at
  // startup, so this reads the cache with no added latency. Fail-soft → null if the reflector was
  // unreachable. ★ NOT sensitive (our own infra's public IP) — stamped DIRECTLY, never through `redact`.
  // Captured here (moved up from after trace processing) so the provisional verdict below carries it.
  const egressIp = await captureEgressIp();

  // ★ B1 (verdict-survives-crash): stamp the honest terminal verdict — status + timing + failed_step +
  // error_message — NOW, BEFORE the memory-heavy trace processing (extract → redacted-zip rebuild →
  // upload) below. That processing is where run #936920 OOM-killed (exit 137) rebuilding a 531s run's
  // redacted zip in memory; because the terminal write used to be sequenced AFTER it — and SIGKILL runs
  // no `finally` — the row stranded at 'running' and was reaped 30 min later to a generic verdict with no
  // duration/failed_step/trace. Writing the verdict first means a crash during trace work leaves a
  // finalized-WITHOUT-trace run (real status + failed_step), not a strand. Trace-derived fields
  // (trace_url/trace_signals/screenshot_url) are enriched in a SECOND write after the trace work.
  await writeProvisionalVerdict(runId, {
    status,
    durationMs: outcome.durationMs,
    httpStatus: outcome.httpStatus,
    errorMessage,
    failedStep: outcome.failedStep,
    certDaysRemaining: outcome.certDaysRemaining,
    // attempts taken to reach this verdict: 1 = first try; >1 + status=pass = degrading-but-green.
    retryCount,
    egressIp,
  });
  state.finalized = true; // ★ verdict persisted — the runOne finally-guard + the stale-running reaper are now no-ops.

  // Screenshot: NEVER stored for a sensitive monitor (a rendered page shows cart contents / logged-in PII).
  let screenshotUrl: string | null = null;
  if (persist.failureScreenshot && outcome.screenshot) {
    screenshotUrl = await uploadScreenshot(runId, outcome.screenshot);
  }

  // Upload the trace (non-fatal), then delete the temp file regardless. ROUTE by verdict:
  //  • fail/error -> per-run key (runs.trace_url), rides the 90d artifact purge.
  //  • pass/warn  -> the monitor's last-known-good baseline at the stable, purge-EXEMPT key
  //                  (success-latest/check-<id>.zip), OVERWRITING the prior one. Recorded on the
  //                  CHECK (not the run) since the slot is shared/overwritten — an old pass run must
  //                  not point at a now-newer baseline, so runs.trace_url stays null for successes.
  let traceUrl: string | null = null;
  // Compact, filtered trace SIGNALS persisted per run (0040) — extracted from the local zip while it's in
  // hand (no later re-download), for ANY traced run (success baseline AND failure). Reuses the SAME extraction
  // as the API's TraceExtractor so trace-diff + ai-insights share one schema. Non-fatal: a bad zip → null.
  let traceSignalsJson: string | null = null;
  if (outcome.tracePath) {
    try {
      // Extract trace_signals from the local zip while it's in hand. For a sensitive monitor the
      // redactor scrubs network URLs + console (session tokens / declared values) BEFORE persist.
      const signals = extractTraceSignals(outcome.tracePath, check.target_url, redact);
      if (signals) traceSignalsJson = JSON.stringify(signals);
    } catch (err) {
      console.warn(`[runner] run ${runId} trace-signals extraction skipped (non-fatal):`, err);
    }
    // ★ B10 (revised — failed-run trace visibility): a sensitive monitor still stores NO RAW zip
    // (the raw capture carries typed credentials, cookies/session tokens, and the logged-in DOM),
    // but a FAILED run now persists a REDACTED, REDUCED copy (traceRedact.ts): text streams scrubbed
    // by the monitor's redactor + structural session-material rules, binary entries (screencast
    // frames — unscrubbable) dropped. Same per-run key + 90d purge as a raw failure trace. FAIL-
    // CLOSED: if the redacted copy can't be built, nothing is uploaded. Green sensitive runs still
    // discard everything (no permanent success-baseline — that slot is purge-exempt), and the
    // screenshot skip above is unchanged. Non-sensitive monitors: unchanged ('raw'/'none').
    if (persist.failureTraceMode === 'raw') {
      traceUrl = await uploadTrace(runId, outcome.tracePath);
    } else if (persist.failureTraceMode === 'redacted') {
      // The zip redactor = the run-level redactor's inputs PLUS the decrypted secret-header VALUES
      // (the Akamai bypass token rides the trace's network stream as a literal header value, exactly
      // like the typed credentials ride its DOM/console). A decrypt failure falls back to the
      // run-level redactor: a value that never decrypted was never injected into this trace either.
      let zipRedact = redact;
      try {
        const secretVals = Object.values(decryptSecretHeaders(check.secret_headers));
        if (secretVals.length > 0) zipRedact = makeRedactor(check.redact_patterns, [...credValues, ...secretVals]);
      } catch {
        // fall back to `redact` (declared patterns + credential values)
      }
      const redactedPath = `${outcome.tracePath}.redacted.zip`;
      if (await buildRedactedTraceZip(outcome.tracePath, redactedPath, zipRedact)) {
        traceUrl = await uploadTrace(runId, redactedPath);
        await unlink(redactedPath).catch(() => {});
      } else {
        console.warn(
          `[trace] run ${runId} redacted-trace build failed — trace NOT uploaded (fail-closed, non-fatal)`,
        );
      }
    } else if (persist.successBaseline) {
      try {
        const url = await uploadSuccessTrace(check.id, outcome.tracePath);
        if (url) {
          await pool.query(`UPDATE checks SET success_trace_url = $2, success_trace_at = now() WHERE id = $1`, [
            check.id,
            url,
          ]);
        }
      } catch (err) {
        console.warn(`[runner] check ${check.id} success trace skipped (non-fatal):`, err);
      }
    }
    await unlink(outcome.tracePath).catch(() => {});
  }

  // Store the RCA visual-diff baseline ONLY on a clean pass (not warn/fail), to a
  // stable per-check key (overwrite). Non-fatal — a baseline failure never affects
  // the run.
  // ★ B10: no RCA visual-diff baseline for a sensitive monitor either (a passing logged-in page
  // still renders PII). With no baseline + no failure screenshot stored, RCA has no image to send.
  if (persist.baselineScreenshot && outcome.baselineScreenshot) {
    try {
      const url = await uploadBaselineScreenshot(check.id, outcome.baselineScreenshot);
      if (url) {
        await pool.query(`UPDATE checks SET baseline_screenshot_url = $2 WHERE id = $1`, [check.id, url]);
      }
    } catch (err) {
      console.warn(`[runner] check ${check.id} baseline screenshot skipped (non-fatal):`, err);
    }
  }

  // ★ B1: enrich the already-finalized run with the trace-derived fields. Touches ONLY
  // trace_url/trace_signals/screenshot_url — the verdict written above is left intact. A crash BEFORE
  // this point leaves a finalized-without-trace run (honest verdict, no trace_url), NOT a strand.
  await enrichRunTrace(runId, { traceUrl, traceSignalsJson, screenshotUrl });

  const run: RunRecord = {
    id: runId,
    check_id: check.id,
    status,
    error_message: errorMessage,
    failed_step: outcome.failedStep,
    screenshot_url: screenshotUrl,
    location: LOCATION,
  };
  // ★ SANDBOX (0064): the run row + trace are already persisted above (inspectable). applyRunSideEffects
  // runs evaluate() (incident open/resolve + dispatchAlerts) + maybeBurnAlert() (SLO burn paging) — UNLESS
  // this is a sandbox run of a PAUSED monitor, in which case it SKIPS them all (the load-bearing option-A
  // guard: without it a paused monitor pages — the "C" failure). Nothing flips checks.enabled either. (OTel
  // below is telemetry, not an alert/incident/SLO write — left on.) SLO rollups don't see this run: the
  // paused check is excluded by the reports' `WHERE c.enabled` filter (and #188 excludes staging).
  await applyRunSideEffects(check, run, sandbox);

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
    metricsCaptureFailed: false,
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
    metricsCaptureFailed: false,
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
    metricsCaptureFailed: false,
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
    metricsCaptureFailed: false,
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
    screenshot: null, metrics: null, metricsCaptureFailed: false, certDaysRemaining: null, tracePath: null,
    baselineScreenshot: null,
  };
}

/** A plain 'error' Outcome usable from executeBrowser (runOne has its own local errorOutcome). */
function errorOutcomeStandalone(msg: string): Outcome {
  return {
    status: 'error', httpStatus: null, durationMs: 0,
    error: msg, failedStep: null,
    screenshot: null, metrics: null, metricsCaptureFailed: false, certDaysRemaining: null, tracePath: null,
    baselineScreenshot: null,
  };
}

async function executeBrowser(
  check: Check,
  runId: number,
  // Whether to KEEP the trace if this run passes (the success baseline). Failures are ALWAYS kept
  // regardless. Decided upstream in runOne (throttled by the monitor's success_trace_at) so a
  // healthy frequent monitor doesn't serialize+upload a multi-MB trace every tick.
  captureSuccessTrace: boolean,
  // ★ S2 pre-prod-arc primitive (INERT by default). When set, every request whose origin matches
  // hostRewrite.fromOrigin is re-pointed to hostRewrite.toOrigin at the route layer (host+port only;
  // path/query/protocol preserved), so a spec hardcoding its prod host can run against staging/dev
  // WITHOUT editing the spec or forking the shared spec_cache. undefined → NO rewrite (byte-identical
  // to before). No caller sets this yet; S3 wires it when a pre-prod check exists.
  hostRewrite?: HostRewrite,
  // ★ #232 defect-2: the run's resolved login-credential VALUES, registered into the step redactor as
  // escaped-literal rules so a typed cred is scrubbed from a per-step error_message. [] for non-login/
  // non-sensitive monitors (resolved once upstream in runOneInner so both redactors agree).
  credValues: readonly string[] = [],
): Promise<Outcome> {
  // FAIL-LOUD before opening a browser: a malformed origin pair REFUSES the run rather than silently
  // running the spec against its hardcoded PROD host (a false-green against prod). Compiled once here.
  const compiledRewrite = hostRewrite ? compileHostRewrite(hostRewrite) : null;
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

    // ★ SPEC PROVENANCE (0047): record EXACTLY what this run loaded, BEFORE executing it, so even a
    // failing/crashing run leaves the forensic trail. executed_sha256 is decisive — compare it to the
    // cache's compiled_js hash to prove whether the run executed the cached spec or something else.
    // Cheap (reuses the in-hand compiledJs; no extra fetch). Non-fatal: a provenance write never breaks a run.
    const provenance = {
      spec_path: check.spec_path,
      origin: resolution.origin,
      resolved_etag: resolution.resolvedEtag,
      cache_fetched_at: resolution.cacheFetchedAt?.toISOString() ?? null,
      executed_sha256: sha256(compiledJs),
      executed_len: compiledJs.length,
      has_preclick: compiledJs.includes('PRE-CLICK'),
    };
    await pool
      .query(`UPDATE runs SET spec_provenance = $2::jsonb WHERE id = $1`, [runId, JSON.stringify(provenance)])
      .catch((err) => console.warn(`[specprov] run ${runId} provenance write failed (non-fatal):`, err));
  } else if (!check.flow_name) {
    // Neither a Git spec nor a baked-in flow — schema's browser_needs_flow should prevent this.
    return errorOutcomeStandalone('browser check has no spec_path or flow_name');
  }

  const start = Date.now();
  const b = await getBrowser();
  const context = await b.newContext();

  // Per-request header injection (installed before any navigation). Two DISTINCT concerns, kept separate in
  // vercelBypass.browserHeaderAdditions:
  //   1. the monitor's non-secret request_headers → merged into EVERY request (the browser path previously
  //      injected none — the HTTP path already did; this closes that gap);
  //   2. the Vercel bypass token → added ONLY for a protected host (per-request host-match).
  // ★ We do NOT use context.extraHTTPHeaders: that is context-wide and would spray the SECRET token to every
  // third-party subresource (analytics/CDNs) the page loads — a leak. Per-request matching sends it only to the
  // protected properties. route.continue() untouched when there's nothing to add (no interception overhead cost
  // beyond the match).
  const customHeaders = check.request_headers ?? {};
  // Per-monitor SECRET headers (references-only): resolved per request, host-scoped to the check's target
  // host so a secret credential never sprays to a third-party subresource (anti-leak, like the bypass token).
  // DECRYPT the secret headers ONCE up front (model B) — fail-closed on a bad key/leaf BEFORE routing, so a
  // decrypt error surfaces as a clean run error (never a throw inside the route handler). Empty when none.
  const secretHeaderValues = decryptSecretHeaders(check.secret_headers);
  const targetHost = hostOf(check.target_url);
  await context.route('**/*', async (route) => {
    const reqUrl = route.request().url();
    const additions = browserHeaderAdditions(reqUrl, customHeaders);
    const secretAdds = firstPartyHeaders(secretHeaderValues, reqUrl, targetHost); // host-scoped (no decrypt here)
    const hasSecret = Object.keys(secretAdds).length > 0;
    // S2: re-point the primary origin (host+port) when a rewrite is compiled; null (inert) otherwise.
    // Third-party origins never match → resolveRewrite returns null → they pass through untouched.
    const rewrittenUrl = resolveRewrite(reqUrl, compiledRewrite);
    if (additions === null && !hasSecret && rewrittenUrl === null) {
      await route.continue();
      return;
    }
    await route.continue({
      ...((additions !== null || hasSecret) && {
        headers: { ...route.request().headers(), ...(additions ?? {}), ...secretAdds },
      }),
      ...(rewrittenUrl !== null && { url: rewrittenUrl }),
    });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(check.timeout_ms);

  // Passive Tier-1 telemetry capture rides this run's own navigation. Set up
  // BEFORE the flow so the LCP observer / response listener / CDP session see
  // the whole page load; collected in the finally below.
  const capture = await startMetricsCapture(context, page);

  // Deploy-markers browser path: retain the MAIN navigation document's response headers (the header half of
  // input parity with the http path). Installed BEFORE the flow so the listener sees the navigation; read at
  // the pass branch below alongside page.content(). Best-effort — never throws, never affects the run.
  const getMainDocHeaders = captureMainDocHeaders(page);

  // Start a Playwright trace for the whole run (recording always happened; the cost change is the
  // SAVE). We keep it on FAILURE (per-run, rides the 90d purge) and on SUCCESS when captureSuccessTrace
  // is set (the last-known-good baseline). sources:false avoids embedding the flow source;
  // screenshots+snapshots are the debugging value. Non-fatal.
  let tracingOn = false;
  await context.tracing
    .start({ screenshots: true, snapshots: true, sources: false })
    .then(() => {
      tracingOn = true;
    })
    .catch((err) => {
      // Non-fatal (the run still proceeds), but it MUST be visible: a swallowed
      // trace-start failure means every run this tick has no trace to debug from,
      // silently and undiagnosably. Log it (same [trace] channel as the stop path).
      console.warn(
        `[trace] run ${runId} tracing.start failed (non-fatal; no trace will be captured):`,
        err,
      );
    });

  // Decide the verdict in the try/catch, capture metrics in the finally, then
  // assemble the Outcome after — so the perf-budget comparison upstream gets the
  // real metrics even though they're collected during teardown.
  let status: TerminalStatus;
  let error: string | null = null;
  let failedStep: string | null = null;
  let screenshot: Buffer | null = null;
  let metrics: RunMetrics;
  let metricsCaptureFailed = false;
  let tracePath: string | null = null;
  let failed = false;
  let baselineScreenshot: Buffer | null = null;
  // Per-monitor login credentials (0067): resolve the declared { role -> ENV_VAR } refs and PUBLISH them as
  // process.env[SW_CRED_<ROLE>] so the spec's credential(role) can read them. Set for the life of THIS run
  // only and cleared in the finally — so a resolved secret can't linger or bleed across the tick's other
  // (serially-run) checks. No-op ([]) for a monitor with no login_credentials. Never logged.
  let credKeys: CredEnvHandle[] = [];

  try {
    credKeys = applyLoginCredentials(check.login_credentials);
    // B10: pass the monitor's REDACTOR so a sensitive monitor's per-step error_message is SCRUBBED (values
    // gone, diagnostic kept) in run_steps — not blanket-replaced. Non-sensitive → identity (unchanged).
    const stepRedact = check.sensitive ? makeRedactor(check.redact_patterns, credValues) : IDENTITY_REDACTOR;
    const rec = new StepRecorder(runId, page, check.target_url, undefined, undefined, stepRedact);
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
      // Whole-flow deadline (MAX_FLOW_MS): a budget breach rejects with a plain Error → the catch
      // below classifies it 'error' (isExpectationError is false), with an honest message instead
      // of a replicaTimeout kill. The context.close() in the finally aborts the abandoned flow's
      // in-flight Playwright work; withDeadline marks its late rejection handled.
      await withDeadline(
        flow(rec),
        MAX_FLOW_MS,
        `browser flow wall-clock budget (${MAX_FLOW_MS}ms) exhausted — per-action timeouts (${check.timeout_ms}ms) never bound the WHOLE flow`,
      );
      status = 'pass';
      // Capture the RCA visual-diff baseline from the just-rendered page (cheap —
      // it's already rendered; we'd otherwise discard it). Non-fatal; runOne only
      // stores it if the final verdict is 'pass' (not a perf-budget 'warn').
      baselineScreenshot = await page.screenshot().catch(() => null);

      // Deploy-markers browser path: feed the SAME curated ladder BOTH the rendered DOM and the main-doc
      // response headers (input parity with the http path) so wegmans' sentry-release SHA (a body marker) and
      // an etag-only host (a header marker) both land — per host, no per-target logic. PASS-ONLY: a red run's
      // DOM is an unreliable deploy fingerprint (mirror the baseline-capture gating). Fully best-effort —
      // noteDeployMarker is internally try/caught, and page.content() is guarded so it can never fail or slow a run.
      const domHtml = await page.content().catch(() => null);
      await noteDeployMarker(check.target_url, getMainDocHeaders(), domHtml, check.id, 'browser');
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
    // ★ Clear the per-run login credentials (0067) FIRST — before any teardown — so a resolved secret never
    // outlives the run in process.env, even if tracing-stop/metrics below throw. No-op when none were set.
    clearLoginCredentials(credKeys);
    // Stop tracing BEFORE closing the context. Write the trace.zip to a temp file (which runOne
    // uploads — to the per-run key on failure, or the per-monitor baseline key on success) when we
    // want to keep it: ALWAYS on failure, and on a pass only when captureSuccessTrace says the
    // baseline is due a refresh. Otherwise stop() discards it (no serialize, no upload). Non-fatal.
    if (tracingOn) {
      try {
        if (failed || captureSuccessTrace) {
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

    // Persist one run_metrics row (any outcome) before tearing down the context. Fall back to an
    // all-null row if capture or the write itself throws — BUT ★ B1: record that capture FAILED. A
    // metric VALUE never decides the verdict, but the ABSENCE of metrics on a perf-budgeted check does:
    // a run that couldn't capture the metrics it's meant to evaluate must not pass as healthy (the
    // verdict consumes metricsCaptureFailed below). Was: "swallow everything" → the inverted-signal bug.
    try {
      const result = await capture.collect();
      metrics = result.metrics;
      await writeRunMetrics(runId, metrics);
      // ★ B1 silent-null: collect() does NOT throw, so the catch below only covers the rare hard-throw
      // path (#146). A budgeted metric whose capture SECTION failed (returned null without throwing) is
      // ALSO not-evaluable — treat it like the throw path so the run can't pass green while blind. A
      // budgeted metric that's null but was captured (legitimately absent, e.g. no LCP) is NOT flagged.
      if (budgetedMetricCaptureFailed(check, result.captureFailed)) {
        metricsCaptureFailed = true;
        console.warn(
          `[metrics] run ${runId} check ${check.id}: a perf-budgeted metric failed to capture ` +
            `(silent null, no throw) — recording not-evaluable, not a blind pass`,
        );
      }
    } catch (err) {
      console.warn(`[metrics] run ${runId} telemetry capture failed:`, err);
      metrics = EMPTY_METRICS;
      metricsCaptureFailed = true;
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
    metricsCaptureFailed,
    certDaysRemaining: null,
    tracePath,
    baselineScreenshot,
  };
}

// ★ Global exception visibility (meta-lesson A): catch-all uncaught/unhandled-rejection handlers that
// PERSIST the real exception + correlation id to the queryable runner_errors table before exiting — they
// preserve Node's crash-on-uncaught semantics exactly (exit 1), they only make the failure visible.
installGlobalErrorHandlers();

main()
  .then(() => 0)
  .catch(async (err) => {
    // Was: console.error → ACA stdout only (uncapturable, #139). Now ALSO persisted (queryable) with the
    // invocation correlation id. Same fatal outcome (exit 1) — visibility added, control flow unchanged.
    await recordFatal('main', err);
    return 1;
  })
  .then(async (code) => {
    if (browser) await browser.close().catch(() => {});
    await shutdownOtel(); // flush batched spans (bounded; non-fatal)
    await pool.end().catch(() => {});
    process.exit(code);
  });
