// Phase 6b Option C — SLICE 3: the durable spec_cache (happy path + change detection).
//
// The runner cold-starts every 5 min and exits, so the compiled-spec cache lives in Postgres
// (spec_cache). Per due Option-C check, getCompiledSpec():
//   1. read the cached row (etag, compiled_js).
//   2. conditional-GET the raw spec with If-None-Match: etag.
//   3. 304 Not Modified -> reuse compiled_js (NO recompile).
//   4. 200 -> esbuild-compile (reuse #101's compileSpec), upsert {etag, source_sha, compiled_js,
//      fetched_at} AND write last_good_compiled_js/last_good_at (so slice 4 has a fallback).
//
// ★ SLICE 4 SEAM: on a fetch FAILURE this slice PROPAGATES the error (no fallback yet). Slice 4
// fills the marked seam below — fall back to last_good_compiled_js so a transient GitHub blip
// never false-fails a monitor (the false-outage guard). ★ NOT wired into live executeBrowser
// until slice 4 exists (a fetch hiccup with no fallback would false-fail a live check).
//
// Deps are injected (store / fetcher / compile / hash) so the flow is a tested unit without
// live GitHub or a DB — the production wiring (pgSpecCacheStore, conditionalFetchSpec,
// compileSpec, sha256) is assembled in getCompiledSpecFromPool().
import { createHash } from 'node:crypto';
import { pool } from '../db.js';
import { conditionalFetchSpec, assertValidSpecPath, type ConditionalFetch } from './fetchSpec.js';
import { compileSpec } from './compileSpec.js';

export interface SpecCacheRow {
  spec_path: string;
  etag: string | null;
  source_sha: string | null;
  compiled_js: string;
  fetched_at: Date;
  last_good_compiled_js: string | null;
  last_good_at: Date | null;
}

/** What getCompiledSpec writes on a 200 (the store stamps fetched_at + last_good_* itself). */
export interface SpecCacheUpsert {
  spec_path: string;
  etag: string | null;
  source_sha: string;
  compiled_js: string;
}

export interface SpecCacheStore {
  read(specPath: string): Promise<SpecCacheRow | null>;
  /** Upsert the fresh compile; MUST set fetched_at=now and last_good_compiled_js/at to the
   *  just-compiled output (every successful compile is a new known-good — slice-4 fallback). */
  upsert(row: SpecCacheUpsert): Promise<void>;
}

export interface SpecCacheDeps {
  store: SpecCacheStore;
  fetcher: (specPath: string, etag?: string | null) => Promise<ConditionalFetch>;
  compile: (source: string, sourcefile?: string) => Promise<string>;
  hash: (s: string) => string;
}

export interface CompiledSpec {
  compiledJs: string;
  /** 'cache-304' = reused unchanged; 'compiled-200' = freshly fetched+compiled. */
  origin: 'cache-304' | 'compiled-200';
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Resolve a runnable compiled spec for spec_path: conditional GET, 304 -> cache, 200 -> compile
 * + upsert. Slice 3 = happy path + change detection only.
 */
export async function getCompiledSpec(specPath: string, deps: SpecCacheDeps): Promise<CompiledSpec> {
  assertValidSpecPath(specPath); // defense in depth; the fetcher also guards
  const existing = await deps.store.read(specPath);

  let fetched: ConditionalFetch;
  try {
    fetched = await deps.fetcher(specPath, existing?.etag ?? null);
  } catch (err) {
    // ─────────────────────────────────────────────────────────────────────────────────────
    // ★★ SLICE 4 SEAM — fetch FAILURE handling lives HERE.
    // Slice 4 will, instead of rethrowing, fall back to existing?.last_good_compiled_js (run
    // normally so a GitHub blip is invisible) and, when there is NO cached/last-good entry,
    // surface a DISTINCT infra error (never a paging 'fail'). For slice 3 there is no fallback
    // yet, so we log + propagate — and this is exactly why the cache is NOT wired into live
    // checks until slice 4 lands. `hasLastGood` shows what slice 4 will have to fall back to.
    // ─────────────────────────────────────────────────────────────────────────────────────
    const hasLastGood = Boolean(existing?.last_good_compiled_js);
    console.warn(
      `[specfetch] fetch failed for ${specPath} (no fallback yet — slice 4; ` +
        `last_good available: ${hasLastGood}):`,
      err instanceof Error ? err.message : err,
    );
    throw err;
  }

  if (fetched.kind === 'unchanged') {
    // 304: the upstream matched our etag. We must have a cached compile to reuse.
    if (!existing) {
      throw new Error(`spec_cache: 304 for ${specPath} but no cached row (etag desync)`);
    }
    return { compiledJs: existing.compiled_js, origin: 'cache-304' };
  }

  // 200: source changed (or first fetch) -> compile once and persist.
  const sourcefile = specPath.split('/').pop();
  const compiledJs = await deps.compile(fetched.source, sourcefile);
  await deps.store.upsert({
    spec_path: specPath,
    etag: fetched.etag,
    source_sha: deps.hash(fetched.source),
    compiled_js: compiledJs,
  });
  return { compiledJs, origin: 'compiled-200' };
}

// ---------------------------------------------------------------------------
// Production store — Postgres-backed (spec_cache). Every successful upsert also refreshes
// last_good_* to the just-compiled output, so slice 4 always has a known-good to fall back to.
// ---------------------------------------------------------------------------
export const pgSpecCacheStore: SpecCacheStore = {
  async read(specPath) {
    const { rows } = await pool.query<SpecCacheRow>(
      `SELECT spec_path, etag, source_sha, compiled_js, fetched_at,
              last_good_compiled_js, last_good_at
         FROM spec_cache WHERE spec_path = $1`,
      [specPath],
    );
    return rows[0] ?? null;
  },
  async upsert(row) {
    await pool.query(
      `INSERT INTO spec_cache
         (spec_path, etag, source_sha, compiled_js, fetched_at, last_good_compiled_js, last_good_at)
       VALUES ($1, $2, $3, $4, now(), $4, now())
       ON CONFLICT (spec_path) DO UPDATE SET
         etag                  = EXCLUDED.etag,
         source_sha            = EXCLUDED.source_sha,
         compiled_js           = EXCLUDED.compiled_js,
         fetched_at            = now(),
         last_good_compiled_js = EXCLUDED.compiled_js,
         last_good_at          = now()`,
      [row.spec_path, row.etag, row.source_sha, row.compiled_js],
    );
  },
};

/** Production wiring: real Postgres store + conditional GET + esbuild compile + sha256. */
export function getCompiledSpecFromPool(specPath: string): Promise<CompiledSpec> {
  return getCompiledSpec(specPath, {
    store: pgSpecCacheStore,
    fetcher: conditionalFetchSpec,
    compile: compileSpec,
    hash: sha256,
  });
}
