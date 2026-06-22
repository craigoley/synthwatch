// OpenTelemetry OTLP trace export — a SIDE CHANNEL that emits each check run as an
// OTel trace so a fork can plug SynthWatch into Grafana / Honeycomb / Dash0 / any
// OTel backend instead of being a data silo.
//
// OPT-IN: if OTEL_EXPORTER_OTLP_ENDPOINT is unset, the SDK is never initialised —
// zero overhead, zero behaviour change. NON-FATAL + ISOLATED: every entry point is
// wrapped so an SDK/init/export failure can never throw into the run path, change a
// verdict, or block recording. Export is batched (BatchSpanProcessor) so a slow or
// dead collector never blocks a run; the run is already recorded by the time we
// emit, and spans are flushed on shutdown.
//
// There is NO finalised OTel semantic convention for synthetic checks yet, so we
// use the conventional HTTP/url/server attributes where they apply and a NAMESPACED
// `synthwatch.*` set for the synthetic-specific bits (collision-proof against a
// future standard).
import {
  trace,
  context,
  SpanStatusCode,
  SpanKind,
  ValueType,
  type Tracer,
  type Span,
  type Attributes,
  type Histogram,
  type Counter,
} from '@opentelemetry/api';
import { NodeTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  AggregationTemporality,
} from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_URL_FULL,
  ATTR_SERVER_ADDRESS,
} from '@opentelemetry/semantic-conventions';

let tracer: Tracer | null = null;
let provider: NodeTracerProvider | null = null;

// Metrics (PR phase-2): a MeterProvider alongside the tracer, same endpoint/gate.
let meterProvider: MeterProvider | null = null;
let durationHist: Histogram | null = null;
let runsCounter: Counter | null = null;
let upCounter: Counter | null = null;

/** True once OTLP export is initialised — lets callers skip work on the off path. */
export function otelEnabled(): boolean {
  return tracer !== null;
}

/** True once metric instruments are initialised — independent of trace init. */
export function metricsEnabled(): boolean {
  return durationHist !== null;
}

/**
 * Initialise OTLP trace export ONCE at startup, only if OTEL_EXPORTER_OTLP_ENDPOINT
 * is set. The OTLP/HTTP exporter reads that endpoint and OTEL_EXPORTER_OTLP_HEADERS
 * (for backend auth) from the environment itself. Never throws.
 */
export function initOtel(): void {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return; // opt-in: off by default
  try {
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.SYNTHWATCH_OTEL_SERVICE_NAME ?? 'synthwatch-runner',
      'deployment.environment': process.env.SYNTHWATCH_ENV ?? 'production',
    });
    // No-arg exporter: honours OTEL_EXPORTER_OTLP_ENDPOINT + OTEL_EXPORTER_OTLP_HEADERS.
    const exporter = new OTLPTraceExporter();
    provider = new NodeTracerProvider({
      resource,
      spanProcessors: [new BatchSpanProcessor(exporter)],
    });
    provider.register();
    tracer = provider.getTracer('synthwatch-runner');
    console.log(`[otel] OTLP trace export ON -> ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}`);
  } catch (err) {
    // Init failure must not affect the runner; export simply stays off.
    console.warn('[otel] trace init failed; trace export disabled:', err instanceof Error ? err.message : err);
    tracer = null;
    provider = null;
  }

  // Metrics — same endpoint/headers, its own try so a metrics failure can't
  // disable traces (or the runner). DELTA temporality suits the ephemeral job:
  // each tick is a fresh process, so an export carries that tick's counts.
  try {
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.SYNTHWATCH_OTEL_SERVICE_NAME ?? 'synthwatch-runner',
      'deployment.environment': process.env.SYNTHWATCH_ENV ?? 'production',
    });
    const metricExporter = new OTLPMetricExporter({
      temporalityPreference: AggregationTemporality.DELTA,
    });
    meterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: metricExporter,
          exportIntervalMillis: 60000,
        }),
      ],
    });
    const meter = meterProvider.getMeter('synthwatch-runner');
    durationHist = meter.createHistogram('synthwatch.check.duration', {
      description: 'Check run duration (ms) — yields p50/p95/p99 in the backend.',
      unit: 'ms',
      valueType: ValueType.DOUBLE,
    });
    runsCounter = meter.createCounter('synthwatch.check.runs', {
      description: 'Total check runs, by status.',
      valueType: ValueType.INT,
    });
    upCounter = meter.createCounter('synthwatch.check.up', {
      description: 'Check outcomes labelled result=up|down — ratio for availability.',
      valueType: ValueType.INT,
    });
    console.log(`[otel] OTLP metric export ON -> ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}`);
  } catch (err) {
    console.warn('[otel] metric init failed; metric export disabled:', err instanceof Error ? err.message : err);
    meterProvider = null;
    durationHist = runsCounter = upCounter = null;
  }
}

/** A run_step rendered as a child span. */
export interface OtelStep {
  index: number;
  name: string;
  status: string; // pass | fail | error
  durationMs: number;
  startedAtMs: number;
  errorMessage: string | null;
}

export interface OtelRun {
  checkId: number;
  checkName: string;
  checkKind: string;
  method: string;
  targetUrl: string;
  runId: number;
  status: 'pass' | 'warn' | 'fail' | 'error';
  errorMessage: string | null;
  httpStatus: number | null;
  startMs: number;
  durationMs: number;
  steps: OtelStep[];
  /** The runner's vantage point (forward-looking for multi-location). Bounded. */
  location?: string;
}

