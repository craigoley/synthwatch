// Local-runner-writes-prod guard (the June 25–26 incident, made structural).
//
// GROUND TRUTH: 46 runs on check 74 (June 25 22:50 → June 26 11:20) carried error messages
// resolving modules under /Users/…/synthwatch/runner/ — a locally-launched dev runner had sourced
// ~/.synthwatch.env (which exports the PROD DATABASE_URL) and wrote prod run rows overnight.
// Nothing prevented a repeat: db.ts builds the pool from DATABASE_URL unconditionally.
//
// THE GUARD (enforced at the very top of index.ts main(), before ANY query — the pg Pool does not
// connect until its first query, so a refusal here means zero prod connections):
//   REFUSE to start when BOTH hold:
//     1. DATABASE_URL points at the prod-class Postgres — host ends with
//        PROD_PG_HOST_SUFFIX ('.postgres.database.azure.com'). Suffix, not the full string or the
//        exact server name: a password rotation or server rename must not break the guard, and
//        this project's only Azure PG is prod (infra/main.bicep:84 postgresServerName =
//        'synthwatch-pg-e2'; every job's database-url is built from its FQDN). Local dev DBs are
//        localhost/docker and never match.
//     2. No deployed-environment signal is present:
//        • SYNTHWATCH_LOCATION — set by infra/main.bicep on ALL three jobs that run index.ts
//          (eastus2 :528, centralus :688, westus2 :843). Template-verified, repo-owned: every
//          deployed runner has it; a plain Mac shell does not (it isn't even in .env.example).
//        • CONTAINER_APP_JOB_NAME — ACA platform metadata, present in job replicas per Azure docs.
//          BONUS signal only: docs could not be full-text verified, so the guard never DEPENDS on
//          it to allow a deployed run (SYNTHWATCH_LOCATION already covers those) — it only widens
//          the deployed detection for hypothetical future ACA entrypoints without LOCATION.
//   ESCAPE HATCH: SYNTHWATCH_ALLOW_PROD=1 — a deliberate local-against-prod run (cache warming,
//   controlled diagnostics) states its intent explicitly and proceeds.
//
// FALSIFIER (named, accepted): a local shell that exports SYNTHWATCH_LOCATION (e.g. while testing
// multi-region logic) AND the prod DATABASE_URL is wrongly allowed — indistinguishable from a
// deployed runner by env alone. The June incident ran with LOCATION unset (its runs stamped
// 'default'), so the actual accident class IS caught. Conversely, a non-ACA deployment without
// SYNTHWATCH_LOCATION would be wrongly blocked — the hatch is the remedy and the error says so.
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
  if (env.SYNTHWATCH_LOCATION || env.CONTAINER_APP_JOB_NAME) {
    return { allowed: true, reason: 'deployed' };
  }
  return { allowed: false, reason: 'local-prod-refused' };
}

/**
 * Enforce at process start (first line of main(), before any query). On refusal: log the reason +
 * the escape hatch, then exit(1) WITHOUT throwing (see module header — a throw would itself write
 * to the prod DB via recordFatal). Deployed runners pass silently.
 */
export function enforceProdGuard(env: NodeJS.ProcessEnv = process.env): void {
  const verdict = prodGuardVerdict(env);
  if (verdict.allowed) return;
  console.error(
    `[runner] REFUSING TO START: DATABASE_URL points at the prod-class Postgres ` +
      `(*${PROD_PG_HOST_SUFFIX}) but no deployed-environment signal is present ` +
      `(SYNTHWATCH_LOCATION / CONTAINER_APP_JOB_NAME unset) — this looks like a LOCAL runner ` +
      `about to write prod (the June 25–26 check-74 incident). If this local-against-prod run ` +
      `is DELIBERATE, set SYNTHWATCH_ALLOW_PROD=1 and re-run.`,
  );
  process.exit(1);
}
