-- Migration 0006 — alert profiles: per-check routing of (severity × status) ->
-- channel set, plus the warn-notify (no-incident) path.
--
-- Fixes the warn alerting gap: an expiring cert (warn) should NOTIFY (e.g. email)
-- without opening an incident or blasting every channel; a hard outage
-- (fail/error) still hits the profile's channels for that class. A 'default'
-- profile preserves today's behavior (fail/error/resolved -> all channels) and
-- adds warn -> email only.
--
-- ADDITIVE / expand-contract-safe: new table + nullable columns (a null
-- alert_profile_id falls back to the 'default' profile; the deployed runner that
-- ignores these columns keeps working). New installs converge from db/schema.sql.
-- Apply with the migrate flow (db/migrate.sh) or:
--   psql "$DATABASE_URL" -f db/migrations/0006_alert_profiles.sql
--
-- IDEMPOTENT: CREATE/ALTER ... IF NOT EXISTS and INSERT ... ON CONFLICT DO NOTHING.

BEGIN;

-- A profile = a named set of routing rules. rules is a JSONB array of
--   { "severity": "critical"|"warning"|"any",
--     "status":   "fail"|"error"|"warn"|"resolved"|"any",
--     "channels": ["email","webhook", ...] }
-- The runner unions the channels of every rule matching (check.severity, status),
-- then sends only to channels that are ALSO configured (absent env => off).
CREATE TABLE IF NOT EXISTS alert_profiles (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       TEXT        NOT NULL UNIQUE,
    rules      JSONB       NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which profile a check uses. NULL => the 'default' profile (resolved in code).
ALTER TABLE checks
    ADD COLUMN IF NOT EXISTS alert_profile_id BIGINT
        REFERENCES alert_profiles(id) ON DELETE SET NULL;

-- Warn-notify debounce bookkeeping: last time a warn notification was sent for
-- this check, and the minimum re-notify interval (so a persistently-expiring cert
-- doesn't email every tick). Reset to NULL on a pass so a fresh warn re-notifies.
ALTER TABLE checks
    ADD COLUMN IF NOT EXISTS last_warn_notified_at TIMESTAMPTZ;
ALTER TABLE checks
    ADD COLUMN IF NOT EXISTS warn_renotify_seconds INTEGER NOT NULL DEFAULT 86400
        CHECK (warn_renotify_seconds > 0);

-- Default profile: preserves today's fail/error/resolved -> all channels, and
-- adds warn -> email only (quiet notify for degraded-but-available, e.g. an
-- expiring cert). A check with no alert_profile_id falls back to this.
INSERT INTO alert_profiles (name, rules) VALUES (
    'default',
    '[
       {"severity":"any","status":"fail",    "channels":["email","webhook"]},
       {"severity":"any","status":"error",   "channels":["email","webhook"]},
       {"severity":"any","status":"resolved","channels":["email","webhook"]},
       {"severity":"any","status":"warn",    "channels":["email"]}
     ]'::jsonb
)
ON CONFLICT (name) DO NOTHING;

COMMIT;
