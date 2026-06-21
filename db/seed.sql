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

-- Real-browser check: loads a real, rich page and asserts it rendered
-- (runner/checks/homepage-load.ts — uses assertions that hold for any real HTML
-- page, so it actually passes). Richer real flows that exercise search + nav
-- ship alongside it: wegmans-homepage and wegmans-search (verified selectors) —
-- point a check at those for full-funnel monitoring.
INSERT INTO checks (name, kind, target_url, flow_name,
                    interval_seconds, timeout_ms, failure_threshold, severity,
                    perf_budget_lcp_ms)
VALUES (
    'Wegmans homepage',
    'browser',
    'https://www.wegmans.com/',
    'homepage-load',
    1800,  -- every 30 minutes (browser checks are expensive)
    20000, -- generous-but-meaningful: a real load is ~4-5s, so a genuine
           -- slowdown trips well before this instead of riding a 45s ceiling.
    3,
    'critical',
    4000   -- perf budget: LCP > 4s downgrades an otherwise-passing run to 'warn'
           -- (real LCP is ~1.3-1.5s, so this flags genuine regressions).
);

COMMIT;
