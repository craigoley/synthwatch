// Incident evaluation: turn a stream of pass/fail runs into debounced incidents.
//
// Debounce rule: open an incident only after `failure_threshold` CONSECUTIVE
// failures, so a single blip doesn't page anyone. Resolve on the FIRST pass.
// Because each check is claimed by exactly one replica per tick (see index.ts),
// there is no cross-replica race here — the DB's partial unique index
// (one_open_incident_per_check) is a belt-and-braces backstop.
import { pool, type Check, type RunRecord } from './db.js';
import { dispatchAlerts } from './alerts.js';

interface OpenIncident {
  id: number;
}

export async function evaluate(check: Check, run: RunRecord): Promise<void> {
  const open = await getOpenIncident(check.id);

  if (run.status === 'pass') {
    if (open) {
      await pool.query(
        `UPDATE incidents
            SET status = 'resolved', resolved_at = now(), resolved_run_id = $2
          WHERE id = $1`,
        [open.id, run.id],
      );
      await dispatchAlerts({
        checkName: check.name,
        severity: check.severity,
        status: 'resolved',
        summary: `Check "${check.name}" recovered.`,
        runId: run.id,
      });
    }
    return;
  }

  // run failed -> count consecutive trailing failures (most recent first).
  const consecutive = await countConsecutiveFailures(check.id, check.failure_threshold);
  if (consecutive < check.failure_threshold) {
    return; // still within the debounce window
  }

  if (open) {
    // Already paged; just keep the running count fresh.
    await pool.query(
      `UPDATE incidents SET consecutive_failures = $2 WHERE id = $1`,
      [open.id, consecutive],
    );
    return;
  }

  const summary =
    `Check "${check.name}" failed ${consecutive} consecutive times` +
    (run.failed_step ? ` (died at step: ${run.failed_step})` : '') + '.';

  await pool.query(
    `INSERT INTO incidents (check_id, status, severity, opened_run_id,
                            consecutive_failures, summary)
     VALUES ($1, 'open', $2, $3, $4, $5)`,
    [check.id, check.severity, run.id, consecutive, summary],
  );

  await dispatchAlerts({
    checkName: check.name,
    severity: check.severity,
    status: 'open',
    summary,
    runId: run.id,
    failedStep: run.failed_step,
    screenshotUrl: run.screenshot_url,
  });
}

async function getOpenIncident(checkId: number): Promise<OpenIncident | null> {
  const { rows } = await pool.query<OpenIncident>(
    `SELECT id FROM incidents WHERE check_id = $1 AND status = 'open' LIMIT 1`,
    [checkId],
  );
  return rows[0] ?? null;
}

async function countConsecutiveFailures(checkId: number, threshold: number): Promise<number> {
  // We only need to look back as far as the threshold to make the open/skip
  // decision: if the most recent `threshold` runs are all failures, that's enough.
  const { rows } = await pool.query<{ status: 'pass' | 'fail' }>(
    `SELECT status FROM runs
      WHERE check_id = $1
      ORDER BY started_at DESC
      LIMIT $2`,
    [checkId, threshold],
  );
  let count = 0;
  for (const row of rows) {
    if (row.status === 'fail') count++;
    else break;
  }
  return count;
}
