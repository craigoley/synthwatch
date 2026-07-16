// Reporting Layer 3 — "Smart Reports". FACT-PACK-THEN-NARRATE: compute facts/deltas/
// anomalies DETERMINISTICALLY (here, in SQL/code), then the model ONLY narrates the
// structured fact pack (cite-only, change-first), with a deterministic template fallback
// if it returns filler/off-shape. The model NEVER computes a number.
//
// Math rules (must agree with the report API): availability is ADDITIVE from the rollup
// counts (sum up / sum up+down — NEVER average daily %); latency percentiles are
// RECOMPUTED FROM RAW per period (#88 — never average daily p95s), over UP (pass|warn)
// runs with maintenance windows excluded (the rollup's latency definition).
//
// Opt-in on AZURE_OPENAI_* (same as RCA): absent => the job no-ops (Layer 3 dark, zero cost).
import { pool } from './db.js';
import { aoaiConfigured, chatCompletionContent, extractJson, DEFAULT_DEPLOYMENT } from './aoai.js';
import { costRatePerActiveSecond, freeGrantDollars, reconcileTargetMonthly } from './costModel.js';

const WINDOW = '7d';
const WINDOW_DAYS = 7;

export interface PeriodFacts {
  from: string;
  to: string;
  up: number;
  down: number;
  availabilityPct: number | null;
  downtimeMin: number;
  incidents: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  latencyN: number;
  lcpP75: number | null;
}

export interface IncidentFact {
  check: string;
  severity: string;
  openedAt: string;
  resolvedAt: string | null;
  durationMin: number;
  classification: string | null;
  summary: string | null;
}

/** One monitor's estimated monthly cost — from the SHARED cost_projection() SQL fn, so these MATCH
 *  /reports/cost by construction. divergence = measured/projected (null when projected 0). */
export interface CostFact {
  name: string;
  estimatedMonthly: number | null; // ★ 0091: the PRIMARY per-monitor $ — free-grant-aware, Σ = the reconcile anchor; null when no runs
  sharePct: number | null; // 0089: this monitor's share of FLEET measured compute (active-seconds) — the SECONDARY metric; null when no monitor ran
  projected: number;
  measured: number;
  divergence: number | null;
  divergenceFlag: boolean; // divergence > 1.5 — EXTRA runs vs the current schedule (config-change straddle / confirmation / sandbox); a pure run-count ratio, NOT retries (0078)
  availabilityPct: number | null; // this window, so the model can spot unreliable-AND-expensive intersections
}

/** Fleet cost roll-up + the monitors worth naming (expensive / divergent / unreliable). Null when the
 *  cost_projection() fn is unavailable (e.g. migration 0069 not yet applied) — never fabricated. */
export interface CostFacts {
  fleetProjected: number;
  fleetMeasured: number;
  fleetDivergence: number | null;
  topDrivers: Array<{ name: string; projected: number }>; // top by projected $
  notable: CostFact[]; // expensive OR divergent OR low-availability — the cross-signal candidates
}

/** A deploy in the window (from the `deploys` table). The model correlates incident timing to deployedAt —
 *  "incident began N min after deploy <sha>" — instead of guessing "check recent deployments". */
export interface DeployMarker {
  deployedAt: string; // ISO — checkable against incident.openedAt
  targetHost: string;
  source: string;
  sha: string | null; // short (12) — null for non-sha markers (etag)
  isSha: boolean; // a real code RELEASE (weight for correlation) vs a config/etag redeploy (noise)
}

export interface FactPack {
  scopeType: 'fleet' | 'monitor';
  scopeKey: string;
  scopeName: string;
  window: string;
  current: PeriodFacts;
  previous: PeriodFacts;
  deltas: {
    availabilityPts: number | null;
    downtimeMin: number;
    incidents: number;
    p95Pct: number | null;
  };
  incidentList: IncidentFact[];
  anomalies: string[];
  cost: CostFacts | null; // fleet+notable cost (fleet scope) or this monitor's cost (monitor scope); null if unavailable
  deployMarkers: DeployMarker[]; // deploys in the window, for incident↔deploy correlation
}

export interface Narrative {
  headline: string;
  body: string;
  highlights: string[];
}

// --- window math (UTC, day-aligned so rollup-availability + raw-percentiles cover the
// SAME runs) ---------------------------------------------------------------------------
function todayUtcMidnight(): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** One period's facts. availability/downtime from the rollup (additive); percentiles +
 *  vitals from RAW (UP runs, MW-excluded); incidents from the incidents table. checkId
 *  null = fleet (all checks). [startDay, endDay) are UTC dates; [startIso, endIso) the
 *  matching timestamps. */
