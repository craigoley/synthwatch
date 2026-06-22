// Multistep API chains — execute an ordered list of HTTP steps, passing values
// between them. This is model (A) DECLARATIVE: a chain is DATA (checks.steps
// JSONB), not code, so it reuses the engines already built for single http
// checks — the assertion evaluator, the secret-ref auth, JSONPath — and adds only
// what's chain-specific: ordered execution, {{var}} template injection, JSONPath
// EXTRACTION into named vars, and cookie carry-forward.
//
// Per step: resolve {{var}} templates -> build request (method/url/headers/body +
// secret-ref auth + carried cookies) -> fetch -> assert (existing engine) ->
// record a run_steps row -> extract vars for later steps. Stop at the first
// failing step (recording WHICH step + why), like a browser flow. Status: an
// assertion miss => 'fail'; an exception/timeout/unresolved-var/missing-secret =>
// 'error'; all steps pass => 'pass'.
import type { Check, ChainStep } from './db.js';
import { pool } from './db.js';
import { buildAuthHeader } from './httpCheck.js';
import {
  evaluateAssertions,
  jsonPath,
  type Assertion,
  type ResponseFacets,
} from './assertions.js';

export interface MultistepResult {
  verdict: 'pass' | 'fail' | 'error';
  durationMs: number;
  /** Name of the step that failed/errored, or null if the whole chain passed. */
  failedStep: string | null;
  /** The failure reason (assertion misses / exception), or null on pass. */
  error: string | null;
}

type Vars = Record<string, unknown>;

const TEMPLATE = /\{\{\s*([^}\s]+)\s*\}\}/g;

/** Substitute {{var}} tokens from `vars`. Reports any token with no matching var. */
function resolveTemplate(input: string, vars: Vars): { value: string; missing: string[] } {
  const missing: string[] = [];
  const value = input.replace(TEMPLATE, (_m, name: string) => {
    if (!(name in vars) || vars[name] === undefined || vars[name] === null) {
      missing.push(name);
      return '';
    }
    return String(vars[name]);
  });
  return { value, missing };
}

/** Parse a Set-Cookie value into [name, value] (everything before the first ';'). */
function parseCookie(setCookie: string): [string, string] | null {
  const first = setCookie.split(';', 1)[0];
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  return [first.slice(0, eq).trim(), first.slice(eq + 1).trim()];
}

async function recordStep(
  runId: number,
  index: number,
  name: string,
  status: 'pass' | 'fail' | 'error',
  durationMs: number,
  errorMessage: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO run_steps (run_id, step_index, name, status, duration_ms, error_message)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [runId, index, name, status, durationMs, errorMessage],
  );
}

export async function runMultistepChain(check: Check, runId: number): Promise<MultistepResult> {
  const chainStart = Date.now();
  const steps = check.steps ?? [];
  if (steps.length === 0) {
    return { verdict: 'error', durationMs: 0, failedStep: null, error: 'multistep check has no steps' };
  }

  const vars: Vars = {};
  const cookies = new Map<string, string>();

  for (let i = 0; i < steps.length; i++) {
    const step: ChainStep = steps[i];
    const name = step.name || `step ${i + 1}`;
    const stepStart = Date.now();

    // Helper to fail/error this step: record the run_step and return the result.
    const stop = async (
      status: 'fail' | 'error',
      message: string,
    ): Promise<MultistepResult> => {
      await recordStep(runId, i, name, status, Date.now() - stepStart, message);
      return { verdict: status, durationMs: Date.now() - chainStart, failedStep: name, error: message };
    };

    // --- resolve {{var}} templates in url / headers / body ---
    const missing: string[] = [];
    const urlR = resolveTemplate(step.url, vars);
    missing.push(...urlR.missing);
    const headers = new Headers();
    for (const [k, v] of Object.entries(step.headers ?? {})) {
      const r = resolveTemplate(String(v), vars);
      missing.push(...r.missing);
      headers.set(k, r.value);
    }
    let body: string | undefined;
    const method = (step.method ?? 'GET').toUpperCase();
    if (step.body != null && method !== 'GET' && method !== 'HEAD') {
      const r = resolveTemplate(step.body, vars);
      missing.push(...r.missing);
      body = r.value;
    }
    if (missing.length > 0) {
      return stop('error', `unresolved template variable(s): ${[...new Set(missing)].map((m) => `{{${m}}}`).join(', ')}`);
    }

    // --- secret-ref auth (reuses the single-check logic; never plaintext) ---
    const auth = buildAuthHeader(step.auth ?? null);
    if (auth.error) return stop('error', auth.error);
    if (auth.header) headers.set(auth.header[0], auth.header[1]);

    // --- carry cookies forward (set first so an explicit header can override) ---
    if (cookies.size > 0 && !headers.has('cookie')) {
      headers.set('cookie', [...cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    }

    // --- send (per-step timeout = the check's timeout_ms) ---
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), check.timeout_ms);
    let facets: ResponseFacets;
    let setCookies: string[];
    try {
      const reqStart = Date.now();
      const res = await fetch(urlR.value, { method, headers, body, redirect: 'follow', signal: controller.signal });
      const responseTimeMs = Date.now() - reqStart;
      const text = await res.text(); // chains are low-volume; always read for extract/assert
      setCookies = res.headers.getSetCookie();
      facets = {
        status: res.status,
        responseTimeMs,
        headers: res.headers,
        body: text,
        sizeBytes: Buffer.byteLength(text),
      };
    } catch (err) {
      const message =
        err instanceof Error && err.name === 'AbortError'
          ? `timed out after ${check.timeout_ms}ms`
          : err instanceof Error
            ? err.message
            : String(err);
      return stop('error', message);
    } finally {
      clearTimeout(timer);
    }

    // update the cookie jar from this response
    for (const sc of setCookies) {
      const parsed = parseCookie(sc);
      if (parsed) cookies.set(parsed[0], parsed[1]);
    }

    // --- assert (existing engine), per step ---
    const assertions: Assertion[] = step.assertions ?? [];
    const { ok, failures } = evaluateAssertions(assertions, facets);
    if (!ok) {
      return stop('fail', `step "${name}" assertion(s) failed: ${failures.join('; ')}`);
    }

    // --- extract vars for later steps (from the parsed JSON body) ---
    if (step.extract?.length) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(facets.body ?? '');
      } catch {
        return stop('error', `step "${name}" extract failed: response body is not JSON`);
      }
      for (const rule of step.extract) {
        const value = jsonPath(parsed, rule.jsonPath);
        if (value === undefined) {
          return stop('error', `step "${name}" extract "${rule.var}": no value at ${rule.jsonPath}`);
        }
        vars[rule.var] = value;
      }
    }

    await recordStep(runId, i, name, 'pass', Date.now() - stepStart, null);
  }

  return { verdict: 'pass', durationMs: Date.now() - chainStart, failedStep: null, error: null };
}
