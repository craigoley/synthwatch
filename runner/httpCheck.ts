// Cheap-tier HTTP check: a plain fetch() with status + body assertions. No
// browser, no Playwright — this path must stay light because most checks are
// HTTP and run frequently.
import type { Check } from './db.js';

export interface HttpResult {
  // 'pass'  = expectations met.
  // 'fail'  = a clean assertion miss (wrong status, body-must-contain miss).
  // 'error' = an exception/timeout/infra problem (network down, DNS, timeout).
  verdict: 'pass' | 'fail' | 'error';
  httpStatus: number | null;
  durationMs: number;
  error: string | null;
}

export async function runHttpCheck(check: Check): Promise<HttpResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), check.timeout_ms);

  try {
    const res = await fetch(check.target_url, {
      method: check.method,
      redirect: 'follow',
      signal: controller.signal,
    });
    const durationMs = Date.now() - start;

    if (res.status !== check.expected_status) {
      return {
        verdict: 'fail',
        httpStatus: res.status,
        durationMs,
        error: `expected status ${check.expected_status}, got ${res.status}`,
      };
    }

    if (check.body_must_contain) {
      const body = await res.text();
      if (!body.includes(check.body_must_contain)) {
        return {
          verdict: 'fail',
          httpStatus: res.status,
          durationMs,
          error: `body did not contain "${check.body_must_contain}"`,
        };
      }
    }

    return { verdict: 'pass', httpStatus: res.status, durationMs, error: null };
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
