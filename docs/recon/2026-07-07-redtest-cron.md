# Recon — D1-v2 red-tests: cron-wire (PR 2) is blocked; PR 1 already shipped

**Decision (Craig, 2026-07-07): DEFER PR 2.** Do not cron the red-test harness yet — a scheduled sweep
would auto-cover only the 8 http monitors and cannot touch the 17-monitor browser majority or ssl/dns.
This doc is the ground-truth record of *why*, and the follow-up harness design a real fleet sweep needs.
**Nothing was built, cron-wired, or deployed.**

Evidence contract: OBSERVED (source / live read) vs INFERRED. Alert/PR/`file:line` cited.

---

## PR 1 (api scorecard READ) — ALREADY DONE, not remaining

**OBSERVED (synthwatch-api origin/main):** the "Part B" consumer the 0057 header names is already
shipped by **#150** (`ab87603` *"§D1 red-test capture (PR 2/2 Part B) — /reports/trust flips
redTest.captured from red_tests"*):

- DTO: `TrustRedTestDto { captured, testedAt, method }` (`Dtos/ReportDtos.cs:133`); `TrustMonitorDto.RedTest`.
- Entity: `TrustMonitorRow.RedTestedAt / RedTestMethod` (`Data/Entities/ReportingRows.cs:103-104`,
  mapped `SynthWatchDbContext.cs:473-474`).
- SQL: `TrustFleetSql` LEFT JOIN LATERAL the latest `red_tests` row, honesty-guarded
  `WHERE rt0.outcome='red' ORDER BY tested_at DESC LIMIT 1` (`Functions/ReportsFunctions.cs:~424`).
- Projection: `TrustReportProjection.ToDto` → `captured=true` iff a row exists, else `{captured:false}`
  (`Infrastructure/TrustReportProjection.cs:97-99`).
- **Contract test EXISTS** (the "unanchored seam" is anchored):
  `Trust_redTest_captured_reflects_a_recorded_red_test` (`IntegrationTests.cs:663`) seeds executed +
  attested rows and asserts `captured`, `testedAt`, latest-wins, and method-distinctness; the fleet test
  asserts the honest `captured=false` default (`:624-631`). Fixture has `red_tests` (`fixtures/schema.sql:1030`).

→ **No PR 1 needed.** The read + its contract test are on main.

---

## PR 2 (cron-wire the harness) — blocked: the harness is not fleet-ready

The task framed PR 2 as "mirror the aux-job bicep pattern" (mostly infra). Recon shows the **infra is
the easy part; the harness is the blocker.**

### OBSERVED — no fleet-sweep entrypoint; the harness is single-check + hand-crafted fault
`runner/redTestMain.ts:3` — *"Not cron-wired; run on demand."* It takes ONE `check_id` (`argv[2]`) plus a
per-check `--fault=`:
- `--fault=bad-url:<url>` (http) or `--fault=route-block:<pattern>` (browser) — `parseFault()`
  supports **only these two kinds**.
