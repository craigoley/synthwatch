# SynthWatch — Live Database Schema Snapshot

> **Generated from the live Postgres database (`synthwatch`) on 2026-06-21.**
> This is **ground truth**, queried directly from the running database — not from
> `db/schema.sql` and not from memory. Use it to reconcile assumptions against
> reality; we have had repeated drift between assumed and actual schema.
>
> **Database:** `synthwatch` · **Postgres:** 16
> **Tables documented:** `checks`, `runs`, `run_steps`, `run_metrics`, `incidents`

## How to regenerate

Run against the live DB (requires `source ~/.synthwatch.env` for `DATABASE_URL`
and the `psql` PATH), then fold the output into this file:

```bash
source ~/.synthwatch.env

# 1. Columns
psql "$DATABASE_URL" -c "SELECT table_name, ordinal_position, column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name IN ('checks','runs','run_steps','run_metrics','incidents')
  ORDER BY table_name, ordinal_position;"

# 2. CHECK constraints
psql "$DATABASE_URL" -c "SELECT rel.relname, con.conname, pg_get_constraintdef(con.oid)
  FROM pg_constraint con JOIN pg_class rel ON rel.oid=con.conrelid
  JOIN pg_namespace n ON n.oid=rel.relnamespace
  WHERE n.nspname='public' AND con.contype='c'
    AND rel.relname IN ('checks','runs','run_steps','run_metrics','incidents')
  ORDER BY rel.relname, con.conname;"

# 3. PK / FK
psql "$DATABASE_URL" -c "SELECT rel.relname, con.contype, con.conname, pg_get_constraintdef(con.oid)
  FROM pg_constraint con JOIN pg_class rel ON rel.oid=con.conrelid
  JOIN pg_namespace n ON n.oid=rel.relnamespace
  WHERE n.nspname='public' AND con.contype IN ('p','f')
    AND rel.relname IN ('checks','runs','run_steps','run_metrics','incidents')
  ORDER BY rel.relname, con.contype DESC, con.conname;"

# 4. Indexes
psql "$DATABASE_URL" -c "SELECT tablename, indexname, indexdef FROM pg_indexes
  WHERE schemaname='public' AND tablename IN ('checks','runs','run_steps','run_metrics','incidents')
  ORDER BY tablename, indexname;"

# 5. SLA views + function
psql "$DATABASE_URL" -c "\dv"
psql "$DATABASE_URL" -c "\df+ sla_availability"

# 6. Row counts
psql "$DATABASE_URL" -c "SELECT count(*) FROM checks;"   # repeat per table
```

---

## ⚠️ Status taxonomy callout (read this first)

The single most drift-prone fact in this schema. Confirmed from the **live CHECK
constraints**:

| Column | Live CHECK constraint | Permitted values |
| --- | --- | --- |
| `runs.status` | `runs_status_check` | **`pass`, `warn`, `fail`, `error`, `running`** |
| `run_steps.status` | `run_steps_status_check` | **`pass`, `fail`, `error`** |
| `incidents.status` | `incidents_status_check` | `open`, `resolved` |
| `checks.kind` | `checks_kind_check` | `http`, `browser` |
| `checks.severity` / `incidents.severity` | `*_severity_check` | `critical`, `warning` |

> **Update 2026-06-21 (taxonomy widened):** the runner widened `runs.status` from the
> original `('pass','fail')` to **`('pass','warn','fail','error','running')`** and
> `run_steps.status` to **`('pass','fail','error')`**. Re-verified directly against the live
> CHECK constraints, and live data now contains `warn`/`error` rows. This supersedes the
> original `('pass','fail')`-only constraint (and the former `'fail'` default).

**`runs.status` now permits `pass`, `warn`, `fail`, `error`, `running`** (the full intended
taxonomy); **`run_steps.status` permits `pass`, `fail`, `error`** (steps have no
`warn`/`running`). The default for `runs.status` is now **`'running'`** (changed from `'fail'`
by migration `0003_widen_status.sql`): a row is inserted in-flight as `running`, then updated
to its terminal status (`pass`/`warn`/`fail`/`error`) on completion.

