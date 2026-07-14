-- 0085_audit_check_location_change.sql
--
-- ★ Make a check_locations add/REMOVE VISIBLE and ALARMED — without preventing it.
--
-- WHY: removing a location is an unlogged, unalarmed way to make a monitor stop being red, and it happened
-- TWICE in nine days — westus2 off checks 341+342 (Jul 5, failing 20.4% / 47.2%, 16 consecutive on 342) and
-- centralus off check 355, the flagship authenticated shop flow (Jul 13, failing 28.6%). In BOTH the platform
-- never paged (the majority quorum makes a single failing region structurally invisible), so the only remedy
-- left was to DELETE THE OBSERVATION. audit_log had ZERO record of either — check_locations is dashboard-owned
-- and its changes bypassed the audited API path, so git and audit_log both never knew.
--
-- WHAT: a best-effort, NEVER-BLOCKING trigger on check_locations INSERT/DELETE that
--   1. writes an audit_log row (who — best-effort via app.actor_email — when, which check, which location) and
--   2. records THE LOCATION'S FAILURE RATE OVER THE PRECEDING 24H — the sentence that makes the decision
--      reviewable ("centralus removed, was failing 28.6%"), and
--   3. on a REMOVAL of a location that was failing >= 10% in that window, ALSO writes a runner_errors row so it
--      is LOUD. It does NOT block — sometimes a bad egress IP is a real, correct reason. Make it loud, not illegal.
--
-- SAFETY:
--   • SECURITY DEFINER + fixed search_path: the audit/alarm INSERT succeeds regardless of the removing role's
--     grants, so it never turns a legitimate removal into a permission error.
--   • The whole body is wrapped in EXCEPTION WHEN OTHERS → the removal ALWAYS proceeds even if auditing fails
--     (a trigger error must never make a removal illegal). "Make it loud, not illegal" — literally.
--   • A CASCADE delete of the whole check (checks → check_locations ON DELETE CASCADE) is SKIPPED: the checks
--     row is already gone, so `EXISTS (checks)` is false → no spurious per-location audit when a check is deleted.
--   • The 10% threshold cleanly separates the real removals (20.4% / 47.2% / 28.6%) from a healthy region
--     (fleet up-rate is ~98-99%, i.e. <~2% failing); the audit ALWAYS records the exact rate regardless.
--   • Fires on INSERT/DELETE only, NOT the runner's frequent last_run_at UPDATE — so no per-run noise.
--
-- NOTE: migration number 0085; distinct from the "0085" single-region-WARNING code tag in evaluate.ts (#308) —
-- that feature had no migration. Idempotent: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS.

BEGIN;

CREATE OR REPLACE FUNCTION audit_check_location_change() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_check_id bigint;
  v_location text;
  v_runs     int;
  v_fail_pct numeric;
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN
      v_check_id := OLD.check_id;
      v_location := OLD.location;
      -- Skip a CASCADE delete of the whole check (its row is already gone) — that is a check deletion, not a
      -- coverage change, and auditing every location of a deleted check would be noise.
      IF NOT EXISTS (SELECT 1 FROM checks WHERE id = v_check_id) THEN
        RETURN OLD;
      END IF;
    ELSE
      v_check_id := NEW.check_id;
      v_location := NEW.location;
    END IF;

    -- The location's failure rate over the preceding 24h — the number that makes the decision reviewable.
    SELECT count(*),
           round(100.0 * count(*) FILTER (WHERE status IN ('fail','error')) / nullif(count(*), 0), 1)
      INTO v_runs, v_fail_pct
      FROM runs
     WHERE check_id = v_check_id AND location = v_location
       AND started_at >= now() - interval '24 hours';

    INSERT INTO audit_log (actor_email, action, target_type, target_id, before_json, after_json, note)
    VALUES (
      current_setting('app.actor_email', true),  -- best-effort actor: the app should SET this; NULL on a raw DB write
      CASE WHEN TG_OP = 'DELETE' THEN 'check_location.remove' ELSE 'check_location.add' END,
      'check', v_check_id::text,
      CASE WHEN TG_OP = 'DELETE'
           THEN jsonb_build_object('location', v_location, 'runs_24h', coalesce(v_runs, 0), 'fail_pct_24h', coalesce(v_fail_pct, 0))
           END,
      CASE WHEN TG_OP = 'INSERT' THEN jsonb_build_object('location', v_location) END,
      format('location %s %s check %s (last 24h: %s runs, %s%% failing)',
             v_location,
             CASE WHEN TG_OP = 'DELETE' THEN 'REMOVED from' ELSE 'added to' END,
             v_check_id, coalesce(v_runs, 0), coalesce(v_fail_pct, 0))
    );

    -- ★ ALARM (loud, not illegal): removing a location while it was materially failing is exactly the
    -- "manufacture a green light by deleting the thing going red" move. Record it — do NOT block it.
    IF TG_OP = 'DELETE' AND coalesce(v_fail_pct, 0) >= 10 THEN
      INSERT INTO runner_errors (invocation_id, phase, check_id, message)
      VALUES (
        'db-trigger', 'check_location.remove', v_check_id,
        format('Location %s removed from check %s while FAILING %s%% over the last 24h (%s runs). Coverage shrank '
               || 'silently and the removal is unpaged by design — verify this was intentional (e.g. a bad egress IP) '
               || 'and not a way to clear a red. See audit_log.', v_location, v_check_id, v_fail_pct, v_runs)
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Never block the removal on an auditing failure. Loud in the logs, but the DML proceeds.
    RAISE WARNING 'audit_check_location_change failed for check % location % (%): %',
      coalesce(v_check_id, -1), coalesce(v_location, '?'), TG_OP, SQLERRM;
  END;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_check_location ON check_locations;
CREATE TRIGGER trg_audit_check_location
  AFTER INSERT OR DELETE ON check_locations
  FOR EACH ROW EXECUTE FUNCTION audit_check_location_change();

COMMIT;