/** pass/warn -> OK; fail/error -> ERROR (+ a failure event carrying the message). */
function applyStatus(span: Span, status: string, message: string | null): void {
  if (status === 'fail' || status === 'error') {
    span.setStatus({ code: SpanStatusCode.ERROR, message: message ?? status });
    if (message) span.addEvent('synthwatch.failure', { 'synthwatch.run.status': status, message });
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }
}

/** Best-effort host from the target for server.address. */
function serverAddress(target: string): Attributes {
  try {
    const host = new URL(target.includes('://') ? target : `https://${target}`).hostname;
    return host ? { [ATTR_SERVER_ADDRESS]: host } : {};
  } catch {
    return {};
  }
}

/**
 * Emit a run as a root span (+ one child span per run_step = the funnel). Timing is
 * the run's real start/duration; steps use their recorded start/duration. Entirely
 * non-fatal — any failure is swallowed so the run path is never affected.
 */
export function emitRunSpan(run: OtelRun): void {
  if (!tracer) return;
  try {
    const attributes: Attributes = {
      'synthwatch.synthetic': true,
      'synthwatch.check.id': run.checkId,
      'synthwatch.check.kind': run.checkKind,
      'synthwatch.check.name': run.checkName,
      'synthwatch.run.id': run.runId,
      'synthwatch.run.status': run.status,
      'synthwatch.location': run.location ?? 'default',
      [ATTR_URL_FULL]: run.targetUrl,
      ...serverAddress(run.targetUrl),
    };
    if (run.checkKind === 'http') {
      attributes[ATTR_HTTP_REQUEST_METHOD] = (run.method || 'GET').toUpperCase();
      if (run.httpStatus != null) attributes[ATTR_HTTP_RESPONSE_STATUS_CODE] = run.httpStatus;
    }

    const root = tracer.startSpan(`check ${run.checkName}`, {
      kind: SpanKind.CLIENT,
      startTime: run.startMs,
      attributes,
    });
    applyStatus(root, run.status, run.errorMessage);

    // Child spans = run_steps, nested under the root (browser/multistep funnel).
    const ctx = trace.setSpan(context.active(), root);
    for (const s of run.steps) {
      const child = tracer.startSpan(
        s.name,
        {
          startTime: s.startedAtMs,
          attributes: {
            'synthwatch.synthetic': true,
            'synthwatch.step.index': s.index,
            'synthwatch.step.name': s.name,
            'synthwatch.step.status': s.status,
          },
        },
        ctx,
      );
      applyStatus(child, s.status, s.errorMessage);
      child.end(s.startedAtMs + s.durationMs);
    }

    root.end(run.startMs + run.durationMs);
  } catch (err) {
    console.warn('[otel] emit failed (non-fatal):', err instanceof Error ? err.message : err);
  }
}

/**
 * Record the numeric metrics for a run: duration histogram + runs counter +
 * up/down counter. ALL attributes are BOUNDED (check id/kind/name, the 4-state
 * status, result=up|down, location) — high-cardinality values (run id, url,
 * timestamps, error messages, http status) are deliberately NOT attached, since
 * metric attributes become Prometheus label dimensions. Non-fatal.
 */
export function recordRunMetric(run: OtelRun): void {
  if (!durationHist || !runsCounter || !upCounter) return; // metrics off / init failed
  try {
    // Bounded label set shared by the duration histogram + runs counter.
    const attrs: Attributes = {
      'synthwatch.synthetic': true,
      'synthwatch.check.id': run.checkId,
      'synthwatch.check.kind': run.checkKind,
      'synthwatch.check.name': run.checkName,
      'synthwatch.run.status': run.status,
      'synthwatch.location': run.location ?? 'default',
    };
    durationHist.record(run.durationMs, attrs);
    runsCounter.add(1, attrs);

    // Availability series: result=up|down (up = pass|warn). 2-state per check, so
    // a backend ratios up / (up+down) cleanly. No 4-state status here.
    const result = run.status === 'pass' || run.status === 'warn' ? 'up' : 'down';
    upCounter.add(1, {
      'synthwatch.synthetic': true,
      'synthwatch.check.id': run.checkId,
      'synthwatch.check.kind': run.checkKind,
      'synthwatch.check.name': run.checkName,
      'synthwatch.result': result,
      'synthwatch.location': run.location ?? 'default',
    });
  } catch (err) {
    console.warn('[otel] metric record failed (non-fatal):', err instanceof Error ? err.message : err);
  }
}

/** Flush + close trace AND metric exporters on shutdown, CONCURRENTLY and each
 *  bounded, so a dead collector can't hang the job (total ~5s, not 5s per signal). */
export async function shutdownOtel(): Promise<void> {
  const bounded = async (label: string, p: Promise<unknown> | undefined): Promise<void> => {
    if (!p) return;
    try {
      await Promise.race([p, new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
    } catch (err) {
      console.warn(`[otel] ${label} shutdown flush failed:`, err instanceof Error ? err.message : err);
    }
  };
  await Promise.all([
    bounded('trace', provider?.shutdown()),
    bounded('metric', meterProvider?.shutdown()),
  ]);
}
