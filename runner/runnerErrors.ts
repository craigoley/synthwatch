// Global exception visibility — meta-lesson A made permanent.
//
// The dismiss-500 cost ~5 PRs because the real exception was swallowed + invisible. The runner's only
// top-level handler was `console.error('[runner] fatal:', err)` → ACA STDOUT, which #139 proved is
// uncapturable (OTel off) — so a fatal manufactured a false "no error" fact. This module persists every
// top-level/uncaught exception to the QUERYABLE runner_errors table with a per-invocation correlation
// id AND keeps logging to stdout, so the NEXT silent failure is a one-grep diagnosis:
//   SELECT * FROM runner_errors ORDER BY occurred_at DESC;
//
// ★ Visibility-ONLY: this never changes which errors are fatal. The process handlers below preserve
// Node's default crash-on-uncaught semantics EXACTLY (exit 1 after recording); the main() catch already
// returned 1. Non-fatal swallow-to-continue sites (telemetry, manifest sync, …) are untouched — they
// keep their own console.warn (meta-lesson B: non-fatal must still be logged).
import { randomUUID } from 'node:crypto';
import { pool } from './db.js';

// One id per process = one ACA job invocation. Stamped on the stdout log lines AND the DB row so the two
// reconcile even though stdout itself isn't queryable.
export const INVOCATION_ID = randomUUID();

// Best-effort "what was in flight" context — set by the run loop so a fatal during a run records WHICH
// check/run blew up. Null outside a run (startup / claim / teardown).
let currentCheckId: number | null = null;
let currentRunId: number | null = null;

/** Record the check/run currently executing, so a fatal is attributed to it. Cleared with (null, null). */
export function setErrorContext(checkId: number | null, runId: number | null): void {
  currentCheckId = checkId;
  currentRunId = runId;
}

/** Extract a loggable message + stack from ANYTHING thrown (Error, string, object, circular) — never
 *  throws, so the visibility helper can't itself become the swallowed failure. Exported for testing. */
export function describeError(err: unknown): { message: string; stack: string | null } {
  if (err instanceof Error) return { message: err.message, stack: err.stack ?? null };
  try {
    return { message: typeof err === 'string' ? err : JSON.stringify(err), stack: null };
  } catch {
    return { message: String(err), stack: null }; // e.g. a circular object that JSON.stringify rejects
  }
}

/**
 * Persist a top-level failure to the queryable sink + stdout. NEVER throws (a visibility helper must not
 * itself become the failure) and is time-bounded (a hung DB must not delay the fatal exit). The caller
 * decides control flow exactly as before; this only makes the failure visible.
 */
export async function recordFatal(phase: string, err: unknown): Promise<void> {
  const { message, stack } = describeError(err);
  // ALWAYS stdout first — instant, survives a DB outage, carries the correlation id.
  console.error(
    `[runner] FATAL [${phase}] invocation=${INVOCATION_ID} check=${currentCheckId ?? '-'} ` +
      `run=${currentRunId ?? '-'}: ${message}`,
  );
  if (stack) console.error(stack);
  // Then the QUERYABLE row (best-effort + bounded). If the DB is what's down, the stdout line + the
  // DB-down itself are the diagnosis — never block the exit on it.
  let timer: NodeJS.Timeout | undefined;
  try {
    const insert = pool.query(
      `INSERT INTO runner_errors (invocation_id, phase, check_id, run_id, message, stack)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [INVOCATION_ID, phase, currentCheckId, currentRunId, message, stack],
    );
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 5000);
    });
    await Promise.race([insert.then(() => undefined), bound]);
  } catch (writeErr) {
    console.error(
      `[runner] (runner_errors persist failed; stdout above is the only record): ${describeError(writeErr).message}`,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Install the process-level catch-alls. uncaughtException + unhandledRejection ALREADY crash the process
 * by default (Node exits non-zero) — these preserve that EXACTLY (process.exit(1) after recording); they
 * only ADD the queryable record + correlation id first. Call once at startup.
 */
export function installGlobalErrorHandlers(): void {
  process.on('uncaughtException', (err) => {
    void recordFatal('uncaughtException', err).finally(() => process.exit(1));
  });
  process.on('unhandledRejection', (reason) => {
    void recordFatal('unhandledRejection', reason).finally(() => process.exit(1));
  });
}
