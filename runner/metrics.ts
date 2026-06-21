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
  transferBytes: null,
  resourceCount: null,
  domNodeCount: null,
  jsHeapBytes: null,
  cpuTimeMs: null,
  layoutCount: null,
  recalcStyleCount: null,
};

/** A live capture session; call collect() once, after the flow finishes. */
export interface MetricsCapture {
  collect(): Promise<RunMetrics>;
}

// Installed before navigation so the LCP observer is live from the first
// document. LCP only finalises on user input / page-hide, so we keep the latest
// observed value and read it before the context is torn down.
const LCP_INIT_SCRIPT = `(() => {
  try {
    window.__swLCP = 0;
    const po = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (last) window.__swLCP = last.startTime;
    });
    po.observe({ type: 'largest-contentful-paint', buffered: true });
  } catch { /* observer unsupported — lcp stays null */ }
})();`;

// Shape returned by the in-page evaluate. All raw DOMHighResTimeStamps (ms).
interface RawPageTimings {
  responseStart: number;
  domContentLoadedEventEnd: number;
  loadEventEnd: number;
  fcp: number;
  lcp: number;
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
  // Register the LCP observer for every document this page loads.
  await page.addInitScript(LCP_INIT_SCRIPT).catch(() => {
    /* init scripts unsupported — lcp stays null */
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
    async collect(): Promise<RunMetrics> {
      const metrics: RunMetrics = { ...EMPTY_METRICS };

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
          // up to ~3s, exit as soon as LCP stabilises between samples
          for (let i = 0; i < 6; i++) {
            await new Promise((r) => setTimeout(r, 500));
            const cur = read();
            if (cur === prev) break;
            prev = cur;
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
          return {
            responseStart: nav?.responseStart ?? 0,
            domContentLoadedEventEnd: nav?.domContentLoadedEventEnd ?? 0,
            loadEventEnd: nav?.loadEventEnd ?? 0,
            fcp: paint?.startTime ?? 0,
            lcp: (window as unknown as { __swLCP?: number }).__swLCP ?? 0,
            domNodeCount: document.getElementsByTagName('*').length,
          };
        });
        metrics.ttfbMs = nz(raw.responseStart);
        metrics.domContentLoadedMs = nz(raw.domContentLoadedEventEnd);
        metrics.loadEventMs = nz(raw.loadEventEnd);
        metrics.fcpMs = nz(raw.fcp);
        metrics.lcpMs = nz(raw.lcp);
        metrics.domNodeCount = raw.domNodeCount > 0 ? raw.domNodeCount : null;
      } catch {
        /* page already navigated away / closed — leave timing fields null */
      }

      // Page weight: let finished responses report their sizes, bounded so a
      // stuck in-flight request can't hang teardown.
      try {
        await Promise.race([Promise.allSettled(sizePromises), delay(2000)]);
        metrics.transferBytes = transferBytes;
        metrics.resourceCount = resourceCount;
      } catch {
        /* leave weight fields at whatever was gathered */
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
          /* getMetrics failed — leave CDP fields null */
        }
      }

      return metrics;
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
       transfer_bytes, resource_count, dom_node_count,
       js_heap_bytes, cpu_time_ms, layout_count, recalc_style_count
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (run_id) DO NOTHING`,
    [
      runId,
      m.ttfbMs,
      m.domContentLoadedMs,
      m.loadEventMs,
      m.fcpMs,
      m.lcpMs,
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
