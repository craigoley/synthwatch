-- OPERATIONAL (NOT an auto-migration) — relabel the original region 'default' -> 'eastus2'.
--
-- The existing runner is physically in eastus2 but labeled 'default' (SYNTHWATCH_LOCATION
-- was unset). This retires the 'default' label so the registry reads {eastus2, centralus}.
--
-- ★ RUN THIS AT CUTOVER, COORDINATED WITH THE JOB ENV-SWITCH. The existing job MUST have
--   SYNTHWATCH_LOCATION=eastus2 set (via the bicep redeploy / `az containerapp job update
--   --set-env-vars SYNTHWATCH_LOCATION=eastus2`) so it stops running as 'default'. If the
--   job still ran as 'default' after this relabel, its claim() lazy-insert would re-create
--   'default' cursors + write 'default' runs, undoing the relabel. Order:
--     1. Set SYNTHWATCH_LOCATION=eastus2 on synthwatch-runner-job (bicep / CLI).
--     2. Run THIS script.
--   (The script is race-safe either way — see the cursor step — but the env-switch is the
--    load-bearing requirement: the job must no longer be 'default'.)
--
-- RACE-SAFE + IDEMPOTENT: handles the case where the eastus2-switched job already
-- lazy-inserted an 'eastus2' cursor before this ran (re-runnable; a second run is a no-op
-- once no 'default' rows remain).
--   psql "$DATABASE_URL" -f db/ops/relabel_default_to_eastus2.sql

BEGIN;

-- Registry: add eastus2 (enabled), retire 'default'.
INSERT INTO locations (name, enabled) VALUES ('eastus2', true) ON CONFLICT (name) DO NOTHING;
DELETE FROM locations WHERE name = 'default';

-- Historical runs: runs has no per-location unique constraint, so a straight relabel of
-- every 'default' run is always safe.
UPDATE runs SET location = 'eastus2' WHERE location = 'default';

-- Cursors: relabel 'default' -> 'eastus2' ONLY where no 'eastus2' cursor already exists
-- (PK is (check_id, location); a lazy-created 'eastus2' cursor would collide), then drop
-- any leftover 'default' cursor (the eastus2 one already exists and is the live cadence).
UPDATE check_locations cl SET location = 'eastus2'
 WHERE cl.location = 'default'
   AND NOT EXISTS (
     SELECT 1 FROM check_locations e
      WHERE e.check_id = cl.check_id AND e.location = 'eastus2'
   );
DELETE FROM check_locations WHERE location = 'default';

COMMIT;
