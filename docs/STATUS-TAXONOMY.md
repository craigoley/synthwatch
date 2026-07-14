# Status taxonomy — recon findings

> _Verified 2026-07-14 — the STATUS ENUM below is **tripwire-enforced** (`runner/statusTaxonomyDoc.test.ts`); the surrounding **prose** (when each status is emitted, what it means) has **no automated check** — if it disagrees with the code, the code wins._
>
> ### ★ CURRENT TRUTH (read this — the body below is a superseded 2026-06-21 recon)
> `runs.status` has **SIX** values today: `pass | warn | fail | error | infra_error |
> running` (`db/schema.sql` → `runs_status_check`, via `0003_widen_status.sql` +
> `0035_infra_error_status.sql`). A run is **inserted as `running`** and updated to a
> terminal status on finish; a crashed runner's stale `running` is reaped to `error`;
> `infra_error` means the runner could not fetch an Option-C spec (not a monitor outage).
> **The statements below that "the runner only ever emits pass/fail" and that the row is
> inserted as `fail` are NO LONGER TRUE** — they describe the pre-widening state and are
> kept only as the original recon record. For the live taxonomy, trust `db/schema.sql`.

<!-- ★ STATUS ENUM — tripwire-enforced by runner/statusTaxonomyDoc.test.ts: the list between the markers below
     MUST equal RunStatus in runner/db.ts AND runs_status_check in db/schema.sql, exactly. The test reds BY NAME
     in either direction (a status here but not in code = the doc invents one; a status in code but not here =
     the doc under-describes). Add a status only by changing the code enum + this list together. -->
<!-- STATUS-ENUM:START -->
`pass` · `warn` · `fail` · `error` · `infra_error` · `running`
<!-- STATUS-ENUM:END -->

## TL;DR (⚠️ HISTORICAL — 2026-06-21, superseded; see "CURRENT TRUTH" above)

- **The runner only ever emits `pass` or `fail` for `runs.status`.** `warn`,
  `error`, and `running` are **never computed** — not computed-then-coerced,
  simply never produced. The code's own types forbid them.
- **Perf budgets are write-only schema with no consumer.** `perf_budget_lcp_ms`
  and `perf_budget_transfer_bytes` are **never read** anywhere in the runner.
  Setting a perf budget on a check today **has no effect**: no `warn`, no
  incident, no log line — nothing evaluates it.
- The live `runs_status_check` constraint (`('pass','fail')`) is therefore not a
  limitation the runner is fighting against — the runner has no code that would
  ever try to write anything else.

---

## 1. `evaluate.ts` — does it compute `warn`/`error`? Is any perf budget evaluated?

**Observed (not inferred):** No, to both.

`evaluate()` *consumes* a status; it does not decide one. It receives a
`RunRecord` (whose `status` is typed `'pass' | 'fail'`) and branches:

```ts
// runner/evaluate.ts:18
if (run.status === 'pass') { /* resolve open incident */ return; }
// ...everything below treats the run as a failure...
```

- There is **no reference to `'warn'` or `'error'`** anywhere in `evaluate.ts`.
- There is **no reference to `perf_budget_*`** (or `lighthouse_*`) anywhere in
  `evaluate.ts` — no budget comparison, no breach detection.
- `countConsecutiveFailures()` (`evaluate.ts:82`) counts only rows where
  `status === 'fail'`. So status decisions and perf budgets play no part here.

`evaluate.ts` is purely the incident debounce layer; status is already decided by
the time a run reaches it.

## 2. Exception vs. assertion failure — is `error` attempted, or is everything `fail`?

**Observed:** Everything becomes `fail`. `error` is never attempted.

The run result is modelled as a **boolean**, not a status string
(`runner/index.ts`):

```ts
interface Outcome { ok: boolean; httpStatus; durationMs; error; failedStep; screenshot }
```

There is no representation for "warn"/"error"/"running" in `Outcome` at all. The
browser path (`executeBrowser`, `index.ts:178`) collapses *every* throw into the
same branch:

```ts
try { await flow(rec); return { ok: true,  ... }; }
catch (err) {            return { ok: false, ... error: err.message ... }; }
```

A Playwright assertion failure, a thrown `Error` from the flow, a navigation
timeout, a selector-not-found — all land in that single `catch` → `ok: false`.
The runner-level `catch` in `runOne` (`index.ts:98`, e.g. the flow loader
throwing) likewise → `ok: false`. `httpCheck.ts` does the same: a network
exception is caught and returned as `{ ok: false }` (`httpCheck.ts:55`),
indistinguishable from a clean assertion miss like a wrong status code.

