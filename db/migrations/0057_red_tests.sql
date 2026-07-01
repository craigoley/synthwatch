-- Migration 0057 — red_tests: §D1 v2 Signal 1 capture (the red-test HARNESS's persisted proof).
--
-- A red-test = a DELIBERATE per-monitor proof that the monitor's assertion goes RED on a KNOWN-BAD input (see
-- runner/redTest.ts — the harness from #176). ★ THE HONESTY GUARDRAIL: a row is written ONLY when the harness
-- CONFIRMED red (the monitor's own assertion fired) — outcome is CHECK-constrained to 'red' so an INCONCLUSIVE
-- run (failed for an UNRELATED reason) or a NOT-RED run (weak assertion) can NEVER be persisted here. captured
-- is thus NEVER inferred from a real fail run or RCA (already represented — incidents taxonomy, proven-live
-- chip; reusing them is the unbacked confidence D1 kills). One row per confirmed red-test (history kept).
--
-- The API READS this (GET /reports/trust flips redTest.captured=true + testedAt/method); the runner (synthadmin
-- owner) WRITES it — API needs SELECT only. Reconcile-safe by construction: a separate table, and reconcile only
-- writes `checks` (no GIT_AUTHORITATIVE_COLUMNS change).
--
-- Additive; new installs converge from db/schema.sql. Apply: psql "$DATABASE_URL" -f db/migrations/0057_red_tests.sql

BEGIN;

CREATE TABLE IF NOT EXISTS red_tests (
    id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    check_id   bigint      NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
    tested_at  timestamptz NOT NULL DEFAULT now(),
    -- How the proof was obtained. CHECK-constrained (a real integrity guard; cheap): an executed harness proof
    -- vs an evidenced human attestation. The two are rendered DISTINCTLY on the scorecard (executed = automated,
    -- attested = human — the honesty distinction).
    method     text        NOT NULL CHECK (method IN ('executed-red-fixture', 'attested-manual')),
    -- Only 'red' is ever persisted (the harness never INSERTs an inconclusive/not-red result). CHECK-constrained
    -- so the honesty guardrail is enforced at the SCHEMA, not just the write path.
    outcome    text        NOT NULL CHECK (outcome IN ('red')),
    -- The fault injected + the observed verdict + evidence ref (attested), for the audit trail.
    detail     jsonb
);

-- The read is "the latest confirmed red-test per check" → index (check_id, tested_at DESC).
CREATE INDEX IF NOT EXISTS red_tests_check_time_idx ON red_tests (check_id, tested_at DESC);

-- The API reads red_tests for the trust scorecard (GET /reports/trust). Guarded so the migration is safe on a
-- fresh DB / the Testcontainers snapshot with no synthwatch-api role. (The runner owns the table → writes.)
DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synthwatch-api') THEN
        GRANT SELECT ON red_tests TO "synthwatch-api";
    END IF;
END
$grant$;

COMMIT;
