// Pull the ACTUAL Azure bill from Cost Management — the cost panel's headline DISPLAYS this, it does not
// COMPUTE one. A monitoring tool that models its own spend and drifts from the invoice is the confidently-
// wrong signal we spend our time killing; cost_projection's per-monitor $ was exactly that (it priced every
// active-second from zero, ignoring the per-subscription free grant, and modeled ONLY ACA compute — half the
// bill). So the fleet dollar figure moves HERE: MTD actual + Azure's own forecast, for the RG scope
// (synthwatch-rg == the whole subscription's spend, confirmed with the owner), cached in azure_cost (0090)
// and served by /reports/cost.
//
// ★ GRACEFUL BY DESIGN — honestly absent beats falsely precise. If the ARM coordinates aren't configured
// (local/dev), the runner MI lacks Cost Management Reader (role not yet propagated), or the API errors, this
// returns null and refreshAzureCost() writes NOTHING — the cached row goes stale/absent and the UI falls back
// to a "see Azure Cost Management" deep link. NEVER throws into the caller.
//
// Auth mirrors jobTrigger.ts / the API's ArmRunnerJobTrigger: DefaultAzureCredential → management.azure.com
// token. The runner MI is granted Cost Management Reader at RG scope in infra/main.bicep.
import { DefaultAzureCredential } from '@azure/identity';

import type { Pool } from 'pg';

const ARM_ENDPOINT = 'https://management.azure.com';
const ARM_SCOPE = 'https://management.azure.com/.default';
// Cost Management query/forecast — pinned; 2023-11-01 is the stable GA the query + forecast actions share.
const COST_API_VERSION = '2023-11-01';
const ARM_TIMEOUT_MS = 20_000;

let credential: DefaultAzureCredential | null = null;

/** What the runner caches into azure_cost (0090) and the api serves. All figures are Azure's, not modeled. */
export interface AzureCostSnapshot {
  scope: string; // 'resourceGroups/synthwatch-rg' — the query scope the figures cover
  currency: string; // ISO currency Azure reported (e.g. 'USD')
  billingMonth: string; // 'YYYY-MM-01' (UTC) — the month these figures cover
  mtdActual: number; // month-to-date ACTUAL cost, all meters in scope
  mtdDays: number; // days elapsed in the billing month at fetch (the ramp denominator)
  forecastMonth: number | null; // Azure's OWN end-of-month forecast; null when the forecast API returns none
  portalUrl: string; // deep link to Cost Management for this scope (the honest-absent fallback target)
}

/** First-of-month (UTC) as YYYY-MM-01 for `at`, and the 1-based day-of-month (days elapsed incl. today).
 *  Exported for unit tests (month-boundary math is the risk). */
export function billingMonthParts(at: Date): { billingMonth: string; monthStart: Date; monthEnd: Date; mtdDays: number } {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth(); // 0-based
  const monthStart = new Date(Date.UTC(y, m, 1));
  const monthEnd = new Date(Date.UTC(y, m + 1, 0)); // last day of this month
  const mm = String(m + 1).padStart(2, '0');
  return { billingMonth: `${y}-${mm}-01`, monthStart, monthEnd, mtdDays: at.getUTCDate() };
}

/** Deep link to Cost Management cost-analysis, scoped to the RG — the UI's fallback when the pull is absent. */
function portalDeepLink(subscriptionId: string, resourceGroup: string): string {
  const scopeId = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`;
  return (
    'https://portal.azure.com/#view/Microsoft_Azure_CostManagement/Menu/~/costanalysis/scope/' +
    encodeURIComponent(scopeId)
  );
}

/** Find a column's index by name (case-insensitive) in a Cost Management result — the response is
 *  column-ordered, so NEVER read rows positionally (the order varies by account type / grouping). */
function columnIndex(columns: Array<{ name?: string }>, name: string): number {
  return columns.findIndex((c) => (c.name ?? '').toLowerCase() === name.toLowerCase());
}

async function armToken(): Promise<string> {
  credential ??= new DefaultAzureCredential();
  const token = await credential.getToken(ARM_SCOPE);
  if (!token?.token) throw new Error('could not acquire an ARM management token');
  return token.token;
}

async function postCost(scopePath: string, action: 'query' | 'forecast', body: unknown, token: string): Promise<unknown> {
  const url = `${ARM_ENDPOINT}/${scopePath}/providers/Microsoft.CostManagement/${action}?api-version=${COST_API_VERSION}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ARM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`CostManagement/${action} ${res.status} ${detail}`.trim());
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Sum the Cost column across rows + read the first Currency (defensive, column-name indexed). Returns null
 *  when the shape is unrecognizable (no Cost column) so the caller degrades to the deep link. Exported for
 *  unit tests — positional row reads are the historical footgun (column order varies by account type). */
export function parseCostRows(payload: unknown): { total: number; currency: string } | null {
  const props = (payload as { properties?: { columns?: Array<{ name?: string }>; rows?: unknown[][] } })?.properties;
  const columns = props?.columns ?? [];
  const rows = props?.rows ?? [];
  // Different account types name the money column differently — try the common ones in priority order.
  const costCol = ['Cost', 'PreTaxCost', 'CostUSD', 'PreTaxCostUSD']
    .map((n) => columnIndex(columns, n))
    .find((i) => i >= 0);
  if (costCol == null || costCol < 0) return null;
  const currCol = columnIndex(columns, 'Currency');
  let total = 0;
  let currency = 'USD';
  for (const row of rows) {
    const v = Number(row[costCol]);
    if (Number.isFinite(v)) total += v;
    if (currCol >= 0 && typeof row[currCol] === 'string' && row[currCol]) currency = row[currCol] as string;
  }
  return { total, currency };
}

