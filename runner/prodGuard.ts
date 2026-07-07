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
//     2. NEITHER deployed-environment signal is present. There are TWO independent ones —
//        belt-and-suspenders — and EITHER suffices to pass:
//        • SYNTHWATCH_DEPLOYED === '1' — the UNIVERSAL marker infra/main.bicep (#197) declares on
//          ALL EIGHT container-app jobs (the 3 mains AND migrate/rollup/narrative/reconcile/
//          retention) and #201 bakes into the runner IMAGE so it rides every deploy. Template/
//          image-owned; a plain Mac shell never has it.
//        • CONTAINER_APP_JOB_NAME present — ACA PLATFORM-INJECTED job metadata. Azure primary docs
//          (learn.microsoft.com/azure/container-apps/environment-variables, "Built-in environment
//          variables → Jobs"): "Azure Container Apps automatically adds environment variables that
//          your apps and jobs can use to obtain platform metadata at run-time"; CONTAINER_APP_JOB_NAME
//          = "The name of the job". So it is present on EVERY real Container Apps job execution,
//          absent in a local shell / bare `docker run`, and NOT settable or strippable by a deploy
//          env-op — the second signal SURVIVES a marker desync.
//        ★ WHY two signals (the 2026-07-06 outage): #198 had reduced this to the marker ALONE. When a
//        deploy left SYNTHWATCH_DEPLOYED off the running jobs, ALL of them refused to start for ~23h
//        (self-alerting was down too). This platform-injected fallback means a real ACA job passes
//        even if the marker desyncs, while a local run — which has NEITHER — is still refused.
//        NOTE we restore ONLY CONTAINER_APP_JOB_NAME, NOT #196's SYNTHWATCH_LOCATION: LOCATION was a
//        user-settable var on only the 3 mains, and a local shell exporting it bypassed the guard
//        (#196's named falsifier) — CONTAINER_APP_JOB_NAME has neither flaw (platform-injected, all jobs).
//   ESCAPE HATCH: SYNTHWATCH_ALLOW_PROD=1 — a deliberate local-against-prod run (cache warming,
//   controlled diagnostics, an intentional local redTestMain) states its intent and proceeds.
//
// FALSIFIER (named, accepted): a non-template deployment (e.g. a bare `docker run` on a VM) has
// NEITHER signal and is wrongly blocked — the hatch is the remedy and the error says so. A local
// shell that deliberately exports SYNTHWATCH_DEPLOYED=1 or CONTAINER_APP_JOB_NAME bypasses — spoofing,
// not the accident class; the June incident ran with a bare sourced ~/.synthwatch.env and IS caught.
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
  // TWO independent deployed-environment signals, EITHER suffices (belt-and-suspenders — see header
  // for the 2026-07-06 marker-desync outage that motivates the second one):
  //  (1) SYNTHWATCH_DEPLOYED === '1' — the universal #197 marker (exact '1', mirrors the hatch's
  //      exactness; pins the bicep/image contract).
  //  (2) CONTAINER_APP_JOB_NAME present — ACA platform-injected job metadata (Azure docs), on every
  //      real Container Apps job execution, absent locally, unstrippable by a deploy env-op. Presence
  //      (any non-empty name), not an exact value — the platform sets the job's actual name.
  const inAcaJob = (env.CONTAINER_APP_JOB_NAME ?? '') !== '';
  if (env.SYNTHWATCH_DEPLOYED === '1' || inAcaJob) {
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
      `(*${PROD_PG_HOST_SUFFIX}) but NEITHER deployed-environment signal is present ` +
      `(no SYNTHWATCH_DEPLOYED=1 marker AND no CONTAINER_APP_JOB_NAME — the ACA platform sets the ` +
      `latter on every real job) — this looks like a LOCAL process about to write prod (the ` +
      `June 25–26 check-74 incident). If this local-against-prod run is DELIBERATE, set ` +
      `SYNTHWATCH_ALLOW_PROD=1 and re-run.`,
  );
  process.exit(1);
}
