// Deploy-marker extraction (deploy-markers v1). AUTO-DETECT a deploy-identity marker from the response the
// runner ALREADY fetches — no Vercel access, no webhook, no per-target config. A marker CHANGE = a deploy.
//
// ★★ THE FALSE-POSITIVE GUARD (non-negotiable). This is a CURATED ALLOWLIST of KNOWN deploy-identity sources,
// tried in priority order — NOT a generic "a value changed" detector. A generic detector is a phantom-deploy
// machine: cache keys, request-ids, CSRF tokens, timestamps, session values, CDN node ids (x-vercel-id,
// cf-ray, x-request-id, x-amz-cf-id, set-cookie, date, age, x-cache) all change PER-REQUEST without a deploy.
// We deliberately NEVER look at those. Every entry below is justified as DEPLOY-STABLE — constant within one
// deploy, changing across deploys. When unsure whether a source is deploy-stable vs per-request-volatile, it
// is EXCLUDED: a missed deploy is better than a fabricated one (the must-go-red discipline).
//
// Excluded on purpose (documented so nobody "helpfully" adds them): x-vercel-id (per-request edge region+id),
// cf-ray, x-request-id, x-amz-cf-id (per-request), set-cookie/date/age/x-cache/x-vercel-cache (per-request),
// last-modified (can be request-time on some CDNs), any generic hashed cache/csrf/session value.

export interface DeployMarker {
  /** Which ladder rung produced it — e.g. 'sentry-release', 'meta:commit', 'next-build-id', 'etag'. */
  source: string;
  /** The marker value (a SHA, a build id, an etag, …). */
  value: string;
  /** True iff `value` is a git commit SHA (7–40 hex) — drives the UI (real commit id vs "deploy detected"). */
  is_sha: boolean;
}

const SHA_RE = /^[0-9a-f]{7,40}$/i;
const isSha = (v: string) => SHA_RE.test(v);

// The <meta name="…"> names that carry a build/commit/version identity (deploy-stable, embedded at build).
// NOTE: an allowlist — csrf-token, viewport, theme-color, description, etc. are NOT deploy markers.
const META_IDENTITY_NAMES = ['commit', 'git-sha', 'build-sha', 'build-id', 'buildid', 'revision', 'release', 'version'];

/** Read a header case-insensitively from a Headers or a plain object. */
function header(headers: Headers | Record<string, string> | undefined, name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name);
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, string>)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

/**
 * Try the curated ladder in priority order; return the FIRST (strongest) deploy marker, or null.
 * Priority: a real commit SHA > a build id > a content-change etag. Body (html) may be null (not fetched);
 * header-only markers (etag) still work in that case.
 */
export function extractDeployMarker(
  headers: Headers | Record<string, string> | undefined,
  html: string | null,
): DeployMarker | null {
  // ── 1. sentry-release from <meta name="baggage" content="…,sentry-release=SHA,…"> (wegmans.com) ──
  //    Deploy-stable: Sentry stamps the release/commit at build; constant within a deploy.
  if (html) {
    const baggage = /<meta[^>]+name=["']baggage["'][^>]*content=["']([^"']*)["']/i.exec(html);
    if (baggage) {
      const rel = /sentry-release=([^,"'\s]+)/i.exec(baggage[1] ?? '');
      const value = rel?.[1]?.trim();
      if (value) return { source: 'sentry-release', value, is_sha: isSha(value) };
    }

    // ── 2. <meta name="commit|git-sha|build-id|version|…" content="…"> — a build/commit identity meta ──
    //    Deploy-stable: embedded at build time. Allowlisted names only (no csrf/viewport/etc.).
    const metaRe = /<meta[^>]+name=["']([^"']+)["'][^>]*content=["']([^"']*)["']/gi;
    for (let m = metaRe.exec(html); m; m = metaRe.exec(html)) {
      const name = (m[1] ?? '').toLowerCase();
      const content = (m[2] ?? '').trim();
      if (content && META_IDENTITY_NAMES.includes(name)) {
        return { source: `meta:${name}`, value: content, is_sha: isSha(content) };
      }
    }

    // ── 3. Next.js buildId from __NEXT_DATA__ ("buildId":"…") ──
    //    Deploy-stable: a new build produces a new buildId; identical across requests of one deploy. Not a SHA.
    const buildId = /"buildId":"([^"]+)"/.exec(html);
    const bid = buildId?.[1]?.trim();
    if (bid && bid !== 'development') return { source: 'next-build-id', value: bid, is_sha: false };
  }

  // ── 4. etag on the root document (meals2go) — the WEAKEST rung: a content-change signal, not a build id ──
  //    Deploy-stable for static/SSG content (a content hash that changes on redeploy). is_sha=false. The
  //    recording path is cadence-bounded + per-host deduped so a slowly-changing etag can't spam phantom rows;
  //    a genuinely per-request etag is a target-specific risk we accept for the tier-3 fallback (labeled
  //    honestly as "deploy detected, no commit id" in the UI).
  const etagRaw = header(headers, 'etag');
  if (etagRaw) {
    const value = etagRaw.replace(/^W\//i, '').replace(/^"|"$/g, '').trim();
    if (value) return { source: 'etag', value, is_sha: false };
  }

  // ── 5. no known marker (amore / nextdoor today) ──
  return null;
}
