-- Migration 0018 — 90-day SLA window.
--
-- The dashboard SLA panel offers 24h/7d/30d; add 90d — the window that matters for
-- real SLA/SLO reporting (and pairs with the SLO error-budget, typically 30-90d).
-- Mirrors sla_availability_30d exactly: a view over the existing parameterized
-- sla_availability() function, so it inherits the SAME up=pass|warn / down=fail|error
-- taxonomy and maintenance-window exclusion. No new logic.
--
-- New installs converge from db/schema.sql. Apply with the migrate flow
-- (db/migrate.sh) or:  psql "$DATABASE_URL" -f db/migrations/0018_sla_90d.sql
--
-- IDEMPOTENT: CREATE OR REPLACE VIEW + guarded GRANT.

BEGIN;

CREATE OR REPLACE VIEW sla_availability_90d AS
    SELECT * FROM sla_availability(now() - interval '90 days', now());

-- Grant the API MI SELECT (mirrors the 24h/7d/30d views). Guarded so the migration
-- is safe on a fresh DB / the Testcontainers snapshot that has no synthwatch-api role.
DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synthwatch-api') THEN
        GRANT SELECT ON sla_availability_90d TO "synthwatch-api";
    END IF;
END
$grant$;

COMMIT;
