-- Migration 0011 — network-layer check kinds: dns, tcp, ping.
--
-- Cheap declarative checks below the HTTP layer (like ssl): catch DNS failures,
-- port closures, and host-unreachability an HTTP check alone misses. They reuse
-- the incident/SLA/maintenance lifecycle for free.
--
-- ADDITIVE / expand-contract-safe: widening the kind CHECK only ALLOWS new values
-- (the deployed runner that only writes http/browser/ssl is unaffected), and
-- net_config is a new nullable column.
--
-- New installs converge from db/schema.sql. Apply with the migrate flow
-- (db/migrate.sh) or:  psql "$DATABASE_URL" -f db/migrations/0011_network_checks.sql
--
-- IDEMPOTENT: DROP CONSTRAINT IF EXISTS + ADD, and ADD COLUMN IF NOT EXISTS.

BEGIN;

-- Allow the three network kinds alongside http / browser / ssl.
ALTER TABLE checks DROP CONSTRAINT IF EXISTS checks_kind_check;
ALTER TABLE checks ADD  CONSTRAINT checks_kind_check
    CHECK (kind IN ('http', 'browser', 'ssl', 'dns', 'tcp', 'ping'));

-- Per-kind network config (host comes from target_url):
--   dns  -> { "recordType": "A"|"AAAA"|"CNAME"|"MX"|"TXT"|"NS", "expectedValue": "<substr>" }
--   tcp  -> { "port": 443 }            (or host:port in target_url)
--   ping -> { "port": 443 }            (TCP-reachability port; default 443)
-- JSONB (matching assertions/auth) — heterogeneous, small, dashboard-editable.
ALTER TABLE checks ADD COLUMN IF NOT EXISTS net_config JSONB;

COMMIT;
