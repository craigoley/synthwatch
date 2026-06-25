-- Migration 0033 — checks.spec_path: the monitors-repo spec path for runtime fetch (Phase 6b
-- Option C, slice 2).
--
-- Option C executes a check's Playwright spec by FETCHING it from synthwatch-monitors at run
-- start (no image rebuild). The hot path reads checks.spec_path DIRECTLY (the locked decision —
-- no per-tick manifest fetch). spec_path is the manifest `script` field for this monitor; it is
-- written when the check is created/reconciled (source_key = manifest id -> script -> spec_path;
-- see reconcile.specPathForSourceKey). NULL for non-Option-C checks (dashboard/native flows).
--
-- The defensive CHECK mirrors the runtime guard (specfetch/fetchSpec.assertValidSpecPath): under
-- monitors/, ends .spec.ts, no `..` traversal. The runtime guard is the real enforcement (it
-- also gates the fetch URL); this constraint is belt-and-suspenders so a direct DB write can't
-- seed an un-fetchable / traversal path.
--
-- New installs converge from db/schema.sql.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0033_spec_path.sql  (IDEMPOTENT).

BEGIN;

ALTER TABLE checks ADD COLUMN IF NOT EXISTS spec_path TEXT;

-- ADD CONSTRAINT has no IF NOT EXISTS — guard with a catalog check so re-apply is a no-op.
DO $spec_path_ck$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'checks_spec_path_shape') THEN
        ALTER TABLE checks ADD CONSTRAINT checks_spec_path_shape
            CHECK (
                spec_path IS NULL
                OR (spec_path ~ '^monitors/.+\.spec\.ts$' AND position('..' in spec_path) = 0)
            );
    END IF;
END
$spec_path_ck$;

COMMIT;
