-- 0086_cost_projection_exclude_archived.sql
--
-- ★ THE LAST ARCHIVED LEAK. #254 excluded archived checks from /incidents, /reports/slo, /incident-breakdown,
-- /mttr, /trust (api-side), but /reports/cost filters INSIDE cost_projection() — so an archived-but-enabled
-- check (rca-demo, 2,264 runs) was STILL inflating the fleet cost report. Adds `c.archived_at IS NULL` to
-- cost_projection's fleet branch, matching #254's semantics exactly (cost_projection is FROM checks directly,
-- so there is no orphan/removed row to keep — enabled + non-archived is the whole predicate).
--
-- ★ Rebased on 0078's body (the DEPLOYED cost_projection, with its projected/measured aliases) — NOT the stale
-- db/schema.sql, which had drifted from 0078 (missing those aliases); extracting from schema.sql would have
-- silently STRIPPED them. schema.sql is corrected to this same end-state in the same PR. Body-only change (no
-- signature/return-type change vs 0078) → CREATE OR REPLACE, no DROP. cost_projection is a SHARED function
-- (the api /reports/cost calls it, schema-parity compares its body) — the paired api fixture bump lands with this.

BEGIN;

CREATE OR REPLACE FUNCTION cost_projection(p_rate numeric)
RETURNS TABLE (
    check_id              bigint,
    source_key            text,
    check_name            text,
    kind                  text,
    interval_seconds      integer,
    region_count          integer,
    avg_duration_s        double precision,
    projected             numeric,   -- rounded 2dp (display)
    measured              numeric,   -- rounded 2dp (display)
    divergence            numeric,   -- rounded 3dp; null when projected = 0
    divergence_flag       boolean,   -- divergence > 1.5
    projected_raw         numeric,   -- unrounded — sum these for the fleet total, THEN round
    measured_raw          numeric,
    run_count_7d          integer,   -- runs (duration_ms NOT NULL) in the last 7d = the N in divergence = N/expected
    confirmation_count_7d integer,   -- of those, confirmation re-runs (confirmation_of_run_id NOT NULL, 0077)
    sandbox_count_7d      integer,   -- of those, sandbox / on-demand fires (runs.sandbox, 0065)
    run_count_recent      integer,   -- runs in the RECENT half of the window (last 3.5d)
    run_count_prior       integer    -- runs in the PRIOR half (3.5–7d ago); recent≠prior ⇒ a cadence change
)
LANGUAGE sql
STABLE
AS $$
    WITH run_stats AS (
        -- ONE grouped pass over the measured set (duration_ms NOT NULL, last 7d), byte-identical avg/Σ to
        -- 0069's two correlated subqueries, plus the run-count columns.
        SELECT r.check_id,
               (avg(r.duration_ms) / 1000.0)::float8 AS avg_duration_s,
               (sum(r.duration_ms) / 1000.0)::float8 AS sum_duration_s_7d,
               count(*)::int AS run_count_7d,
               count(*) FILTER (WHERE r.confirmation_of_run_id IS NOT NULL)::int AS confirmation_count_7d,
               count(*) FILTER (WHERE r.sandbox)::int AS sandbox_count_7d,
               count(*) FILTER (WHERE r.started_at >  now() - interval '3.5 days')::int AS run_count_recent,
               count(*) FILTER (WHERE r.started_at <= now() - interval '3.5 days')::int AS run_count_prior
          FROM runs r
         WHERE r.started_at > now() - interval '7 days'
           AND r.duration_ms IS NOT NULL
         GROUP BY r.check_id
    ),
    base AS (
        SELECT c.id AS check_id, c.source_key, c.name AS check_name, c.kind, c.interval_seconds,
               (SELECT count(*)::int FROM check_locations cl WHERE cl.check_id = c.id) AS region_count,
               rs.avg_duration_s, rs.sum_duration_s_7d,
               coalesce(rs.run_count_7d, 0)          AS run_count_7d,
               coalesce(rs.confirmation_count_7d, 0) AS confirmation_count_7d,
               coalesce(rs.sandbox_count_7d, 0)      AS sandbox_count_7d,
               coalesce(rs.run_count_recent, 0)      AS run_count_recent,
               coalesce(rs.run_count_prior, 0)       AS run_count_prior
          FROM checks c
          LEFT JOIN run_stats rs ON rs.check_id = c.id
         -- ★ 0086: exclude ARCHIVED checks (matches #254 at the source — the last surface it missed).
         WHERE c.enabled AND c.archived_at IS NULL
    ),
    scored AS (
        SELECT b.*,
               CASE WHEN b.avg_duration_s IS NOT NULL AND b.interval_seconds > 0
                    THEN b.avg_duration_s::numeric * (2592000::numeric / b.interval_seconds) * b.region_count * p_rate
                    ELSE 0 END AS p_raw,
               CASE WHEN b.sum_duration_s_7d IS NOT NULL
                    THEN b.sum_duration_s_7d::numeric * p_rate * (30::numeric / 7::numeric)
                    ELSE 0 END AS m_raw
          FROM base b
    )
    SELECT s.check_id, s.source_key, s.check_name, s.kind, s.interval_seconds, s.region_count, s.avg_duration_s,
           round(s.p_raw, 2) AS projected,
           round(s.m_raw, 2) AS measured,
           CASE WHEN s.p_raw > 0 THEN round(s.m_raw / s.p_raw, 3) ELSE NULL END AS divergence,
           CASE WHEN s.p_raw > 0 THEN round(s.m_raw / s.p_raw, 3) > 1.5 ELSE false END AS divergence_flag,
           s.p_raw AS projected_raw,
           s.m_raw AS measured_raw,
           s.run_count_7d, s.confirmation_count_7d, s.sandbox_count_7d, s.run_count_recent, s.run_count_prior
      FROM scored s
$$;

COMMIT;