The exception **message** is preserved in `runs.error_message`, but the
**status** is uniformly `fail`. So the design's intended distinction
"exception → `error`, assertion failure → `fail`" **does not exist in code** —
it isn't computed and coerced, it's simply never computed.

## 3. The `runs.status` write path — exact emittable values

There are exactly **two** write sites, both in `runner/index.ts`:

| Site | Statement | Value written |
| --- | --- | --- |
| `index.ts:87` | `INSERT INTO runs (..., status) VALUES ($1, now(), 'fail')` | literal `'fail'` (pessimistic insert) |
| `index.ts:116` | `UPDATE runs SET status = $2 ...` | `outcome.ok ? 'pass' : 'fail'` (`index.ts:122`) |

**The complete set of values the code can emit for `runs.status` is `{ 'pass',
'fail' }`.** This is enforced structurally, not just by convention:

- `Outcome.ok` is a `boolean`.
- `RunRecord.status` (`db.ts:34`) is typed `'pass' | 'fail'`.
- The `'pass' | 'fail'` ternary is the only producer.

Cross-reference (⚠️ historical — the constraint has since widened to **six** values;
see `db/schema.sql` → `runs_status_check`): at 2026-06-21 the live `runs_status_check`
permitted exactly `('pass','fail')`. **Code and constraint agreed** then — no longer.

Side note on `running`: the in-flight row is inserted as `'fail'`, **not**
`'running'` (`index.ts:87` — pessimistic so a crash leaves an honest failure). So
`running` is never written either, and the SLA function's "exclude `running`"
clause is currently a no-op (no row is ever `running`).

## 4. Perf budgets — read anywhere, or write-only?

**Observed:** Write-only. **Zero** consumers.

```
$ grep -rniE "perf_budget|lighthouse" runner/**/*.ts   # → no matches
```

- `perf_budget_lcp_ms` / `perf_budget_transfer_bytes` are **not read** by any
  runner module.
- They are **not even present on the `Check` TypeScript interface** (`db.ts:13`),
  so although `claim()` does `SELECT *` and the columns ride along in the row
  object at runtime, no typed code accesses them.
- `metrics.ts` **captures** `lcp_ms` and `transfer_bytes` into the `run_metrics`
  table but performs **no comparison** against any budget — it has no
  budget/threshold/breach logic at all (it only ever `INSERT`s into
  `run_metrics`; it never touches `runs.status`).
- Same story for the `lighthouse_*` columns: config-only, no consumer.

**The gap, stated plainly:** the shipped `perf_budget_*` columns currently have
**no effect**. A check configured with a perf budget behaves identically to one
without. Nothing turns a budget breach into a `warn`, an incident, or any signal.

---

## Recommendation (for a FUTURE PR — not this one)

The SLA function (`sla_availability`) already classifies with all five statuses
(`up = pass,warn` / `down = fail,error` / `running` excluded), so the reporting
layer is **already forward-compatible**. To make the taxonomy real, a future PR
would need:

1. **Schema:** widen `runs_status_check` to
   `('pass','warn','fail','error','running')`. (Additive migration + mirror into
   `db/schema.sql`. Optionally insert the run as `'running'` and flip to a final
   status, to make in-flight visible and give the SLA "exclude running" clause a
   real job.)
2. **Model the result as a status, not a boolean.** Replace `Outcome.ok:
   boolean` and `RunRecord.status: 'pass' | 'fail'` with a status enum so the
   later stages can carry `warn`/`error`.
3. **Distinguish exception → `error`.** In the `executeBrowser` / `executeHttp`
   catch paths, classify thrown exceptions/timeouts as `error` while a clean
   assertion miss (wrong status code, body assertion, explicit step failure)
   stays `fail`.
4. **Wire perf-budget evaluation → `warn`.** After a successful browser run, read
   `check.perf_budget_lcp_ms` / `perf_budget_transfer_bytes` (add them to the
   `Check` type), compare against the captured `run_metrics`, and downgrade an
   otherwise-`pass` run to `warn` on breach. (`warn` = degraded-but-reachable, so
   it counts as *up* for availability but is still visible.)
5. **Fix the debounce counter for the new down-status.** `countConsecutiveFailures`
   counts only `status === 'fail'`; if `error` becomes a distinct down-status, it
   must count `status IN ('fail','error')` or an all-`error` streak would never
   open an incident. **Flag this explicitly** — it's an easy miss.

None of the above is done here; this PR is recon only.
