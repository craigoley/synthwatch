// Per-monitor LOGIN CREDENTIALS — references-only (mirrors checks.secret_headers / checks.auth's *_env model).
//
// checks.login_credentials is { credentialRole -> ENV_VAR_NAME } (e.g. { username: 'B2C_TEST_USER',
// password: 'B2C_TEST_PASS' }): the runner resolves process.env[ENV_VAR_NAME] at RUN time and exposes the
// value to the browser spec under a GENERIC role name — never the env-var name, never a hardcoded secret in
// the spec. The stored map is NON-secret (role names + env-var names — the same references-only shape as
// `secret_headers`/`auth`). The resolved VALUE is used ONLY to fill the login form:
//   • NEVER logged        — the resolver's warn (on a missing env var) names the role + ENV_VAR only.
//   • NEVER in a DTO       — the api maps only the REFERENCE names (role -> env-var-name), never the value.
//   • NEVER in trace_signals — the trace extractor captures no request headers / form values (audit #219).
//
// ★ WHY NOT the secret_headers mechanism verbatim: secret_headers resolves at the NETWORK layer and injects
//   a request header — the value never reaches the spec's JS. A login credential must be TYPED into a form
//   field by the spec, so the value has to reach spec scope. It's exposed via a per-run env convention
//   (SW_CRED_<ROLE>, set by applyLoginCredentials + read by the shim's credential()) — set right before the
//   flow runs and CLEARED right after, so it can't linger or bleed across the serially-run checks in a tick.
//   The per-monitor role→env-var mapping stays in the check (declared in the manifest), not in the spec.
//
// ★ PROVISIONING CEILING (honest limit): each ENV_VAR_NAME must be an ACA job env var (like B2C_TEST_USER) —
//   there is no per-monitor secret vault. Same ceiling as secret_headers.

/** credentialRole -> ENV_VAR_NAME. Both non-secret; only the resolved env value is secret. */
export type LoginCredentialRefs = Record<string, string>;

/** The env-var name the shim's credential(role) reads: SW_CRED_<ROLE>, ROLE upper-cased. */
export function credentialEnvKey(role: string): string {
  return `SW_CRED_${role.toUpperCase()}`;
}

/**
 * Resolve a monitor's login credentials to { role: value } for each ref whose ENV_VAR is set.
 *
 * FAIL-SOFT: a ref whose env var is unset/empty is SKIPPED (with a NAME-only warn) — a missing credential
 * must not crash the run; the monitor's own login assertion then goes red, which is the correct signal.
 *
 * ★ The resolved VALUE appears ONLY in the returned map. It is NEVER logged.
 */
export function resolveLoginCredentials(refs: LoginCredentialRefs | null | undefined): Record<string, string> {
  if (!refs) return {};
  const out: Record<string, string> = {};
  for (const [role, envName] of Object.entries(refs)) {
    const value = process.env[envName];
    if (value === undefined || value.length === 0) {
      // NAME-only — never the (absent) value.
      console.warn(`[login-creds] role "${role}" -> env var "${envName}" not set — credential skipped (fail-soft)`);
      continue;
    }
    out[role] = value;
  }
  return out;
}

/** A published SW_CRED_<ROLE> env var + the value it had BEFORE publish (undefined = didn't exist), so the
 *  cleanup can RESTORE the prior value rather than blindly deleting — defensive if the reserved SW_CRED_*
 *  namespace ever collides with a pre-existing job env var. */
export interface CredEnvHandle {
  key: string;
  prior: string | undefined;
}

/**
 * Resolve + PUBLISH a monitor's login credentials for its (about-to-run) browser spec: sets
 * process.env[SW_CRED_<ROLE>] = value for each resolved role, and returns a handle per key (with the prior
 * value) so the caller can restore them in a finally. Values already live in process.env under their own
 * ENV_VAR names (ACA secrets), so the generic-role copy is no new exposure class — but it is short-lived.
 */
export function applyLoginCredentials(refs: LoginCredentialRefs | null | undefined): CredEnvHandle[] {
  const resolved = resolveLoginCredentials(refs);
  const handles: CredEnvHandle[] = [];
  for (const [role, value] of Object.entries(resolved)) {
    const key = credentialEnvKey(role);
    handles.push({ key, prior: process.env[key] }); // capture prior BEFORE overwrite
    process.env[key] = value;
  }
  return handles;
}

/** RESTORE the SW_CRED_<ROLE> env vars applyLoginCredentials set — call in a finally after the spec runs.
 *  Deletes a key that didn't exist before; restores one that did (so a collision leaves env as it found it). */
export function clearLoginCredentials(handles: CredEnvHandle[]): void {
  for (const { key, prior } of handles) {
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
}
