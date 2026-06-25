// Phase 6b Option C — SLICE 4: the FALLBACK + FALSE-OUTAGE GUARD (the load-bearing slice).
//
// ★★ THE INVARIANT: a fetch or compile FAILURE must DEGRADE TO LAST-KNOWN-GOOD and can NEVER
// manufacture a monitor failure. A monitor that false-fails because GitHub hiccuped pages an SRE
// for a non-existent outage — that is THE failure mode this feature must not have.
//
// getCompiledSpec returns a typed SpecResolution (it no longer throws on fetch/compile failure):
//   - { kind: 'runnable' }  — there is a compiled spec to run (a fresh compile, a 304 cache hit,
//                             or, on failure, the LAST-KNOWN-GOOD). The check runs NORMALLY; its
//                             outcome (pass/fail/error) comes from the REAL run, not the fetch.
//   - { kind: 'infra-error' } — the runner could not obtain ANY spec to run (fetch failed AND no
//                             last-known-good). ★ This is categorically NOT a monitor outage: the
//                             check couldn't RUN. The caller (the live-wiring slice) maps this to
//                             a DISTINCT non-paging status (see the STATUS DECISION below) — never
//                             a 'fail' or 'error', both of which route to the down/paging path.
//
// STATUS DECISION (recon of the taxonomy in db.ts): RunStatus = pass|warn|fail|error|running, and
// the availability partition is "up" = pass|warn, "down" = fail|error — so BOTH fail AND error
// open incidents and PAGE. The nightmare case (infra-error) must be NEITHER up nor down, like
// 'running' but terminal — excluded from SLA and from incidents. There is no such status today,
// so the live-wiring slice will ADD a terminal status (recommended: 'infra_error') and exclude it
// from the up/down partition (runs.status CHECK + the SLA views + evaluate.ts). Slice 4 defines
// the SIGNAL (the typed 'infra-error' variant) and proves the guard; it writes no runs row (not
// wired), so the status-value + SLA/evaluate exclusion ship coherently with the slice that writes
// it. ★ The non-negotiable contract: 'infra-error' must NOT become a 'fail'/'error'.
//
// Deps are injected (store / fetcher / compile / hash) so the flow is a tested unit. ★ STILL NOT
// wired into live executeBrowser (next slice) — the guard had to exist + be proven first.
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
   *  just-compiled output (every successful compile is a new known-good — the fallback). */
  upsert(row: SpecCacheUpsert): Promise<void>;
}

export interface SpecCacheDeps {
  store: SpecCacheStore;
  fetcher: (specPath: string, etag?: string | null) => Promise<ConditionalFetch>;
  compile: (source: string, sourcefile?: string) => Promise<string>;
  hash: (s: string) => string;
}

/** Where a runnable compiled spec came from — observability for the degradation path. */
export type SpecOrigin =
  | 'compiled-200' // fresh fetch + compile
  | 'cache-304' // upstream unchanged, reused cache
  | 'fallback-last-good'; // ★ fetch/compile FAILED — ran the last-known-good (degraded, NOT failed)

/**
 * The outcome of resolving a spec. NEVER throws for a fetch/compile failure (that is the whole
 * point) — failures become either a degraded 'runnable' (last-good) or a distinct 'infra-error'.
 */
