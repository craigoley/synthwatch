-- 0095 — incidents.resolution_reason: distinguish an operator-intervention close from a genuine recovery.
--
-- THE PROBLEM. An incident closes ONLY when a run produces a cross-location recovery verdict
-- (runner/evaluate.ts). A STOPPED monitor never runs, so its open incident is stranded forever — nothing
-- can resolve it (paused enabled=false, archived archived_at, or git-removed which soft-disables to
-- enabled=false). The runner now reconciles these on its tick (runner/staleIncidents.ts), but a plain
-- `status='resolved'` would be a lie in two ways: it deflates MTTR (a ≈0-duration incident dragged into the
-- mean/median) and leaves the timeline incoherent (resolved, red final run, no green recovery, nothing
-- explaining it). This column carries WHY it closed so every consumer can tell the two apart.
--
-- ★ NULL MEANS GENUINE RECOVERY. Additive + nullable + NO backfill here: all 35 existing resolved rows keep
--   resolution_reason NULL and stay correct — they WERE genuine recoveries. Only the new stopped-monitor
--   path stamps a non-null value. The one-time close of the 2 already-stranded rows is a SEPARATE
--   operator-gated script (db/scripts/…), NOT this migration — a migration must not mutate incident state.
--
-- ★ THE MTTR CONTRACT (for the paired api PR): /reports/mttr must exclude non-recovery closures, i.e. add
--   `AND i.resolution_reason IS NULL` to its duration query (ReportsFunctions.cs). Filtering on IS NULL
--   rather than the specific values keeps the api decoupled from this value set.
--
-- ★ SHARED TABLE. synthwatch-api maps `incidents`, so this REDS its schema-parity gate until the api's
--   tests/SynthWatch.Api.Tests/fixtures/schema.sql carries this column + CHECK VERBATIM (the paired api PR).
--   Runner-first, by design — see db/migrations/README.md.
--
-- Idempotent (IF NOT EXISTS): db/migrate.sh replays every migration on top of schema.sql, which also carries
-- this column for fresh installs. No index → no CONCURRENTLY concern.
ALTER TABLE incidents
  ADD COLUMN IF NOT EXISTS resolution_reason TEXT
    CONSTRAINT incidents_resolution_reason_chk
    CHECK (resolution_reason IS NULL OR resolution_reason IN ('monitor_paused', 'monitor_archived', 'monitor_removed'));

COMMENT ON COLUMN incidents.resolution_reason IS
  'WHY the incident closed. NULL = a genuine cross-location recovery run (the default; all pre-0095 rows). '
  'Non-null = closed by the stopped-monitor reconcile because the check can no longer run: monitor_paused '
  '(enabled=false), monitor_archived (archived_at set), monitor_removed (git-removed → soft-disabled). '
  'resolved_run_id is NULL for these (no run caused the close). /reports/mttr excludes non-null reasons.';
