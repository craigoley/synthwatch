// StepRecorder — the structural heart of SynthWatch's funnel telemetry.
//
// Every meaningful action in a browser flow MUST go through `step()`. The
// Playwright Page is held privately and is ONLY handed to the callback inside
// step(), so there is no way to drive the browser without being timed and
// recorded. Each step writes a `run_steps` row (pass or fail) BEFORE control
// returns; on failure it records the row, remembers the failed step name, and
// rethrows so the flow stops exactly where it broke. The result: a failed run
// shows which step it died at without re-running anything.
import type { Page } from 'playwright';
import { pool } from './db.js';

export class StepRecorder {
  private stepIndex = 0;

  /** Name of the step that threw, or null if the flow completed. */
  public failedStep: string | null = null;

  constructor(
    private readonly runId: number,
    // Private: the only path to the page is through step()'s callback.
    private readonly page: Page,
    /** The check's target_url, exposed to flows for navigation. */
    public readonly baseUrl: string,
  ) {}

  /**
   * Run one instrumented step of a flow. The page is provided to the callback;
   * the step is timed, persisted to run_steps, and on error the failure is
   * recorded and rethrown (the flow must not continue past a broken step).
   */
  async step<T>(name: string, fn: (page: Page) => Promise<T>): Promise<T> {
    const index = this.stepIndex++;
    const start = Date.now();
    try {
      const result = await fn(this.page);
      await this.record(index, name, 'pass', Date.now() - start, null);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.record(index, name, 'fail', Date.now() - start, message);
      this.failedStep = name;
      throw err;
    }
  }

  private async record(
    index: number,
    name: string,
    status: 'pass' | 'fail',
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
