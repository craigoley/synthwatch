-- Migration 0073 — env_domain_map: ordered domain→environment inference for reconcile-apply (env PR-2).
--
-- Until now `checks.environment` (prod|staging|dev, GIT-AUTHORITATIVE) was set ONLY from a per-monitor
-- manifest declaration. Just 1 of 36 monitors declares it (staging → preview.commerce.wegmans.com); the
-- other 35 fall through to the DB default 'prod'. So a FUTURE preview/dev host would silently be tagged
-- prod (and wrongly counted in the prod SLO/trust rollups). There was NO domain→env inference anywhere.
--
-- This table is the inference source: ordered (pattern → environment) rules. reconcile-apply resolves the
-- effective env as  manifest.environment ?? inferFromDomain(target_url, map) ?? 'prod'  — an explicit
-- manifest env still WINS (explicit > inferred > default), inference fills the 35-monitor gap.
--
-- PATTERN SEMANTICS (deliberately simple — NOT regex, to keep a user-editable config a non-footgun):
--   • exact host   — `preview.commerce.wegmans.com` matches that host only.
--   • suffix wildcard — `*.staging.wegmans.com` matches the apex `staging.wegmans.com` AND any subdomain
--     `x.staging.wegmans.com` (host == suffix OR host endsWith '.' + suffix). No other glob forms.
-- ORDERING: lowest `priority` wins; ties broken by `id` (insert order). The runner matches in that order and
-- takes the FIRST match. (runner/envDomainMap.ts inferFromDomain is the single implementation + its tests.)
--
-- SEED — CONSERVATIVE by design. The fleet is NOT currently mis-tagged (35 prod / 1 staging), so the seed
-- must NOT re-tag anything correct: every prod host today (www.wegmans.com, *.meals2go.com, wegmansamore.com,
-- httpbin.org, synthwatch-api.azurewebsites.net, synthwatch-dashboard.vercel.app, wegapi.azure-api.net, …)
-- matches NONE of these patterns → inferFromDomain returns null → stays 'prod'. The one staging host is
-- seeded exactly (and it also manifest-declares staging, so manifest wins either way — no change). The
-- *.preview/staging/dev.wegmans.com + localhost rules match NO current host (verified) — they exist so a
-- FUTURE non-prod host auto-tags without a manifest edit. Broad rules that WOULD hit a current prod host
-- (*.azurewebsites.net, *.vercel.app) are deliberately NOT seeded.
--
-- BACKFILL: reconcile-apply re-derives `environment` every apply → a single `reconcile/trigger` recomputes
-- env fleet-wide; no separate data migration. After it, `SELECT environment, count(*) FROM checks GROUP BY 1`
-- must still read 35 prod / 1 staging.
--
-- GRANT: SELECT to the API (the PR-2 read endpoint GET /api/env-domain-map). WRITE (CRUD + the management
-- page) is PR-3 — grant only what's needed now (mirrors 0024's guarded grant).
--
-- New table (NOT in the base schema.sql install until this migration; schema.sql gets the same block for
-- fresh installs). IDEMPOTENT: CREATE TABLE IF NOT EXISTS + ON CONFLICT DO NOTHING + guarded GRANT. BEGIN/COMMIT.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0073_env_domain_map.sql

BEGIN;

CREATE TABLE IF NOT EXISTS env_domain_map (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- exact host or `*.suffix` wildcard; lowercase, no whitespace (matched case-insensitively by the runner).
    pattern     text NOT NULL UNIQUE
                CHECK (pattern = lower(pattern) AND pattern !~ '[[:space:]]'),
    environment text NOT NULL CHECK (environment IN ('prod','staging','dev')),
    -- lowest priority wins; ties by id (insert order). Exact rules seeded below wildcards.
    priority    int  NOT NULL DEFAULT 100 CHECK (priority >= 0),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS env_domain_map_priority_idx ON env_domain_map (priority, id);

-- Conservative seed (see header) — re-tags nothing currently correct.
INSERT INTO env_domain_map (pattern, environment, priority) VALUES
    ('preview.commerce.wegmans.com', 'staging', 100),
    ('*.preview.wegmans.com',        'staging', 200),
    ('*.staging.wegmans.com',        'staging', 200),
    ('*.dev.wegmans.com',            'dev',     200),
    ('localhost',                    'dev',     300),
    ('127.0.0.1',                    'dev',     300)
ON CONFLICT (pattern) DO NOTHING;

-- PR-2: the API only READS the map (GET /api/env-domain-map). CRUD is PR-3.
DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synthwatch-api') THEN
        GRANT SELECT ON env_domain_map TO "synthwatch-api";
    END IF;
END
$grant$;

COMMIT;
