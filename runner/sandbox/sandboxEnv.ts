// ── The sandbox isolation primitive ────────────────────────────────────────────────────────────────────
// A preview runs an UPLOADED, UNMERGED spec — arbitrary Node at runner privilege (compileSpec.ts's RCE
// boundary), WITHOUT the monitors-repo merge gate. Two layers defend it:
//   1. INFRA (authoritative): the `synthwatch-sandbox` ACA job is a SEPARATE identity with a secret-free,
//      allowlist-constructed env (infra/main.bicep) — no CRED_ENC_KEY, no prod DATABASE_URL, no ACS, no
//      Postgres write. Even fully-hostile uploaded code has nothing to steal and nowhere to write.
//   2. THIS FILE (defense-in-depth + the LOCAL PROOF): the spec is executed in a CHILD PROCESS whose env is
//      built from an ALLOWLIST — the child NEVER inherits the parent's process.env. So even if the sandbox
//      job's env ever regressed to carry a secret, the executed spec still can't see it. This layer is what
//      makes the "print process.env → no prod secret" acceptance test runnable OFF-Azure (see
//      sandboxIsolation.test.ts): set a fake CRED_ENC_KEY in the parent, prove the child's dump omits it.
//
// ★ ALLOWLIST, never denylist. A denylist ("strip these secrets") fails open the day a new secret is added.
// The child env is EMPTY except the handful of non-secret vars a Playwright spec genuinely needs to run,
// plus the user's OWN per-run credentials when they typed some (see SandboxRunVars.credentials).
import type { SandboxCredentials } from './sandboxPayload.js';

/** The ONLY env vars the sandbox child inherits — every one is non-secret and load-bearing for execution. */
const SANDBOX_ENV_ALLOWLIST = [
  'PATH', // find node + the playwright browser launcher
  'HOME', // playwright/tmp writes; browser profile dir
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'NODE_ENV',
  'PLAYWRIGHT_BROWSERS_PATH', // where the browsers were installed (non-secret path)
] as const;

/** Vars a preview run is EXPLICITLY given (non-secret): the target it may hit, and a bounded timeout. */
export interface SandboxRunVars {
  /** The non-prod / public target the preview navigates to. Never a prod first-party host with real creds. */
  targetUrl: string;
  /** Hard per-run wall-clock budget (ms) — mirrored by the ACA replicaTimeout; belt-and-braces here. */
  timeoutMs: number;
  /**
   * ★ The user's OWN credentials, typed in the Tests UI for THIS run, arriving via the payload blob
   * (sandboxPayload.ts) — NEVER via the ARM env, which ACA persists in execution history.
   *
   * ★★ buildSandboxEnv PUBLISHES NOTHING FOR THIS FIELD. It used to (SW_SANDBOX_CRED_USERNAME / _PASSWORD /
   * _BYPASS_TOKEN), which meant a one-line `console.log(process.env)` in an uploaded spec dumped the user's
   * password into the child's stdout — and sandboxMain ships 128 KB of that stdout to the UI. The values now
   * travel to the child over STDIN and live only in its heap, reachable solely through `credential(role)`
   * (runner/sandbox/sandboxCredChannel.ts + runner/specfetch/specCredentials.ts, which carry the full
   * why-not-env argument). The field stays on SandboxRunVars because it IS a per-run input — runChild reads
   * it for the stdin write — it just no longer becomes an environment variable.
   *
   * ★ THE ALLOWLIST IS NOW EXCEPTION-FREE AGAIN. Every var below is non-secret; there is no carve-out for a
   * secret-valued name that a future reader has to re-justify. PROD_SECRET_ENV_NAMES is unchanged and
   * sandboxIsolation.test.ts still proves every name on it is absent.
   */
  credentials?: SandboxCredentials;
}

/**
 * Build the child process's env from the allowlist + the explicit run vars. NOTHING from the parent's
 * process.env crosses this boundary except the allowlisted, non-secret entries — so no CRED_ENC_KEY, no
 * DATABASE_URL, no ACS connection string, no SW_CRED_* can reach the executed spec, by construction.
 */
export function buildSandboxEnv(vars: SandboxRunVars, parentEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.create(null);
  for (const key of SANDBOX_ENV_ALLOWLIST) {
    const v = parentEnv[key];
    if (v !== undefined) env[key] = v;
  }
  // Explicit, non-secret run inputs — namespaced so they can't shadow anything the spec might expect.
  env.SW_SANDBOX = '1';
  env.SW_SANDBOX_TARGET_URL = vars.targetUrl;
  env.SW_SANDBOX_TIMEOUT_MS = String(vars.timeoutMs);
  // ★★ NO CREDENTIAL IS PUBLISHED HERE — see SandboxRunVars.credentials. `vars.credentials` is deliberately
  //   NOT read in this function: the user's typed values reach the child over stdin (sandboxCredChannel.ts)
  //   and are resolved in-process by credential(). An env dump by uploaded code therefore shows no credential
  //   under ANY name, and this file's allowlist claim ("every entry is non-secret") holds without exception.
  //   ★ Do not "helpfully" re-add them. The string-typed lock that used to guard the publication moved with
  //     it to buildChildCredentials(); re-introducing an env write here would reopen the type-confusion gap
  //     AND the process.env-dump surface in one edit.
  // ★ Marker asserting the DECISION, so a future edit that spreads {...process.env} here is a visible diff.
  env.SW_SANDBOX_ENV_IS_ALLOWLISTED = '1';
  return env;
}

/** The exact prod-secret env names the acceptance test asserts NEVER appear in a sandbox run. Named here (one
 *  place) so the test and any future audit read the same list — add a new prod secret and add it here. */
export const PROD_SECRET_ENV_NAMES = [
  'CRED_ENC_KEY',
  'DATABASE_URL',
  'ACS_EMAIL_CONNECTION_STRING',
  'AZURE_OPENAI_API_KEY',
  'VERCEL_BYPASS_TOKEN',
] as const;
