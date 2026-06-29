-- Migration 0048 — runs.retry_count: how many attempts a run took to reach its verdict.
--
-- Makes "passes-only-on-retry" visible. With Option B fast-retry (#133) + retry-skip-when-already-
-- failing (#136), a monitor can pass on attempt 2/3 EVERY run — degrading, yet never opening an
-- incident (it ultimately passes). Splunk/Datadog expose attempt-count as a dimension; this is that.
--
--   retry_count = number of execute() attempts to the final status (1 = first try; 2 = settled on the
--   2nd; = maxAttempts when retries are exhausted). Two cases worth querying:
--     (a) status=pass AND retry_count>1  → DEGRADING-BUT-GREEN (the silent case)
--     (b) status IN (fail,error) AND retry_count=retries+1 → confirmed down after exhausting retries
--
-- NULLABLE, no default → historical rows stay NULL = "unknown (pre-telemetry)", which is honest; a
-- DEFAULT 1 would falsely claim every old run passed first try. Additive + idempotent. New installs
-- converge from db/schema.sql.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0048_run_retry_count.sql

BEGIN;

ALTER TABLE runs ADD COLUMN IF NOT EXISTS retry_count INTEGER;

COMMIT;
