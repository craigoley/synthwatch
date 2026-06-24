-- Migration 0025 — TAG-ROUTING (Phase 9a tie-in): a tag dimension on alert routing.
--
-- An incident's channels become the UNION (Craig's decision — all dimensions ADDITIVE)
-- of: the severity-default channels (baseline, ALWAYS applies) + the per-check routes +
-- every tag-rule whose tag matches the incident's check. Deduped. "Hit any criterion ->
-- you get the alert." This REVERSES #81's per-check-OVERRIDE (per-check no longer
-- suppresses the severity baseline). See runner/alerts.ts resolveChannels().
--
-- A tag-rule = (tag_key, tag_value, channel_id): "checks tagged {key:value} also route to
-- {channel}". Matched at dispatch by joining the check's check_tags (#84) to tag_routes.
--
-- Mirrors alert_routes' FK shape: channel_id -> channels ON DELETE CASCADE (deleting a
-- channel drops its routes). tag_key/tag_value are normalized like check_tags (#84) —
-- lowercase + whitespace-free (DB CHECK), so the join to normalized check_tags is exact;
-- the API normalizes on write (same rule as tags.ts normalizeField).
--
-- New installs converge from db/schema.sql.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0025_tag_routes.sql  (IDEMPOTENT).

BEGIN;

CREATE TABLE IF NOT EXISTS tag_routes (
    id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tag_key    text        NOT NULL
                           CHECK (tag_key = lower(tag_key) AND tag_key !~ '[[:space:]]'),
    tag_value  text        NOT NULL
                           CHECK (tag_value <> '' AND tag_value = lower(tag_value) AND tag_value !~ '[[:space:]]'),
    channel_id bigint      NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- One rule per (key, value, channel) — a tag routing to a channel twice is the same rule.
CREATE UNIQUE INDEX IF NOT EXISTS tag_routes_uq ON tag_routes (tag_key, tag_value, channel_id);
-- Match lookup: tag-rules for a (key, value) the check carries.
CREATE INDEX IF NOT EXISTS tag_routes_key_value_idx ON tag_routes (tag_key, tag_value);

-- The API MI manages tag-routes from the dashboard.
DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synthwatch-api') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON tag_routes TO "synthwatch-api";
    END IF;
END
$grant$;

COMMIT;
