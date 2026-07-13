-- Migration 0080 — checks.flake_target + flake_status() (B3-3): the MONITOR trust budget.
--
-- CONTEXT: 0077/#291 made a self-healed failure VISIBLE (superseded_by_run_id) for every kind; 0079/#292
-- classified each superseded transient (runs.transient_class ∈ monitor-side / service-side / indeterminate).
-- "Just report" was the state — and a trust signal with no forcing function decays into DECORATION (the chip
-- was quietly wrong about 355 and 222 for weeks). This is the forcing function: a per-monitor flake BUDGET,
-- mirroring slo_target / slo_status exactly.
--
-- ★★ THE SAFETY PROPERTY (do not weaken): the budget CONSUMES ONLY monitor-side transients. A service-side
-- transient is a real (if brief) outage the monitor CAUGHT — it must NEVER burn the monitor's budget, else
-- "the flakier your SERVICE, the more untrustworthy the MONITOR that caught it looks." indeterminate burns
-- NOTHING (surfaced, so a budget over partial data is honest). The consumed = monitor-side count is the SAME
-- gated signal the API's spurious-red dimension already uses (and the NaiveAllTransients revert-proof guards).
--
-- ★ NEVER a mute: flake_status is a READ-ONLY reporting function. It has no write path to alerts/routing. A
-- monitor that flaps because the service is flaky is telling the truth; the consequence of a breached budget
-- is a DIRECTED MONITOR-HEALTH TASK (surfaced by the API/dashboard), never an auto-suppression.
--
-- ★ FLEET-DEFAULT, not opt-in: slo_target is adopted by 1 of 36 checks — a budget nobody configures is a
-- budget nobody sees. flake_target NULL ⇒ the FLEET DEFAULT (2%); a per-monitor value overrides it. So every
-- monitor has a live budget from day one.
--
-- ★ DASHBOARD-OWNED: flake_target is set from the dashboard, NEVER from the monitors-as-code manifest. It is in
-- NEITHER reconcile write allow-list (GIT_AUTHORITATIVE_COLUMNS / SEED_ONLY_COLUMNS), so a manifest apply is
-- STRUCTURALLY incapable of clobbering a deliberate override — the exact archived_at / environment_override
-- guarantee (reconcile.test.ts asserts it).
--
-- SHARED TABLE: checks is mapped by synthwatch-api — the schema-parity fixture + the Check EF entity are patched
-- in the paired API PR (they land together). IDEMPOTENT: ADD COLUMN IF NOT EXISTS + a named CHECK added only
-- when absent (a nullable column + an all-NULL CHECK validates instantly). CREATE OR REPLACE for the new
-- function (no prior signature → replay-safe; schema.sql carries the identical definition).

ALTER TABLE checks ADD COLUMN IF NOT EXISTS flake_target NUMERIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'checks_flake_target_check') THEN
    ALTER TABLE checks ADD CONSTRAINT checks_flake_target_check
      CHECK (flake_target IS NULL OR (flake_target >= 0 AND flake_target < 1));
  END IF;
END $$;

