-- Migration 0038 — audit_log (Phase 12, slice 2: the gate).
--
-- Every mutating request that passes the API's AuthorizationMiddleware is recorded here (actor, action,
-- target, before/after diff with secrets REDACTED, outcome). Logically API-OWNED (only the API writes it,
-- via the middleware) but here because the runner owns the schema + migrate-on-deploy pipeline.
--
-- ★ APPEND-ONLY: an audit trail you can rewrite is worthless. The API role gets INSERT + SELECT only;
-- UPDATE + DELETE are REVOKEd, so the application CANNOT alter or erase history even with a code bug.
--
-- New installs converge from db/schema.sql.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0038_audit_log.sql  (IDEMPOTENT).

BEGIN;

CREATE TABLE IF NOT EXISTS audit_log (
    id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ts           timestamptz NOT NULL DEFAULT now(),
    actor_email  text,                  -- the resolved session email (null only if ever written un-authed)
    actor_ip     text,
    action       text,                  -- create | update | delete (coarse, from the HTTP verb)
    target_type  text,                  -- e.g. check | channel | routing (from the diff or the route)
    target_id    text,
    http_method  text,
    http_path    text,
    status_code  integer,
    success      boolean,
    before_json  jsonb,                 -- REDACTED entity snapshot before the change (null when N/A)
    after_json   jsonb,                 -- REDACTED entity snapshot after the change (null when N/A)
    note         text
);

CREATE INDEX IF NOT EXISTS audit_log_ts_idx ON audit_log (ts DESC);

-- ★ Append-only guard. The API MI may INSERT (write trail) + SELECT (read trail), never UPDATE/DELETE.
-- The REVOKE is belt-and-suspenders: a fresh GRANT only adds INSERT/SELECT, but REVOKE makes the
-- immutability explicit and survives a stray broad GRANT elsewhere. The runner connects as the admin
-- role and never touches this table.
DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synthwatch-api') THEN
        GRANT  INSERT, SELECT   ON audit_log TO "synthwatch-api";
        REVOKE UPDATE, DELETE   ON audit_log FROM "synthwatch-api";
    END IF;
END
$grant$;

COMMIT;
