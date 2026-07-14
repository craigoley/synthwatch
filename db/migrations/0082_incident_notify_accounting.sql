-- 0082_incident_notify_accounting.sql
--
-- ★ A FAILED PAGE AND A SUCCESSFUL PAGE LEAVE IDENTICAL DB STATE. The critical page fires at
-- evaluate.ts:295 through dispatchAlerts → Promise.allSettled; a rejected send is caught, logged to the
-- EPHEMERAL container log, returned as {delivered:0}, and the caller persists NOTHING. So a delivery
-- failure is indistinguishable from success once the logs rotate (why it was UNKNOWABLE whether incidents
-- 167/165 paged during the Meals2Go outage). This adds delivery accounting to the incident, for all three
-- incident dispatches (open / resolve / RCA-ready enrichment).
--
-- notify_status: 'sent' (>=1 channel delivered), 'failed' (channels tried, all rejected — also writes a
-- runner_errors row from the caller), 'skipped' (no deliverable channel — a REAL state, must not read as
-- success). notify_attempts increments on every dispatch for the incident; notify_error/notify_attempted_at
-- hold the LATEST attempt. The durable per-failure trail is runner_errors (append-only).
--
-- ★ SHARED TABLE (incidents): synthwatch-api maps it. The api's fixture schema.sql + EF entity must land
-- in lockstep or the schema-parity gate reds. Sequence (in the PR body): api fixture PR green+approved →
-- merge THIS → api deploys the migration → merge the api PR immediately.

BEGIN;

ALTER TABLE incidents
    ADD COLUMN IF NOT EXISTS notify_attempted_at timestamptz,
    ADD COLUMN IF NOT EXISTS notify_status       text,
    ADD COLUMN IF NOT EXISTS notify_error        text,
    ADD COLUMN IF NOT EXISTS notify_attempts     integer NOT NULL DEFAULT 0;

-- Guarded CHECK (idempotent): valid statuses only, NULL until the first dispatch.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'incidents_notify_status_chk') THEN
    ALTER TABLE incidents
      ADD CONSTRAINT incidents_notify_status_chk
      CHECK (notify_status IS NULL OR notify_status IN ('sent', 'failed', 'skipped'));
  END IF;
END $$;

COMMENT ON COLUMN incidents.notify_status IS
    'Delivery outcome of the LATEST alert dispatch for this incident: sent | failed | skipped. NULL before any dispatch. A ''failed'' also writes a runner_errors row (phase alert-dispatch-failed). See runner/evaluate.ts recordIncidentDispatch (0082).';

COMMIT;