> Implication for the SLA work: `sla_availability` classifies with the full taxonomy —
> `up = (pass,warn)`, `down = (fail,error)`, `running` excluded from completed runs. Now that
> the constraint is widened, all of these values can actually appear, so the availability math
> exercises the full classification (it no longer collapses to just `up = pass, down = fail`).

---

## Table: `checks`

The catalogue of monitored targets. **20 columns.** Row count: **2**.

| # | Column | Type | Nullable | Default |
| --- | --- | --- | --- | --- |
| 1 | `id` | bigint | NO | generated always as identity |
| 2 | `name` | text | NO | — |
| 3 | `kind` | text | NO | — |
| 4 | `target_url` | text | NO | — |
| 5 | `flow_name` | text | YES | — |
| 6 | `method` | text | NO | `'GET'::text` |
| 7 | `expected_status` | integer | NO | `200` |
| 8 | `body_must_contain` | text | YES | — |
| 9 | `interval_seconds` | integer | NO | `300` |
| 10 | `last_run_at` | timestamptz | YES | — |
| 11 | `timeout_ms` | integer | NO | `30000` |
| 12 | `failure_threshold` | integer | NO | `3` |
| 13 | `severity` | text | NO | `'critical'::text` |
| 14 | `enabled` | boolean | NO | `true` |
| 15 | `created_at` | timestamptz | NO | `now()` |
| 16 | `lighthouse_enabled` | boolean | NO | `false` |
| 17 | `lighthouse_interval_seconds` | integer | YES | — |
| 18 | `lighthouse_form_factor` | text | NO | `'desktop'::text` |
| 19 | `perf_budget_lcp_ms` | integer | YES | — |
| 20 | `perf_budget_transfer_bytes` | bigint | YES | — |

**CHECK constraints**
- `browser_needs_flow`: `CHECK ((kind <> 'browser') OR (flow_name IS NOT NULL))`
- `checks_failure_threshold_check`: `CHECK (failure_threshold > 0)`
- `checks_interval_seconds_check`: `CHECK (interval_seconds > 0)`
- `checks_kind_check`: `CHECK (kind = ANY (ARRAY['http','browser']))`
- `checks_severity_check`: `CHECK (severity = ANY (ARRAY['critical','warning']))`
- `checks_timeout_ms_check`: `CHECK (timeout_ms > 0)`

**Primary key**
- `checks_pkey`: `PRIMARY KEY (id)`

**Foreign keys** — none.

**Indexes**
- `checks_pkey` — `UNIQUE btree (id)`

---

## Table: `runs`

One row per check execution (one row per claim). **10 columns.** Row count: **46**.

| # | Column | Type | Nullable | Default |
| --- | --- | --- | --- | --- |
| 1 | `id` | bigint | NO | generated always as identity |
| 2 | `check_id` | bigint | NO | — |
| 3 | `status` | text | NO | `'running'::text` |
| 4 | `started_at` | timestamptz | NO | `now()` |
| 5 | `finished_at` | timestamptz | YES | — |
| 6 | `duration_ms` | integer | YES | — |
| 7 | `http_status` | integer | YES | — |
| 8 | `error_message` | text | YES | — |
| 9 | `failed_step` | text | YES | — |
| 10 | `screenshot_url` | text | YES | — |

