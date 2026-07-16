-- 0088_canary_channel.sql
--
-- ★ Invert the notification canary: RECORD every run, EMAIL only on FAILURE. See runner/canary.ts.
--
-- WHY: the #298 canary dispatched a [TEST] alert through the REAL path to EVERY enabled channel on every
-- tick. On SUCCESS that delivered a "[SynthWatch][TEST] … WARNING" to the operator's alert inbox (a daily
-- nag that trains you to ignore it); on FAILURE the send simply didn't arrive and left only a runner_errors
-- row nobody was watching — exactly backwards. A check that emails when it PASSES and goes silent when it
-- FAILS is a fake-quiet. The runner change makes SUCCESS a recorded, pull-only fact and reserves the EMAIL
-- for the failure (and for the canary going silent — the staleness guard).
--
-- WHAT (this migration): a dedicated, DISABLED '__canary__' email channel. It is:
--   • the FK anchor + the discriminator for the canary's evidence rows in test_send_requests — a row whose
--     channel_id is this channel is a canary probe (vs a user-initiated "test this channel" send). The
--     canary's due-check and the staleness guard both key off channel_id = __canary__ (no new column on the
--     shared test_send_requests table — additive seed data only).
--   • NOT an alert-routing target: it is seeded `enabled = false` and gets NO alert_routes row, so
--     resolveChannels() never fans an incident out to it. The canary probe is delivered NOT to this channel's
--     recipients (its config is empty) but to CANARY_EMAIL_TO (runner env) — a deliverability mailbox the
--     operator does not watch, so a healthy canary is silent. Failures/staleness page the REAL critical
--     channels (resolveChannels(0,'critical')).
--
-- SHARED TABLE (channels): synthwatch-api maps it, but this is a SEED ROW (data), not a DDL change — no
-- column/constraint/index change, so the schema-parity gate (which compares STRUCTURE) does not red. The one
-- extra disabled row is inert for the api/dashboard (no route, not enabled).
--
-- Idempotent: name is UNIQUE, ON CONFLICT DO NOTHING. schema.sql carries the same seed for fresh installs.

BEGIN;

INSERT INTO channels (name, type, config, enabled)
VALUES ('__canary__', 'email', '{}'::jsonb, false)
ON CONFLICT (name) DO NOTHING;

COMMIT;
