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

-- SSL/TLS cert-expiry check (kind='ssl', no browser). Reads the leaf cert over a
-- TLS handshake: > cert_expiry_warn_days remaining => pass, within the window =>
-- warn, expired/invalid => fail, unreachable => error. days-remaining is recorded
-- in the run's error_message for the dashboard.
INSERT INTO checks (name, kind, target_url, interval_seconds, timeout_ms,
                    failure_threshold, severity, cert_expiry_warn_days)
VALUES (
    'wegmans.com TLS cert',
    'ssl',
    'https://www.wegmans.com/',
    3600,  -- hourly is plenty for a cert that changes ~quarterly
    10000, -- TLS handshake budget (ms)
    2,
    'critical',
    30     -- warn when the cert has <= 30 days left
);

-- Network-layer checks (no browser). Host comes from target_url; net_config holds
-- the per-kind extras. See runner/netChecks.ts.

-- DNS: resolve an A record (pass = resolves; add net_config.expectedValue to
-- assert a specific value).
INSERT INTO checks (name, kind, target_url, interval_seconds, timeout_ms,
                    failure_threshold, severity, net_config)
VALUES ('wegmans.com DNS (A)', 'dns', 'www.wegmans.com', 300, 5000, 3, 'critical',
        '{"recordType":"A"}'::jsonb);

-- TCP: is the HTTPS port open? (pass = connect; fail = refused; error = timeout)
INSERT INTO checks (name, kind, target_url, interval_seconds, timeout_ms,
                    failure_threshold, severity)
VALUES ('wegmans.com TCP 443', 'tcp', 'www.wegmans.com:443', 300, 5000, 3, 'critical');

-- PING: host reachability (TCP-reachability, NOT ICMP — ACA grants no CAP_NET_RAW;
-- see netChecks.ts). Defaults to TCP 443; a connect OR refusal means reachable.
INSERT INTO checks (name, kind, target_url, interval_seconds, timeout_ms,
                    failure_threshold, severity)
VALUES ('wegmans.com reachable', 'ping', 'www.wegmans.com', 300, 5000, 3, 'critical');

COMMIT;
