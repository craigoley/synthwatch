// Phase 6b Option C — fetch a spec from the monitors repo.
//
// Mirrors reconcile.ts's manifest fetch: anonymous HTTPS to raw.githubusercontent.com. The
// host/repo/branch are HARDCODED constants and only the path varies (validated against
// traversal) — the security design's injection control (a poisoned row can't redirect the
// fetch). raw honors If-None-Match, so the cache (slice 3) does CONDITIONAL GETs for cheap
// change-detection (a 304 carries no body) — NOT the GitHub API (60 req/hr anon, hot-path-fatal).
const RAW_BASE = 'https://raw.githubusercontent.com/craigoley/synthwatch-monitors/main';

/** A manifest `script` path: under monitors/, ends .spec.ts, no traversal. */
const SPEC_PATH_RE = /^monitors\/[A-Za-z0-9._/-]+\.spec\.ts$/;

/** The single source of truth for "is this a fetchable spec path?". Throws if not. Reused by
 *  specUrl (here) AND the spec_path resolver (reconcile.ts) — one guard, not two. */
export function assertValidSpecPath(scriptPath: string): void {
  if (!SPEC_PATH_RE.test(scriptPath) || scriptPath.includes('..')) {
    throw new Error(`invalid spec path (refusing to fetch): ${JSON.stringify(scriptPath)}`);
  }
}

export function specUrl(scriptPath: string): string {
  assertValidSpecPath(scriptPath);
  return `${RAW_BASE}/${scriptPath}`;
}

/** Fetch the raw .spec.ts source. Throws on a bad path or a non-200. (Unconditional; the cache
 *  uses conditionalFetchSpec. Kept for the spike/one-off path.) */
export async function fetchSpec(scriptPath: string): Promise<string> {
  const url = specUrl(scriptPath);
  const res = await fetch(url, { headers: { accept: 'text/plain' } });
  if (!res.ok) {
    throw new Error(`spec fetch failed: ${res.status} ${res.statusText} (${url})`);
  }
  return res.text();
}

/** Result of a conditional GET: either the upstream is unchanged (304) or we got fresh source. */
export type ConditionalFetch =
  | { kind: 'unchanged' }
  | { kind: 'fetched'; source: string; etag: string | null };

/** Conditional GET with If-None-Match. 304 => unchanged (use cache); 200 => fresh source + etag.
 *  Throws on a bad path or any non-200/304 — the cache layer decides what to do with a throw
 *  (slice 3 propagates; slice 4 adds the last-good fallback). */
export async function conditionalFetchSpec(
  scriptPath: string,
  etag?: string | null,
): Promise<ConditionalFetch> {
  const url = specUrl(scriptPath);
  const headers: Record<string, string> = { accept: 'text/plain' };
  if (etag) headers['if-none-match'] = etag;
  const res = await fetch(url, { headers });
  if (res.status === 304) return { kind: 'unchanged' };
  if (!res.ok) {
    throw new Error(`spec fetch failed: ${res.status} ${res.statusText} (${url})`);
  }
  return { kind: 'fetched', source: await res.text(), etag: res.headers.get('etag') };
}