export type SpecResolution =
  | { kind: 'runnable'; compiledJs: string; origin: SpecOrigin }
  | { kind: 'infra-error'; reason: string };

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Degrade a fetch/compile failure: run the LAST-KNOWN-GOOD if we have one (the check runs
 * normally — a GitHub blip is invisible), else surface a DISTINCT infra-error (the check could
 * not run; the caller must keep this OFF the paging path). Always logs a WARN (observability:
 * the operator must know the fetch path is degrading even though monitors aren't false-failing).
 */
function degradeOrInfraError(
  specPath: string,
  existing: SpecCacheRow | null,
  why: string,
): SpecResolution {
  if (existing?.last_good_compiled_js) {
    console.warn(
      `[specfetch] DEGRADED ${specPath}: ${why} — ran LAST-KNOWN-GOOD ` +
        `(last_good_at=${existing.last_good_at?.toISOString() ?? '?'}). ` +
        `Monitor NOT failed; the spec-fetch path is flaky.`,
    );
    return { kind: 'runnable', compiledJs: existing.last_good_compiled_js, origin: 'fallback-last-good' };
  }
  console.warn(
    `[specfetch] INFRA-ERROR ${specPath}: ${why} — and NO last-known-good cached. ` +
      `Cannot run the check; this is an INFRA error (fetching the spec), NOT a monitor outage. ` +
      `It MUST NOT page.`,
  );
  return { kind: 'infra-error', reason: why };
}

/**
 * Resolve a runnable compiled spec for spec_path with graceful degradation:
 *   - conditional GET (If-None-Match: etag).
 *   - 304 + cache  -> reuse compiled_js (no recompile).
 *   - 304 + NO cache (etag desync) -> forced unconditional re-fetch (cache-miss).
 *   - 200          -> esbuild-compile + upsert (refreshes last_good_*).
 *   - fetch fails / 5xx / timeout / compile fails -> last-known-good, else infra-error.
 * NEVER throws for a fetch/compile failure — that would false-fail the monitor.
 */
export async function getCompiledSpec(specPath: string, deps: SpecCacheDeps): Promise<SpecResolution> {
  assertValidSpecPath(specPath); // defense in depth; the fetcher also guards
  const existing = await deps.store.read(specPath);

  // 1) Conditional GET. A network error / 5xx / timeout throws here -> degrade.
  let fetched: ConditionalFetch;
  try {
    fetched = await deps.fetcher(specPath, existing?.etag ?? null);
  } catch (err) {
    return degradeOrInfraError(specPath, existing, `fetch failed: ${errMsg(err)}`);
  }

  // 2) 304 Not Modified.
  if (fetched.kind === 'unchanged') {
    if (existing) {
      return { kind: 'runnable', compiledJs: existing.compiled_js, origin: 'cache-304' };
    }
    // 304 with no cached row (we couldn't have sent a matching etag) -> treat as cache-miss:
    // force a full unconditional fetch.
    console.warn(`[specfetch] ${specPath}: 304 with no cached row (etag desync) — forcing a full fetch.`);
    try {
      fetched = await deps.fetcher(specPath, null);
    } catch (err) {
      return degradeOrInfraError(specPath, existing, `forced re-fetch failed: ${errMsg(err)}`);
    }
    if (fetched.kind === 'unchanged') {
      // Still 304 on an unconditional fetch is pathological — there is no source to compile.
      return degradeOrInfraError(specPath, existing, 'unconditional fetch still returned 304 (pathological)');
    }
  }

  // 3) 200 -> compile + persist. A broken merged spec (shouldn't pass monitors-repo CI) throws
  //    in compile -> degrade to last-good rather than running a broken spec or failing the monitor.
  const { source, etag } = fetched;
  let compiledJs: string;
  try {
    compiledJs = await deps.compile(source, specPath.split('/').pop());
  } catch (err) {
    return degradeOrInfraError(specPath, existing, `compile failed (broken spec merged?): ${errMsg(err)}`);
  }
  await deps.store.upsert({
    spec_path: specPath,
    etag,
    source_sha: deps.hash(source),
    compiled_js: compiledJs,
  });
  return { kind: 'runnable', compiledJs, origin: 'compiled-200' };
}

// ---------------------------------------------------------------------------
// Production store — Postgres-backed (spec_cache). Every successful upsert also refreshes
// last_good_* to the just-compiled output, so a fetch failure always has a known-good to fall
// back to (until the very first successful fetch — the nightmare case, handled as infra-error).
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
export function getCompiledSpecFromPool(specPath: string): Promise<SpecResolution> {
  return getCompiledSpec(specPath, {
    store: pgSpecCacheStore,
    fetcher: conditionalFetchSpec,
    compile: compileSpec,
    hash: sha256,
  });
}

/**
 * Pre-WARM the cache for a set of spec paths (Phase 6b Option C, slice 5). Run BEFORE checks
 * flip to the fetch path so no check's FIRST live run is a cold no-last_good fetch (which, if
 * GitHub were down at that moment, would dark out every browser monitor at once — infra_error,
 * not a page, but every monitor silent). Each path is fetched+compiled and cached (200 ->
 * compiled_js + last_good). Best-effort: a failure on one path warns + counts, never throws, so
 * one bad spec can't abort the warm pass. The reconcile job calls this (it already has the
 * manifest); the deploy order is: migrate -> warm (reconcile) -> checks run the fetch path.
 */
export async function warmSpecCache(specPaths: string[]): Promise<{ warmed: number; failed: number }> {
  let warmed = 0;
  let failed = 0;
  for (const p of specPaths) {
    try {
      const res = await getCompiledSpecFromPool(p);
      if (res.kind === 'runnable') {
        warmed++;
      } else {
        failed++;
        console.warn(`[specfetch:warm] ${p}: ${res.reason}`);
      }
    } catch (err) {
      failed++;
      console.warn(`[specfetch:warm] ${p} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return { warmed, failed };
}
