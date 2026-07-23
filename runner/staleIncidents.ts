// Close incidents STRANDED on a stopped monitor.
//
// THE STRAND. An incident resolves ONLY when a run produces a cross-location recovery verdict
// (evaluate.ts). A monitor that has STOPPED RUNNING never produces one, so its open incident sits `open`
// forever — nobody is paging on it (it's stopped), but every open-incident rollup keeps counting it.
//
// ★ "STOPPED RUNNING" IS THE NEGATION OF THE DUE-LOOP PREDICATE, not a hand-listed set of columns. The
//   due-loop (index.ts findDueChecks) runs a check WHERE `c.enabled AND c.archived_at IS NULL`. So a check
//   is stopped iff `NOT (c.enabled AND c.archived_at IS NULL)` — i.e. paused (enabled=false) OR archived
//   (archived_at set). Git-removal is NOT a third axis: reconcile SOFT-DISABLES a removed check
//   (reconcile.ts → `UPDATE checks SET enabled=false`), so removed ⊂ paused. Deriving the predicate from
//   the due-loop rather than re-listing columns means the two can never drift: if the due-loop's gate
//   changes, this must change with it, and STOPPED_CHECK_PREDICATE is where that link is documented.
//
// ★ NON-RECOVERY CLOSURE. These are stamped resolution_reason (0095) so MTTR and the timeline can tell them
//   from a genuine recovery, and resolved_run_id stays NULL (no run caused the close — the schema permits
//   it; pre-existing rows already have NULL resolved_run_ids). This module NEVER calls dispatchAlerts, so
//   no "recovered" page fires — suppression by construction, not by a maintenance-window-style guard. A
//   still-broken monitor must never tell anyone it recovered.
import { pool } from './db.js';

// The exact negation of index.ts's findDueChecks gate (`c.enabled AND c.archived_at IS NULL`). Exported so
// the integration test drives THIS string, and so a reader can diff it against the due-loop by eye.
export const STOPPED_CHECK_PREDICATE = 'NOT (c.enabled AND c.archived_at IS NULL)';

// Precedence in the CASE is most-terminal-first: a git-removed check (on the 90d purge clock) reads as
// 'monitor_removed' even though it is also enabled=false; an archived check as 'monitor_archived'; a plain
// paused check as 'monitor_paused'. Every branch is reachable only because the row already matched the
// predicate above, so the ELSE is genuinely "paused, not archived, not removed".
export const CLOSE_STRANDED_INCIDENTS_SQL = `
  UPDATE incidents i
     SET status = 'resolved',
         resolved_at = now(),
         resolution_reason = CASE
           WHEN c.removed_at  IS NOT NULL THEN 'monitor_removed'
           WHEN c.archived_at IS NOT NULL THEN 'monitor_archived'
           ELSE 'monitor_paused'
         END
    FROM checks c
   WHERE i.check_id = c.id
     AND i.status = 'open'
     AND ${STOPPED_CHECK_PREDICATE}
  RETURNING i.id, i.check_id, i.resolution_reason
`;

/**
 * Resolve every open incident whose check can no longer run. Returns the number closed. Best-effort and
 * non-fatal at the call site (like reapStaleRunning) — a failure here must never break the tick.
 */
export async function closeStrandedIncidents(): Promise<number> {
  const { rows } = await pool.query<{ id: number; check_id: number; resolution_reason: string }>(
    CLOSE_STRANDED_INCIDENTS_SQL,
  );
  if (rows.length > 0) {
    // One line per close so the reason is auditable in ACA logs — this is the runner's half of the trail
    // (there is no notification, by design).
    for (const r of rows) {
      console.log(
        `[stale-incidents] closed incident ${r.id} on check ${r.check_id} — ${r.resolution_reason} (no run; not paged)`,
      );
    }
  }
  return rows.length;
}
