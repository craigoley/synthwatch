-- Migration 0032 — incidents_opened_idx: back the GET /api/incidents keyset cursor.
--
-- synthwatch-api #79 paginates incidents with a KEYSET cursor ordered (opened_at DESC,
-- id DESC) over a date-range window. Without a matching index Postgres full-scans the
-- incidents table and sorts on every page; this index makes it an index range scan (the
-- incidents equivalent of runs_check_started_idx). The index column order MIRRORS the
-- cursor's ORDER BY EXACTLY (opened_at DESC, id DESC) — a mismatch and the planner won't
-- use it. #79 added this to the API's TEST-FIXTURE schema only; the runner owns production
-- schema, so this is the production migration.
--
-- ★ CONCURRENTLY (no table lock): incidents is append-heavy on a live DB, and a plain
-- CREATE INDEX takes an ACCESS EXCLUSIVE lock for the whole build (blocks evaluate.ts
-- opening/resolving incidents). CONCURRENTLY builds without blocking writers.
--
-- ★ NO TRANSACTION BLOCK (unlike sibling migrations): CREATE INDEX CONCURRENTLY cannot run
-- inside a transaction. migrate.sh applies each file with bare `psql -f` (NOT -1/
-- --single-transaction) and documents "each migration file manages its own BEGIN/COMMIT",
-- so a file with no BEGIN/COMMIT runs in autocommit — exactly what CONCURRENTLY needs. This
-- file therefore deliberately has NO BEGIN/COMMIT. (Caveat of the trade: if a CONCURRENTLY
-- build is interrupted it can leave an INVALID index; re-running is safe because IF NOT
-- EXISTS skips a same-named index — drop an invalid one by hand before re-applying if that
-- ever happens. Acceptable: incidents is small and this is a one-time build.)
--
-- New installs converge from db/schema.sql (which creates the same index, non-concurrently,
-- on the empty table).
-- Apply: psql "$DATABASE_URL" -f db/migrations/0032_incidents_opened_idx.sql  (IDEMPOTENT).

CREATE INDEX CONCURRENTLY IF NOT EXISTS incidents_opened_idx
    ON incidents (opened_at DESC, id DESC);
