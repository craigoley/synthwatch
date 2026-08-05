// ── The IN-PROCESS credential store the sandbox child resolves credential() from ────────────────────────
//
// ★ WHY THIS EXISTS. The Tests area was built to preview the fleet's AUTHENTICATED monitors, and every one of
// them opens with `credential('username')` / `credential('password')`. Those resolve from `SW_CRED_<ROLE>`
// (runner/loginCredentials.ts) — env vars the sandbox has never had and must never get. So the one thing the
// Tests area existed for was the one thing it could not do: a credentialed spec died on its first line with
// the preview refusal, before reaching a single navigation.
//
// ★★ WHY NOT JUST PUBLISH SW_CRED_* TO THE CHILD (the obvious fix, deliberately rejected):
//   1. `process.env` IS THE LEAK SURFACE. sandboxChild executes UPLOADED, UNMERGED code (compileSpec's RCE
//      boundary). A `console.log(process.env)` is one line, and sandboxMain ships 128 KB of the child's
//      stdout inside `{token}.json` for the UI to render. A credential that is never IN the env cannot be
//      dumped OUT of it — the strongest available statement, and it costs nothing here.
//   2. IT WOULD DILUTE THE ALLOWLIST PROOF. sandboxEnv.ts's whole claim is "the child env is EMPTY except a
//      handful of non-secret, load-bearing vars." Adding a secret-valued name to that list turns an
//      exception-free invariant into one with a carve-out, and every future reader has to re-derive whether
//      the carve-out is still safe. verify_sandbox_least_privilege and PROD_SECRET_ENV_NAMES stay untouched.
//   3. SW_CRED_* IS THE FLEET'S NAMESPACE. Reusing it in the sandbox would make the two paths look
//      interchangeable when they are not: the fleet's values come from checks.login_credentials decrypted
//      under CRED_ENC_KEY (which the sandbox does not hold); the preview's come from a per-run blob the user
//      just typed. Distinct provenance, distinct channel.
//   4. AN ENV VAR IS PROCESS-WIDE AND UNSCOPED. A module-private Map is reachable ONLY through credential(),
//      which is the accessor the parity contract already governs.
//
// ★ HOW THE VALUES GET HERE WITHOUT ENV: the parent writes them to the child's STDIN as one JSON line and
//   closes it (runner/sandbox/sandboxCredChannel.ts). The child drains stdin to EOF and calls set() BEFORE
//   the uploaded spec is imported, so by the time any spec code runs the pipe is already consumed and closed.
//
// ★ FLEET UNAFFECTED. Nothing in the live check path calls set(), so this store is empty in the runner
//   process and credential() falls through to SW_CRED_<ROLE> exactly as it always has.

/** role (lower-cased) -> plaintext. Module-private: the ONLY reader is specShim's credential(). */
const store = new Map<string, string>();

/**
 * Roles are matched CASE-INSENSITIVELY, mirroring the fleet path — there, `credential(role)` reads
 * `SW_CRED_${role.toUpperCase()}`, so 'username'/'Username'/'USERNAME' are already one role. Normalising the
 * same way here keeps a spec's behaviour identical between a preview and a live run.
 *
 * ★ It is CASE folding ONLY — NOT punctuation folding. `credential('bypass_token')` is a DIFFERENT role from
 *   `credential('bypassToken')` and will miss, exactly as it would in the fleet (`SW_CRED_BYPASS_TOKEN` vs
 *   `SW_CRED_BYPASSTOKEN`). Silently aliasing the two would make the preview resolve something a live run
 *   would not, which is the "preview that lies" failure mode.
 */
function normalise(role: string): string {
  return role.toLowerCase();
}

/**
 * Install this process's spec credentials. Called ONCE by sandboxChild before the uploaded spec is imported;
 * a later call REPLACES the set (there is no accumulate-across-runs case — one child, one preview).
 *
 * Empty/non-string values are dropped rather than stored: `credential()` must FAIL-CLOSED on a role the user
 * left blank, never hand a spec an empty string it would submit to a login form.
 */
export function setSpecCredentials(creds: Record<string, unknown>): void {
  store.clear();
  for (const [role, value] of Object.entries(creds)) {
    if (typeof value === 'string' && value.length > 0) store.set(normalise(role), value);
  }
}

/** The plaintext for `role`, or undefined when this process holds none (the fleet: always undefined). */
export function lookupSpecCredential(role: string): string | undefined {
  return store.get(normalise(role));
}

/** Whether ANY credential was installed — lets credential()'s miss say "you supplied none" vs "not that one". */
export function hasSpecCredentials(): boolean {
  return store.size > 0;
}

/** The role names installed, for a VALUE-FREE diagnostic ("you supplied username, password"). Never values. */
export function specCredentialRoles(): string[] {
  return [...store.keys()];
}

/** TEST-ONLY: drop everything, so one test's install cannot bleed into the next. */
export function __clearSpecCredentialsForTest(): void {
  store.clear();
}
