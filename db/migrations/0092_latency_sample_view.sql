-- 0092_latency_sample_view.sql
--
-- latency_sample — the canonical "real measured latency sample" for percentile reporting. A pass/warn,
-- NON-sandbox run. The sibling of countable_run, but a DELIBERATELY DIFFERENT predicate:
--
--   ★ KEEPS confirmations. latency_sample counts every real measured duration INCLUDING confirmation
--     re-checks. Unlike countable_run it does NOT drop confirmations, because the re-roll bias
--     countable_run exists to correct is an AVAILABILITY problem, not a latency one: excluding a passing
--     confirmation from availability removes a flattering re-sample of a failed tick; but a passing
--     confirmation's DURATION is a real measurement of how fast the service actually responded, and a tick
--     that failed-then-recovered would otherwise contribute ZERO latency samples. There is no asymmetric
--     bias to correct — a confirmation's latency is just its latency. (If a future audit re-flags this as
--     "raw-runs drift" vs countable_run: it is not. Same class of object, different question. Do NOT unify
--     it into countable_run — that would silently discard real successful latency samples.)
--   ★ EXCLUDES sandbox. A sandbox run is a manual test-send, not a scheduled observation; letting a test
--     at an outlier latency move a reported p95 is the "test traffic shouldn't move real percentiles" bug.
--   ★ status IN ('pass','warn') — you only measure latency of a run that produced a duration; a fail/error
--     has no meaningful duration_ms. (This also makes the superseded axis moot: we only re-check FAILURES,
--     so a pass/warn run is essentially never superseded — no explicit superseded filter is needed.)
--   ★ Maintenance-window exclusion stays PER-CONSUMER, not baked into the view: it is contextual
--     (run.started_at vs each window's [starts_at, ends_at)) — exactly as countable_run leaves it out.
--
-- EXPLICIT column list (the 0083 lesson — a view on SELECT * freezes the runs schema-parity contract). List
-- only what the two consumers read: narrative.ts latency percentiles (duration_ms; started_at + check_id for
-- the window/scope filter) and synthwatch-api /reports/performance (id, check_id, status, duration_ms;
-- started_at for the window). Adding a column later is a deliberate act.
--
-- Apply: psql "$DATABASE_URL" -f db/migrations/0092_latency_sample_view.sql   (IDEMPOTENT: CREATE OR REPLACE)

BEGIN;

CREATE OR REPLACE VIEW latency_sample AS
    SELECT id, check_id, status, started_at, duration_ms
      FROM runs
     WHERE status IN ('pass', 'warn')
       AND NOT sandbox;

-- Grant the API MI SELECT (mirrors countable_run @ 0081/0083): /reports/performance reads it. Guarded so the
-- migration is safe on a fresh DB / the Testcontainers snapshot that has no synthwatch-api role.
DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synthwatch-api') THEN
        EXECUTE 'GRANT SELECT ON latency_sample TO "synthwatch-api"';
    END IF;
END
$grant$;

COMMIT;
