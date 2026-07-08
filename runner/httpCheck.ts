// Cheap-tier HTTP check: a plain fetch() with a generic assertion evaluator. No
// browser, no Playwright — this path must stay light because most checks are
// HTTP and run frequently.
//
// Request config (custom headers / body / auth) is sent when present; auth uses
// a SECRET REFERENCE (an env-var name on the runner) — credentials are never read
// from the DB row. Assertions are evaluated by ./assertions; an empty assertion
// set falls back to the legacy expected_status (+ body_must_contain) so existing
// checks behave identically.
import type { Check, AuthConfig } from './db.js';
import {
  evaluateAssertions,
  type Assertion,
  type ResponseFacets,
} from './assertions.js';
import { noteDeployMarker, hostOf } from './deploys.js';
import { bypassHeaderFor } from './vercelBypass.js';
import { resolveSecretHeaders } from './secretHeaders.js';

export interface HttpResult {
  // 'pass'  = all assertions met.
  // 'fail'  = a clean assertion miss (status/header/body/json_path/... mismatch).
  // 'error' = an exception/timeout/infra/config problem (network down, timeout,
  //           or an auth secret env var that isn't set).
  verdict: 'pass' | 'fail' | 'error';
  httpStatus: number | null;
  durationMs: number;
  error: string | null;
}

/** The legacy assertions a check carries when its `assertions` array is empty. */
function legacyAssertions(check: Check): Assertion[] {
  const a: Assertion[] = [
    { source: 'status', comparison: 'eq', expected: check.expected_status },
  ];
  if (check.body_must_contain) {
    a.push({ source: 'body', comparison: 'contains', expected: check.body_must_contain });
  }
  return a;
}

/**
 * Build the Authorization (or api-key) header from the check's auth config.
 * Returns { header } to apply, {} for no auth, or { error } if a referenced
 * secret env var is missing (a config problem surfaced as a clear error).
 */
export function buildAuthHeader(
  auth: AuthConfig | null,
): { header?: [string, string]; error?: string } {
  if (!auth || !auth.type || auth.type === 'none') return {};

  if (auth.type === 'bearer') {
    const token = auth.token_env ? process.env[auth.token_env] : undefined;
    if (!token) return { error: `auth: env var "${auth.token_env}" not set` };
    return { header: ['authorization', `Bearer ${token}`] };
  }
  if (auth.type === 'basic') {
    const pw = auth.password_env ? process.env[auth.password_env] : undefined;
    if (!pw) return { error: `auth: env var "${auth.password_env}" not set` };
    const b64 = Buffer.from(`${auth.username ?? ''}:${pw}`).toString('base64');
    return { header: ['authorization', `Basic ${b64}`] };
  }
  if (auth.type === 'api_key') {
    const val = auth.value_env ? process.env[auth.value_env] : undefined;
    if (!val) return { error: `auth: env var "${auth.value_env}" not set` };
    return { header: [auth.header ?? 'x-api-key', val] };
  }
  return { error: `unknown auth type: ${String(auth.type)}` };
}

export async function runHttpCheck(check: Check): Promise<HttpResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), check.timeout_ms);

  try {
    // --- build the request ---
    const headers = new Headers();
    if (check.request_headers) {
      for (const [k, v] of Object.entries(check.request_headers)) headers.set(k, String(v));
    }
    const auth = buildAuthHeader(check.auth);
    if (auth.error) {
      return { verdict: 'error', httpStatus: null, durationMs: Date.now() - start, error: auth.error };
    }
    if (auth.header) headers.set(auth.header[0], auth.header[1]);

    // Per-monitor SECRET headers (references-only): resolve process.env[ENV_VAR] per ref and set on the
    // request. A single fetch to target_url, so it's inherently first-party (host-scoped by construction).
    for (const [h, v] of Object.entries(
      resolveSecretHeaders(check.secret_headers, check.target_url, hostOf(check.target_url)),
    )) {
      headers.set(h, v);
    }

    // Vercel Deployment Protection: add the bypass token ONLY when target_url is a protected host AND the
    // fleet secret is set (host-scoped + fail-soft — see vercelBypass.ts). A single fetch to target_url, so
    // this is inherently scoped to the check's own host; non-protected checks + local runs are untouched.
    const bypass = bypassHeaderFor(check.target_url);
    if (bypass) headers.set(bypass[0], bypass[1]);

    const method = (check.method || 'GET').toUpperCase();
    const init: RequestInit = { method, redirect: 'follow', signal: controller.signal, headers };
    if (check.request_body != null && method !== 'GET' && method !== 'HEAD') {
      init.body = check.request_body;
    }

    // --- send + measure (response time = to headers, before reading the body) ---
    const res = await fetch(check.target_url, init);
    const responseTimeMs = Date.now() - start;

    // --- gather facets; only read the body if an assertion needs it ---
    const assertions = check.assertions?.length ? check.assertions : legacyAssertions(check);
    const needsBody = assertions.some(
      (a) => a.source === 'body' || a.source === 'json_path' || a.source === 'size',
    );
    // Read the body if an assertion needs it OR if it's HTML we can mine for a deploy marker (sentry-release /
    // build-id / Next buildId live in the body; the etag marker is header-only). Otherwise release the socket.
    const isHtml = (res.headers.get('content-type') ?? '').includes('text/html');
    let body: string | null = null;
    let sizeBytes: number | null = null;
    if (needsBody) {
      body = await res.text();
      sizeBytes = Buffer.byteLength(body);
    } else if (isHtml) {
      // Best-effort read purely to mine a deploy marker. No assertion depends on it, so a body-read
      // failure/timeout here must NEVER flip a healthy status-only check to 'error' (the marker feature
      // is "never fails a run"). Swallow it — worst case we just miss a marker this tick.
      body = await res.text().catch(() => null);
    } else {
      // No body assertion + non-HTML: discard the unread stream so undici can release the
      // socket promptly instead of holding it open until GC.
      await res.body?.cancel().catch(() => {});
    }

    // Deploy-markers v1: auto-detect a deploy-identity marker from the response we already fetched. Best-effort
    // (never fails the run); records a deploy on marker change, or flags a silent-null for a host that used to
    // have one. sizeBytes stays null for the marker-only body read (no body assertion → no size to report).
    await noteDeployMarker(check.target_url, res.headers, body, check.id);

    const facets: ResponseFacets = {
      status: res.status,
      responseTimeMs,
      headers: res.headers,
      body,
      sizeBytes,
    };

    const { ok, failures } = evaluateAssertions(assertions, facets);
    return {
      verdict: ok ? 'pass' : 'fail',
      httpStatus: res.status,
      durationMs: responseTimeMs,
      error: ok ? null : failures.join('; '),
    };
  } catch (err) {
    // A thrown fetch (network failure, DNS, connection reset) or an abort/timeout
    // is an EXCEPTION, not a clean assertion miss => 'error'.
    const message =
      err instanceof Error && err.name === 'AbortError'
        ? `timed out after ${check.timeout_ms}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    return { verdict: 'error', httpStatus: null, durationMs: Date.now() - start, error: message };
  } finally {
    clearTimeout(timer);
  }
}
