-- 0081_countable_run_view.sql
--
-- ★ ONE canonical definition of "a countable scheduled observation", consumed by every read-side
-- health/verdict path. Before this, the predicate was inlined SIX times with FIVE different
-- definitions — three wrong in production:
--   • sla_availability / slo_status / daily_check_rollup excluded superseded (0077) but NOT
--     confirmation runs → a real outage's [scheduled fail, confirmation fail] counted as TWO down
--     observations, so availability and SLO error-budget burn OVER-counted failures. slo_status was
--     doubly wrong: it also lacked the sandbox exclusion (0070) the others had.
--   • aggregateVerdict / countConsecutiveDown (fixed in #295) excluded superseded + confirmation but
--     NOT sandbox.
--
-- countable_run = the INTRINSIC "this row is a real scheduled observation" predicate. Maintenance-window
-- exclusion stays per-consumer (it is contextual — run.started_at vs each window's range).
--
-- ★ flake_status is DELIBERATELY NOT a consumer: it measures FLAPS, and a flap IS a superseded transient
-- (its numerator selects `superseded_by_run_id IS NOT NULL`). Feeding it countable_run (excl superseded)
-- would zero the numerator and erase its signal. It keeps its own predicate — see schema.sql.
--
-- Idempotent (CREATE OR REPLACE). Numerically LAST so its function bodies win on a schema.sql-then-
-- replay-all-migrations rebuild (an earlier migration re-defines these functions with old bodies; 0081
-- runs after and re-wins). No signature change → no DROP (the #284 rule). Function bodies below are
-- byte-identical to schema.sql EXCEPT the `LEFT JOIN runs r … inline filters` → `LEFT JOIN countable_run r`.

BEGIN;

CREATE OR REPLACE VIEW countable_run AS
    SELECT *
      FROM runs
     WHERE status NOT IN ('running', 'infra_error')
       AND superseded_by_run_id IS NULL
       -- ★ Exclude only a DOWN confirmation run. A fail/error confirmation is a redundant RE-CHECK of the
       -- scheduled failure it confirms (already in the window) → dropping it fixes the outage double-count
       -- (the bug). But a PASSING confirmation is the transient's RECOVERY — the "up" for that tick — and
       -- must be KEPT, else a self-healed blip contributes zero availability, silently reversing the
       -- deliberate rollup behaviour proven by confirmationRetry #7/#8 ("only the passing confirmation counts
       -- as up"). Excluding ALL confirmations erased that distinction — the exact "unification worse than the
       -- duplication" this canonical view was warned against.
       AND NOT (confirmation_of_run_id IS NOT NULL AND status IN ('fail', 'error'))
       AND NOT sandbox;

COMMENT ON VIEW countable_run IS
    'Canonical "countable scheduled observation": a real-result, non-superseded, non-confirmation, non-sandbox run. The single source for availability / SLO / rollup / incident-verdict counting. flake_status deliberately does NOT use it (a flap is a superseded run). See 0081.';

-- The api role calls sla_availability()/slo_status() (SECURITY INVOKER), so it must be able to read the
-- view those functions now select from. Guarded so a fresh DB with no api role still applies cleanly.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synthwatch-api') THEN
    EXECUTE 'GRANT SELECT ON countable_run TO "synthwatch-api"';
  END IF;
END $$;

-- ── sla_availability: JOIN countable_run (now also excludes confirmation runs). Body else byte-identical. ──
CREATE OR REPLACE FUNCTION sla_availability(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
    check_id         bigint,
    check_name       text,
    kind             text,
    window_from      timestamptz,
    window_to        timestamptz,
    completed_runs   bigint,
    up_runs          bigint,
    down_runs        bigint,
    availability_pct numeric
)
LANGUAGE sql
STABLE
AS $$
    SELECT
        c.id   AS check_id,
        c.name AS check_name,
        c.kind AS kind,
        p_from AS window_from,
        p_to   AS window_to,
        count(*) FILTER (WHERE r.status IN ('pass', 'warn', 'fail', 'error')) AS completed_runs,
        count(*) FILTER (WHERE r.status IN ('pass', 'warn'))                  AS up_runs,
        count(*) FILTER (WHERE r.status IN ('fail', 'error'))                 AS down_runs,
        round(
            100.0 * count(*) FILTER (WHERE r.status IN ('pass', 'warn'))
                  / nullif(count(*) FILTER (WHERE r.status IN ('pass', 'warn', 'fail', 'error')), 0),
            4
        ) AS availability_pct
    FROM checks c
    -- ★ countable_run (0081): status / superseded / confirmation / sandbox now filtered by the view.
    LEFT JOIN countable_run r
           ON r.check_id   = c.id
          AND r.started_at >= p_from
          AND r.started_at <  p_to
    -- MAINTENANCE-WINDOW EXCLUSION (additive anti-join, mirrors 0004): kept per-consumer (contextual).
    LEFT JOIN maintenance_windows mw
           ON (mw.check_id = c.id OR mw.check_id IS NULL)
          AND r.started_at >= mw.starts_at
          AND r.started_at <  mw.ends_at
    WHERE mw.id IS NULL
    GROUP BY c.id, c.name, c.kind
$$;

COMMENT ON FUNCTION sla_availability(timestamptz, timestamptz) IS
    'Per-check availability over [p_from, p_to). up=(pass,warn) / completed=(pass,warn,fail,error). Counts only countable_run (running/infra/superseded/confirmation/sandbox excluded). On-demand, index-assisted.';

-- ── slo_status: JOIN countable_run (now excludes confirmation AND sandbox — both were missing). Else byte-identical. ──
CREATE OR REPLACE FUNCTION slo_status(p_check_id bigint, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
    check_id      bigint,
    slo_target    real,
    window_from   timestamptz,
    window_to     timestamptz,
    total_runs    bigint,
    down_runs     bigint,
    budget        numeric,
    consumed      bigint,
    remaining     numeric,
    remaining_pct numeric,
    burn_rate     numeric
)
LANGUAGE sql
STABLE
AS $$
    WITH agg AS (
        SELECT
            c.id         AS check_id,
            c.slo_target AS slo_target,
            count(*) FILTER (WHERE r.status IN ('pass', 'warn', 'fail', 'error')) AS total_runs,
            count(*) FILTER (WHERE r.status IN ('fail', 'error'))                 AS down_runs
        FROM checks c
        -- ★ countable_run (0081): was `LEFT JOIN runs r … AND r.superseded_by_run_id IS NULL`, which missed
        -- BOTH confirmation runs (double-counted a confirmed outage's burn) AND sandbox runs (a paused
        -- monitor's validation consumed the error budget). The view fixes both.
        LEFT JOIN countable_run r
               ON r.check_id   = c.id
              AND r.started_at >= p_from
              AND r.started_at <  p_to
        LEFT JOIN maintenance_windows mw
               ON (mw.check_id = c.id OR mw.check_id IS NULL)
              AND r.started_at >= mw.starts_at
              AND r.started_at <  mw.ends_at
        WHERE c.id = p_check_id
          AND c.slo_target IS NOT NULL
          AND mw.id IS NULL
        GROUP BY c.id, c.slo_target
    )
    SELECT
        check_id,
        slo_target,
        p_from AS window_from,
        p_to   AS window_to,
        total_runs,
        down_runs,
        (1::numeric - slo_target::numeric) * total_runs                         AS budget,
        down_runs                                                      AS consumed,
        (1::numeric - slo_target::numeric) * total_runs - down_runs             AS remaining,
        CASE WHEN (1::numeric - slo_target::numeric) * total_runs > 0
             THEN round(1 - down_runs::numeric / ((1::numeric - slo_target::numeric) * total_runs), 6)
             END                                                       AS remaining_pct,
        CASE WHEN total_runs > 0
             THEN round((down_runs::numeric / total_runs) / (1::numeric - slo_target::numeric), 4)
             ELSE 0 END                                                AS burn_rate
    FROM agg
$$;

COMMENT ON FUNCTION slo_status(bigint, timestamptz, timestamptz) IS
    'Per-check SLO over [p_from, p_to): target, error-budget (run-weighted), consumed, remaining, burn_rate=(down/total)/(1-target). Counts only countable_run (running/infra/superseded/confirmation/sandbox excluded). Zero rows if no slo_target.';

COMMIT;
