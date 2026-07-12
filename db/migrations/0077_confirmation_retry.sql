-- Migration 0077 — confirmation-retry as a FRESH execution (Option B, P1).
--
-- THE BUG: in-run fast-retry (checks.retries, default 2) loops all attempts inside ONE runOne / ONE runs row /
-- ONE ACA execution (runner/retry.ts + index.ts). A 3 × ~5-min browser flow blows the per-execution 660s
-- replicaTimeout → the pod is killed mid-attempt-3 → a STRAND (run 945808: error, duration_ms=NULL, "runner
-- did not finalize"). A tick also runs its due checks SEQUENTIALLY, so a "fresh budget" is only truly isolated
-- in a dedicated off-cadence execution — not by waiting for the next */5 tick.
--
-- THE FIX (browser/multistep): a failed SCHEDULED run enqueues exactly ONE confirmation run in a FRESH ACA
-- execution (fresh pod, fresh 660s), reusing the existing run_requests → drainRunRequests → forceClaim →
-- runOne machinery + an ARM jobs/start. The confirmation OWNS the verdict: it passes → the original was a
-- TRANSIENT (marked superseded, visible but excluded from health signal); it fails → the incident opens
-- exactly as today. `confirmation` is a per-request flavor flag mirroring `sandbox`.
--
-- COLUMNS (runs + run_requests are SHARED tables — the synthwatch-api schema-parity fixture + EF entities are
-- patched in the paired API PR):
--   • runs.confirmation_of_run_id — set on the CONFIRMATION run, points at the original it is confirming.
--   • runs.superseded_by_run_id   — set on the ORIGINAL when its confirmation PASSES (⇒ the original was a
--                                    transient). The read-side health filters exclude WHERE this IS NOT NULL.
--   • run_requests.confirmation   — the per-request flavor flag (mirror sandbox); drainRunRequests threads it.
-- Both self-FKs are ON DELETE SET NULL so 90d row-retention (which purges the pair together) is never blocked
-- by the cross-run reference (contrast incidents.opened_run_id RESTRICT).
--
-- READ-SIDE EXCLUSIONS (this migration owns the two SQL functions; runner code owns aggregateVerdict + rollup;
-- the API owns the status-page projection): sla_availability + slo_status EXCLUDE superseded transients, exactly
-- mirroring the existing `AND NOT r.sandbox` idiom. A superseded transient is a run that DID fail but was
-- confirmed transient — it must not move availability / burn the error budget / flip the public status page.
--
-- New columns on existing tables + CREATE OR REPLACE of two functions. IDEMPOTENT: ADD COLUMN IF NOT EXISTS +
-- CREATE OR REPLACE. Metadata-only + fast (nullable columns + a constant-default boolean are metadata-only in
-- PG11+; no table-scanning index build — see the note below). Safe in a BEGIN/COMMIT transaction.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0077_confirmation_retry.sql

BEGIN;

ALTER TABLE runs
    ADD COLUMN IF NOT EXISTS confirmation_of_run_id BIGINT REFERENCES runs(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS superseded_by_run_id   BIGINT REFERENCES runs(id) ON DELETE SET NULL;

ALTER TABLE run_requests
    ADD COLUMN IF NOT EXISTS confirmation BOOLEAN NOT NULL DEFAULT false;

-- NO new index: the read-side exclusions filter `superseded_by_run_id IS NULL` — the COMMON case (≈every row),
-- which no index would accelerate; the drain's "latest awaiting original" lookup rides runs_check_started_idx
-- (check_id, started_at DESC) with the confirmation columns as cheap filters; and the status-page awaiting check
-- is an EXISTS over run_requests (pending), not over runs. So this migration stays metadata-only — a
-- table-scanning CREATE INDEX on the large runs table (even a zero-row partial one) would take an ACCESS
-- EXCLUSIVE lock and is deliberately avoided (cf. the CONCURRENTLY-index lesson). Add one CONCURRENTLY later if
-- a future query ever filters ON confirmation_of_run_id.

-- ── sla_availability: add the superseded-transient exclusion (mirror the 0070 sandbox exclusion) ──────────
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
    LEFT JOIN runs r
           ON r.check_id   = c.id
          AND r.started_at >= p_from
          AND r.started_at <  p_to
          -- SANDBOX EXCLUSION (0070): a paused monitor's on-demand validation is not a scheduled health signal.
          AND NOT r.sandbox
          -- SUPERSEDED-TRANSIENT EXCLUSION (0077): a failed run whose confirmation PASSED — it was transient, so
          -- it must never move availability. Same rail as the sandbox exclusion; in the JOIN so a check whose
          -- only window runs are superseded keeps its LEFT-JOIN null-run row.
          AND r.superseded_by_run_id IS NULL
    LEFT JOIN maintenance_windows mw
           ON (mw.check_id = c.id OR mw.check_id IS NULL)
          AND r.started_at >= mw.starts_at
          AND r.started_at <  mw.ends_at
    WHERE mw.id IS NULL
    GROUP BY c.id, c.name, c.kind
$$;

-- ── slo_status: add the superseded-transient exclusion so a transient never burns the error budget ────────
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
        LEFT JOIN runs r
               ON r.check_id   = c.id
              AND r.started_at >= p_from
              AND r.started_at <  p_to
              -- SUPERSEDED-TRANSIENT EXCLUSION (0077): a confirmed-transient failure must not consume the
              -- error budget (mirror the sla_availability exclusion; the confirmation run is the one that counts).
              AND r.superseded_by_run_id IS NULL
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

COMMIT;
