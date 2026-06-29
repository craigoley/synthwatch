// Phase 6b Option C — fetch a spec from the monitors repo, STRONGLY CONSISTENTLY.
//
// Why not raw.githubusercontent.com: raw is a Fastly CDN with a ~5-minute propagation window AND
// per-edge cache flapping, so a "Run now" minutes after a merge could still run the OLD spec (and a
// lagging edge could even flap the cache back). That cost ~6 stale-spec traces.
//
// The fix: api.github.com (strongly consistent, no CDN). Two steps:
//   1. resolve main's HEAD commit SHA  — GET /repos/<repo>/commits/main (Accept: …github.sha → the
//      bare 40-hex sha). The API reflects a merge IMMEDIATELY. This is the one online "what does main
//      point at now?" step. Memoised PER PROCESS (the runner runs one tick then exits) so it costs ~1
//      call per tick, not per spec → ~12/hr regardless of monitor count, well under the 60/hr anon cap.
//   2. fetch the spec content AT THAT SHA — GET /repos/<repo>/contents/<spec>?ref=<sha> (Accept:
//      …github.raw). Content-addressed by commit ⇒ immutable ⇒ consistent. No CDN window, no flapping.
//
// The host/repo are HARDCODED constants and the spec path is validated against traversal (the security
// design's injection control — a poisoned row can't redirect the fetch). The cache (specCache.ts) is
// UNCHANGED: it passes the last "version identity" back as `etag` and stores the returned `etag`; that
// identity is now the COMMIT SHA (was the raw CDN etag). A 304-equivalent = "main still points at the
// SHA we last compiled from" → no content fetch at all.
const API_BASE = 'https://api.github.com/repos/craigoley/synthwatch-monitors';
const REF = 'main';

/** A manifest `script` path: under monitors/, ends .spec.ts, no traversal. */
const SPEC_PATH_RE = /^monitors\/[A-Za-z0-9._/-]+\.spec\.ts$/;

/** The single source of truth for "is this a fetchable spec path?". Throws if not. Reused by
 *  conditionalFetchSpec (here) AND the spec_path resolver (reconcile.ts) — one guard, not two. */
export function assertValidSpecPath(scriptPath: string): void {
  if (!SPEC_PATH_RE.test(scriptPath) || scriptPath.includes('..')) {
    throw new Error(`invalid spec path (refusing to fetch): ${JSON.stringify(scriptPath)}`);
  }
}

// Optional auth: the monitors repo is PUBLIC so this works unauthenticated, but a token lifts the rate
// limit 60→5000/hr. The per-process SHA memo already keeps us well under 60/hr; a token is headroom.
function ghHeaders(accept: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept,
    'user-agent': 'synthwatch-runner',
    'x-github-api-version': '2022-11-28',
  };
  const token = process.env.GITHUB_TOKEN || process.env.SYNTHWATCH_MONITORS_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

// Per-PROCESS memo of main's resolved HEAD commit SHA. The runner runs ONE tick per process then exits
// (see index.ts), so this resolves main exactly once per tick and all specs in the tick pin to the SAME
// consistent SHA — bounding commits-API calls to ~1/tick.
let cachedMainSha: string | null = null;

/** Reset the per-process SHA memo. Test-only (a fresh process always starts null). */
export function _resetMainShaCache(): void {
  cachedMainSha = null;
}

async function resolveMainSha(): Promise<string> {
  if (cachedMainSha) return cachedMainSha;
  const url = `${API_BASE}/commits/${REF}`;
  const res = await fetch(url, { headers: ghHeaders('application/vnd.github.sha') });
  if (!res.ok) {
    throw new Error(`resolve main sha failed: ${res.status} ${res.statusText} (${url})`);
  }
  const sha = (await res.text()).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`resolve main sha: unexpected body ${JSON.stringify(sha.slice(0, 60))}`);
  }
  cachedMainSha = sha;
  return sha;
}

/**
 * Fetch a repo file's RAW content at main's HEAD SHA — strongly consistent (commits API resolves the
 * SHA, contents API serves the immutable bytes at it), no raw-CDN propagation/flapping. Generic over
 * the path so BOTH the spec fetch (conditionalFetchSpec) AND reconcile's manifest fetch share one path
 * + the per-process SHA memo. The caller is responsible for path trust (the paths here are hardcoded
 * constants or already-validated spec paths — a poisoned row can't redirect the fetch).
 */
export async function fetchContentsAtMain(
  path: string,
  accept: string,
): Promise<{ source: string; sha: string }> {
  const sha = await resolveMainSha();
  const url = `${API_BASE}/contents/${path}?ref=${sha}`;
  const res = await fetch(url, { headers: ghHeaders(accept) });
  if (!res.ok) {
    throw new Error(`contents fetch failed: ${res.status} ${res.statusText} (${url})`);
  }
  return { source: await res.text(), sha };
}

/** Result of a conditional fetch: the spec is unchanged (main still at the last SHA) or fresh source.
 *  `etag` carries the COMMIT SHA (the version identity the cache stores + passes back). */
export type ConditionalFetch =
  | { kind: 'unchanged' }
  | { kind: 'fetched'; source: string; etag: string | null };

/**
 * Resolve main's HEAD SHA and fetch the spec AT that SHA. `lastSha` is the version identity the cache
 * last compiled from (specCache passes the stored `etag`). If main still points at it → 'unchanged'
 * (no content fetch). Otherwise fetch the exact content at the resolved SHA → 'fetched' with the new
 * SHA as `etag`. Throws on a bad path or any non-200 — the cache layer decides (degrade to last-good).
 */
export async function conditionalFetchSpec(
  scriptPath: string,
  lastSha?: string | null,
): Promise<ConditionalFetch> {
  assertValidSpecPath(scriptPath);
  const sha = await resolveMainSha();
  // STRONGLY CONSISTENT 304-equivalent: main hasn't moved since we last compiled this spec. The commits
  // API reflects a merge immediately, so unlike the raw CDN this can't falsely report unchanged.
  if (lastSha && lastSha === sha) return { kind: 'unchanged' };
  // Fetch the EXACT content at the pinned SHA — content-addressed by commit (resolveMainSha is memoised,
  // so this re-uses the SHA just resolved; no second commits call).
  const { source } = await fetchContentsAtMain(scriptPath, 'application/vnd.github.raw');
  return { kind: 'fetched', source, etag: sha };
}
