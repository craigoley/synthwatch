// Run finalization — split into a PROVISIONAL VERDICT write and a later TRACE ENRICHMENT write.
//
// ★ B1 (verdict-survives-crash): the terminal status used to be written by a SINGLE `UPDATE runs …`
// sequenced AFTER the heavy trace processing (extractTraceSignals → buildRedactedTraceZip → uploadTrace).
// A crash/OOM/SIGKILL during that processing (run #936920: the 531s shop-flow OOM-killed, exit 137, while
// rebuilding the redacted trace zip in memory) meant the terminal write NEVER ran → the row stranded at
// 'running' and was reaped ~30 min later to a GENERIC 'runner did not finalize' with no duration_ms / no
// failed_step / no trace_url — masking the real failure. A Node `finally` cannot rescue this: SIGKILL runs
// no finally.
//
// The fix is ORDERING: stamp the honest verdict (everything that does NOT need the trace) FIRST, while
// memory is lower, then do the trace work, then enrich the already-finalized row with the trace-derived
// fields. A crash after the provisional write leaves a finalized-WITHOUT-trace run (real status +
// failed_step + duration, just no trace_url) — NOT a strand.
//
// These are their own committed statements (one query each), so a crash during trace work cannot roll the
// verdict back. Extracted here (not inline in index.ts, which runs main() on import and so isn't
// importable) so the ordering invariant is unit-testable — the codebase's "test the extracted seam" pattern.
import { pool, type TerminalStatus } from './db.js';

/** The verdict fields — everything derivable from the flow Outcome, needing NO trace processing. */
export interface ProvisionalVerdict {
  status: TerminalStatus;
  durationMs: number;
  httpStatus: number | null;
  errorMessage: string | null;
  failedStep: string | null;
  certDaysRemaining: number | null;
  retryCount: number;
  egressIp: string | null;
}

/** Stamp the terminal verdict on the run row BEFORE trace processing. After this the row is no longer
 *  'running', so the runOne finally-guard + the stale-running reaper both become no-ops for it. */
export async function writeProvisionalVerdict(runId: number, v: ProvisionalVerdict): Promise<void> {
  await pool.query(
    `UPDATE runs
        SET status = $2, finished_at = now(), duration_ms = $3, http_status = $4,
            error_message = $5, failed_step = $6, cert_days_remaining = $7,
            retry_count = $8, egress_ip = $9
      WHERE id = $1`,
    [runId, v.status, v.durationMs, v.httpStatus, v.errorMessage, v.failedStep, v.certDaysRemaining, v.retryCount, v.egressIp],
  );
}

/** The trace-DERIVED fields — available only AFTER trace extraction/redaction/upload + screenshot upload. */
export interface TraceEnrichment {
  traceUrl: string | null;
  traceSignalsJson: string | null;
  screenshotUrl: string | null;
}

/** Enrich the already-finalized run with the trace-derived fields. Touches ONLY those columns — the
 *  verdict (status/finished_at/duration/failed_step/error_message) written above is left untouched, so a
 *  late enrichment can never disturb (or regress) the terminal verdict. */
export async function enrichRunTrace(runId: number, t: TraceEnrichment): Promise<void> {
  await pool.query(
    `UPDATE runs SET trace_url = $2, trace_signals = $3::jsonb, screenshot_url = $4 WHERE id = $1`,
    [runId, t.traceUrl, t.traceSignalsJson, t.screenshotUrl],
  );
}