- No argument → it throws `usage: redTestMain.js <check_id> --fault=...`. A cron job with no per-check
  args (mirroring `retentionJob`'s `args: ['dist/retentionMain.js']`) would **error on every run**.

### OBSERVED — harness coverage by monitor kind
- **http** — `runHttpRedTest(check, {bad-url})` re-runs the check against a swapped `target_url`
  (`redTest.ts:87`, the `target_url: fault.url` swap; `runHttpRedTest` signature at `:82`). A bad url is
  **synthesizable** (e.g. an unresolvable host) → the up-assertion fires
  → red. Ephemeral: writes NOTHING but the `red_tests` row (no `runs`, no incident, no page). ✅ auto-testable.
- **browser** — `runBrowserRedTest(check, {route-block})` aborts THE ANCHOR request the red-condition
  names (`redTest.ts:98`). The anchor is **monitor-specific** — which request the key assertion depends
  on. **Not synthesizable** without per-monitor metadata. ✗ not auto-testable today.
- **ssl / dns / tcp / ping** — **no red-test path at all**: `parseFault` has no fault kind for them, and
  `redTest.ts` has no `runSslRedTest`/`runDnsRedTest`. ✗ not testable by the current harness.
- **attested-manual** — human-only (`recordAttested`), not for a cron sweep.

### OBSERVED — live fleet composition (read-only, `~/.synthwatch.env`)
```
browser | 17   ← majority, NOT auto-testable (needs anchors)
http    |  8   ← auto-testable (synth bad-url)
ssl     |  4   ← no red-test path
dns     |  4   ← no red-test path
```
→ A naive fleet sweep over the existing harness meaningfully covers **8 of 33** enabled monitors (24%)
and would `inconclusive`/error on the other 25 (composition is a **point-in-time fleet read as of
2026-07-07** — the ratio shifts as monitors are added, but the *kind-coverage* gap is structural).
**INFERRED:** shipping that as "the fleet red-test
sweep" reads as full-fleet coverage while silently skipping the majority — a false-confidence outcome
that undercuts the whole point of a red-test (proving alerts CAN fire). Hence: defer.

### OBSERVED — the infra to mirror is READY (not the blocker)
Everything the ACA job needs is in place and idiomatic:
- Template: `retentionJob` (`infra/main.bicep:1286`) — `Microsoft.App/jobs`, `triggerType:'Schedule'`,
  `scheduleTriggerConfig.cronExpression`, ACR registry, `database-url` secret, `image: runnerImage`,
  `command:['node']`, `args:['dist/…Main.js']`, and the **A4 marker `SYNTHWATCH_DEPLOYED=1`** in `env`.
- Guard-marker assertion: `deploy.sh:569` loops `RUNNER_IMAGE_JOBS` asserting `SYNTHWATCH_DEPLOYED=='1'`
  (the #197/#202 lesson — a job REFUSES TO START without it). `RUNNER_IMAGE_JOBS` is the single source of
  truth in `scripts/lib/deploy-lib.sh:22` (`NARRATIVE_JOB`/`ROLLUP_JOB`/`RECONCILE_JOB`/`RETENTION_JOB`).
- So when a sweep is built, the job step is: add `REDTEST_JOB` to `deploy-lib.sh` + the bicep resource
  (marker included) → the #202 assertion auto-covers it. **~30 lines. Not the blocker.**

---

## Follow-up design — what a real fleet sweep needs (in order)

1. **A fleet-sweep entrypoint** `runner/redTestSweepMain.ts` (mirrors `rollupMain`/`retentionMain`):
   load enabled checks, dispatch per-kind, persist confirmed reds, `enforceProdGuard()` (passes on
   `SYNTHWATCH_DEPLOYED=1`). This is the missing seam a cron job would invoke.
2. **Browser coverage** — a per-monitor declared red-test **anchor** (a `route-block` pattern), since it
   can't be synthesized. Schema-adjacent + runner-owned (a `checks.red_test_anchor` column, or a field in
   the monitor spec). Without this, the 17-monitor majority stays uncovered.
3. **ssl/dns coverage** — either new harness fault kinds (`bad-host`/`wrong-record`) + `runSslRedTest`/
   `runDnsRedTest`, or an explicit decision that these kinds are **attested-only** (captured via the
   `attested-manual` path, never auto-swept).
4. **THEN the scheduled ACA job** — the easy last step (retentionJob clone + `REDTEST_JOB` in
   `RUNNER_IMAGE_JOBS` + the `SYNTHWATCH_DEPLOYED=1` marker; deploy.sh #202 assertion auto-covers it).

**Proposed cadence (for when built):** **daily** (`cronExpression` in the `0 * * *`-ish off-peak slot the
other aux jobs use, e.g. `15 1 * * *`). Justification (not a guess): the sweep is ephemeral (only a
`red_tests` row on a confirmed red — no runs/incidents/paging) and cheap (≤ a few dozen extra requests/
day), so cost/noise is negligible; `redTest.captured` is **NOT windowed** (a red-test is a durable
capability proof), so even **weekly** would keep the scorecard honest — daily just narrows the "has this
monitor's assertion been re-proven recently" window. Start daily; drop to weekly if even that reads noisy.

---

## Disposition

- **PR 1:** already shipped (#150) — nothing to do.
- **PR 2:** **deferred** per Craig. No entrypoint built, no bicep job added, no deploy. The blocker is
  harness capability (fleet entrypoint + browser anchors + ssl/dns faults), not infra. Follow-up design
  above; the ACA job is the final, ~30-line step once the harness can sweep.
