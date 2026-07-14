-- 0087_runs_location_not_null.sql
--
-- ★ RECONCILE THE ONE STRUCTURAL PROD↔schema.sql DRIFT. schema.sql has `location TEXT NOT NULL DEFAULT
-- 'default'` (schema.sql line 341) and a from-scratch replay agrees — but PROD's runs.location is NULLABLE.
-- Someone tightened schema.sql and never wrote the migration, so prod never got the constraint. A restore
-- (schema.sql + migrations) would therefore GAIN a constraint the running DB lacks: the artifact you would
-- restore from is not the database you are running. The direction is SAFE (a restore only GAINS NOT NULL), but
-- it is real, unreconciled drift and nothing was watching. This migration is that missing write. (Found by the
-- three-way recon; Gate A [CI schema.sql↔replay] + Gate B [scheduled prod↔replay] make this class visible.)
--
-- ★ RE-CONFIRM 0 NULLS AT APPLY TIME — do not trust a stale count. The guard below re-counts runs.location
-- NULLs in the SAME transaction as the ALTER, against the REAL target DB (the truest "immediately before"), and
-- aborts with an actionable message if any exist. A bare SET NOT NULL would also fail on a NULL, but opaquely
-- and only after a full validating scan; this fails first, loudly, and rolls back (BEGIN/COMMIT) rather than
-- wedging a deploy. 0 nulls in 126,147 rows at recon.
--
-- schema.sql ALREADY carries NOT NULL, so this changes NO shared-object shape the api mirrors → no paired
-- fixture PR. On a fresh DB / replay the column is already NOT NULL, so the ALTER is a harmless no-op and the
-- guard sees 0 rows.

BEGIN;

DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM runs WHERE location IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'runs.location has % NULL row(s) — backfill before SET NOT NULL (0087 expected 0)', n;
  END IF;
END $$;

ALTER TABLE runs ALTER COLUMN location SET NOT NULL;

COMMIT;
