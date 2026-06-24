-- Migration 0024 — TAGS (Phase 9a): key:value tags on checks.
--
-- The keystone primitive for tag-scoped alert routing, dashboard filtering, and
-- per-team/per-app reporting (all CONSUMERS, built later — this is just the data model).
--
-- SCHEMA DECISION — a NORMALIZED table, not a JSONB column on checks: filtering + routing
-- both need "find all checks WHERE key=X [AND value=Y]", a clean indexed query here but
-- awkward on JSONB. Mirrors the check_locations (#73) FK+CASCADE per-check pattern.
--
-- PK(check_id, key) => ONE value per key per check (a check is env:prod OR env:staging,
-- not both). Optimised for CONSISTENCY (cardinality is a non-issue — tags on ~5 checks,
-- not on metric series). Multi-value-per-key (e.g. two owning teams) would need
-- PK(check_id, key, value) or distinct keys (team_primary/...) — deferred; see the PR.
--
-- NORMALIZATION (enforced in code AND guarded here so a direct API write can't drift):
-- key + value are lowercase and whitespace-free. key may be '' (a bare value — key:value
-- preferred); value must be non-empty.
--
-- New installs converge from db/schema.sql. Example tags are seeded LIVE via the
-- setCheckTags() primitive (specific check ids are THIS stack's data, not install-generic),
-- NOT here. Apply: psql "$DATABASE_URL" -f db/migrations/0024_check_tags.sql  (IDEMPOTENT).

BEGIN;

CREATE TABLE IF NOT EXISTS check_tags (
    check_id bigint NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
    key      text   NOT NULL DEFAULT ''
                    CHECK (key = lower(key) AND key !~ '[[:space:]]'),
    value    text   NOT NULL
                    CHECK (value <> '' AND value = lower(value) AND value !~ '[[:space:]]'),
    PRIMARY KEY (check_id, key)
);

-- Filtering/routing lookup: "checks WHERE key=X [AND value=Y]".
CREATE INDEX IF NOT EXISTS check_tags_key_value_idx ON check_tags (key, value);

-- The API MI manages tags from the dashboard.
DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synthwatch-api') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON check_tags TO "synthwatch-api";
    END IF;
END
$grant$;

COMMIT;
