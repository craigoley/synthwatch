// No-code assertion model + a generic evaluator. The runner half of the endpoint
// assertion builder: given a set of assertions and the facets of an HTTP
// response, decide pass/fail and produce human messages for the failures.
//
// ALL assertions must pass for the check to pass. Each failure is reported as
// "expected <source>[ <target>] <comparison> <expected>, got <actual>".

export type AssertionSource =
  | 'status'
  | 'response_time'
  | 'header'
  | 'body'
  | 'json_path'
  | 'size';

export type AssertionComparison =
  | 'eq'
  | 'ne'
  | 'lt'
  | 'gt'
  | 'gte'
  | 'lte'
  | 'contains'
  | 'not_contains'
  | 'matches'
  | 'exists'
  | 'one_of';

export interface Assertion {
  source: AssertionSource;
  comparison: AssertionComparison;
  /** Header name (source=header) or JSONPath expr (source=json_path). */
  target?: string | null;
  /** Expected value; an array for one_of. Ignored for exists. */
  expected?: unknown;
}

/** The bits of an HTTP response an assertion can target. */
export interface ResponseFacets {
  status: number;
  responseTimeMs: number;
  headers: Headers;
  /** Raw response body, or null if it wasn't read (no body/json_path/size assertion). */
  body: string | null;
  /** Byte length of the body, or null if the body wasn't read. */
  sizeBytes: number | null;
}

export interface AssertionOutcome {
  ok: boolean;
  failures: string[];
}

/**
 * Minimal JSONPath: supports `$.a.b`, `$.a[0].b`, `$['a']["b"]`. Returns the
 * value at the path, or undefined if any segment is missing or the expression is
 * outside this subset (wildcards/filters/recursion are NOT supported — document
 * if a check needs them). Kept dependency-free on purpose.
 */
export function jsonPath(root: unknown, expr: string): unknown {
  if (typeof expr !== 'string') return undefined;
  let e = expr.trim();
  if (e.startsWith('$')) e = e.slice(1);
  if (e === '') return root;

  const re = /\.([A-Za-z_$][\w$]*)|\[(\d+)\]|\['([^']*)'\]|\["([^"]*)"\]/g;
  const tokens: string[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(e)) !== null) {
    if (m.index !== lastIndex) return undefined; // gap => unparseable
    tokens.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
    lastIndex = re.lastIndex;
  }
  if (lastIndex !== e.length) return undefined;

  let cur: unknown = root;
  for (const t of tokens) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[t];
  }
  return cur;
}

const num = (v: unknown): number => Number(v);
const looksNumeric = (v: unknown): boolean =>
  v !== null && v !== '' && !Number.isNaN(Number(v));

/** Loose equality: numeric when both sides look numeric, else string compare. */
function looseEq(a: unknown, b: unknown): boolean {
  if (looksNumeric(a) && looksNumeric(b)) return num(a) === num(b);
  return String(a) === String(b);
}

function compare(cmp: AssertionComparison, actual: unknown, expected: unknown): boolean {
  switch (cmp) {
    case 'eq':
      return looseEq(actual, expected);
    case 'ne':
      return !looseEq(actual, expected);
    case 'lt':
      return num(actual) < num(expected);
    case 'gt':
      return num(actual) > num(expected);
    case 'gte':
      return num(actual) >= num(expected);
    case 'lte':
      return num(actual) <= num(expected);
    case 'contains':
      return String(actual ?? '').includes(String(expected));
    case 'not_contains':
      return !String(actual ?? '').includes(String(expected));
    case 'matches':
      return new RegExp(String(expected)).test(String(actual ?? ''));
    case 'exists':
      return actual !== null && actual !== undefined;
    case 'one_of':
      return Array.isArray(expected) && expected.map(String).includes(String(actual));
    default:
      return false;
  }
}

/** Resolve the actual value an assertion targets from the response facets. */
function actualValue(
  a: Assertion,
  f: ResponseFacets,
  jsonCache: { parsed?: unknown; tried?: boolean },
): unknown {
  switch (a.source) {
    case 'status':
      return f.status;
    case 'response_time':
      return f.responseTimeMs;
    case 'header':
      return f.headers.get(a.target ?? '');
    case 'body':
      return f.body;
    case 'size':
      return f.sizeBytes;
    case 'json_path': {
      if (!jsonCache.tried) {
        jsonCache.tried = true;
        try {
          jsonCache.parsed = f.body === null ? undefined : JSON.parse(f.body);
        } catch {
          jsonCache.parsed = undefined; // not JSON
        }
      }
      return jsonPath(jsonCache.parsed, a.target ?? '$');
    }
    default:
      return undefined;
  }
}

/** JSON-render a value for a message, truncated so a big body can't bloat error_message. */
function render(v: unknown, max = 200): string {
  const s = JSON.stringify(v ?? null);
  return s.length > max ? `${s.slice(0, max)}…(${s.length} chars)` : s;
}

function describe(a: Assertion): string {
  const where = a.target ? `${a.source} ${a.target}` : a.source;
  const exp = a.comparison === 'exists' ? '' : ` ${render(a.expected)}`;
  return `${where} ${a.comparison}${exp}`;
}

/**
 * Evaluate every assertion against the response. Returns ok=true only if all
 * pass; otherwise collects a message per failure. A malformed assertion (bad
 * regex, unparseable JSONPath body, etc.) counts as a failure, not a crash.
 */
export function evaluateAssertions(
  assertions: Assertion[],
  facets: ResponseFacets,
): AssertionOutcome {
  const failures: string[] = [];
  const jsonCache: { parsed?: unknown; tried?: boolean } = {};

  for (const a of assertions) {
    let actual: unknown;
    try {
      actual = actualValue(a, facets, jsonCache);
      if (!compare(a.comparison, actual, a.expected)) {
        failures.push(`expected ${describe(a)}, got ${render(actual)}`);
      }
    } catch (err) {
      failures.push(
        `assertion ${describe(a)} could not be evaluated: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return { ok: failures.length === 0, failures };
}
