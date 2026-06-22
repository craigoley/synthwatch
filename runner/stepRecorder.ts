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

export class StepRecorder {
  private stepIndex = 0;

  /** Name of the step that threw, or null if the flow completed. */
  public failedStep: string | null = null;

  constructor(
    private readonly runId: number,
    private readonly page: Page,
    /** The check's target_url, exposed to flows for navigation. */
    public readonly baseUrl: string,
  ) {}

  /**
   * Run one instrumented step. The body uses `page` from its closure (idiomatic
   * Playwright); the step is timed, persisted to run_steps, and on error the
   * failure is recorded and rethrown (the flow must not continue past a break).
   */
  async step<T>(name: string, body: () => Promise<T>): Promise<T> {
    const index = this.stepIndex++;
    const start = Date.now();
    try {
      const result = await body();
      await this.record(index, name, 'pass', Date.now() - start, null);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A thrown ExpectationError is a clean assertion miss ('fail'); anything
      // else (Playwright timeout, navigation crash) is an exception ('error').
      const status = isExpectationError(err) ? 'fail' : 'error';
      await this.record(index, name, status, Date.now() - start, message);
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
    await pool.query(
      `INSERT INTO run_steps (run_id, step_index, name, status, duration_ms, error_message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [this.runId, index, name, status, durationMs, errorMessage],
    );
  }
}
