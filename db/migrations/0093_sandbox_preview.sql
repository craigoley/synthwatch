-- 0093_sandbox_preview.sql
--
-- sandbox_preview — the LIFECYCLE + AUDIT record for a spec preview-run (POST /api/preview). One row per
-- preview: who ran it, WHAT (the spec sha256 — NOT the body), when, and its status.
--
-- ★ WRITTEN BY THE API, NOT THE SANDBOX JOB. The synthwatch-sandbox ACA job is DB-less by design (part of its
--   low-privilege shape — no database-url secret, no DB grant; see infra/main.bicep + runner/sandbox/*). So the
--   API owns this table's whole lifecycle: it INSERTs 'running' before it starts the job, and UPDATEs to
--   'done'/'failed'/'timeout' when it polls the sandbox-artifacts blob. The sandbox never touches Postgres.
--
-- ★ RETENTION / PII: we store the spec SHA-256, NOT the spec body. The body is passed to the sandbox once, via
--   an ephemeral env override on jobs/start (SW_SANDBOX_SPEC_B64), and never persisted here; the trace output
--   lives in the TTL'd sandbox-artifacts blob. So a preview leaves only a hash + metadata in the DB — enough to
--   audit "who ran what, when" and to dedup, without retaining arbitrary uploaded source. (The daily retention
--   job can age these rows out later; not wired in this migration — the table is tiny.)
--
-- Apply: psql "$DATABASE_URL" -f db/migrations/0093_sandbox_preview.sql

BEGIN;

CREATE TABLE IF NOT EXISTS sandbox_preview (
    id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Opaque result token: the API generates it, returns it to the caller, names the sandbox-artifacts blob
    -- with it, and GET /api/preview/{token} polls by it. Not guessable (a random 128-bit hex/uuid from the API).
    token         TEXT        NOT NULL UNIQUE,
    -- WHO — the authenticated caller (IAuthPrincipal.Email). The audit actor + the per-user rate-limit key.
    actor_email   TEXT        NOT NULL,
    actor_ip      TEXT,
    -- WHAT — the spec's SHA-256 (hex). The body is NOT stored (see the retention note above).
    spec_sha256   TEXT        NOT NULL,
    -- The non-prod / public target the preview navigated to (echoed for the audit trail).
    target_url    TEXT        NOT NULL,
    status        TEXT        NOT NULL DEFAULT 'running'
                              CHECK (status IN ('running', 'done', 'failed', 'timeout')),
    requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at  TIMESTAMPTZ,
    exit_code     INTEGER,
    error         TEXT
);

-- Per-user rate limit: "how many previews did this actor run in the last window" → (actor_email, requested_at).
CREATE INDEX IF NOT EXISTS sandbox_preview_actor_idx ON sandbox_preview (actor_email, requested_at DESC);
-- Concurrency cap: "how many are in flight right now" → count WHERE status='running' (partial index keeps it cheap).
CREATE INDEX IF NOT EXISTS sandbox_preview_running_idx ON sandbox_preview (requested_at) WHERE status = 'running';

-- The API MI owns the whole lifecycle (INSERT the request, UPDATE on completion, SELECT for rate/concurrency +
-- the GET poll). NO DELETE (retention is a separate job). The sandbox job gets NOTHING — it has no DB role.
-- Guarded so the migration is safe on a fresh DB / the Testcontainers snapshot with no synthwatch-api role.
DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synthwatch-api') THEN
        GRANT SELECT, INSERT, UPDATE ON sandbox_preview TO "synthwatch-api";
    END IF;
END
$grant$;

COMMIT;
