-- 0094 — sandbox_preview.redact_credentials: the per-run "Redact credentials from output" toggle.
--
-- WHY IT IS PERSISTED. The Tests area can now run a credentialed preview with redaction OFF, which puts a
-- plaintext credential into that run's trace/stdout by design (the operator typed it and asked to see raw
-- output). A code-execution surface with OPTIONAL redaction needs a trail: WHO ran an unredacted preview
-- and WHEN. actor_email + requested_at already answer who/when; this column answers "with the guard off?".
-- Default TRUE = redaction ON, so every pre-existing row reads as redacted, which is what actually happened.
--
-- ★ LIFECYCLE IS API-OWNED. The api INSERTs the sandbox_preview row and sets this from the request body;
--   the sandbox job stays DB-LESS (it holds no Postgres credentials and never will — it runs uploaded code).
--   The runner's half of the trail is the job-log line in sandboxMain.
--
-- ★ SHARED TABLE. synthwatch-api maps sandbox_preview, so this REDS its schema-parity gate until the api's
--   tests/**/fixtures/schema.sql carries this column VERBATIM (PR2). That is the gate working as designed —
--   runner-first, then the fixture bump. See db/migrations/README.md.
--
-- Idempotent (IF NOT EXISTS): db/migrate.sh replays every migration on top of schema.sql, which also
-- carries this column for fresh installs.
ALTER TABLE sandbox_preview
  ADD COLUMN IF NOT EXISTS redact_credentials boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN sandbox_preview.redact_credentials IS
  'Per-run Tests-UI toggle. true = credentials scrubbed from trace/stdout/error/trace_signals (default); '
  'false = operator opted into raw output. Audit: who ran an UNREDACTED preview, and when.';
