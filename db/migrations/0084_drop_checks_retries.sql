-- 0084_drop_checks_retries.sql
--
-- Drop checks.retries — the in-run FAST-RETRY budget (0021 + 0045). It is DEAD CODE:
--   • 0077 made every failure confirm by a SEPARATE re-run, and confirmByRerunEligible was extended to
--     EVERY kind (post-#291), so effectiveRetries() returned 0 for every run — the in-run loop never took a
--     second attempt (ZERO runs with retry_count > 1 after 2026-07-13 12:25; the one 12:21 run was an
--     in-flight ACA execution on the pre-deploy image, not a bypass).
--   • The runner reads of check.retries (effectiveRetries + runWithRetry) are removed in this same PR.
--   • The api NEVER read checks.retries (no DTO, not in the DbContext) — confirmed before this drop.
--
-- ★ runs.retry_count STAYS. The api trust report's retryRate (TrustReportProjection.RetryRate) reads it, so
--   it is NOT dropped here — it is now structurally 1 for every run (a single attempt). See the PR body on
--   retiring or re-sourcing that dimension. This migration touches ONLY the checks table.
--
-- The inline `CHECK (retries >= 0)` is a COLUMN constraint (auto-named checks_retries_check), so it is
-- dropped automatically with the column — no separate DROP CONSTRAINT, no CASCADE. countable_run and every
-- other object are untouched (nothing references checks.retries), so the schema.sql-then-replay rebuild needs
-- no DROP-first. Idempotent: DROP COLUMN IF EXISTS.

BEGIN;

ALTER TABLE checks DROP COLUMN IF EXISTS retries;

COMMIT;
