-- 0083_countable_run_explicit_symmetric.sql
--
-- Two corrections to countable_run (0081) — same view, one migration, because they are one contract:
--
-- ① SYMMETRIC confirmation exclusion. 0081 excluded only a DOWN confirmation and KEPT a PASSING one as an
--    "up". That is asymmetric in the FLATTERING direction: on every transient we took the good re-sample and
--    discarded the bad, inflating availability by exactly one up per transient. A confirmation is a RE-CHECK of
--    a sample already in the window — neither a new up nor a new down. It is a transient, which flake_status
--    (deliberately NOT a countable_run consumer — a flap IS a superseded run) measures. FIX: exclude ALL
--    confirmations — `confirmation_of_run_id IS NULL`.
--    Live 90d impact (measured before merge, so a material drop would surface): worst single check is 355
--    (Wegmans authenticated pickup) down-only 95.95% → symmetric 95.71% (−0.24pt); fleet aggregate
--    93.021% → 93.020% (−0.001pt). Passing confirmations are rare (9 fleet-wide over 90d), so the correction
--    is principled AND numerically negligible. confirmationRetry #7/#8 were updated to encode this decision.
--
-- ② EXPLICIT column list, not SELECT *. SELECT * pinned every runs column into the view's contract — including
--    retry_count, which no consumer reads yet whose drop the view then BLOCKED. That froze synthwatch-api's
--    fixture-vs-migrations schema-parity gate ("cannot drop column retry_count of table runs because other
--    objects depend on it"), which in turn froze the whole api merge queue. A view on SELECT * is a schema
--    contract nobody agreed to. FIX: list only what the five consumers read —
--      id, check_id, status, started_at, location, duration_ms
--    (sla_availability/slo_status: check_id,started_at,status · aggregateVerdict + countConsecutiveDown:
--     +location · computeRollupForDay: +id,duration_ms). Adding a column later is a deliberate act — the point.
--
-- CREATE OR REPLACE VIEW cannot drop/rename a view's columns (SELECT * → explicit is a column drop), so this is
-- DROP VIEW + CREATE, not CREATE OR REPLACE. The string-body sla_availability/slo_status functions carry no
-- pg_depend on the view (they reference it by name, resolved at call time), so DROP VIEW is not blocked. The
-- GRANT is re-applied (DROP removes it). Idempotent: DROP … IF EXISTS + a guarded GRANT. 0081 was amended in
-- lockstep to DROP-first so the schema.sql(explicit)-then-replay-all-migrations rebuild converges here.

BEGIN;

DROP VIEW IF EXISTS countable_run;

CREATE VIEW countable_run AS
    SELECT id, check_id, status, started_at, location, duration_ms
      FROM runs
     WHERE status NOT IN ('running', 'infra_error')
       AND superseded_by_run_id IS NULL
       -- ★ A confirmation run is a SECOND SAMPLE of a tick we ALREADY sampled — not a new observation.
       -- The scheduled probe at 10:00 FAILED. That is the observation on the cadence. We then took another
       -- sample, OFF-CADENCE and TRIGGERED BY THE FAILURE, and it passed.
       -- ★ Counting that pass as "up" means: when a scheduled probe fails, re-roll, and report the good
       -- result. We ONLY ever re-roll on a bad result — a passing scheduled run never gets a second sample.
       -- So the extra samples are drawn EXCLUSIVELY from the failure population and ONLY the good outcomes
       -- survive. That is not modeling. It is a bias with a mechanism.
       -- ★★ THE PROOF: a service that fails 50% of scheduled runs, whose confirmations all pass, reports
       -- 100% AVAILABILITY under the asymmetric rule — every failure is superseded (excluded) AND replaced
       -- by a passing confirmation (counted). The denominator never sees them.
       -- ★ The transient is NOT lost information — it is recorded in flake_status, with its own
       -- classification, budget, and directed task. That is why the flake budget is a SEPARATE AXIS.
       -- Excluding both says "this tick was a transient, counted over there." Counting the recovery as "up"
       -- says "it was fine" — which it demonstrably was not.
       -- ★ ACCEPTED COST: a self-healed blip contributes ZERO to availability, thinning the denominator.
       -- A thin denominator is VISIBLE (the sample count is right there). An inflated numerator is INVISIBLE,
       -- and it inflates most on exactly the monitors you trust least. Take the metric that admits it
       -- doesn't know.
       AND confirmation_of_run_id IS NULL
       AND NOT sandbox;

COMMENT ON VIEW countable_run IS
    'Canonical "countable scheduled observation": a real-result, non-superseded, non-confirmation (symmetric — a confirmation is a re-check, neither up nor down), non-sandbox run. Explicit column list (id, check_id, status, started_at, location, duration_ms) — the five consumers'' union, NOT SELECT *. The single source for availability / SLO / rollup / incident-verdict counting. flake_status deliberately does NOT use it (a flap is a superseded run). See 0081, 0083.';

-- The api role calls sla_availability()/slo_status() (SECURITY INVOKER) which select from this view, so it must
-- read it. DROP removed the 0081 grant; re-apply, guarded so a fresh DB with no api role still applies cleanly.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synthwatch-api') THEN
    EXECUTE 'GRANT SELECT ON countable_run TO "synthwatch-api"';
  END IF;
END $$;

COMMIT;
