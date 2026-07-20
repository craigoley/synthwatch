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
   * (sandboxPayload.ts) — NEVER via the ARM env, which ACA persists in execution history. Published to the
   * child so the spec can drive a real login.
   *
   * ★ THIS DOES NOT WEAKEN THE ALLOWLIST PROPERTY. The property is "the executed spec cannot reach the
   * FLEET's secrets" — no CRED_ENC_KEY, so no decrypting other monitors' stored logins; no DATABASE_URL;
   * no ACS/AOAI key; no platform VERCEL_BYPASS_TOKEN. Handing the spec the one credential the user just
   * typed, for the run they just asked for, is the feature. PROD_SECRET_ENV_NAMES is unchanged and
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
  // ★ The user's own per-run credentials (see SandboxRunVars.credentials). Set ONLY when non-empty, so an
  //   uncredentialed preview's child env is byte-identical to what it was before this feature existed.
  //   Every value published here is ALSO registered with makeRedactor as a knownValue by runSandboxPreview,
  //   so anything that echoes it into stdout / the trace / an error is scrubbed on the way out.
  if (vars.credentials?.username) env.SW_SANDBOX_CRED_USERNAME = vars.credentials.username;
  if (vars.credentials?.password) env.SW_SANDBOX_CRED_PASSWORD = vars.credentials.password;
  if (vars.credentials?.bypassToken) env.SW_SANDBOX_CRED_BYPASS_TOKEN = vars.credentials.bypassToken;
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
