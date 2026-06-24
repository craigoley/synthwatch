// Tags (Phase 9a) — key:value tags on checks. The keystone primitive for tag-scoped
// alert routing, dashboard filtering, and per-team/per-app reporting (all CONSUMERS,
// built later). This module is JUST the data primitive: read/set a check's tags + a
// "checks matching a tag" lookup. NO filtering/routing/reporting here.
//
// Model (research-grounded, Datadog/Dynatrace): key:value (env:prod, team:checkout,
// criticality:tier-1) — key:value is what makes a tag routable + filterable. A bare value
// (no ':') is supported as key:value with an empty key, but key:value is preferred.
//
// Storage: a NORMALIZED check_tags table, PK(check_id, key) => one value per key per
// check. See db/migrations/0024_check_tags.sql.
import { pool } from './db.js';

export interface Tag {
  key: string;
  value: string;
}

/**
 * Suggested-canonical tag keys — SUGGESTIONS, not an enforced enum (arbitrary keys are
 * allowed; an enum that rejects new keys is too rigid). Shared cross-repo by DOCUMENTING
 * this list (the API/dashboard mirror it as their own constant) — a static 4-item list
 * doesn't warrant a DB table or an endpoint. See the PR contract.
 */
export const SUGGESTED_TAG_KEYS = ['env', 'service', 'team', 'criticality'] as const;

/**
 * Normalization rule (the anti-drift guard, enforced here AND by DB CHECKs): lowercase,
 * trim, collapse internal whitespace to '_'. Applied to BOTH key and value (Datadog
 * lowercases values too — prevents Prod/prod and Team/team drift). Charset is otherwise
 * unrestricted in v1 (only whitespace is normalized away).
 */
export function normalizeField(s: string): string {
  return (s ?? '').trim().toLowerCase().replace(/\s+/g, '_');
}

/**
 * Normalize a tag. Returns null when the value is empty after normalization (a tag must
 * carry a value). key may be '' (a bare value).
 */
export function normalizeTag(t: Tag): Tag | null {
  const key = normalizeField(t.key);
  const value = normalizeField(t.value);
  if (!value) return null;
  return { key, value };
}

/**
 * Parse a tag STRING into {key, value} — the tags-as-code seam (the synthwatch-monitors
 * manifest declares tags as strings; a synced monitor calls setCheckTags with the parsed
 * set). Splits on the FIRST ':'. No ':' => a bare value (empty key). Not normalized here
 * — setCheckTags/normalizeTag normalizes on write.
 */
export function parseTag(s: string): Tag {
  const i = s.indexOf(':');
  return i === -1 ? { key: '', value: s } : { key: s.slice(0, i), value: s.slice(i + 1) };
}

/** A check's tags, ordered for stable display. */
export async function getCheckTags(checkId: number): Promise<Tag[]> {
  const { rows } = await pool.query<Tag>(
    `SELECT key, value FROM check_tags WHERE check_id = $1 ORDER BY key, value`,
    [checkId],
  );
  return rows;
}

/**
 * Set a check's EXACT tag set (the location-selector / flow-manifest PUT pattern: upsert
 * each desired tag, then delete the keys no longer present). Normalizes on write; dedupes
 * by key (one value per key — last value wins). Passing [] clears all tags. Returns the
 * resulting tags.
 */
export async function setCheckTags(checkId: number, tags: Tag[]): Promise<Tag[]> {
  // Normalize + dedupe by key (PK is (check_id, key)); last value for a key wins.
  const byKey = new Map<string, string>();
  for (const t of tags) {
    const n = normalizeTag(t);
    if (n) byKey.set(n.key, n.value);
  }
  const desired = [...byKey.entries()].map(([key, value]) => ({ key, value }));

  for (const { key, value } of desired) {
    await pool.query(
      `INSERT INTO check_tags (check_id, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (check_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [checkId, key, value],
    );
  }
  // Delete-diff: drop any key not in the desired set. With desired=[] the array is empty
  // and `key <> ALL('{}')` is TRUE for every row, so all tags are cleared.
  await pool.query(
    `DELETE FROM check_tags WHERE check_id = $1 AND key <> ALL($2::text[])`,
    [checkId, desired.map((d) => d.key)],
  );
  return getCheckTags(checkId);
}

/**
 * IDs of checks carrying a tag — the lookup filtering/routing will build on. `value`
 * omitted => match any value for the key (e.g. all checks that have an `env`). Inputs are
 * normalized so a caller can pass raw "Env"/"Prod".
 */
export async function checksWithTag(key: string, value?: string): Promise<number[]> {
  const k = normalizeField(key);
  if (value === undefined) {
    const { rows } = await pool.query<{ check_id: string }>(
      `SELECT check_id FROM check_tags WHERE key = $1 ORDER BY check_id`,
      [k],
    );
    return rows.map((r) => Number(r.check_id));
  }
  const { rows } = await pool.query<{ check_id: string }>(
    `SELECT check_id FROM check_tags WHERE key = $1 AND value = $2 ORDER BY check_id`,
    [k, normalizeField(value)],
  );
  return rows.map((r) => Number(r.check_id));
}
