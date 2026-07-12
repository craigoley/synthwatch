-- Migration 0076 — error_mutes: per-CHECK, per-FINGERPRINT mute for the error-diff NEW bucket (error-diff P4).
--
-- Error-diff P2 (#218) surfaces the errors a run has that are NEW vs the last-N settled runs; P3 (#245) renders
-- that on the monitor page. A NEW error is meant to be must-go-red, but some NEW errors are known/accepted (a
-- third-party console warning an operator has triaged, a benign 4xx). Without a mute they re-appear as NEW on
-- every run forever — alert fatigue, which trains the operator to ignore the whole panel.
--
-- This table records an operator's decision to MUTE one fingerprint for one check. The API's error-diff read
-- then MOVES a muted fingerprint OUT of `new[]` into a separate `muted[]` bucket (+ counts.muted) — it is
-- NEVER silently dropped (a hidden-forever error is its own bug); the dashboard shows a collapsed "N muted"
-- disclosure with an unmute action. Mute is per-monitor and persists until explicitly unmuted.
--
-- OWNERSHIP: DASHBOARD-managed operator config (like check_tags / env_domain_map) — the API has SELECT/INSERT/
-- DELETE CRUD; the runner never reads or writes it (the diff+mute-filter is entirely API-side, over persisted
-- runs.trace_signals). It is NOT RCE-sensitive: a fingerprint is inert text used only to filter a read
-- (contrast spec_cache/0041, whose compiled_js executes at runner privilege and is therefore API-write-REVOKED).
--
-- NOTES ARE NOT EDITABLE: a mute carries an optional note set AT mute time; changing your mind = unmute + re-mute.
-- So the API needs INSERT + DELETE (+ SELECT), NOT UPDATE. required-grants.json `writes` lists exactly that set;
-- the api grant-coverage gate parses THIS migration's GRANT to satisfy it (runner owns the grants), so this
-- migration must be merged for that gate to pass.
--
-- LIFECYCLE: check_id FK is ON DELETE CASCADE, so a check purge (0072 removed_at hard-delete) takes its mutes
-- with it — no orphan rows. Reconcile never touches this table (it's not a checks column + not in either
-- reconcile write allow-list), so a mute survives every reconcile until unmuted.
--
-- New table (NOT in the base schema.sql install until this migration; schema.sql gets the same block for fresh
-- installs). IDEMPOTENT: CREATE TABLE IF NOT EXISTS + guarded GRANT. BEGIN/COMMIT.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0076_error_mutes.sql

BEGIN;

CREATE TABLE IF NOT EXISTS error_mutes (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- the muted check; a check purge cascades its mutes away (no orphans).
    check_id    bigint NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
    -- the P1/P2 error fingerprint ({console|net}|level/status|origin|sourceHost|canonical) — opaque text here.
    fingerprint text NOT NULL,
    muted_at    timestamptz NOT NULL DEFAULT now(),
    -- who muted it (email from the API session), best-effort; NULL when unknown.
    muted_by    text NULL,
    -- optional operator note ("known third-party — tracked in JIRA-123"). Set at mute time; not editable.
    note        text NULL,
    -- one mute per (check, fingerprint) — a second mute of the same error is a no-op (ON CONFLICT on the API side).
    -- This unique index also serves the "load all mutes for a check" read (WHERE check_id = $1, leftmost prefix).
    CONSTRAINT error_mutes_check_fingerprint_key UNIQUE (check_id, fingerprint)
);

-- API: SELECT (list + the error-diff filter) + INSERT (mute) + DELETE (unmute). NO UPDATE — notes aren't editable
-- (unmute + re-mute to change one). The id is GENERATED ALWAYS AS IDENTITY — Postgres allocates it from the
-- table's OWN identity sequence, so no separate sequence USAGE grant is needed (table INSERT is sufficient).
DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synthwatch-api') THEN
        GRANT SELECT, INSERT, DELETE ON error_mutes TO "synthwatch-api";
    END IF;
END
$grant$;

COMMIT;
