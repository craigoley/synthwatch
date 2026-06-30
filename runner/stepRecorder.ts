// StepRecorder — funnel telemetry for browser flows.
//
// A flow is authored with idiomatic Playwright ergonomics (see defineFlow in
// checks/index.ts): `page` is in scope and each step looks like Playwright's
// test.step():
//
//     await step('open homepage', async () => {
//       await page.goto(baseUrl);          // paste codegen here verbatim
//     });
//
// step() times the body, writes a `run_steps` row (pass / fail / error), and on
// failure records the row, remembers the failed step, and RETHROWS so the flow
// stops where it broke — a failed run shows which step died without re-running.
// Actions performed OUTSIDE a step still run but aren't individually recorded, so
// wrap each meaningful action in a step to get funnel telemetry (same model as
// Playwright's optional test.step grouping).
import type { Page } from 'playwright';
import { pool } from './db.js';
import { expect, isExpectationError } from './errors.js';
import { type Redactor, IDENTITY_REDACTOR } from './redact.js';

/**
 * What a flow author receives. `page` is the live Playwright Page (in scope, so
 * codegen pastes verbatim); `step` records the funnel; `baseUrl` is the check's
 * target_url; `expect(cond, msg)` signals a clean assertion failure (=> 'fail').
 */
export interface FlowContext {
  page: Page;
  baseUrl: string;
  step: <T>(name: string, body: () => Promise<T>) => Promise<T>;
  /** Assert a flow expectation; throws (=> 'fail') if the condition is falsy.
   *  Typed as a plain fn (not an `asserts` guard) so it can be called via the
   *  destructured context without TS2775; runtime behaviour is identical. */
  expect: (condition: unknown, message: string) => void;
}

/** One recorded funnel step. The persisted shape of a run_steps row. */
export interface RecordedStep {
  runId: number;
  index: number;
  name: string;
  status: 'pass' | 'fail' | 'error';
  durationMs: number;
  errorMessage: string | null;
}

/** Where a TERMINAL recorded step goes. Default finalizes the run_steps row; tests inject an in-memory sink. */
export type StepSink = (step: RecordedStep) => Promise<void>;

/** Marks a step 'running' the moment it starts (one row per step). Default writes run_steps; tests inject a no-op. */
export type RunningSink = (runId: number, index: number, name: string) => Promise<void>;

/** Production running-marker: INSERT a 'running' run_steps row (duration 0; started_at=now() dates the step). */
const poolRunningSink: RunningSink = (runId, index, name) =>
  pool
    .query(
      `INSERT INTO run_steps (run_id, step_index, name, status, duration_ms)
       VALUES ($1, $2, $3, 'running', 0)`,
      [runId, index, name],
    )
    .then(() => undefined);

/** Production terminal sink: FINALIZE the step's row in place (running -> pass/fail/error + real duration).
 *  Falls back to an INSERT if the 'running' marker never landed (its write was non-fatally swallowed), so a
 *  step is recorded exactly once either way. */
const poolSink: StepSink = async (s) => {
  const { rowCount } = await pool.query(
    `UPDATE run_steps SET status = $3, duration_ms = $4, error_message = $5
      WHERE run_id = $1 AND step_index = $2`,
    [s.runId, s.index, s.status, s.durationMs, s.errorMessage],
  );
  if (!rowCount) {
    await pool.query(
      `INSERT INTO run_steps (run_id, step_index, name, status, duration_ms, error_message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [s.runId, s.index, s.name, s.status, s.durationMs, s.errorMessage],
    );
  }
};

export class StepRecorder {
  private stepIndex = 0;

  /** Name of the step that threw, or null if the flow completed. */
  public failedStep: string | null = null;

  constructor(
    private readonly runId: number,
    private readonly page: Page,
    /** The check's target_url, exposed to flows for navigation. */
    public readonly baseUrl: string,
    /** Sink for TERMINAL recorded steps. Defaults to the run_steps finalize; tests override it. */
    private readonly sink: StepSink = poolSink,
    /** Sink that marks a step 'running' on start. Defaults to the run_steps INSERT; tests pass a no-op. */
    private readonly markRunningSink: RunningSink = poolRunningSink,
    /** B10: the monitor's redactor — SCRUBS sensitive VALUES out of the PERSISTED per-step error_message so a
     *  Playwright error echoing a Bearer/JWT/token never lands in run_steps (which the RCA AI also reads via
     *  the funnel) while KEEPING the diagnostic text. IDENTITY_REDACTOR (non-sensitive) → unchanged. The
     *  thrown error is unchanged (flow control / classification). */
    private readonly redact: Redactor = IDENTITY_REDACTOR,
  ) {}

  /**
   * Run one instrumented step. The body uses `page` from its closure (idiomatic
   * Playwright); the step is marked 'running' as it starts (live progress), timed,
   * finalized in run_steps to pass/fail/error, and on error the failure is recorded
   * and rethrown (the flow must not continue past a break).
   */
  async step<T>(name: string, body: () => Promise<T>): Promise<T> {
    const index = this.stepIndex++;
    const start = Date.now();
    // Mark 'running' so the live checklist shows ⟳ on the in-flight step. NON-FATAL: a failed marker just
    // means no transient ⟳ (the terminal write still lands via the INSERT fallback) — never break the run.
    try {
      await this.markRunningSink(this.runId, index, name);
    } catch (err) {
      console.warn(`[steps] run ${this.runId} step ${index} running-marker skipped (non-fatal):`, err);
    }
    try {
      const result = await body();
      await this.record(index, name, 'pass', Date.now() - start, null);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A thrown ExpectationError is a clean assertion miss ('fail'); anything
      // else (Playwright timeout, navigation crash) is an exception ('error').
      const status = isExpectationError(err) ? 'fail' : 'error';
      // B10: SCRUB sensitive values from the per-step message (the raw error can echo a Bearer/JWT/token)
      // while KEEPING the diagnostic text; the step NAME (author-controlled) is kept too. Non-sensitive →
      // identity (unchanged).
      const persisted = this.redact(message);
      await this.record(index, name, status, Date.now() - start, persisted);
      this.failedStep = name;
      throw err;
    }
  }

  /** The context handed to a flow body (see defineFlow). */
  context(): FlowContext {
    return {
      page: this.page,
      baseUrl: this.baseUrl,
      step: this.step.bind(this),
      expect,
    };
  }

  private async record(
    index: number,
    name: string,
    status: 'pass' | 'fail' | 'error',
    durationMs: number,
    errorMessage: string | null,
  ): Promise<void> {
    await this.sink({ runId: this.runId, index, name, status, durationMs, errorMessage });
  }
}
