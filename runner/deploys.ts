// Deploy recording (deploy-markers v1, STEP 2). Turns an extracted marker into (or dedups against) a `deploys`
// row, and — critically — flags a SILENT-NULL so a detector that quietly stops detecting can't hide.

import { pool } from './db.js';
import { INVOCATION_ID } from './runnerErrors.js';
import { extractDeployMarker, type DeployMarker } from './deployMarker.js';

/** A pool or a checked-out client/txn — so callers (and rolled-back tests) can pass their own executor. */
export interface Queryable { query: (text: string, params?: unknown[]) => Promise<{ rowCount: number | null; rows: unknown[] }>; }

/** Host of a check's target_url (the per-HOST join key — a deploy is per host, not per check). */
export function hostOf(targetUrl: string): string | null {
  try {
    return new URL(targetUrl).host.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Record a detected marker — one row per (host, distinct fingerprint). ★ ON CONFLICT DO NOTHING is the whole
 * dedup story: the SAME marker from N regions/M checks → 1 row; an UNCHANGED marker → 0 rows; and concurrent
 * inserts (3 regions, same tick) are race-safe with no advisory lock. Returns true iff a NEW deploy landed.
 */
export async function recordDeployMarker(
  host: string,
  marker: DeployMarker,
  checkId: number | null = null,
  db: Queryable = pool,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO deploys (target_host, sha, fingerprint, is_sha, source, detail)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (target_host, fingerprint) DO NOTHING`,
    [host, marker.is_sha ? marker.value : null, marker.value, marker.is_sha, marker.source,
      JSON.stringify({ checkId, source: marker.source })],
  );
  return (rowCount ?? 0) > 0;
}

// One silent-null flag per host per invocation — the runner is a per-tick job, and a host is hit from several
// regions/checks in a tick; without this the queryable sink would get a duplicate row per hit.
const flaggedSilentNull = new Set<string>();

/**
 * ★ SILENT-NULL OBSERVABILITY: a marker detector that silently STOPS detecting is the exact silent-monitoring
 * class we kill. If extraction returns null for a host that has PREVIOUSLY produced markers (its page shape
 * likely changed), record it to the queryable runner_errors sink — never swallow. A host that has never
 * produced a marker (amore/nextdoor) is EXPECTED-null and not flagged.
 */
export async function recordMarkerSilentNull(
  host: string,
  checkId: number | null = null,
  db: Queryable = pool,
): Promise<void> {
  if (flaggedSilentNull.has(host)) return;
  const { rows } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM deploys WHERE target_host = $1) AS seen`,
    [host],
  );
  if (!(rows[0] as { seen: boolean } | undefined)?.seen) return; // never produced a marker → null expected, not a regression
  flaggedSilentNull.add(host);
  await db.query(
    `INSERT INTO runner_errors (invocation_id, phase, check_id, message)
     VALUES ($1, 'deploy-marker-silent-null', $2, $3)`,
    [INVOCATION_ID, checkId,
      `deploy-marker extraction returned null for ${host}, which has previously produced markers — ` +
      `the page shape may have changed (the detector silently stopped detecting)`],
  );
}

/**
 * The one call the run path makes with a response it already fetched: extract via the curated ladder → record
 * a hit (deduped), OR flag a silent-null. Best-effort: deploy-marker bookkeeping NEVER fails a run.
 */
export async function noteDeployMarker(
  targetUrl: string,
  headers: Headers | Record<string, string> | undefined,
  html: string | null,
  checkId: number | null = null,
): Promise<void> {
  const host = hostOf(targetUrl);
  if (!host) return;
  try {
    const marker = extractDeployMarker(headers, html);
    if (marker) await recordDeployMarker(host, marker, checkId);
    else await recordMarkerSilentNull(host, checkId);
  } catch {
    // best-effort — a marker/DB hiccup must never turn a healthy run red.
  }
}
