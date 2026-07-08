-- Migration 0063 — checks.redtest_anchor (browser red-test route-block pattern source; recon #55 gap A).
--
-- The browser red-test (runBrowserRedTest) ABORTS the anchor request the monitor's red-condition names
-- (route-block). Today that pattern is only a CLI arg (--fault=route-block:<pattern>), so a FLEET sweep
-- has no source for it. This column stores the per-monitor route-block pattern so the harness can read it
-- (check.redtest_anchor) instead of a hand-crafted --fault per monitor. NULL = no browser red-test anchor.
--
-- ★ #216 POSITIONAL-CONTRACT LESSON (deliberately avoided here): this column is NOT added to
-- GIT_AUTHORITATIVE_COLUMNS / buildApplyUpsert, so it does NOT enter the positional reconcile-apply plan
-- tuple (the array the API materialize reads by index — the #216 desync). Instead it is manifest-declared
-- and SCOPED-SYNCED by reconcile via a targeted `UPDATE checks SET redtest_anchor=$2 WHERE source_key=$1`
-- (mirrors the B10 sensitive/redact scoped sync in reconcileMain) — positional-safe, and it works even
-- while the field-split apply stays gated. So it touches NO plan tuple; the #216 trap cannot recur.
--
-- Git-authoritative-in-spirit (the manifest is its source; the scoped sync corrects drift), but plumbed
-- outside the plan. No CHECK (a free route-block glob string, validated in code). No new grant. New
-- installs converge from db/schema.sql. BEGIN/COMMIT.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0063_checks_redtest_anchor.sql

BEGIN;

ALTER TABLE checks ADD COLUMN IF NOT EXISTS redtest_anchor text;

COMMIT;
