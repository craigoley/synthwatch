-- Migration 0023 — dashboard-managed alerting v1: CHANNELS (targets) + ROUTING in the DB.
--
-- THE ARCHITECTURAL SPLIT: the TRANSPORT CREDENTIAL (ACS connection string) stays an
-- infra secret in env ("how we send"); the channel TARGETS (recipients, webhook URL)
-- and ROUTING (which alert -> which channel) move to the DB ("who gets what"), so the
-- dashboard manages them. Previously alerts.ts read recipients/URL from env
-- (ALERT_EMAIL_TO / ALERT_WEBHOOK_URL) AND routing from alert_profiles — this splits
-- that: targets -> channels, routing -> alert_routes. alert_profiles + checks.
-- alert_profile_id are superseded (left in place, additive; the runner stops reading them).
--
-- New installs converge from db/schema.sql.
-- Apply:  psql "$DATABASE_URL" -f db/migrations/0023_alert_channels.sql
-- IDEMPOTENT: CREATE TABLE IF NOT EXISTS + ON CONFLICT DO NOTHING seeds + guarded GRANT.

BEGIN;

-- CHANNELS — delivery targets. NO transport secret here (the ACS connection string
-- stays in env; a webhook URL MAY embed a token — acceptable for v1, noted). config:
--   email   -> { "to": ["a@x", ...], "from": "sender@x" }
--   webhook -> { "url": "https://...", "authHeader"?: "Bearer ..." }
CREATE TABLE IF NOT EXISTS channels (
    id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       text        NOT NULL UNIQUE,
    type       text        NOT NULL CHECK (type IN ('email', 'webhook')),
    config     jsonb       NOT NULL DEFAULT '{}'::jsonb,
    enabled    boolean     NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- ROUTING — which alerts go to which channels. v1 dimensions, ONE per row:
--   severity-default: severity set, check_id NULL  (all checks of that severity)
--   per-check override: check_id set, severity NULL (overrides the severity default)
-- Phase 9a adds a `tag` column here WITHOUT reshaping (a 3rd dimension alongside).
CREATE TABLE IF NOT EXISTS alert_routes (
    id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    severity   text        CHECK (severity IS NULL OR severity IN ('critical', 'warning')),
    check_id   bigint      REFERENCES checks(id) ON DELETE CASCADE,
    channel_id bigint      NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    -- Exactly one routing dimension per row (v1: severity-default XOR per-check).
    CONSTRAINT alert_route_one_dimension
        CHECK ((severity IS NOT NULL AND check_id IS NULL)
            OR (severity IS NULL AND check_id IS NOT NULL))
);
-- De-dup: one route per (severity, channel) and per (check, channel). Partial indexes
-- because UNIQUE treats NULLs as distinct (a plain UNIQUE wouldn't dedup the NULL side).
CREATE UNIQUE INDEX IF NOT EXISTS alert_routes_severity_uq
    ON alert_routes (severity, channel_id) WHERE check_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS alert_routes_check_uq
    ON alert_routes (check_id, channel_id) WHERE check_id IS NOT NULL;

-- Seed/migrate the existing 'default' profile (fail/error/resolved -> [email, webhook],
-- warn -> [email]) into the new model. v1 routing is SEVERITY-keyed (the old status
-- dimension is dropped), so both severities default to [email, webhook] — a superset
-- that keeps behaviour DEFINED. Channels start with EMPTY config: no recipients/URL
-- were ever actually set (the env vars were aspirational), so nothing delivers yet —
-- the dashboard fills config.to / config.url and delivery begins. enabled so routing
-- resolves to them.
INSERT INTO channels (name, type, config, enabled) VALUES
    ('email',   'email',   '{}'::jsonb, true),
    ('webhook', 'webhook', '{}'::jsonb, true)
ON CONFLICT (name) DO NOTHING;

INSERT INTO alert_routes (severity, channel_id)
SELECT s.sev, c.id
  FROM (VALUES ('critical'), ('warning')) AS s(sev)
  CROSS JOIN channels c
 WHERE c.name IN ('email', 'webhook')
ON CONFLICT DO NOTHING;

-- The API MI manages channels + routing from the dashboard.
DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synthwatch-api') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON channels, alert_routes TO "synthwatch-api";
    END IF;
END
$grant$;

COMMIT;
