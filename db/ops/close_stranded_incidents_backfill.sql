-- ONE-TIME BACKFILL — close the incidents already stranded on stopped monitors before 0095 shipped.
--
-- ★ OPERATOR-RUN, GATED BY CRAIG — NOT a migration. A migration must not mutate incident state (it would
--   re-run against every fresh DB / restore and there is nothing to close there). This is the same shape as
--   db/ops/backfill_source_key.sql: run once, by hand, against prod, deliberately.
--
-- It is exactly the reconcile's own statement (runner/staleIncidents.ts CLOSE_STRANDED_INCIDENTS_SQL) — the
-- deployed runner will close these on its next tick anyway; this only closes them IMMEDIATELY instead of
-- waiting for the first post-deploy tick. Idempotent: `i.status='open'` means a second run touches nothing.
--
-- As of the 2026-07 recon this closes exactly TWO rows:
--   inc 178  check "Wegmans Authorized User Add to Cart"  enabled=false, not archived  -> monitor_paused
--   inc 34   check "rca-demo"                             enabled=false AND archived   -> monitor_archived
-- Preview them first:
--   SELECT i.id, c.name, c.enabled, c.archived_at, c.removed_at
--     FROM incidents i JOIN checks c ON c.id = i.check_id
--    WHERE i.status='open' AND NOT (c.enabled AND c.archived_at IS NULL);

UPDATE incidents i
   SET status = 'resolved',
       resolved_at = now(),
       resolution_reason = CASE
         WHEN c.removed_at  IS NOT NULL THEN 'monitor_removed'
         WHEN c.archived_at IS NOT NULL THEN 'monitor_archived'
         ELSE 'monitor_paused'
       END
  FROM checks c
 WHERE i.check_id = c.id
   AND i.status = 'open'
   AND NOT (c.enabled AND c.archived_at IS NULL)
RETURNING i.id, i.check_id, i.resolution_reason;
