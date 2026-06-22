-- Migration 0010 — CLS + INP (the two Core Web Vitals not yet captured).
--
-- Adds Tier-1 telemetry columns to run_metrics, populated passively off the
-- browser run (like the other Tier-1 metrics):
--   cls    — Cumulative Layout Shift (session-window score; 0 = stable page).
--   inp_ms — Interaction to Next Paint, ms. BEST-EFFORT: INP needs real user
--            interactions, so a pure load/assert flow (no clicks/keys) records
--            NULL. A flow that interacts (clicks, types) registers it. We do not
--            fabricate it.
--
-- ADDITIVE / expand-contract-safe: two nullable columns. NULL for non-browser
-- runs (and for browser runs predating this), so the deployed runner that ignores
-- them keeps working. New installs converge from db/schema.sql.
--
-- Apply with the migrate flow (db/migrate.sh) or:
--   psql "$DATABASE_URL" -f db/migrations/0010_cls_inp.sql
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS.

BEGIN;

ALTER TABLE run_metrics ADD COLUMN IF NOT EXISTS cls    DOUBLE PRECISION;
ALTER TABLE run_metrics ADD COLUMN IF NOT EXISTS inp_ms INTEGER;

COMMIT;
