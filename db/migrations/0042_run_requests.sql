-- Migration 0042 — run_requests: on-demand "Run now" queue (mirror of 0026_test_send_requests).
--
-- A dashboard "Run now" (or any caller) enqueues a row here; the API also fires the runner Job
-- immediately (ARM jobs/start — the same IRunnerJobTrigger as test-sends), so the run happens NOW
-- instead of at the next */5 cron tick (the cron drain is the fallback). The runner drains pending
-- rows at tick start, force-runs the check (advancing last_run_at so the due-loop skips it), and
-- writes results through the SAME runOne path as a scheduled run — so trace / signals / verdict /
-- RCA all flow identically. An on-demand run is just a run.
--
-- Idempotency: at most ONE pending request per check (the partial unique index) — rapid re-clicks
-- coalesce; the API returns the existing pending request. The runner claims atomically (one replica
-- per request) and is keyed by check (location-agnostic; v1 runs at the triggered runner's location).
--
-- New installs converge from db/schema.sql.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0042_run_requests.sql  (IDEMPOTENT).

BEGIN;

CREATE TABLE IF NOT EXISTS run_requests (
    id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    check_id     bigint      NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
    status       text        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'done')),
    requested_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
);

-- The runner's drain claims by status='pending'; a partial index keeps that scan cheap.
CREATE INDEX IF NOT EXISTS run_requests_pending_idx
    ON run_requests (requested_at) WHERE status = 'pending';

-- ★ Idempotency: at most one PENDING request per check — re-clicks coalesce (the API returns the
-- existing one on the unique violation). Done rows don't participate (partial), so history accrues.
CREATE UNIQUE INDEX IF NOT EXISTS run_requests_one_pending_per_check
    ON run_requests (check_id) WHERE status = 'pending';

-- The API MI INSERTs requests + SELECTs to coalesce; the runner (owner: synthadmin) UPDATEs to 'done'.
-- Least-privilege (per 0041): the API gets SELECT + INSERT only — NOT UPDATE/DELETE.
DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synthwatch-api') THEN
        GRANT SELECT, INSERT ON run_requests TO "synthwatch-api";
    END IF;
END
$grant$;

COMMIT;