/**
 * Fetch the RG's MTD actual + Azure's end-of-month forecast. Returns null (never throws) when unconfigured or
 * on any API failure — the caller then writes nothing and the UI shows the deep-link fallback.
 * `now` is injectable for tests (default: wall clock).
 */
export async function fetchAzureCost(now: Date = new Date()): Promise<AzureCostSnapshot | null> {
  const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID;
  const resourceGroup = process.env.AZURE_RESOURCE_GROUP;
  if (!subscriptionId || !resourceGroup) {
    console.warn('[azure-cost] skipped — AZURE_SUBSCRIPTION_ID / AZURE_RESOURCE_GROUP not set');
    return null;
  }
  const scopePath = `subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`;
  const { billingMonth, monthStart, monthEnd, mtdDays } = billingMonthParts(now);

  try {
    const token = await armToken();

    // 1) MTD ACTUAL — sum of Cost over the current month to date, no grouping.
    const actualBody = {
      type: 'ActualCost',
      timeframe: 'MonthToDate',
      dataset: { granularity: 'None', aggregation: { totalCost: { name: 'Cost', function: 'Sum' } } },
    };
    const actual = parseCostRows(await postCost(scopePath, 'query', actualBody, token));
    if (!actual) {
      console.warn('[azure-cost] query returned no recognizable Cost column — degrading to deep link');
      return null;
    }

    // 2) FORECAST — Azure's own projection for the WHOLE current month (actual so far + forecast remainder).
    //    Best-effort: a forecast failure must NOT lose the actual, so this is a nested try → forecastMonth null.
    let forecastMonth: number | null = null;
    try {
      const iso = (d: Date) => d.toISOString().slice(0, 10);
      const forecastBody = {
        type: 'ActualCost',
        timeframe: 'Custom',
        timePeriod: { from: `${iso(monthStart)}T00:00:00Z`, to: `${iso(monthEnd)}T23:59:59Z` },
        dataset: { granularity: 'None', aggregation: { totalCost: { name: 'Cost', function: 'Sum' } } },
        includeActualCost: true,
        includeFreshPartialCost: false,
      };
      const forecast = parseCostRows(await postCost(scopePath, 'forecast', forecastBody, token));
      if (forecast && forecast.total > 0) forecastMonth = forecast.total;
    } catch (err) {
      console.warn('[azure-cost] forecast unavailable (keeping MTD actual):', err instanceof Error ? err.message : err);
    }

    return {
      scope: `resourceGroups/${resourceGroup}`,
      currency: actual.currency,
      billingMonth,
      mtdActual: actual.total,
      mtdDays,
      forecastMonth,
      portalUrl: portalDeepLink(subscriptionId, resourceGroup),
    };
  } catch (err) {
    console.warn('[azure-cost] pull failed — UI falls back to the portal deep link:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Refresh the azure_cost (0090) single-row cache from Cost Management. BEST-EFFORT: returns true when a fresh
 * row was written, false when the pull was unavailable (nothing written — the last-good row simply ages, and
 * the UI shows its `fetched_at`/deep link). Never throws. `maxAgeHours` short-circuits when the cached row is
 * still fresh (so a frequently-running caller doesn't hammer the API); omit/0 to always refresh.
 */
export async function refreshAzureCost(pool: Pool, opts: { maxAgeHours?: number; now?: Date } = {}): Promise<boolean> {
  const now = opts.now ?? new Date();
  if (opts.maxAgeHours && opts.maxAgeHours > 0) {
    try {
      const { rows } = await pool.query<{ fresh: boolean }>(
        `SELECT fetched_at > now() - ($1 || ' hours')::interval AS fresh FROM azure_cost WHERE id = 1`,
        [String(opts.maxAgeHours)],
      );
      if (rows[0]?.fresh) {
        console.log('[azure-cost] cache still fresh — skipping refresh');
        return false;
      }
    } catch {
      /* no row yet / table absent → fall through and refresh */
    }
  }

  const snap = await fetchAzureCost(now);
  if (!snap) return false;

  await pool.query(
    `INSERT INTO azure_cost (id, scope, currency, billing_month, mtd_actual, mtd_days, forecast_month, portal_url, fetched_at)
     VALUES (1, $1, $2, $3::date, $4, $5, $6, $7, now())
     ON CONFLICT (id) DO UPDATE SET
       scope = EXCLUDED.scope, currency = EXCLUDED.currency, billing_month = EXCLUDED.billing_month,
       mtd_actual = EXCLUDED.mtd_actual, mtd_days = EXCLUDED.mtd_days, forecast_month = EXCLUDED.forecast_month,
       portal_url = EXCLUDED.portal_url, fetched_at = now()`,
    [snap.scope, snap.currency, snap.billingMonth, snap.mtdActual, snap.mtdDays, snap.forecastMonth, snap.portalUrl],
  );
  console.log(
    `[azure-cost] refreshed: ${snap.currency} ${snap.mtdActual.toFixed(2)} MTD (${snap.mtdDays}d)` +
      `${snap.forecastMonth != null ? `, forecast ${snap.forecastMonth.toFixed(2)}` : ', no forecast'} [${snap.scope}]`,
  );
  return true;
}
