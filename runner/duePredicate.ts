// The due predicate — SHARED by findDueChecks (the pre-filter) and claim() (the atomic gate) in
// index.ts, and exercised verbatim by cadence.integration.test.ts. One source so the two queries
// and the regression harness can never drift.
//
// ★★ THE δ-SLIP MECHANISM (do NOT "simplify" the guard away — it IS the cadence fix).
// The cron tier fires on fixed wall-clock marks (*/5). claim() stamps last_run_at = now(), which is
// tick start PLUS the check's in-loop offset δ (reap/manifest/drain run first; checks run
// sequentially, so δ is seconds-to-minutes and δ > 0 always). With the naive predicate
//     elapsed >= interval
// the next mark sees elapsed = interval − δ < interval → NOT due → the check slips a FULL extra
// tick. Realized cadence = interval + one tick period for EVERY check whose interval is a multiple
// of the tick: prod medians July 4 were 300s→598, 600s→896, 900s→1197, 1800s→2097, 3600s→3897 —
// the whole fleet sampling at ~half to ~5/6 of its configured rate. The guard forgives δ up to
// TICK_SLIP_GUARD_S, so the mark where elapsed = interval − δ still qualifies:
//     elapsed >= interval − min(TICK_SLIP_GUARD_S, interval/2)
//
// WHY THIS CANNOT DOUBLE-FIRE:
//   • Within a tick: a just-claimed check has elapsed ≈ 0, and 0 >= interval − ε is false for every
//     ε <= interval/2 (the LEAST() clamp guarantees ε <= interval/2, so the threshold is >= interval/2 > 0).
//   • Across replicas: claim()'s conditional UPDATE re-checks this same predicate against the
//     winner's fresh last_run_at under READ COMMITTED — at-most-once per due-window regardless.
//   • Across ticks: firing at consecutive marks requires elapsed-at-next-mark (= tick − δ' + tick-jitter)
//     to reach interval − ε, i.e. ε >= interval − tick + δ'. For every interval >= tick that needs
//     ε >= δ' at minimum and ε >= interval − tick + δ' in general — 150 < 300 (the tick period), so a
//     same-cadence check fires at most once per mark, and a 2×tick check at most every other mark.
//     (The integration test proves both properties red/green — see cadence.integration.test.ts.)
//
// 150 = half the 300s cron tick: forgives any realistic in-loop δ (the loop budget is the 240s
// replicaTimeout, but δ for a given check is its START offset, overwhelmingly < 150s once PR 1's
// oldest-first ordering rotates deferred work to the front) while staying strictly below the tick
// period, which is what the no-double-fire argument above needs.
export const TICK_SLIP_GUARD_S = 150;

/**
 * SQL fragment: is the (checks c ⋈ check_locations cl) row due? NULL cursor = never ran = due-now.
 * The LEAST() clamp keeps the guard meaningful for hypothetical sub-300s intervals (a finer future
 * cron tier): ε is never more than half the interval, so the threshold never collapses toward zero.
 */
export const DUE_PREDICATE_SQL = `(cl.last_run_at IS NULL
             OR now() - cl.last_run_at >=
                make_interval(secs => c.interval_seconds)
                - make_interval(secs => LEAST(${TICK_SLIP_GUARD_S}, c.interval_seconds / 2.0)))`;
