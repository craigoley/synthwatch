-- Migration 0026 — channel test-sends via the runner's REAL dispatch path.
--
-- A channel "test send" must exercise the SAME path real alerts use (the runner's
-- dispatchAlerts/sendEmail/sendWebhook) — not an API-side replica — or it doesn't prove
-- real delivery. Mechanism: the API writes a PENDING row here + triggers the runner job
-- on-demand (az containerapp job start, NO env override so all secretRefs are preserved);
-- the runner drains pending rows at startup, sends a [TEST] alert through the real path,
-- and marks the row delivered/failed. The request is carried by THIS ROW, not an env var
-- (start --env-vars would require a full container respec and drop the DB/ACS secretRefs).
-- See runner/testSend.ts. Replaces the inert API-direct ACS replica (#70).
--
-- New installs converge from db/schema.sql.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0026_test_send_requests.sql  (IDEMPOTENT).

BEGIN;

CREATE TABLE IF NOT EXISTS test_send_requests (
    id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    channel_id   bigint      NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    -- pending  : written by the API, awaiting the runner
    -- sending  : claimed by a runner (in flight)
    -- delivered: sent through the real path
    -- failed   : not deliverable / send error (see detail)
    status       text        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'sending', 'delivered', 'failed')),
    detail       text,       -- human result/reason (e.g. "sent via email", "no recipients")
    requested_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
);

-- The runner's drain claims by status='pending'; a partial index keeps that cheap.
CREATE INDEX IF NOT EXISTS test_send_requests_pending_idx
    ON test_send_requests (requested_at) WHERE status = 'pending';

-- The API MI writes pending requests + polls their status. The runner connects with the
-- admin role (full privileges) and owns the sending->delivered/failed transition.
DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synthwatch-api') THEN
        GRANT SELECT, INSERT ON test_send_requests TO "synthwatch-api";
    END IF;
END
$grant$;

COMMIT;