async function periodFacts(
  checkId: number | null,
  startDay: string,
  endDay: string,
  startIso: string,
  endIso: string,
): Promise<PeriodFacts> {
  const avail = await pool.query<{ up: string; down: string; downtime: string }>(
    `SELECT coalesce(sum(up_count),0) AS up, coalesce(sum(down_count),0) AS down,
            coalesce(sum(downtime_minutes),0) AS downtime
       FROM daily_check_rollup
      WHERE day >= $2::date AND day < $3::date AND ($1::bigint IS NULL OR check_id = $1)`,
    [checkId, startDay, endDay],
  );
  const lat = await pool.query<{ p50: number | null; p95: number | null; p99: number | null; n: string }>(
    `SELECT round(percentile_cont(0.5)  WITHIN GROUP (ORDER BY r.duration_ms))::int AS p50,
            round(percentile_cont(0.95) WITHIN GROUP (ORDER BY r.duration_ms))::int AS p95,
            round(percentile_cont(0.99) WITHIN GROUP (ORDER BY r.duration_ms))::int AS p99,
            count(*) AS n
       FROM runs r
      WHERE r.started_at >= $2 AND r.started_at < $3 AND r.status IN ('pass','warn')
        AND ($1::bigint IS NULL OR r.check_id = $1)
        AND NOT EXISTS (
          SELECT 1 FROM maintenance_windows mw
           WHERE (mw.check_id = r.check_id OR mw.check_id IS NULL)
             AND r.started_at >= mw.starts_at AND r.started_at < mw.ends_at)`,
    [checkId, startIso, endIso],
  );
  const inc = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM incidents
      WHERE opened_at >= $2 AND opened_at < $3 AND ($1::bigint IS NULL OR check_id = $1)`,
    [checkId, startIso, endIso],
  );
  const vit = await pool.query<{ lcp_p75: number | null }>(
    `SELECT round(percentile_cont(0.75) WITHIN GROUP (ORDER BY m.lcp_ms))::int AS lcp_p75
       FROM run_metrics m JOIN runs r ON r.id = m.run_id
      WHERE r.started_at >= $2 AND r.started_at < $3 AND r.status IN ('pass','warn')
        AND ($1::bigint IS NULL OR r.check_id = $1)
        AND NOT EXISTS (
          SELECT 1 FROM maintenance_windows mw
           WHERE (mw.check_id = r.check_id OR mw.check_id IS NULL)
             AND r.started_at >= mw.starts_at AND r.started_at < mw.ends_at)`,
    [checkId, startIso, endIso],
  );
  const up = Number(avail.rows[0].up);
  const down = Number(avail.rows[0].down);
  const total = up + down;
  return {
    from: startIso,
    to: endIso,
    up,
    down,
    availabilityPct: total > 0 ? Math.round((10000 * up) / total) / 100 : null,
    downtimeMin: Math.round(Number(avail.rows[0].downtime)),
    incidents: Number(inc.rows[0].n),
    p50: lat.rows[0].p50,
    p95: lat.rows[0].p95,
    p99: lat.rows[0].p99,
    latencyN: Number(lat.rows[0].n),
    lcpP75: vit.rows[0].lcp_p75,
  };
}

/** Compute the full deterministic fact pack for a scope as of `asOf` (UTC midnight end). */
const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

// The $/active-second rate is DERIVED (two ACA meters × the live deploy-stamped allocation) in the ONE
// shared place — runner/costModel.ts. The api's CostRate.cs mirrors the same derivation, so the runner's
// cost facts and /reports/cost use one rate model (no magic scalar). A resize re-prices automatically;
// verify() asserts the stamped SYNTHWATCH_RUNNER_CPU/MEMORY_GIB match the live container resources.
const costRate = costRatePerActiveSecond;

/** Cost facts from the SHARED cost_projection() fn (figures MATCH /reports/cost by construction). Fleet total
 *  + notable monitors (fleet scope), or just this monitor's figures (monitor scope). Availability is joined
 *  from the rollup so the model can find the unreliable-AND-expensive intersection. FAIL-SOFT: if the fn is
 *  unavailable (0069 not yet applied) → null (never a fabricated $0). */
async function costFacts(checkId: number | null, startDay: string, endDay: string): Promise<CostFacts | null> {
  try {
    const cost = await pool.query<{
      check_id: string; check_name: string; estimated_monthly: string | null; compute_share_pct: string | null;
      projected: string; measured: string;
      divergence: string | null; divergence_flag: boolean; projected_raw: string; measured_raw: string;
    }>(
      // ★ 0091: the free-grant-aware 3-param model. estimated_monthly is the PRIMARY per-monitor $ (Σ = the
      // reconcile anchor: coalesce(target, grant-corrected fleet)); compute_share_pct is the SECONDARY share.
      `SELECT check_id, check_name, estimated_monthly, compute_share_pct, projected, measured, divergence, divergence_flag, projected_raw, measured_raw
         FROM cost_projection($1::numeric, $2::numeric, $3::numeric)`,
      [costRate(), freeGrantDollars(), reconcileTargetMonthly()],
    );
    if (cost.rows.length === 0) return null;
    const av = await pool.query<{ check_id: string; pct: string | null }>(
      `SELECT check_id, round(100.0*sum(up_count)/nullif(sum(up_count+down_count),0),2) AS pct
         FROM daily_check_rollup WHERE day >= $1::date AND day < $2::date GROUP BY check_id`,
      [startDay, endDay],
    );
    const availById = new Map(av.rows.map((r) => [r.check_id, r.pct == null ? null : Number(r.pct)]));
    const all = cost.rows.map((r) => ({
      id: r.check_id,
      fact: {
        name: r.check_name,
        estimatedMonthly: r.estimated_monthly == null ? null : Number(r.estimated_monthly),
        sharePct: r.compute_share_pct == null ? null : Number(r.compute_share_pct),
        projected: Number(r.projected),
        measured: Number(r.measured),
        divergence: r.divergence == null ? null : Number(r.divergence),
        divergenceFlag: r.divergence_flag,
        availabilityPct: availById.get(r.check_id) ?? null,
      } as CostFact,
      projRaw: Number(r.projected_raw),
      measRaw: Number(r.measured_raw),
    }));
    const fleetProjected = r2(all.reduce((s, r) => s + r.projRaw, 0));
    const fleetMeasured = r2(all.reduce((s, r) => s + r.measRaw, 0));
    const fleetDivergence = fleetProjected > 0 ? r3(fleetMeasured / fleetProjected) : null;

    // Monitor scope: just this check's cost (fleet* = the monitor's own figures; notable = [itself]).
    if (checkId != null) {
      const me = all.find((r) => r.id === String(checkId));
      if (!me) return null;
      return {
        fleetProjected: me.fact.projected, fleetMeasured: me.fact.measured, fleetDivergence: me.fact.divergence,
        topDrivers: [], notable: [me.fact],
      };
    }
    // Fleet scope: top drivers + notable = expensive ∪ divergent ∪ (unreliable AND costing).
    const byProj = [...all].sort((a, b) => b.projRaw - a.projRaw);
    const topDrivers = byProj.slice(0, 5).map((r) => ({ name: r.fact.name, projected: r.fact.projected }));
    const notable = new Map<string, (typeof all)[number]>();
    for (const r of byProj.slice(0, 8)) notable.set(r.id, r); // most expensive
    for (const r of all) if (r.fact.divergenceFlag) notable.set(r.id, r); // cost-divergent (leading indicator)
    for (const r of all) if (r.fact.availabilityPct != null && r.fact.availabilityPct < 100 && r.fact.projected > 0) notable.set(r.id, r); // unreliable AND costing
    return {
      fleetProjected, fleetMeasured, fleetDivergence, topDrivers,
      notable: [...notable.values()].sort((a, b) => b.projRaw - a.projRaw).map((r) => r.fact),
    };
  } catch (err) {
    console.warn('[narrative] cost facts unavailable (cost_projection missing?) — omitting:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Deploys in the window → the model correlates incident timing to deployedAt. To keep the input focused
 *  (the deploys table is dominated by the dashboard's frequent etag/config redeploys), keep EVERY real code
 *  release (is_sha — the correlation candidates) but only the 10 most-recent config/etag markers. */
async function deployMarkersInWindow(startIso: string, endIso: string): Promise<DeployMarker[]> {
  const { rows } = await pool.query<{ deployed_at: Date; target_host: string; source: string; sha: string | null; is_sha: boolean }>(
    `(SELECT deployed_at, target_host, source, left(sha, 12) AS sha, is_sha
        FROM deploys WHERE deployed_at >= $1 AND deployed_at < $2 AND is_sha)
     UNION ALL
     (SELECT deployed_at, target_host, source, left(sha, 12) AS sha, is_sha
        FROM deploys WHERE deployed_at >= $1 AND deployed_at < $2 AND NOT is_sha
        ORDER BY deployed_at DESC LIMIT 10)
     ORDER BY deployed_at`,
    [startIso, endIso],
  );
  return rows.map((r) => ({
    deployedAt: new Date(r.deployed_at).toISOString(),
    targetHost: r.target_host,
    source: r.source,
    sha: r.sha,
    isSha: r.is_sha,
  }));
}

export async function computeFactPack(
  scope: { type: 'fleet' | 'monitor'; checkId: number | null; key: string; name: string },
  asOf: Date = todayUtcMidnight(),
): Promise<FactPack> {
  const end = asOf;
  const curStart = new Date(end.getTime() - WINDOW_DAYS * 86_400_000);
  const prevStart = new Date(end.getTime() - 2 * WINDOW_DAYS * 86_400_000);
  const checkId = scope.checkId;

  const current = await periodFacts(checkId, isoDay(curStart), isoDay(end), curStart.toISOString(), end.toISOString());
  const previous = await periodFacts(checkId, isoDay(prevStart), isoDay(curStart), prevStart.toISOString(), curStart.toISOString());

  const incList = await pool.query<{
    check: string; severity: string; opened_at: string; resolved_at: string | null;
    duration_min: number; classification: string | null; summary: string | null;
  }>(
    `SELECT c.name AS check, i.severity, i.opened_at, i.resolved_at,
            round(EXTRACT(epoch FROM (coalesce(i.resolved_at, now()) - i.opened_at)) / 60)::int AS duration_min,
            i.rca->>'classification' AS classification, i.rca->>'summary' AS summary
       FROM incidents i JOIN checks c ON c.id = i.check_id
      WHERE i.opened_at >= $2 AND i.opened_at < $3 AND ($1::bigint IS NULL OR i.check_id = $1)
      ORDER BY i.opened_at`,
    [checkId, current.from, current.to],
  );
  const incidentList: IncidentFact[] = incList.rows.map((r) => ({
    check: r.check,
    severity: r.severity,
    openedAt: r.opened_at,
    resolvedAt: r.resolved_at,
    durationMin: r.duration_min,
    classification: r.classification,
    summary: r.summary,
  }));

  // Deltas (current vs previous).
  const availabilityPts =
    current.availabilityPct != null && previous.availabilityPct != null
      ? Math.round((current.availabilityPct - previous.availabilityPct) * 100) / 100
      : null;
  const p95Pct =
    current.p95 != null && previous.p95 != null && previous.p95 > 0
      ? Math.round(((current.p95 - previous.p95) / previous.p95) * 1000) / 10
      : null;

  // Anomalies — flagged BY CODE thresholds, so the model is HANDED "what's notable".
  const anomalies: string[] = [];
  if (availabilityPts != null && availabilityPts < -1)
    anomalies.push(`Availability dropped ${Math.abs(availabilityPts)}pts w/w (${previous.availabilityPct}% -> ${current.availabilityPct}%).`);
  if (p95Pct != null && p95Pct > 20)
    anomalies.push(`p95 latency up ${p95Pct}% w/w (${previous.p95}ms -> ${current.p95}ms).`);
  if (current.incidents > previous.incidents)
    anomalies.push(`Incidents up ${current.incidents - previous.incidents} w/w (${previous.incidents} -> ${current.incidents}).`);

  // Repeat-offender: same RCA signature across >= 2 incidents this period.
  const repeat = await pool.query<{ sig: string; n: string }>(
    `SELECT i.rca->>'signature' AS sig, count(*) AS n FROM incidents i
      WHERE i.opened_at >= $2 AND i.opened_at < $3 AND i.rca->>'signature' IS NOT NULL
        AND ($1::bigint IS NULL OR i.check_id = $1)
      GROUP BY 1 HAVING count(*) >= 2 ORDER BY count(*) DESC`,
    [checkId, current.from, current.to],
  );
  for (const r of repeat.rows) anomalies.push(`Repeat offender: ${r.n} incidents with the same failure signature.`);

  // Worst monitors (fleet only).
  if (scope.type === 'fleet') {
    const worst = await pool.query<{ name: string; avail: number | null }>(
      `SELECT c.name, round(100.0*sum(dcr.up_count)/nullif(sum(dcr.up_count+dcr.down_count),0),2) AS avail
         FROM daily_check_rollup dcr JOIN checks c ON c.id = dcr.check_id
        WHERE dcr.day >= $1::date AND dcr.day < $2::date
        GROUP BY c.id, c.name HAVING sum(dcr.up_count+dcr.down_count) > 0
        ORDER BY avail ASC NULLS LAST LIMIT 3`,
      [isoDay(curStart), isoDay(end)],
    );
    const worstLine = worst.rows
      .filter((w) => w.avail != null && Number(w.avail) < 100)
      .map((w) => `${w.name} ${w.avail}%`)
      .join(', ');
    if (worstLine) anomalies.push(`Lowest-availability monitors: ${worstLine}.`);
  }

  // Cost (shared cost_projection fn — matches /reports/cost) + deploy markers (for incident↔deploy timing).
  const cost = await costFacts(checkId, isoDay(curStart), isoDay(end));
  const deployMarkers = await deployMarkersInWindow(curStart.toISOString(), end.toISOString());

  return {
    scopeType: scope.type,
    scopeKey: scope.key,
    scopeName: scope.name,
    window: WINDOW,
    current,
    previous,
    deltas: {
      availabilityPts,
      downtimeMin: current.downtimeMin - previous.downtimeMin,
      incidents: current.incidents - previous.incidents,
      p95Pct,
    },
    incidentList,
    anomalies,
    cost,
    deployMarkers,
  };
}

// --- narrate (model only narrates) + deterministic fallback ---------------------------
const SYSTEM_PROMPT =
  `You are a FinOps/SRE analyst writing a terse, cross-cutting report for an engineer. The JSON data is the ` +
  `SOLE source of truth: cite ONLY figures present in it — never invent, estimate, or round beyond it. ` +
  `Prose is INTERPRETATION of those facts, not new facts.\n` +
  `SYNTHESIZE across signals — do NOT produce three separate lists (reliability, cost, deploys). Weave them:\n` +
  `- LEAD with the single highest-priority item, ordered by impact.\n` +
  `- The headline signal is the INTERSECTION: a monitor that is SIMULTANEOUSLY unreliable AND expensive ` +
  `AND/OR recently-changed. Name it and connect the facts (e.g. "X is <avail>% available AND still ` +
  `projected $<proj>/mo = wasted spend — fix or retire"). Use cost.notable for these candidates.\n` +
  `- Treat cost DIVERGENCE (measured >> projected; divergenceFlag) as a LEADING indicator — retries/` +
  `slowdowns inflating cost before they show as failures. Call it out with the ratio.\n` +
  `- CORRELATE incident timing with deployMarkers: for an incident, compare its openedAt to each ` +
  `deployedAt; if one is shortly before, say "began ~N min after the <date> deploy <sha> (<target>)" ` +
  `using the ACTUAL timestamps. If NO deploy plausibly precedes it, say so explicitly ("no correlated ` +
  `deploy in-window → likely external/regional"). ★ NEVER assert a correlation the timestamps don't ` +
  `support — a claimed "after deploy X" must be checkable against that deploy's deployedAt.\n` +
  `- Speak in deviations-from-normal (week-over-week) where the deltas have them. Cite incidents by ` +
  `classification. Reference the connections (the anomaly's cost, the change's deploy-timing) — sections ` +
  `must interlock, not stand alone.\n` +
  `- If cost is null or deployMarkers is empty, simply omit that dimension — do NOT fabricate $ or a deploy.\n` +
  `- ★ ABSOLUTE FIGURES, NOT JUST DELTAS: you MUST state the scope's current.availabilityPct as a LITERAL ` +
  `percentage (e.g. "93.33%") somewhere — headline, body, OR a highlight — and, when current.incidents > 0, ` +
  `the literal incident COUNT. A week-over-week delta ("+11.36 pts w/w") COMPLEMENTS the aggregate, it never ` +
  `REPLACES it: reporting only the delta, or only per-monitor availabilities, is INCOMPLETE — the reader must ` +
  `see the actual current availability number. This does NOT dilute the holistic style: still lead with the ` +
  `story and weave signals, then anchor it to the real aggregate figure (copy the number from the fact pack ` +
  `verbatim — do not round or restate it).\n` +
  `- BAN filler: no greetings, no "in conclusion", no "all systems nominal". Every line carries a cited ` +
  `signal; if truly nothing notable changed, say that in one sentence.\n` +
  `Respond ONLY as JSON: {"headline": "<=1 sentence, the top item", "body": "2-6 sentences, markdown, ` +
  `woven across signals", "highlights": ["short cited string", ...]}.`;

/** Deterministic templated summary from the fact pack — used when the model is off/empty/
 *  filler, so a bad generation NEVER ships mush. Cites the same numbers. */
export function buildFallback(fp: FactPack): Narrative {
  const c = fp.current;
  const avail = c.availabilityPct != null ? `${c.availabilityPct}%` : 'n/a';
  const dPts = fp.deltas.availabilityPts;
  const dStr = dPts == null ? '' : ` (${dPts >= 0 ? '+' : ''}${dPts}pts w/w)`;
  const p95 = c.p95 != null ? `${c.p95}ms` : 'n/a';
  const p95d = fp.deltas.p95Pct == null ? '' : ` (${fp.deltas.p95Pct >= 0 ? '+' : ''}${fp.deltas.p95Pct}% w/w)`;
  const classes = fp.incidentList.map((i) => i.classification ?? 'unclassified');
  const classBreak = classes.length ? ` (${[...new Set(classes)].join(', ')})` : '';
  const headline = `${fp.scopeName} ${fp.window}: availability ${avail}${dStr}, ${c.incidents} incident(s).`;
  const bodyParts = [
    `Availability ${avail}${dStr} over ${fp.window}.`,
    `${c.incidents} incident(s) opened${classBreak}; ${c.downtimeMin} min downtime.`,
    `p95 ${p95}${p95d}.`,
  ];
  if (fp.anomalies.length) bodyParts.push(fp.anomalies.join(' '));
  else bodyParts.push('Nothing notable changed week-over-week.');
  // Cost — ONLY when present (never a fabricated $0). Names the divergent monitor if one is flagged.
  const highlights = fp.anomalies.length ? fp.anomalies.slice(0, 5) : [`Availability ${avail}`, `p95 ${p95}`, `${c.incidents} incident(s)`];
  if (fp.cost) {
    const fd = fp.cost.fleetDivergence;
    bodyParts.push(`Projected $${fp.cost.fleetProjected}/mo, measured $${fp.cost.fleetMeasured}/mo${fd != null ? ` (divergence ${fd}×)` : ''}.`);
    const div = fp.cost.notable.find((m) => m.divergenceFlag);
    if (div) {
      bodyParts.push(`${div.name}: $${div.measured}/mo measured vs $${div.projected} projected (${div.divergence}×) — retry/slowdown amplification.`);
      highlights.push(`${div.name} cost divergence ${div.divergence}×`);
    }
  }
  // Deploys — factual list only; the deterministic fallback does NOT assert correlation (that's the model's job).
  if (fp.deployMarkers.length) {
    const shas = fp.deployMarkers.map((d) => d.sha ?? d.source).slice(0, 3).join(', ');
    bodyParts.push(`${fp.deployMarkers.length} deploy(s) in-window (${shas}).`);
  }
  return {
    headline,
    body: bodyParts.join(' '),
    highlights: highlights.slice(0, 6),
  };
}

/** Validate the model output shape: {headline:string, body:string, highlights:string[]}. */
function validShape(o: unknown): o is Narrative {
  if (typeof o !== 'object' || o === null) return false;
  const r = o as Record<string, unknown>;
  return (
    typeof r.headline === 'string' && r.headline.trim().length > 0 &&
    typeof r.body === 'string' && r.body.trim().length > 0 &&
    Array.isArray(r.highlights) && r.highlights.every((h) => typeof h === 'string')
  );
}

/**
 * The HEADLINE figures the prose must surface — proof the model used the fact pack rather
 * than emitting generic filler/hallucination. Returns the labels of any MISSING figure
 * (empty array = passes). Deliberately a REASONABLE SUBSET, not every number:
 *  - availability — the primary reliability figure; rounding-tolerant (accept the
 *    truncated OR rounded integer, e.g. 73.98% -> "73" or "74") so a faithful citation
 *    in any rendering passes.
 *  - incident COUNT — but only when there were incidents (>0); a 0-count is often phrased
 *    "no incidents", so don't demand the literal "0".
 * Secondary metrics (p95, downtime, vitals) are NOT required: a change-focused fleet
 * summary legitimately leads with availability + incidents + anomalies and may omit or
 * reformat p95 (e.g. "10.8s" not "10830") — that previously rejected good fleet prose.
 * The guardrail still fires on filler (no real availability/incident figures -> missing).
 */
export function missingFigures(n: Narrative, fp: FactPack): string[] {
  // ★ SEARCH THE WHOLE NARRATIVE — headline + body + HIGHLIGHTS. `highlights` is a first-class model
  // output field (validShape requires it; SYSTEM_PROMPT asks for `"highlights": ["short cited string"]`;
  // upsert() persists it and the dashboard renders it), so it is exactly where a HOLISTIC fleet narrative
  // (the #241 rewrite) parks a bare cited figure while the body carries the cross-signal STORY. Searching
  // only headline+body false-rejected such a narrative even though it cited the figure verbatim in a
  // highlight — that is what fell back the 2026-07-09 fleet run (`missing: availability(93.33%)` while the
  // model finished clean, finish_reason=stop, 1894 chars). Including highlights also closes a latent hole:
  // an invented $ or unsupported deploy-sha in a highlight (shown to the user) now trips the guard too.
  const prose = [n.headline, n.body, ...n.highlights].join(' ');
  const missing: string[] = [];
  const pct = fp.current.availabilityPct;
  if (pct != null) {
    const alts = [String(Math.trunc(pct)), String(Math.round(pct))]; // rounding-tolerant
    if (!alts.some((a) => prose.includes(a))) missing.push(`availability(${pct}%)`);
  }
  if (fp.current.incidents > 0 && !prose.includes(String(fp.current.incidents))) {
    missing.push(`incidents(${fp.current.incidents})`);
  }

  // ★ ANTI-HALLUCINATION (reinforced for the bigger pack): the prose may cite ONLY figures the pack holds.
  // (a) COST — every "$<n>" must be near a cost figure the pack carries (fleet + drivers + notable),
  //     tolerant of rounding to the whole dollar. An out-of-pack $ = an invented number → fallback.
  const packVals: number[] = [];
  if (fp.cost) {
    packVals.push(fp.cost.fleetProjected, fp.cost.fleetMeasured);
    for (const d of fp.cost.topDrivers) packVals.push(d.projected);
    for (const c of fp.cost.notable) packVals.push(c.projected, c.measured);
  }
  for (const m of prose.matchAll(/\$\s?(\d+(?:\.\d+)?)/g)) {
    const num = Number(m[1]);
    if (!packVals.some((v) => Math.abs(v - num) < 0.5)) missing.push(`invented-cost($${m[1]})`);
  }
  // (b) DEPLOY — any hex commit-sha cited in a deploy claim must be a REAL in-window marker (prefix-match,
  //     since the model may cite a shorter prefix). A sha not among deployMarkers = an unsupported
  //     correlation ("began after deploy <sha>" the timestamps can't back) → fallback.
  if (/deploy/i.test(prose)) {
    const packShas = fp.deployMarkers.map((d) => d.sha).filter((s): s is string => !!s).map((s) => s.toLowerCase());
    for (const m of prose.matchAll(/\b([0-9a-f]{7,40})\b/gi)) {
      const sha = m[1].toLowerCase();
      if (!packShas.some((p) => p.startsWith(sha) || sha.startsWith(p))) missing.push(`unsupported-deploy-sha(${sha})`);
    }
  }
  return missing;
}

/** True when the prose surfaces the headline figures (see missingFigures). */
export function spotCheck(n: Narrative, fp: FactPack): boolean {
  return missingFigures(n, fp).length === 0;
}

/** Narrate the fact pack. Returns the narrative + which model produced it (the deployment,
 *  or 'fallback-template'). The model only narrates; on any failure/filler -> fallback. */
// gpt-5-mini is a REASONING model: max_completion_tokens bounds reasoning + output COMBINED. The old 700
// was output-sized — low-effort reasoning over the enriched fleet pack (cost + deploys + 34-check data)
// consumed the whole budget BEFORE any content → finish_reason=length, content_len=0 → fallback. 4000 gives
// comfortable headroom for the reasoning pass + the ~700-token JSON output (RCA, same model, uses 16000).
const NARRATIVE_MAX_TOKENS = 4000;

export async function narrate(fp: FactPack): Promise<{ narrative: Narrative; model: string }> {
  const user = JSON.stringify(fp);
  // Observability: surface the input size + the budget so a future budget-starve is diagnosable at a glance
  // (finish_reason=length with a big prompt vs a small max = starved; the log below pairs with it).
  console.log(
    `[narrative] ${fp.scopeType}:${fp.scopeKey || 'fleet'} prompt≈${SYSTEM_PROMPT.length + user.length} chars ` +
      `(~${Math.round((SYSTEM_PROMPT.length + user.length) / 4)} tok in), max_completion_tokens=${NARRATIVE_MAX_TOKENS}`,
  );
  const content = await chatCompletionContent({
    system: SYSTEM_PROMPT,
    user,
    maxTokens: NARRATIVE_MAX_TOKENS,
    reasoningEffort: 'low',
    logPrefix: '[narrative]',
  });
  if (content) {
    try {
      const parsed = JSON.parse(extractJson(content)) as unknown;
      if (validShape(parsed)) {
        const n: Narrative = {
          headline: parsed.headline.trim(),
          body: parsed.body.trim(),
          highlights: parsed.highlights.slice(0, 5),
        };
        const missing = missingFigures(n, fp);
        if (missing.length === 0) return { narrative: n, model: DEFAULT_DEPLOYMENT ?? 'aoai' };
        // meta-lesson A: the DISCARDED output was previously invisible (only the fallback was stored), so a
        // spot-check false-rejection was un-diagnosable without re-deriving. Log the full discarded narrative
        // (non-sensitive fleet stats) + the exact figure it wanted, so the NEXT failure is one-glance:
        // "rephrased/omitted (CASE 1/2)" vs "cited-but-in-a-field-we-don't-search (CASE 3)".
        console.warn(
          `[narrative] ${fp.scopeType}:${fp.scopeKey || 'fleet'} model output failed spot-check ` +
            `(missing: ${missing.join(', ')}) — fallback. DISCARDED output below (searched headline+body+highlights):\n` +
            `  headline: ${n.headline}\n  body: ${n.body}\n  highlights: ${JSON.stringify(n.highlights)}`,
        );
      } else {
        console.warn('[narrative] model output off-shape — fallback');
      }
    } catch (err) {
      console.warn('[narrative] model output not JSON — fallback:', err instanceof Error ? err.message : err);
    }
  }
  return { narrative: buildFallback(fp), model: 'fallback-template' };
}

async function upsert(fp: FactPack, n: Narrative, model: string): Promise<void> {
  await pool.query(
    `INSERT INTO report_narratives (scope_type, scope_key, "window", generated_at, headline, body, highlights, model, fact_pack)
     VALUES ($1, $2, $3, now(), $4, $5, $6::jsonb, $7, $8::jsonb)
     ON CONFLICT (scope_type, scope_key, "window") DO UPDATE SET
       generated_at = now(), headline = EXCLUDED.headline, body = EXCLUDED.body,
       highlights = EXCLUDED.highlights, model = EXCLUDED.model, fact_pack = EXCLUDED.fact_pack`,
    [fp.scopeType, fp.scopeKey, fp.window, n.headline, n.body, JSON.stringify(n.highlights), model, JSON.stringify(fp)],
  );
}

/**
 * The monitors that get a per-monitor AI narrative each cycle: LIVE checks only.
 *
 * ★ TWO DIFFERENT "active check" predicates live in this codebase and the divergence on `enabled` is
 * DELIBERATE — do NOT unify them (that erases a real distinction: the countable_run / flake-budget lesson):
 *   live_check       = enabled AND archived_at IS NULL   — "does this produce LIVE health RIGHT NOW?"
 *                      THIS loop. A paused check produces no live signal to narrate, and an ARCHIVED/retired
 *                      check must NEVER get an urgent AI action-item written about it (rca-demo: 0% avail,
 *                      2,264 dead runs, narrated + billed at AOAI prices every cycle until this).
 *   reportable_check = archived_at IS NULL               — "is this a real HISTORICAL record?" A PAUSED
 *                      check's incidents + SLO history are real and stay reportable.
 * `archived_at IS NULL` is the shared floor both need; `enabled` is the extra liveness filter only the live
 * predicate adds. (Mirrors #313's cost_projection fix exactly — exclude archived, keep paused visible.)
 */
export async function narratableCheckIds(): Promise<{ id: string; name: string }[]> {
  const { rows } = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM checks WHERE enabled AND archived_at IS NULL ORDER BY id`,
  );
  return rows;
}

/**
 * Generate + store narratives for the fleet and each LIVE monitor (enabled AND not archived). No-ops
 * (returns 0) when AOAI is not configured (Layer 3 dark, zero cost). Returns the number of narratives
 * written.
 */
export async function runNarratives(): Promise<number> {
  if (!aoaiConfigured()) {
    console.log('[narrative] AZURE_OPENAI_* absent — Layer 3 off (no narratives generated)');
    return 0;
  }
  let written = 0;

  const fleet = await computeFactPack({ type: 'fleet', checkId: null, key: '', name: 'Fleet' });
  const fleetN = await narrate(fleet);
  await upsert(fleet, fleetN.narrative, fleetN.model);
  written++;
  console.log(`[narrative] fleet: "${fleetN.narrative.headline}" (${fleetN.model})`);

  const rows = await narratableCheckIds();
  for (const c of rows) {
    const fp = await computeFactPack({ type: 'monitor', checkId: Number(c.id), key: String(c.id), name: c.name });
    const res = await narrate(fp);
    await upsert(fp, res.narrative, res.model);
    written++;
  }
  console.log(`[narrative] wrote ${written} narrative(s) (1 fleet + ${rows.length} monitor(s))`);
  return written;
}
