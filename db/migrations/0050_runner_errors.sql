-- Migration 0050 — runner_errors: a QUERYABLE sink for the runner's top-level/uncaught exceptions.
--
-- Meta-lesson A made permanent. The dismiss-500 cost ~5 PRs because the real exception was swallowed +
-- invisible: the runner's only top-level handler was `console.error('[runner] fatal:', err)` → ACA
-- STDOUT, which #139 proved is uncapturable (OTel off) — so a fatal manufactured a false "no error"
-- fact. This table is the queryable channel: the global handler (runnerErrors.ts) writes one row per
-- uncaught/top-level failure with a per-invocation correlation id, so the NEXT silent failure is a
-- one-grep diagnosis (`SELECT * FROM runner_errors ORDER BY occurred_at DESC`) not a 5-PR investigation.
--
-- Visibility-only: nothing here changes which errors are fatal — the handler logs+persists on the
-- ALREADY-fatal path, then exits as before. Additive; new installs converge from db/schema.sql.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0050_runner_errors.sql

BEGIN;

CREATE TABLE IF NOT EXISTS runner_errors (
    id            bigserial   PRIMARY KEY,
    -- Per-process correlation id (one ACA job invocation). Ties this row to the stdout log lines, which
    -- carry the same id — so DB + ACA logs reconcile even though stdout itself isn't queryable.
    invocation_id text        NOT NULL,
    occurred_at   timestamptz NOT NULL DEFAULT now(),
    -- Where it was caught: 'main' (top-level promise rejection) | 'uncaughtException' | 'unhandledRejection'.
    phase         text        NOT NULL,
    -- Best-effort context: the check/run in flight when it blew up (NULL if outside a run — setup/claim).
    check_id      bigint,
    run_id        bigint,
    message       text        NOT NULL,
    stack         text
);

-- The one-grep query is "newest first"; index it.
CREATE INDEX IF NOT EXISTS runner_errors_occurred_at_idx ON runner_errors (occurred_at DESC);

COMMIT;
