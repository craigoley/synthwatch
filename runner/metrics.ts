// Tier-1 per-run telemetry capture for browser checks.
//
// This is ADDITIVE, passive instrumentation: it rides the navigation the flow
// already performs (it never triggers a second page load) and it must NEVER
// affect a check's pass/fail verdict. Every capture point is individually
// guarded — if a metric can't be read we record null for it and move on, and
// one run_metrics row is written per browser run regardless of outcome.
//
// Wiring (see runner/index.ts executeBrowser):
//   const cap = await startMetricsCapture(context, page);  // before the flow
//   ... run the flow ...
//   const metrics = await cap.collect();                   // after the flow
//   await writeRunMetrics(runId, metrics);                 // before context.close()

// The page.evaluate() callback below runs IN THE BROWSER and needs DOM types
// (window, document, PerformanceNavigationTiming). This is a Node project with
// no DOM lib, so pull DOM in for THIS file only rather than project-wide.
/// <reference lib="dom" />
import type { BrowserContext, Page } from 'playwright';
import { pool } from './db.js';

/** One run_metrics row's worth of values. Every field is nullable: partial
 *  telemetry beats none, and a capture failure must not fail the check. */
export interface RunMetrics {
  // Navigation Timing (W3C) + paint, in ms relative to navigation start.
  ttfbMs: number | null;
  domContentLoadedMs: number | null;
  loadEventMs: number | null;
  fcpMs: number | null;
  lcpMs: number | null;
  // Core Web Vitals: layout shift (unitless score) + interaction latency (ms).
  cls: number | null;
  inpMs: number | null;
  // Page weight.
  transferBytes: number | null;
  resourceCount: number | null;
  domNodeCount: number | null;
  // CDP Performance.getMetrics.
  jsHeapBytes: number | null;
  cpuTimeMs: number | null;
  layoutCount: number | null;
  recalcStyleCount: number | null;
}

const EMPTY_METRICS: RunMetrics = {
  ttfbMs: null,
  domContentLoadedMs: null,
  loadEventMs: null,
  fcpMs: null,
  lcpMs: null,
  cls: null,
  inpMs: null,
  transferBytes: null,
  resourceCount: null,
  domNodeCount: null,
  jsHeapBytes: null,
  cpuTimeMs: null,
  layoutCount: null,
  recalcStyleCount: null,
};

/** The result of collect(): the metrics PLUS the set of fields whose CAPTURE FAILED — i.e. their
 *  collection SECTION threw and the value is null because we couldn't read it, NOT because it's
 *  legitimately absent. ★ B1 silent-null: a budgeted metric in `captureFailed` is not-evaluable (must
 *  not pass green); a budgeted metric that's null but NOT in the set was captured-and-genuinely-absent
 *  (a page with no LCP) and still passes. collect() itself never throws — this set is how a silent
 *  capture failure becomes visible to the verdict. */
export interface MetricsResult {
  metrics: RunMetrics;
  captureFailed: Set<keyof RunMetrics>;
}

/** A live capture session; call collect() once, after the flow finishes. */
export interface MetricsCapture {
  collect(): Promise<MetricsResult>;
}

// The fields each collect() SECTION is responsible for — added to `captureFailed` when that section's
// read throws (so null-because-failed is distinguishable from null-because-absent).
const TIMINGS_FIELDS: (keyof RunMetrics)[] = [
  'ttfbMs', 'domContentLoadedMs', 'loadEventMs', 'fcpMs', 'lcpMs', 'cls', 'inpMs', 'domNodeCount',
];
const WEIGHT_FIELDS: (keyof RunMetrics)[] = ['transferBytes', 'resourceCount'];
const CDP_FIELDS: (keyof RunMetrics)[] = ['jsHeapBytes', 'cpuTimeMs', 'layoutCount', 'recalcStyleCount'];

// Installed before navigation so the observers are live from the first document.
// Each Core Web Vital accumulates into a window global we read at collect time:
//   __swLCP  largest-contentful-paint (latest entry's startTime)
//   __swCLS  cumulative layout shift (session-window score, excl. recent-input shifts)
//   __swINP  interaction to next paint (max interaction latency; needs real input)
// Separate try/catch per observer so one unsupported entry type can't kill the rest.
const CWV_INIT_SCRIPT = `(() => {
  try {
    window.__swLCP = 0;
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (last) window.__swLCP = last.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch { /* lcp unsupported -> stays null */ }

  try {
    // CLS = the largest "session window" sum (gaps < 1s, window < 5s) of
    // layout-shift values, ignoring shifts within 500ms of user input — the
    // Core Web Vitals definition (matches web-vitals.js).
    window.__swCLS = 0;
    let sessionValue = 0, sessionStart = 0, sessionLast = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.hadRecentInput) continue;
        if (sessionValue && e.startTime - sessionLast < 1000 && e.startTime - sessionStart < 5000) {
          sessionValue += e.value; sessionLast = e.startTime;
        } else {
          sessionValue = e.value; sessionStart = e.startTime; sessionLast = e.startTime;
        }
        if (sessionValue > window.__swCLS) window.__swCLS = sessionValue;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch { /* layout-shift unsupported -> cls stays 0 */ }

  try {
    // INP (best-effort): the max latency of a real interaction. interactionId>0
    // marks a genuine user interaction; a pure load flow with no input leaves
    // this 0 (recorded as NULL).
    window.__swINP = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.interactionId && e.duration > window.__swINP) window.__swINP = e.duration;
      }
    }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
  } catch { /* event timing unsupported -> inp stays null */ }
})();`;

