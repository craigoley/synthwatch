-- SynthWatch — minimal seed data: one HTTP check + one browser check.
-- Apply AFTER schema.sql:  psql "$DATABASE_URL" -f db/seed.sql

BEGIN;

-- Cheap HTTP-tier check: GET example.com, expect 200 and some body text.
INSERT INTO checks (name, kind, target_url, method, expected_status,
                    body_must_contain, interval_seconds, failure_threshold, severity)
VALUES (
    'example.com homepage',
    'http',
    'https://example.com/',
    'GET',
    200,
    'Example Domain',
    300,   -- every 5 minutes
    3,
    'critical'
);

-- Real-browser check: runs the homepage-search flow (runner/checks/homepage-search.ts).
-- NOTE: that flow ships with PLACEHOLDER selectors — point target_url at a real
-- site and update the flow's selectors before trusting this check.
INSERT INTO checks (name, kind, target_url, flow_name,
                    interval_seconds, timeout_ms, failure_threshold, severity)
VALUES (
    'homepage search funnel',
    'browser',
    'https://example.com/',
    'homepage-search',
    1800,  -- every 30 minutes (browser checks are expensive)
    45000,
    3,
    'critical'
);

COMMIT;
