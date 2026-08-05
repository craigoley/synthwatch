// ── The parent → child CREDENTIAL CHANNEL (stdin, not env) ──────────────────────────────────────────────
//
// The user's typed credentials arrive in the sandbox process inside the decrypted payload blob
// (sandboxPayload.ts). They then have to reach the CHILD, because the child is what executes the spec — and
// `credential()` runs inside it. This module is that hop.
//
// ★ WHY STDIN AND NOT ENV — see specfetch/specCredentials.ts for the full argument. In one line: a value that
//   is never in `process.env` cannot be dumped out of `process.env` by uploaded code, and sandboxMain ships
//   128 KB of the child's stdout to the UI. This replaces the old SW_SANDBOX_CRED_* env publication.
//
// ★ WHY NOT argv: a process's argv is world-readable via /proc and shows up in `ps` — strictly worse than env.
// ★ WHY NOT a temp file: the spec runs IN the child, with fs. A file it can readFileSync is not a boundary.
// ★ WHY STDIN IS DIFFERENT: the parent writes ONE line and closes the pipe; the child drains it to EOF BEFORE
//   importing the spec (sandboxChild). By the time any uploaded code runs, fd 0 is consumed and at EOF, so a
//   hostile `readFileSync('/dev/stdin')` gets nothing. The values live only in the child's heap, reachable
//   solely through credential().
//
// ★ The channel is ALWAYS written, even for an uncredentialed preview (an empty object). A uniform, always-
//   closed stdin means the child has ONE read path to reason about, and a preview with no credentials cannot
//   accidentally block on a pipe that is never ended.
import type { Readable, Writable } from 'node:stream';

import type { SandboxCredentials } from './sandboxPayload.js';

/**
 * The role name each payload field is exposed under to `credential(role)`.
 *
 * ★ `username`/`password` are the roles the FLEET's credentialed specs already call (b2c-login-test,
 *   authorized-user-add-to-cart, full-shop-flow all do `credential('username')` / `credential('password')`),
 *   so a preview of those specs resolves with NO spec edit. That 1:1 match is the point of the feature.
 *
 * ★ `bypassToken` has NO fleet counterpart and is a DELIBERATE non-match, flagged rather than mapped: on the
 *   fleet path the Vercel bypass is injected by the RUNNER as a host-scoped request header
 *   (vercelBypass.browserHeaderAdditions reading the platform's VERCEL_BYPASS_TOKEN secret), never handed to
 *   a spec. In a preview the platform token is absent BY DESIGN — VERCEL_BYPASS_TOKEN is on
 *   PROD_SECRET_ENV_NAMES and sandboxIsolation.test.ts asserts it is not in the child env — so a spec that
 *   needs the bypass must read the one the user typed, and this is the only channel for it. A spec doing
 *   `process.env.VERCEL_BYPASS_TOKEN` gets undefined in a preview and always will; it must call
 *   `credential('bypassToken')`.
 */
export const CHILD_CRED_ROLES = {
  username: 'username',
  password: 'password',
  bypassToken: 'bypassToken',
} as const satisfies Record<keyof SandboxCredentials, string>;

/**
 * The { role -> plaintext } map to hand the child: the three known fields, STRING-TYPED and non-empty only.
 *
 * ★ THE STRING TEST IS A LOCK, NOT A TIDY-UP — it must agree with credentialValues()/isCredentialedRun(),
 *   which decide whether the run is `sensitive` at all. This is the same second lock that used to live in
 *   buildSandboxEnv: when the two predicates disagreed, a non-string credential (`{"password": 12345678}`)
 *   was published to the spec while the run was classified NON-sensitive — redaction off, raw trace kept,
 *   every protection down while the secret was still handed to uploaded code. decodeSandboxPayload coerces
 *   at the boundary; this is the belt to that braces, moved with the publication it guards.
 */
export function buildChildCredentials(creds: SandboxCredentials | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!creds) return out;
  for (const [field, role] of Object.entries(CHILD_CRED_ROLES) as [keyof SandboxCredentials, string][]) {
    const v = creds[field];
    if (typeof v === 'string' && v.length > 0) out[role] = v;
  }
  return out;
}

/** The exact bytes the parent writes to the child's stdin: one JSON line, newline-terminated. */
export function encodeChildCredentials(creds: SandboxCredentials | undefined): string {
  return JSON.stringify({ credentials: buildChildCredentials(creds) }) + '\n';
}

/**
 * PARENT side: write the credentials line and CLOSE stdin. Closing is load-bearing — it is what puts fd 0 at
 * EOF before the spec ever runs, and what lets the child's read resolve at all.
 *
 * Best-effort by design: a child that died between spawn and this write makes the pipe EPIPE, and that is
 * already reported through the 'error'/'close' handlers. Throwing here would replace a real diagnostic with a
 * plumbing one.
 */
export function writeChildCredentials(stdin: Writable | null, creds: SandboxCredentials | undefined): void {
  if (!stdin) return;
  stdin.on('error', () => {
    /* EPIPE if the child is already gone — the spawn/close handlers carry the real failure */
  });
  try {
    stdin.end(encodeChildCredentials(creds));
  } catch {
    /* see above */
  }
}

/**
 * CHILD side: drain stdin to EOF and return the credential map.
 *
 * ★ FAIL-OPEN TO EMPTY, ON PURPOSE — and that is not a security hole. The failure modes here (no line, bad
 *   JSON, a truncated pipe) all end in "this run has no credentials", which makes `credential()` THROW its
 *   fail-closed refusal and the preview RED with a legible message. The dangerous direction would be running
 *   with a WRONG credential, and there is no path to that: nothing is ever invented, only read or absent.
 *
 * ★ It never throws, because a throw here would abort BEFORE sandboxChild's structured-output handling and
 *   the operator would see a bare stack instead of the refusal telling them what to type.
 */
export async function readChildCredentials(stdin: Readable): Promise<Record<string, string>> {
  let raw = '';
  try {
    stdin.setEncoding('utf8');
    for await (const chunk of stdin) raw += chunk;
  } catch {
    return {};
  }
  const line = raw.trim();
  if (line.length === 0) return {};
  try {
    const parsed = JSON.parse(line) as { credentials?: unknown };
    const creds = parsed?.credentials;
    if (!creds || typeof creds !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [role, value] of Object.entries(creds as Record<string, unknown>)) {
      if (typeof value === 'string' && value.length > 0) out[role] = value;
    }
    return out;
  } catch {
    // ★ Deliberately does NOT echo `line` — it is the credential plaintext.
    return {};
  }
}