// Shape returned by the in-page evaluate. All raw DOMHighResTimeStamps (ms).
interface RawPageTimings {
  responseStart: number;
  domContentLoadedEventEnd: number;
  loadEventEnd: number;
  fcp: number;
  lcp: number;
  cls: number;
  inp: number;
  domNodeCount: number;
}

/** A CDP Performance metric entry (Performance.getMetrics). */
interface CdpMetric {
  name: string;
  value: number;
}

const nz = (v: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Begin passive telemetry capture on a freshly-created page, BEFORE the flow
 * navigates. Never throws: any setup that fails simply yields nulls later.
 */
export async function startMetricsCapture(
  context: BrowserContext,
  page: Page,
): Promise<MetricsCapture> {
  // Register the CWV observers (LCP / CLS / INP) for every document this page loads.
  await page.addInitScript(CWV_INIT_SCRIPT).catch(() => {
    /* init scripts unsupported — those metrics stay null */
  });

  // Page weight: sum response body sizes as requests finish. request().sizes()
  // resolves only once a request completes, so we collect the promises and
  // drain them (with a timeout) at collect time to guard in-flight requests.
  let transferBytes = 0;
  let resourceCount = 0;
  const sizePromises: Promise<void>[] = [];
  page.on('response', (response) => {
    resourceCount += 1;
    sizePromises.push(
      response
        .request()
        .sizes()
        .then((s) => {
          transferBytes += s.responseBodySize ?? 0;
        })
        .catch(() => {
          /* request still in flight or failed — skip its bytes */
        }),
    );
  });

  // CDP performance counters (Chromium only). Enable now so cumulative counters
  // (TaskDuration, LayoutCount, …) cover the whole run.
  let cdpMetrics: (() => Promise<CdpMetric[]>) | null = null;
  try {
    const client = await context.newCDPSession(page);
    await client.send('Performance.enable');
    cdpMetrics = async () => {
      const { metrics } = await client.send('Performance.getMetrics');
      return metrics as CdpMetric[];
    };
  } catch {
    /* CDP unavailable — heap/cpu/layout metrics stay null */
  }

  return {
    async collect(): Promise<MetricsResult> {
      const metrics: RunMetrics = { ...EMPTY_METRICS };
      // Fields whose collection SECTION threw (null-because-failed, not null-because-absent). ★ B1.
      const captureFailed = new Set<keyof RunMetrics>();

      // Let LCP finalize before reading, so it isn't understated as == fcp. LCP
      // only grows as larger elements paint; on a JS-hydrated SPA the largest
      // element paints after the 'load' event, so a short flow can finish before
      // it.
      //
      // We deliberately DO NOT wait for networkidle: a heavy SPA (ads/analytics/
      // long-poll, e.g. wegmans.com) may NEVER reach network silence, so that
      // wait just rides its timeout on every run — it pinned this check's runs at
      // ~11s of pure settle regardless of real page speed. Instead we poll the
      // observed LCP until it stops growing: the MEANINGFUL "largest paint has
      // happened" signal, bounded (~3s) and exiting early once stable.
      await page
        .evaluate(async () => {
          const read = (): number =>
            (window as unknown as { __swLCP?: number }).__swLCP ?? 0;
          let prev = read();
          // up to ~3s; require TWO consecutive equal samples before declaring LCP
          // settled. Exiting on the FIRST equal pair under-reports LCP when a larger
          // element paints after a brief plateau (lazy hero image / late font) — one
          // matching pair isn't enough evidence the largest paint has happened.
          let stable = 0;
          for (let i = 0; i < 6; i++) {
            await new Promise((r) => setTimeout(r, 500));
            const cur = read();
            if (cur === prev) {
              if (++stable >= 2) break;
            } else {
              stable = 0;
              prev = cur;
            }
          }
        })
        .catch(() => {
          /* page navigated away / closed — read whatever is available below */
        });

      // Navigation Timing + paint + LCP + DOM node count, in one evaluate so we
      // don't perturb the page more than necessary.
      try {
        const raw = await page.evaluate<RawPageTimings>(() => {
          const nav = performance.getEntriesByType(
            'navigation',
          )[0] as PerformanceNavigationTiming | undefined;
          const paint = performance
            .getEntriesByType('paint')
            .find((e) => e.name === 'first-contentful-paint');
          const w = window as unknown as {
            __swLCP?: number;
            __swCLS?: number;
            __swINP?: number;
          };
          return {
            responseStart: nav?.responseStart ?? 0,
            domContentLoadedEventEnd: nav?.domContentLoadedEventEnd ?? 0,
            loadEventEnd: nav?.loadEventEnd ?? 0,
            fcp: paint?.startTime ?? 0,
            lcp: w.__swLCP ?? 0,
            cls: w.__swCLS ?? 0,
            inp: w.__swINP ?? 0,
            domNodeCount: document.getElementsByTagName('*').length,
          };
        });
        metrics.ttfbMs = nz(raw.responseStart);
        metrics.domContentLoadedMs = nz(raw.domContentLoadedEventEnd);
        metrics.loadEventMs = nz(raw.loadEventEnd);
        metrics.fcpMs = nz(raw.fcp);
        metrics.lcpMs = nz(raw.lcp);
        // CLS: 0 is a valid score (a stable page), so record it (null only if the
        // value isn't finite). Round to 4 dp to keep the stored number tidy.
        metrics.cls = Number.isFinite(raw.cls) ? Math.round(raw.cls * 10000) / 10000 : null;
        // INP: 0 means no interaction was observed -> null (don't fabricate it).
        metrics.inpMs = nz(raw.inp);
        metrics.domNodeCount = raw.domNodeCount > 0 ? raw.domNodeCount : null;
      } catch {
        // ★ The timings evaluate THREW → these fields are null because we couldn't READ them (not because
        // they're absent). Mark them failed so a budgeted metric here (lcpMs) is treated as not-evaluable.
        for (const f of TIMINGS_FIELDS) captureFailed.add(f);
      }

      // Page weight: let finished responses report their sizes, bounded so a
      // stuck in-flight request can't hang teardown.
      try {
        await Promise.race([Promise.allSettled(sizePromises), delay(2000)]);
        metrics.transferBytes = transferBytes;
        metrics.resourceCount = resourceCount;
      } catch {
        // ★ Weight gather threw → transferBytes (a budgeted metric) is null-because-failed, not absent.
        for (const f of WEIGHT_FIELDS) captureFailed.add(f);
      }

      // CDP counters.
      if (cdpMetrics) {
        try {
          const byName = new Map(
            (await cdpMetrics()).map((m) => [m.name, m.value]),
          );
          const heap = byName.get('JSHeapUsedSize');
          const task = byName.get('TaskDuration');
          const layout = byName.get('LayoutCount');
          const recalc = byName.get('RecalcStyleCount');
          if (heap !== undefined) metrics.jsHeapBytes = Math.round(heap);
          // TaskDuration is in seconds.
          if (task !== undefined) metrics.cpuTimeMs = Math.round(task * 1000);
          if (layout !== undefined) metrics.layoutCount = Math.round(layout);
          if (recalc !== undefined) {
            metrics.recalcStyleCount = Math.round(recalc);
          }
        } catch {
          // CDP getMetrics failed → these (non-budgeted) fields are null-because-failed.
          for (const f of CDP_FIELDS) captureFailed.add(f);
        }
      }

      return { metrics, captureFailed };
    },
  };
}

/**
 * Persist exactly one run_metrics row for a browser run. Safe to call with
 * all-null metrics; run_id is UNIQUE so a retry is a no-op.
 */
export async function writeRunMetrics(
  runId: number,
  m: RunMetrics,
): Promise<void> {
  await pool.query(
    `INSERT INTO run_metrics (
       run_id,
       ttfb_ms, dom_content_loaded_ms, load_event_ms, fcp_ms, lcp_ms,
       cls, inp_ms,
       transfer_bytes, resource_count, dom_node_count,
       js_heap_bytes, cpu_time_ms, layout_count, recalc_style_count
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (run_id) DO NOTHING`,
    [
      runId,
      m.ttfbMs,
      m.domContentLoadedMs,
      m.loadEventMs,
      m.fcpMs,
      m.lcpMs,
      m.cls,
      m.inpMs,
      m.transferBytes,
      m.resourceCount,
      m.domNodeCount,
      m.jsHeapBytes,
      m.cpuTimeMs,
      m.layoutCount,
      m.recalcStyleCount,
    ],
  );
}

export { EMPTY_METRICS };