**CHECK constraints**
- `runs_status_check`: `CHECK (status = ANY (ARRAY['pass','warn','fail','error','running']))` — see [status callout](#️-status-taxonomy-callout-read-this-first).

**Primary key**
- `runs_pkey`: `PRIMARY KEY (id)`

**Foreign keys**
- `runs_check_id_fkey`: `FOREIGN KEY (check_id) REFERENCES checks(id) ON DELETE CASCADE`

**Indexes**
- `runs_pkey` — `UNIQUE btree (id)`
- `runs_check_started_idx` — `btree (check_id, started_at DESC)` — hot path; backs both the runner's recent-runs lookups and the SLA per-check aggregate.

---

## Table: `run_steps`

Structural funnel telemetry: one row per `StepRecorder.step()`. **8 columns.** Row count: **22**.

| # | Column | Type | Nullable | Default |
| --- | --- | --- | --- | --- |
| 1 | `id` | bigint | NO | generated always as identity |
| 2 | `run_id` | bigint | NO | — |
| 3 | `step_index` | integer | NO | — |
| 4 | `name` | text | NO | — |
| 5 | `status` | text | NO | — |
| 6 | `duration_ms` | integer | NO | — |
| 7 | `error_message` | text | YES | — |
| 8 | `started_at` | timestamptz | NO | `now()` |

**CHECK constraints**
- `run_steps_status_check`: `CHECK (status = ANY (ARRAY['pass','fail','error']))`

**Primary key**
- `run_steps_pkey`: `PRIMARY KEY (id)`

**Foreign keys**
- `run_steps_run_id_fkey`: `FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE`

**Indexes**
- `run_steps_pkey` — `UNIQUE btree (id)`
- `run_steps_run_idx` — `btree (run_id, step_index)`

---

## Table: `run_metrics`

Tier-1 per-run telemetry; one row per **browser** run (HTTP checks write nothing
here). Every metric is nullable — a capture failure must never fail the check.
**15 columns.** Row count: **11**.

| # | Column | Type | Nullable | Default |
| --- | --- | --- | --- | --- |
| 1 | `id` | bigint | NO | generated always as identity |
| 2 | `run_id` | bigint | NO | — |
| 3 | `ttfb_ms` | integer | YES | — |
| 4 | `dom_content_loaded_ms` | integer | YES | — |
| 5 | `load_event_ms` | integer | YES | — |
| 6 | `fcp_ms` | integer | YES | — |
| 7 | `lcp_ms` | integer | YES | — |
| 8 | `transfer_bytes` | bigint | YES | — |
| 9 | `resource_count` | integer | YES | — |
| 10 | `dom_node_count` | integer | YES | — |
| 11 | `js_heap_bytes` | bigint | YES | — |
| 12 | `cpu_time_ms` | integer | YES | — |
| 13 | `layout_count` | integer | YES | — |
| 14 | `recalc_style_count` | integer | YES | — |
| 15 | `captured_at` | timestamptz | NO | `now()` |

**CHECK constraints** — none.

**Primary key**
- `run_metrics_pkey`: `PRIMARY KEY (id)`

**Foreign keys**
- `run_metrics_run_id_fkey`: `FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE`

**Indexes**
- `run_metrics_pkey` — `UNIQUE btree (id)`
- `run_metrics_run_id_key` — `UNIQUE btree (run_id)` — enforces one metrics row per run (from the `UNIQUE` on `run_id`).

---

## Table: `incidents`

Open/resolved incident lifecycle per check, debounced against flapping. **10 columns.** Row count: **1**.

| # | Column | Type | Nullable | Default |
| --- | --- | --- | --- | --- |
| 1 | `id` | bigint | NO | generated always as identity |
| 2 | `check_id` | bigint | NO | — |
| 3 | `status` | text | NO | — |
| 4 | `severity` | text | NO | — |
| 5 | `opened_at` | timestamptz | NO | `now()` |
| 6 | `resolved_at` | timestamptz | YES | — |
| 7 | `opened_run_id` | bigint | YES | — |
| 8 | `resolved_run_id` | bigint | YES | — |
| 9 | `consecutive_failures` | integer | NO | `0` |
| 10 | `summary` | text | YES | — |

**CHECK constraints**
- `incidents_severity_check`: `CHECK (severity = ANY (ARRAY['critical','warning']))`
- `incidents_status_check`: `CHECK (status = ANY (ARRAY['open','resolved']))`

**Primary key**
- `incidents_pkey`: `PRIMARY KEY (id)`

**Foreign keys**
- `incidents_check_id_fkey`: `FOREIGN KEY (check_id) REFERENCES checks(id) ON DELETE CASCADE`
- `incidents_opened_run_id_fkey`: `FOREIGN KEY (opened_run_id) REFERENCES runs(id)`
- `incidents_resolved_run_id_fkey`: `FOREIGN KEY (resolved_run_id) REFERENCES runs(id)`

**Indexes**
- `incidents_pkey` — `UNIQUE btree (id)`
- `one_open_incident_per_check` — `UNIQUE btree (check_id) WHERE (status = 'open')` — partial unique index; at most one open incident per check.

---

## SLA view / function inventory

Added by the SLA reporting work (migration `db/migrations/0002_sla_view.sql`,
mirrored into `db/schema.sql`). All present in the live DB.

**Function**

| Name | Arguments | Returns | Language | Volatility |
| --- | --- | --- | --- | --- |
| `sla_availability` | `p_from timestamptz, p_to timestamptz` | `TABLE(check_id bigint, check_name text, kind text, window_from timestamptz, window_to timestamptz, completed_runs bigint, up_runs bigint, down_runs bigint, availability_pct numeric)` | `sql` | `STABLE` |

Comment (live): *"Per-check availability over [p_from, p_to). up=(pass,warn) /
completed=(pass,warn,fail,error); running excluded. On-demand, index-assisted."*

**Views** (each a thin wrapper over the function with a fixed window):

| View | Definition |
| --- | --- |
| `sla_availability_24h` | `SELECT * FROM sla_availability(now() - interval '24 hours', now())` |
| `sla_availability_7d` | `SELECT * FROM sla_availability(now() - interval '7 days', now())` |
| `sla_availability_30d` | `SELECT * FROM sla_availability(now() - interval '30 days', now())` |

---

## Row counts (what is seeded)

| Table | Rows |
| --- | --- |
| `checks` | 2 |
| `runs` | 46 |
| `run_steps` | 22 |
| `run_metrics` | 11 |
| `incidents` | 1 |

---

## Drift notes — live DB vs `db/schema.sql`

Compared the live database (above) against `db/schema.sql` on `main` at the time
of generation, across columns, types, nullability, defaults, CHECK constraints,
PK/FK, indexes, and the SLA function/views.

**Result: NO DRIFT. The live database and `db/schema.sql` are in full agreement.**

Specifically verified to match:

- **All five tables, every column** — name, type, nullability, and default all
  match `db/schema.sql`. This includes the `checks` Lighthouse / perf-budget
  columns (`lighthouse_enabled`, `lighthouse_interval_seconds`,
  `lighthouse_form_factor`, `perf_budget_lcp_ms`, `perf_budget_transfer_bytes`),
  which are present both live and in `schema.sql` (added via migration
  `0001_run_metrics.sql`).
- **All CHECK constraints** — including the widened `runs.status`
  (`'pass','warn','fail','error','running'`) and `run_steps.status`
  (`'pass','fail','error'`) from migration `0003_widen_status.sql`, matching the file
  (`db/schema.sql` carries the same widened constraints, so live and file still agree).
- **All PK/FK** — including the three `incidents` foreign keys and every
  `ON DELETE CASCADE`.
- **All indexes** — `runs_check_started_idx (check_id, started_at DESC)`,
  `run_steps_run_idx`, the partial `one_open_incident_per_check`, and the
  `run_metrics` unique on `run_id`.
- **SLA objects** — `sla_availability(timestamptz, timestamptz)` plus the 24h /
  7d / 30d views exist live and match the definitions appended to `schema.sql`.

> Note: `db/schema.sql` declares the SLA objects inside `CREATE OR REPLACE`
> blocks at the end of the file (mirroring `0002_sla_view.sql`), so a fresh
> `psql -f db/schema.sql` install converges to the same state as the migrated
> live database. No reconciliation action required.
