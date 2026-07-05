// Local-runner-writes-prod guard (the June 25–26 incident, made structural).
//
// GROUND TRUTH: 46 runs on check 74 (June 25 22:50 → June 26 11:20) carried error messages
// resolving modules under /Users/…/synthwatch/runner/ — a locally-launched dev runner had sourced
// ~/.synthwatch.env (which exports the PROD DATABASE_URL) and wrote prod run rows overnight.
// Nothing prevented a repeat: db.ts builds the pool from DATABASE_URL unconditionally.
//
// THE GUARD (enforced as the FIRST executable statement of EVERY DB-writing entrypoint — index.ts
// main() plus the five aux mains: retentionMain (DELETEs), reconcileMain, rollupMain,
// narrativeMain, redTestMain — before ANY query; the pg Pool does not connect until its first
// query, so a refusal means zero prod connections):
//   REFUSE to start when BOTH hold:
//     1. DATABASE_URL points at the prod-class Postgres — host ends with
//        PROD_PG_HOST_SUFFIX ('.postgres.database.azure.com'). Suffix, not the full string or the
//        exact server name: a password rotation or server rename must not break the guard, and
//        this project's only Azure PG is prod (infra/main.bicep:84 postgresServerName =
//        'synthwatch-pg-e2'; every job's database-url is built from its FQDN). Local dev DBs are
//        localhost/docker and never match.
//     2. The deployed-environment marker is absent: SYNTHWATCH_DEPLOYED === '1' — the UNIVERSAL
//        marker infra/main.bicep (#197) declares on ALL EIGHT container-app jobs (the 3 mains AND
//        migrate/rollup/narrative/reconcile/retention), verified live on all 8 post-deploy
//        (July 4 gate). Template-owned (re-asserted by every deploy); a plain Mac shell never has
//        it. ONE marker, ONE invariant, every entrypoint — this replaced #196's
//        SYNTHWATCH_LOCATION ∨ CONTAINER_APP_JOB_NAME check: LOCATION exists only on the 3 mains
//        (would have blocked the deployed aux fleet), and dropping it as a signal CLOSES #196's
//        named falsifier (a local shell exporting LOCATION to test multi-region logic no longer
//        bypasses the guard). CONTAINER_APP_JOB_NAME was never doc-verified and is now redundant.
//   ESCAPE HATCH: SYNTHWATCH_ALLOW_PROD=1 — a deliberate local-against-prod run (cache warming,
//   controlled diagnostics, an intentional local redTestMain) states its intent and proceeds.
//
// FALSIFIER (named, accepted): a non-template deployment (e.g. a bare `docker run` on a VM)
// without the marker is wrongly blocked — the hatch is the remedy and the error says so. A local
// shell that deliberately exports SYNTHWATCH_DEPLOYED=1 bypasses — spoofing, not the accident
// class; the June incident ran with a bare sourced ~/.synthwatch.env and IS caught.
//
// ★ REFUSAL IS log + process.exit(1), NOT a throw: a throw at main() top would route through
// main().catch → recordFatal → an INSERT into runner_errors ON THE PROD DB — the exact write
// class this guard exists to prevent. Zero connections means zero, including the error sink.

export const PROD_PG_HOST_SUFFIX = '.postgres.database.azure.com';

export interface GuardVerdict {
  allowed: boolean;
  /** Machine-checkable cause — the tests pin these; the human message is derived below. */
  reason:
    | 'no-database-url' // nothing to guard (the pool will fail on first query anyway)
    | 'non-prod-host' //   local/docker/other DB — developing locally is normal, never blocked
    | 'unparseable-url' // can't be identified as prod; the pool will surface the real error
    | 'deployed' //        a deployed-environment signal is present
    | 'allow-prod-hatch' // SYNTHWATCH_ALLOW_PROD=1 — deliberate, stated intent
    | 'local-prod-refused'; // prod host + no deployed signal + no hatch
}

/** Pure decision, injectable env for tests. */
export function prodGuardVerdict(env: NodeJS.ProcessEnv = process.env): GuardVerdict {
  const url = env.DATABASE_URL;
  if (!url) return { allowed: true, reason: 'no-database-url' };

  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { allowed: true, reason: 'unparseable-url' };
  }
  if (!host.endsWith(PROD_PG_HOST_SUFFIX)) return { allowed: true, reason: 'non-prod-host' };

  if (env.SYNTHWATCH_ALLOW_PROD === '1') return { allowed: true, reason: 'allow-prod-hatch' };
  // The ONE deployed invariant — the universal #197 marker, exactly '1' (mirrors the hatch's
  // exactness; pins the bicep contract). See the module header for why LOCATION and
  // CONTAINER_APP_JOB_NAME are deliberately NOT signals anymore.
  if (env.SYNTHWATCH_DEPLOYED === '1') {
    return { allowed: true, reason: 'deployed' };
  }
  return { allowed: false, reason: 'local-prod-refused' };
}

/**
 * Enforce at process start (first executable statement of each entrypoint, before any query). On refusal: log the reason +
 * the escape hatch, then exit(1) WITHOUT throwing (see module header — a throw would itself write
 * to the prod DB via recordFatal). Deployed runners pass silently.
 */
export function enforceProdGuard(env: NodeJS.ProcessEnv = process.env): void {
  const verdict = prodGuardVerdict(env);
  if (verdict.allowed) return;
  console.error(
    `[runner] REFUSING TO START: DATABASE_URL points at the prod-class Postgres ` +
      `(*${PROD_PG_HOST_SUFFIX}) but the deployed-environment marker is absent ` +
      `(SYNTHWATCH_DEPLOYED != '1' — bicep sets it on every deployed job) — this looks like a ` +
      `LOCAL process about to write prod (the June 25–26 check-74 incident). If this ` +
      `local-against-prod run is DELIBERATE, set SYNTHWATCH_ALLOW_PROD=1 and re-run.`,
  );
  process.exit(1);
}
