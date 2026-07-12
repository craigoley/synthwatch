-- Migration 0074 — checks.environment_override: the per-check ENV OVERRIDE (env PR-3).
--
-- The env sequence: PR-1 (#237) unified env rendering; PR-2 (#275/#219) added env_domain_map +
-- inference at reconcile-apply, so `checks.environment` = manifest.environment ?? inferFromDomain(map)
-- ?? 'prod'. This is PR-3: a DASHBOARD-owned MANUAL override that WINS over that derived value.
--
-- ★ THE LOAD-BEARING CONSTRAINT. `checks.environment` is GIT-AUTHORITATIVE (in reconcile's
-- GIT_AUTHORITATIVE_COLUMNS → reconcile UPDATEs it every apply). So a manual override CANNOT live on that
-- column — reconcile would clobber it. environment_override is a SEPARATE column in NEITHER
-- GIT_AUTHORITATIVE_COLUMNS NOR SEED_ONLY_COLUMNS; reconcile only ever writes columns in those two
-- allow-lists, so this column is STRUCTURALLY invisible to a manifest apply / re-infer / backfill — it
-- survives every reconcile. This is exactly the property archived_at (0071) relies on; a reconcile-safety
-- test asserts it (runner/reconcile.test.ts). The runner does NOT read environment for behavior; the
-- non-prod exclusion lives in the API/dashboard readers, which now coalesce.
--
-- EFFECTIVE ENV (readers): coalesce(environment_override, environment). Full precedence:
--   1. environment_override (this column — manual, dashboard, survives reconcile)
--   2. manifest-declared environment (git)         }  these two + the fallback are already folded into
--   3. domain-map inference (PR-2)                 }  `environment` by reconcile-apply (PR-2)
--   4. 'prod' (DB default)
--
-- NULL = no override → use the derived environment. Set/cleared via PUT /api/checks/{id}/environment (the
-- api writes ONLY this column, never `environment`). Uses the existing checks UPDATE grant — NO new grant.
--
-- checks is a SHARED table (synthwatch-api maps it): the api schema-parity gate (fixture schema.sql +
-- EF Check.cs) MUST add environment_override in the paired api PR, or that gate fails BY DESIGN.
--
-- DEFAULT NULL (no override). New installs converge from db/schema.sql. Idempotent (IF NOT EXISTS). BEGIN/COMMIT.
-- Apply: psql "$DATABASE_URL" -f db/migrations/0074_checks_environment_override.sql

BEGIN;

ALTER TABLE checks ADD COLUMN IF NOT EXISTS environment_override TEXT
    CONSTRAINT checks_environment_override_vocab
    CHECK (environment_override IN ('prod', 'staging', 'dev'));

COMMIT;