-- flake_status: per-check MONITOR trust budget over [p_from, p_to). Mirrors slo_status' algebra
--   budget = target × N · consumed · remaining · burn_rate = (consumed/N)/target
-- but N = SCHEDULED runs (the denominator INCLUDES superseded transients — they ARE scheduled ticks that
-- flaked; it EXCLUDES confirmations + sandbox + maintenance), and consumed = the MONITOR-SIDE transient count
-- ONLY. service_side + indeterminate are returned but NEVER consumed. Fleet default 2% via COALESCE; returns a
-- row for EVERY check (unlike slo_status, which is opt-in). GRANT EXECUTE to the API below (guarded).
CREATE OR REPLACE FUNCTION flake_status(p_check_id bigint, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
    check_id          bigint,
    flake_target      numeric,   -- EFFECTIVE target (per-monitor override, else the fleet default)
    target_is_default boolean,   -- true = no per-monitor override (this budget uses the fleet default)
    window_from       timestamptz,
    window_to         timestamptz,
    scheduled_runs    bigint,    -- denominator: non-sandbox, non-confirmation, non-maintenance scheduled ticks
    monitor_side      bigint,    -- ★ CONSUMED — the monitor cried wolf (a monitor-side transient)
    service_side      bigint,    -- surfaced, NEVER consumed (a real blip the monitor CAUGHT — telling the truth)
    indeterminate     bigint,    -- surfaced, NEVER consumed (no error signals yet — expected for http/dns/ssl)
    budget            numeric,   -- flake_target × scheduled_runs
    consumed          bigint,    -- = monitor_side (the ONLY thing that burns budget)
    remaining         numeric,
    remaining_pct     numeric,
    burn_rate         numeric    -- (monitor_side / scheduled_runs) / flake_target
)
LANGUAGE sql
STABLE
AS $$
    WITH agg AS (
        SELECT
            c.id AS check_id,
            -- ★ FLEET DEFAULT 2% (0.02) — a monitor may be MONITOR-SIDE flaky ≤2% of scheduled runs before it is
            -- "degraded as a monitor". Justified by the measured flap distribution (p95 ≤0.016% → ~125× headroom;
            -- the worst non-service flapper is 1.1%) and stage-1's spurious-red bands (elevated 1%, flaky 5%).
            COALESCE(c.flake_target, 0.02)::numeric AS flake_target,
            (c.flake_target IS NULL)                AS target_is_default,
            count(*) FILTER (
                WHERE r.confirmation_of_run_id IS NULL AND NOT r.sandbox) AS scheduled_runs,
            count(*) FILTER (
                WHERE r.superseded_by_run_id IS NOT NULL AND r.transient_class = 'monitor-side'
                  AND r.confirmation_of_run_id IS NULL AND NOT r.sandbox) AS monitor_side,
            count(*) FILTER (
                WHERE r.superseded_by_run_id IS NOT NULL AND r.transient_class = 'service-side'
                  AND r.confirmation_of_run_id IS NULL AND NOT r.sandbox) AS service_side,
            count(*) FILTER (
                WHERE r.superseded_by_run_id IS NOT NULL AND r.transient_class = 'indeterminate'
                  AND r.confirmation_of_run_id IS NULL AND NOT r.sandbox) AS indeterminate
        FROM checks c
        LEFT JOIN runs r
               ON r.check_id   = c.id
              AND r.started_at >= p_from
              AND r.started_at <  p_to
        -- MAINTENANCE-WINDOW EXCLUSION (mirrors slo_status): drop runs inside an active window for this check
        -- or a fleet-wide window. Anti-join — uncovered runs keep mw.id NULL and survive; a check with no runs
        -- keeps its single null-run row (row exists for every check → fleet-default budget always resolvable).
        LEFT JOIN maintenance_windows mw
               ON (mw.check_id = c.id OR mw.check_id IS NULL)
              AND r.started_at >= mw.starts_at
              AND r.started_at <  mw.ends_at
        WHERE c.id = p_check_id
          AND mw.id IS NULL
        GROUP BY c.id, c.flake_target
    )
    SELECT
        check_id,
        flake_target,
        target_is_default,
        p_from AS window_from,
        p_to   AS window_to,
        scheduled_runs,
        monitor_side,
        service_side,
        indeterminate,
        flake_target * scheduled_runs                    AS budget,
        monitor_side                                     AS consumed,
        flake_target * scheduled_runs - monitor_side     AS remaining,
        CASE WHEN flake_target * scheduled_runs > 0
             THEN round(1 - monitor_side::numeric / (flake_target * scheduled_runs), 6)
             END                                         AS remaining_pct,
        CASE WHEN scheduled_runs > 0 AND flake_target > 0
             THEN round((monitor_side::numeric / scheduled_runs) / flake_target, 4)
             ELSE 0 END                                  AS burn_rate
    FROM agg
$$;

COMMENT ON FUNCTION flake_status(bigint, timestamptz, timestamptz) IS
    'Per-check MONITOR trust budget over [p_from, p_to): consumed = MONITOR-SIDE transients ONLY (service-side + indeterminate surfaced, never consumed). budget = flake_target × scheduled_runs; fleet default 2% via COALESCE. READ-ONLY — never mutes an alert; a breach surfaces a directed monitor-health task.';

-- GRANT EXECUTE to the API MI (guarded, like slo_status — no-op on a fresh DB / the Testcontainers snapshot
-- that has no synthwatch-api role).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synthwatch-api') THEN
        GRANT EXECUTE ON FUNCTION flake_status(bigint, timestamptz, timestamptz) TO "synthwatch-api";
    END IF;
END $$;
