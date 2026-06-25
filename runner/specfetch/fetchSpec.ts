// Phase 6b Option C — SLICE 1 (SPIKE). Fetch ONE spec from the monitors repo.
//
// Mirrors reconcile.ts's manifest fetch: anonymous HTTPS to raw.githubusercontent.com, throws
// on non-200. ★ SPIKE ONLY: no cache, no conditional GET, no fallback — those are slices 3-4
// (and a fetch failure has NO fallback yet, which is exactly why this is not wired into live
// checks). The host/repo/branch are HARDCODED constants and only the path varies (validated
// against traversal) — the security design's injection control (can't redirect the fetch).
const RAW_BASE = 'https://raw.githubusercontent.com/craigoley/synthwatch-monitors/main';

/** A manifest `script` path: under monitors/, ends .spec.ts, no traversal. */
const SPEC_PATH_RE = /^monitors\/[A-Za-z0-9._/-]+\.spec\.ts$/;

export function specUrl(scriptPath: string): string {
  if (!SPEC_PATH_RE.test(scriptPath) || scriptPath.includes('..')) {
    throw new Error(`invalid spec path (refusing to fetch): ${JSON.stringify(scriptPath)}`);
  }
  return `${RAW_BASE}/${scriptPath}`;
}

/** Fetch the raw .spec.ts source. Throws on a bad path or a non-200 (no fallback yet). */
export async function fetchSpec(scriptPath: string): Promise<string> {
  const url = specUrl(scriptPath);
  const res = await fetch(url, { headers: { accept: 'text/plain' } });
  if (!res.ok) {
    throw new Error(`spec fetch failed: ${res.status} ${res.statusText} (${url})`);
  }
  return res.text();
}
