-- Migration 0054 — runs.egress_ip (static-egress-IP Phase 0 measurement; ANALYSIS-static-egress-ip-2026-06-30.md).
--
-- Every run records the PUBLIC egress IP the runner left from (best-effort, fail-soft — NULL if the reflector
-- was unreachable; runner/egress.ts). The real monitors' normal cron across all 3 regions IS the measurement:
-- over a day, query distinct egress IPs per region to decide whether egress is a stable allowlistable IP per
-- region (zero-infra) or a rotating SNAT pool (needs Phase 1 NAT/proxy). Durable: an IP that later rotates
-- shows up as a new distinct value on subsequent runs. NOT sensitive — it's our own infra's public IP.
--
-- ★ THE VERDICT QUERY (run after ~a day of real cron runs):
--   SELECT location,
--          count(*)                              AS runs,
--          count(DISTINCT egress_ip)             AS distinct_egress_ips,
--          array_agg(DISTINCT egress_ip)         AS egress_ips
--     FROM runs
--    WHERE egress_ip IS NOT NULL
--      AND started_at > now() - interval '1 day'
--    GROUP BY location
--    ORDER BY location;
--   distinct_egress_ips = 1 per region → STABLE: allowlist the 3 IPs, zero infra.
--   distinct_egress_ips > 1            → ROTATING SNAT pool → Phase 1 (NAT Gateway / proxy).
--
-- Apply: psql "$DATABASE_URL" -f db/migrations/0054_runs_egress_ip.sql

BEGIN;

ALTER TABLE runs ADD COLUMN IF NOT EXISTS egress_ip text;

COMMIT;
