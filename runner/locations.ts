// Location-assignment data layer (4-MLACT step 1: the assignment MODEL).
//
// A check's ASSIGNMENT is the set of check_locations rows it has — it runs from
// exactly those locations (the #68 cadence cursor IS the assignment, one source of
// truth, no intent-vs-cursor drift). This module is the canonical set of operations
// on that model: read the active registry, default a check to all active locations,
// and set a check's location set exactly. The API's create/update path drives these
// (this repo owns the schema, so the reference implementation lives here); the
// runner's claim loop reads the rows directly (see index.ts findDueChecks/claim).
import { pool } from './db.js';

/**
 * The active deployed regions, from the `locations` registry. A new check defaults to
 * one cursor per active location; the dashboard's location-selector reads this for its
 * options. Today this is just ['default'].
 */
export async function activeLocations(): Promise<string[]> {
  const { rows } = await pool.query<{ name: string }>(
    `SELECT name FROM locations WHERE enabled ORDER BY name`,
  );
  return rows.map((r) => r.name);
}

/**
 * Assign a check to EVERY active location (the create-path default). Idempotent:
 * ON CONFLICT DO NOTHING preserves any existing cursor (cadence is NOT reset). Call
 * this when a check is created so it runs from all active regions by default.
 */
export async function assignDefaultLocations(checkId: number): Promise<void> {
  await pool.query(
    `INSERT INTO check_locations (check_id, location)
     SELECT $1, name FROM locations WHERE enabled
     ON CONFLICT (check_id, location) DO NOTHING`,
    [checkId],
  );
}

/**
 * Set a check's assigned location set EXACTLY: insert any newly-assigned locations
 * (preserving existing cursors) and delete cursors no longer in the set. Unassigning
 * deletes that location's cursor, so re-adding it later starts that region's cadence
 * fresh (acceptable). Passing [] unassigns the check from every location (it then runs
 * nowhere once enforcement lands — callers should guard against an accidental empty set).
 */
export async function setCheckLocations(checkId: number, locations: string[]): Promise<void> {
  if (locations.length > 0) {
    await pool.query(
      `INSERT INTO check_locations (check_id, location)
       SELECT $1, unnest($2::text[])
       ON CONFLICT (check_id, location) DO NOTHING`,
      [checkId, locations],
    );
  }
  // Drop cursors no longer assigned (ANY of an empty array is false -> deletes all).
  await pool.query(
    `DELETE FROM check_locations
      WHERE check_id = $1 AND NOT (location = ANY($2::text[]))`,
    [checkId, locations],
  );
}

/** A check's current assignment (the locations it has a cursor for), sorted. */
export async function getCheckLocations(checkId: number): Promise<string[]> {
  const { rows } = await pool.query<{ location: string }>(
    `SELECT location FROM check_locations WHERE check_id = $1 ORDER BY location`,
    [checkId],
  );
  return rows.map((r) => r.location);
}
