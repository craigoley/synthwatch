-- Migration 0079 — runs.transient_class (B3-2 stage 2): classify a SUPERSEDED transient.
--
-- CONTEXT: 0077/#291 made a self-healed failure VISIBLE (superseded_by_run_id) for every kind. B3-2 stage 1
-- surfaced flap/retry/monitor-noise as distinct trust dimensions. This adds the missing dimension's backing:
-- WHOSE FAULT was the transient?
--   • monitor-side  — the red was a monitor-side assertion / selector race; the service was up. The monitor
--                     cried wolf. (222's "grid rendered 0 rows" paint race.)
--   • service-side  — the failing run carried a NEW first-party service failure (a first-party fetch/xhr/doc
--                     that failed, absent from the last-N settled baseline). A real, if brief, outage the
--                     monitor CAUGHT and told the truth about. (355's Wegmans "Failed to fetch".)
--   • indeterminate — the failing run captured no trace_signals (http/dns/ssl, or a strand) — we don't guess.
--
-- ★ THE SAFETY PROPERTY THIS ENABLES (B3-3): the flake budget burns ONLY monitor-side transients. A
-- service-side transient is a real outage and must NOT penalise the monitor that caught it — otherwise "the
-- flakier your service, the quieter your monitoring". The classification is written by the runner at
-- supersede-time (evaluate.applyRunSideEffects → classifyTransient), NEVER used to mute an alert.
--
-- COLUMN (runs is a SHARED table — the synthwatch-api schema-parity fixture + EF entity are patched in the
-- paired API PR): runs.transient_class TEXT, set ONLY on a superseded transient; NULL otherwise.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS + a named CHECK added only when absent. Metadata-only (a nullable
-- column + a NOT VALID-free CHECK on an all-NULL column validates instantly) — safe on the live runs table.

ALTER TABLE runs ADD COLUMN IF NOT EXISTS transient_class TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'runs_transient_class_check') THEN
    ALTER TABLE runs ADD CONSTRAINT runs_transient_class_check
      CHECK (transient_class IS NULL OR transient_class IN ('monitor-side', 'service-side', 'indeterminate'));
  END IF;
END $$;
