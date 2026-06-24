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
        AND ($1::bigint IS NULL OR r.check_id = $1)`,
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
  };
}

// --- narrate (model only narrates) + deterministic fallback ---------------------------
const SYSTEM_PROMPT =
  `You write a terse reliability report for an SRE. Use ONLY the numbers and incidents in ` +
  `the data — never invent or estimate. Lead with what CHANGED and what's ANOMALOUS; state ` +
  `specific figures; cite incidents by classification. If nothing notable changed, say so in ` +
  `one sentence. No greetings, no "in conclusion", no advice unless an incident's RCA implies ` +
  `a concrete next step. Respond ONLY as JSON: ` +
  `{"headline": "<=1 sentence", "body": "2-5 sentences, markdown", "highlights": ["short string", ...]}.`;

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
  return {
    headline,
    body: bodyParts.join(' '),
    highlights: fp.anomalies.length ? fp.anomalies.slice(0, 5) : [`Availability ${avail}`, `p95 ${p95}`, `${c.incidents} incident(s)`],
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

/** Spot-check: the key figures (availability, p95, incident count) must appear in the
 *  prose. If the model omitted them, it's narrating something other than the facts ->
 *  prefer the fallback. */
export function spotCheck(n: Narrative, fp: FactPack): boolean {
  const prose = `${n.headline} ${n.body}`;
  const checks: string[] = [];
  // Availability: match the INTEGER part (e.g. "77" in 77.66%) — lenient on decimals/
  // rounding so a faithful citation ("77.66%", "77.7%", "77%") passes, while pure filler
  // (no figure at all) fails.
  if (fp.current.availabilityPct != null) checks.push(String(Math.trunc(fp.current.availabilityPct)));
  if (fp.current.p95 != null) checks.push(String(fp.current.p95));
  checks.push(String(fp.current.incidents));
  return checks.every((fig) => prose.includes(fig));
}

/** Narrate the fact pack. Returns the narrative + which model produced it (the deployment,
 *  or 'fallback-template'). The model only narrates; on any failure/filler -> fallback. */
export async function narrate(fp: FactPack): Promise<{ narrative: Narrative; model: string }> {
  const content = await chatCompletionContent({
    system: SYSTEM_PROMPT,
    user: JSON.stringify(fp),
    maxTokens: 700,
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
        if (spotCheck(n, fp)) return { narrative: n, model: DEFAULT_DEPLOYMENT ?? 'aoai' };
        console.warn('[narrative] model output failed spot-check (key figures missing) — fallback');
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
 * Generate + store narratives for the fleet and each enabled monitor. No-ops (returns 0)
 * when AOAI is not configured (Layer 3 dark, zero cost). Returns the number of narratives
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

  const { rows } = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM checks WHERE enabled ORDER BY id`,
  );
  for (const c of rows) {
    const fp = await computeFactPack({ type: 'monitor', checkId: Number(c.id), key: String(c.id), name: c.name });
    const res = await narrate(fp);
    await upsert(fp, res.narrative, res.model);
    written++;
  }
  console.log(`[narrative] wrote ${written} narrative(s) (1 fleet + ${rows.length} monitor(s))`);
  return written;
}
