-- ============================================================================
-- ONE-TIME BACKFILL — adopt existing browser checks under their manifest id.
-- Phase 6b, monitors-as-code. ★ DO NOT APPLY BLIND — see the mapping analysis below.
-- ============================================================================
--
-- WHY THIS IS HAND-CURATED (the landmine the 6b design flagged): the manifest `id` is
-- NOT the runner `flow_name`. The reconcile keys on checks.source_key = manifest id, so
-- if we adopt the WRONG existing row under a manifest id, every later reconcile is wrong
-- (it would "change"/"missing" the wrong check). So the mapping is reviewed by a human
-- ONCE, here, before any source_key is written. After this, reconcile maintains it.
--
-- ── REALITY AS OF 2026-06-25 (live DB) ──────────────────────────────────────
--   Live browser checks:
--     id=2  "Wegmans homepage"   flow_name=homepage-load   target=https://www.wegmans.com/
--   (the other live checks — API health, Wegmans cert, CORS, rca-demo — are http/ssl,
--    NOT browser, and the manifest is browser-only, so they are out of scope entirely.)
--
--   Manifest monitors (synthwatch-monitors/manifest.json):
--     wegmans-search-product   script .../search-product.spec.ts   -> flow 'search-product'
--     wegmans-recipe-nav       script .../recipe-nav.spec.ts       -> flow 'recipe-nav'
--     synthwatch-self-homepage script .../dashboard-homepage.spec.ts-> flow 'dashboard-homepage'
--
--   Compiled runner flows (runner/checks/): homepage-load, wegmans-homepage, wegmans-search
--
-- ── PROPOSED MAPPING (manifest id -> existing check) ────────────────────────
--   wegmans-search-product   -> (none)   NO confident live check. "Wegmans homepage" is a
--                                         generic homepage load, NOT the search->product
--                                         journey. Adopting it would be wrong.
--   wegmans-recipe-nav       -> (none)   No recipe-nav check exists live.
--   synthwatch-self-homepage -> (none)   No SynthWatch self-monitor check exists live.
--
--   => THE MAPPING IS EMPTY. No existing row should be adopted. All three manifest
--      monitors are genuinely NEW; the live "Wegmans homepage" check (id=2) stays
--      UNMANAGED (source_key NULL) — it has no manifest counterpart and reconcile
--      ignores it. (Reconcile also reports all three as ORPHAN: none has a compiled
--      runner flow yet — spec execution is deferred to a later phase.)
--
-- ── CRAIG, CONFIRM ONE OF: ───────────────────────────────────────────────────
--   (A) Accept the empty mapping (recommended). Apply NOTHING here; the next PR's apply
--       step will INSERT the three monitors fresh. Leave id=2 unmanaged. -> do nothing.
--   (B) Adopt id=2 "Wegmans homepage" under a manifest id. Only valid if you ALSO add a
--       matching monitor to the manifest (e.g. a 'wegmans-homepage' entry bound to the
--       'wegmans-homepage'/'homepage-load' flow). Then uncomment + edit the template below.
--
-- The statements below are COMMENTED OUT. Nothing runs until a human uncomments them.
-- Apply (after uncommenting): psql "$DATABASE_URL" -f db/ops/backfill_source_key.sql

BEGIN;

-- TEMPLATE — uncomment + set the (manifest id, existing check id) pair PER ADOPTED ROW.
-- The WHERE source_key IS NULL guard makes this safe to re-run and refuses to stomp a
-- row already managed by Git.
--
-- UPDATE checks SET source_key = '<manifest-id>'
--  WHERE id = <existing-check-id> AND kind = 'browser' AND source_key IS NULL;

-- (A) Empty mapping: no adoptions. This file is a no-op as shipped.

COMMIT;
