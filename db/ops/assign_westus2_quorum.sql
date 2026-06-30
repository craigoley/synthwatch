-- Cutover ops (run ONCE, AFTER the westus2 runner job is deployed + ticking): register the 3rd region
-- and EXPLICITLY assign it to the checks that benefit from the 2-of-3 quorum.
--
-- WHO gets westus2: only checks ALREADY assigned to BOTH eastus2 AND centralus (the multi-region set).
-- That's the explicit, targeted rule the quorum needs — it makes those checks 2-of-3 instead of 2-of-2,
-- WITHOUT silently 3x-ing a single-region check that doesn't want the cost, and without leaving westus2
-- idle. (Today all 9 checks are multi-region, so all 9 get westus2.) New checks created after this auto-
-- include westus2 via locations.assignDefaultLocations (it defaults to every ENABLED registry row).
--
-- Ordering note: assigning a cursor BEFORE westus2 reports is harmless — aggregateVerdict counts only
-- REPORTING locations (a run within STALE_LOCATION), so an assigned-but-silent region never vetoes
-- paging. Still, deploy the job first so the cursors aren't idle.
-- Apply: psql "$DATABASE_URL" -f db/ops/assign_westus2_quorum.sql

BEGIN;

-- 1) Register westus2 as an active region (idempotent). assignDefaultLocations reads ENABLED rows, so
--    this also makes every future check default to 3 regions.
INSERT INTO locations (name, enabled) VALUES ('westus2', true)
ON CONFLICT (name) DO UPDATE SET enabled = true;

-- 2) Assign westus2 to the multi-region checks (in BOTH eastus2 and centralus). Idempotent.
INSERT INTO check_locations (check_id, location)
SELECT check_id, 'westus2'
  FROM check_locations
 GROUP BY check_id
HAVING count(*) FILTER (WHERE location = 'eastus2') > 0
   AND count(*) FILTER (WHERE location = 'centralus') > 0
ON CONFLICT (check_id, location) DO NOTHING;

COMMIT;

-- Verify: every multi-region check now has a westus2 cursor (expect westus2 count == both-region count).
-- SELECT location, count(*) FROM check_locations GROUP BY location ORDER BY location;
