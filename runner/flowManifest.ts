// Flow manifest — the single source of truth for "what browser flows exist".
//
// The runner discovers its own flow modules (runner/checks/*.ts, compiled to
// dist/checks/*.js) and upserts them into the `flow_manifest` DB table at tick
// start. The dashboard's flow picker (and the API) read THAT table instead of
// "SELECT DISTINCT flow_name FROM checks" — so a flow shows up the moment it's
// deployed, before any check references it.
//
// Why a DB table (vs a static/generated file): the API is a separate service that
// already reads SynthWatch state from Postgres; a file inside the runner image
// isn't reachable by it. The table is the natural integration point and a direct
// replacement for the distinct-flow_name query. The runner owns it: it discovers
// flows from its image and publishes them, so a deploy auto-syncs.
import { readdir } from 'node:fs/promises';
import { pool } from './db.js';
import type { FlowMeta } from './checks/index.js';

export interface FlowManifestEntry {
  name: string;
  description: string | null;
  entryUrlHint: string | null;
}

/**
 * Enumerate the deployed flows by scanning the compiled checks directory: each
 * module that exports a `flow` function is a flow; its name is the filename and
 * its optional `meta` supplies description / entryUrlHint. Never throws.
 */
export async function discoverFlows(): Promise<FlowManifestEntry[]> {
  const dir = new URL('./checks/', import.meta.url);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (err) {
    console.warn('[manifest] could not read checks directory:', err);
    return [];
  }

  const entries: FlowManifestEntry[] = [];
  for (const file of files.sort()) {
    if (!file.endsWith('.js') || file === 'index.js') continue;
    try {
      const mod = (await import(new URL(file, dir).href)) as {
        flow?: unknown;
        meta?: FlowMeta;
      };
      if (typeof mod.flow !== 'function') continue; // not a flow module
      entries.push({
        name: file.slice(0, -3),
        description: mod.meta?.description ?? null,
        entryUrlHint: mod.meta?.entryUrlHint ?? null,
      });
    } catch (err) {
      console.warn(`[manifest] skipping "${file}":`, err instanceof Error ? err.message : err);
    }
  }
  return entries;
}

/**
 * Discover flows and reconcile the flow_manifest table: upsert each, then delete
 * rows for flows no longer in the image. Best-effort — callers swallow errors so
 * a manifest sync never breaks a tick.
 */
export async function syncFlowManifest(): Promise<void> {
  const flows = await discoverFlows();

  if (flows.length === 0) {
    // Discovery found nothing (empty dir or a read glitch). Don't wipe the table
    // on a transient miss — leave it and warn.
    console.warn('[manifest] no flows discovered; leaving flow_manifest unchanged');
    return;
  }

  for (const f of flows) {
    await pool.query(
      `INSERT INTO flow_manifest (name, description, entry_url_hint, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (name) DO UPDATE
         SET description = EXCLUDED.description,
             entry_url_hint = EXCLUDED.entry_url_hint,
             updated_at = now()`,
      [f.name, f.description, f.entryUrlHint],
    );
  }

  const names = flows.map((f) => f.name);
  await pool.query(`DELETE FROM flow_manifest WHERE name <> ALL($1::text[])`, [names]);

  console.log(`[manifest] synced ${flows.length} flow(s): ${names.join(', ')}`);
}
