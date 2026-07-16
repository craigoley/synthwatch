-- 0090_azure_cost_cache.sql
--
-- ★ THE HEADLINE = AZURE'S NUMBER, NOT OURS. The cost panel must DISPLAY the actual bill, not COMPUTE one: a
-- monitoring tool that models its own spend and drifts from the invoice is exactly the confidently-wrong
-- signal we spend our time killing. This single-row cache holds what the runner PULLS from the Azure Cost
-- Management API (MTD actual + Azure's own end-of-month forecast, RG scope) on the daily rollup job; the api
-- serves it and the dashboard shows it. If the pull is unavailable (role not yet propagated / API error) the
-- row is simply STALE or ABSENT and the UI falls back to a "see Azure Cost Management" deep link —
-- HONESTLY ABSENT beats FALSELY PRECISE.
--
-- SINGLETON: id is pinned to 1 (CHECK + PK), so the runner UPSERTs one row (ON CONFLICT (id) DO UPDATE). The
-- money columns are numeric (currency-scaled); mtd_days lets the UI show the ramp ("$47 over 16d") beside the
-- forecast. billing_month anchors the figures to a month so a stale row across a month boundary is detectable.
-- fetched_at drives the runner's staleness guard (refresh at most ~daily) AND the UI's "as of" label.
--
-- GRANT: SELECT to the api (read-only /reports/cost augmentation). WRITE is the runner (owner) only — the api
-- grant-coverage gate parses THIS migration's GRANT (runner owns the grants). IDEMPOTENT: CREATE TABLE IF NOT
-- EXISTS + guarded GRANT. BEGIN/COMMIT.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0090_azure_cost_cache.sql

BEGIN;

CREATE TABLE IF NOT EXISTS azure_cost (
    id             smallint    PRIMARY KEY DEFAULT 1,
    scope          text        NOT NULL,               -- e.g. 'resourceGroups/synthwatch-rg' — the query scope the figures cover
    currency       text        NOT NULL,               -- ISO currency Azure reported (e.g. 'USD')
    billing_month  date        NOT NULL,               -- first-of-month the figures cover (UTC) — staleness across a boundary is visible
    mtd_actual     numeric     NOT NULL,               -- month-to-date ACTUAL cost (all meters in scope), from Cost Management
    mtd_days       integer     NOT NULL,               -- days elapsed in the billing month at fetch (the ramp denominator)
    forecast_month numeric,                            -- Azure's OWN end-of-month forecast; null when the forecast API returns none
    portal_url     text        NOT NULL,               -- deep link to Cost Management for this scope (the honest-absent fallback target)
    fetched_at     timestamptz NOT NULL DEFAULT now(), -- staleness guard + the UI's "as of" timestamp
    CONSTRAINT azure_cost_singleton CHECK (id = 1)
);

COMMENT ON TABLE azure_cost IS
    'Single-row cache of Azure Cost Management figures the runner PULLS (rollup job, azureCost.ts): MTD actual + Azure forecast for the RG scope. The cost panel DISPLAYS this (not a modeled number); stale/absent → UI deep-links to the portal. Runner writes (owner); api reads.';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synthwatch-api') THEN
        GRANT SELECT ON azure_cost TO "synthwatch-api";
    END IF;
END $$;

COMMIT;
