// LIVE integration proof of B1 (verdict-survives-crash): the terminal VERDICT is persisted by
// writeProvisionalVerdict BEFORE any trace processing, so a crash/OOM DURING trace processing leaves a
// finalized run (real status + failed_step + duration), NOT a 'running' strand. Runs only when
// DATABASE_URL is set (skipped offline), like the other runner integration tests.
//
// index.ts runs main() on import (house convention), so runOneInner isn't importable — we test the
// extracted finalization seam (writeProvisionalVerdict / enrichRunTrace), the two surfaces the reorder
// introduced. MUST-GO-RED: under the OLD ordering the verdict was written only by the SINGLE terminal
// UPDATE sequenced AFTER trace processing, so a crash during trace work left status='running'. This test
// asserts the verdict lands from the provisional write ALONE (no trace write), and that a later
// enrichment adds the trace without disturbing the verdict.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from './db.js';
import { writeProvisionalVerdict, enrichRunTrace } from './runFinalize.js';

const SKIP = !process.env.DATABASE_URL;

async function makeCheck(name: string): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO checks (name, kind, target_url, flow_name, spec_path, failure_threshold, severity, enabled)
     VALUES ($1, 'browser', 'https://example.test', 'noop', 'monitors/__test__/x.spec.ts', 1, 'critical', false)
     RETURNING id`,
    [name],
  );
  return rows[0].id;
}

async function insertRunningRun(checkId: number): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO runs (check_id, started_at, status, location, sandbox)
     VALUES ($1, now(), 'running', 'default', true) RETURNING id`,
    [checkId],
  );
  return rows[0].id;
}

nodeTest(
  'B1: provisional verdict persists BEFORE trace enrichment — a trace-processing crash leaves the verdict, not a strand',
  { skip: SKIP },
  async () => {
    const checkId = await makeCheck('__b1_provisional_verdict_e2e__');
    try {
      const runId = await insertRunningRun(checkId);

      // ── STAMP THE VERDICT (what runs before trace processing). Model run #936920: a FAILED long run. ──
      await writeProvisionalVerdict(runId, {
        status: 'error',
        durationMs: 531694,
        httpStatus: null,
        errorMessage: '[full-shop-flow] STEP-FAIL return-cart: cart did not render',
        failedStep: 'return-cart',
        certDaysRemaining: null,
        retryCount: 1,
        egressIp: '20.85.72.149',
      });

      // ── SIMULATE A CRASH/OOM DURING TRACE PROCESSING: we simply never reach enrichRunTrace (as if the
      //    process were SIGKILLed here). The row must ALREADY be a finalized 'error' with the real verdict. ──
      {
        const { rows } = await pool.query<{
          status: string; duration_ms: number | null; failed_step: string | null;
          error_message: string | null; trace_url: string | null; finished_at: Date | null;
        }>(
          `SELECT status, duration_ms, failed_step, error_message, trace_url, finished_at FROM runs WHERE id = $1`,
          [runId],
        );
        const r = rows[0];
        assert.equal(r.status, 'error', 'verdict must be terminal (error), not left running, before trace work');
        assert.notEqual(r.status, 'running', 'MUST-GO-RED: the run must NOT strand at running');
        assert.equal(r.duration_ms, 531694, 'duration is part of the verdict, written before the trace');
        assert.equal(r.failed_step, 'return-cart', 'the REAL failed_step survives — not a generic reap');
        assert.match(r.error_message ?? '', /return-cart/, 'the real error survives, not "runner did not finalize"');
        assert.notEqual(r.finished_at, null, 'finished_at is stamped by the verdict write');
        assert.equal(r.trace_url, null, 'no trace yet — a crash here yields finalized-WITHOUT-trace, not a strand');
      }

      // ── HAPPY PATH: trace processing completed → enrich. The verdict must be untouched; trace added. ──
      await enrichRunTrace(runId, {
        traceUrl: 'https://blob.example/traces/run.zip',
        traceSignalsJson: JSON.stringify({ targetHost: 'www.wegmans.com' }),
        screenshotUrl: null,
      });
      {
        const { rows } = await pool.query<{ status: string; failed_step: string | null; trace_url: string | null; trace_signals: unknown }>(
          `SELECT status, failed_step, trace_url, trace_signals FROM runs WHERE id = $1`,
          [runId],
        );
        const r = rows[0];
        assert.equal(r.status, 'error', 'enrichment must NOT disturb the verdict status');
        assert.equal(r.failed_step, 'return-cart', 'enrichment must NOT disturb failed_step');
        assert.equal(r.trace_url, 'https://blob.example/traces/run.zip', 'enrichment adds trace_url');
        assert.notEqual(r.trace_signals, null, 'enrichment adds trace_signals');
      }
    } finally {
      // FK-cascade cleanup: deleting the check removes its runs (runs.check_id ON DELETE CASCADE).
      await pool.query(`DELETE FROM checks WHERE id = $1`, [checkId]);
    }
  },
);
