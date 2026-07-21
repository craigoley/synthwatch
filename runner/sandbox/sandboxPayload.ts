// ── The sandbox PAYLOAD channel (spec + user-typed credentials) ─────────────────────────────────────────
//
// ★ WHY THIS EXISTS: the spec used to ride SW_SANDBOX_SPEC_B64, an ARM `jobs/start` env override. ACA
// persists the ENTIRE override template VERBATIM on the execution resource — OBSERVED:
//   $ az containerapp job execution list -n synthwatch-sandbox -g synthwatch-rg
//     … "env": [ { "name": "SW_SANDBOX_SPEC_B64", "value": "aW1wb3J0IHsgdGVzdCwg…" } ]
// readable by ANY Reader on the resource group. The docs bound execution history to "the most recent 100
// successful and failed job executions" for SCHEDULED and EVENT-based jobs — synthwatch-sandbox is
// triggerType:'Manual', which that sentence does NOT cover, so retention is unbounded-by-contract. A typed
// password on that channel would sit in Azure indefinitely, in plaintext, for a far wider audience than the
// vault holding CRED_ENC_KEY. So the payload moves OFF the env.
//
// ── THE SPLIT-SECRET CHANNEL (neither half is sufficient) ───────────────────────────────────────────────
//   ARM env  → SW_SANDBOX_CRED_KEY: a per-run random AES-256 key. ★ This one LEAKS to execution history,
//              and that is FINE BY DESIGN — a key with no ciphertext is worthless.
//   Blob     → `{token}.payload`: AES-256-GCM ciphertext of {spec, credentials}. Private container, MI-only,
//              DELETED ON READ (see resolveSandboxPayload). Never appears in execution history at all.
//
// ★ WHY NOT BLOB-ONLY: the sandbox MI holds Blob Data Contributor on the SHARED container and preview
// concurrency is 3, so a hostile spec could mint an IMDS token and read a CONCURRENT run's ciphertext. That
// run's key lives in the OTHER execution's ARM env, and verify_sandbox_least_privilege (scripts/deploy.sh)
// proves the sandbox MI has ZERO ARM read grants — so it cannot fetch the key it would need. The split is
// what makes the concurrent-neighbour case safe; delete-on-read shrinks the window to milliseconds on top.
//
// ── ★ RESIDUAL RISK: THE CRASHED-PREVIEW WINDOW (open; needs an api-side sweep) ─────────────────────────
// Delete-on-read is the primary cleanup and it is fast. But if the job dies BETWEEN the api's upload and
// this process's read (ACA replica eviction, an image-pull failure, a 180s replicaTimeout kill), nothing
// deletes the ciphertext and only the lifecycle rule remains.
//
// ★ THAT BACKSTOP CANNOT BE MADE SUB-DAY. infra/main.bicep's 'expire-sandbox-previews' rule already covers
// `{container}/` — so `.payload` inherits it — but `daysAfterModificationGreaterThan` is typed **Integer**
// in the lifecycle policy schema (no fractional days), and Azure documents that a policy change can take
// "up to 24 hours to go into effect", with runs merely "periodic". So the floor is ~1 day, not minutes.
// Meanwhile the run's key sits in ACA execution history permanently — so for that window an actor holding
// BOTH RG Reader AND blob data access has both halves, which is exactly the property the split is meant to
// deny. It is a narrow window and a two-grant actor, but it should not be accepted silently.
//
// ★ PROPOSED CLOSURE (api-side, NOT in this PR): PreviewFunctions already runs a stale-row sweep
// (RunningStaleAfter = 5 min, flipping `running` rows to `timeout`). Deleting `{token}.payload` in that same
// sweep bounds the window to ~5 minutes instead of ~24 hours. Cost: the api MI is currently Blob Data
// READER on this container and would need delete rights — a deliberate, scoped widening to weigh, not a
// free win. Until then the exposure above stands, documented.
//
// ★ CRED_ENC_KEY IS NEVER INVOLVED. This reuses runner/crypto.ts's v1 envelope as a FORMAT ONLY. The
// sandbox job has no `secrets:` block (infra/main.bicep) and CRED_ENC_KEY is not in PROD_SECRET_ENV_NAMES'
// allowlist — sandboxIsolation.test.ts's "no prod secret" proof is untouched by this file.
import { decryptCredValue, parseAes256Key } from '../crypto.js';

/**
 * The credentials a user TYPED in the Tests UI for ONE preview run. Ephemeral: they exist in the ciphertext
 * blob (deleted on read), this process's memory, and the child's env — never in Postgres, never in the ARM
 * body, never in audit_log (which records the actor + the spec HASH, never a secret).
 *
 * `bypassToken` is the Vercel protection-bypass token, PASTED BY THE USER per-run — deliberately NOT
 * server-injected from the platform's own VERCEL_BYPASS_TOKEN. Server-injecting a SHARED platform secret
 * would let a hostile spec dump it, and would require deleting VERCEL_BYPASS_TOKEN from
 * PROD_SECRET_ENV_NAMES — i.e. removing a currently-passing assertion to make room for the thing it catches.
 */
export interface SandboxCredentials {
  username?: string;
  password?: string;
  bypassToken?: string;
}

/** What the api encrypts into `{token}.payload`. The api mirror MUST serialize exactly these field names. */
export interface SandboxPayload {
  spec: string;
  credentials?: SandboxCredentials;
  /**
   * Per-run "Redact credentials from output" toggle (Tests UI, editor/admin only). DEFAULT ON.
   * ON  → the credentialed run is `sensitive`: makeRedactor scrubs trace text, stdout, error, trace_signals.
   * OFF → IDENTITY_REDACTOR, nothing scrubbed — the operator asked to see raw output for a credential they
   *       typed themselves. Absent ⇒ ON (see decodeSandboxPayload: only a literal `false` disables).
   */
  redactCredentials?: boolean;
}

/** Where a resolved payload came from — `legacy-env` is the pre-cutover path PR4 removes. */
export type SandboxPayloadSource = 'payload-blob' | 'legacy-env';

export interface ResolvedSandboxPayload {
  payload: SandboxPayload;
  source: SandboxPayloadSource;
}

/**
 * The credential VALUES of a payload, as the flat list makeRedactor takes as `knownValues`. Empty/absent
 * fields are dropped; makeRedactor itself additionally skips values under 3 chars (a 1-2 char "value" would
 * over-redact the whole trace into noise).
 */
export function credentialValues(creds: SandboxCredentials | undefined): string[] {
  if (!creds) return [];
  return [creds.username, creds.password, creds.bypassToken].filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/** True iff this run carries ANY user-typed credential — the flag that makes a preview `sensitive`. */
export function isCredentialedRun(creds: SandboxCredentials | undefined): boolean {
  return credentialValues(creds).length > 0;
}

/**
 * Decrypt + parse a `{token}.payload` body. FAIL-CLOSED (throws) on a bad key, a tampered/truncated
 * envelope, malformed JSON, or a payload with no string `spec` — a preview must never fall back to running
 * something we could not authenticate. The thrown message NEVER embeds the plaintext or the key: a decrypt
 * failure names the envelope, and a shape failure names the field.
 */
export function decodeSandboxPayload(ciphertext: string, key: Buffer): SandboxPayload {
  const json = decryptCredValue(ciphertext, key); // throws on wrong key / tampered tag / bad version prefix
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // ★ Deliberately does NOT echo `json` — it is the decrypted plaintext and would carry the credentials.
    throw new Error('sandbox payload decrypted but is not valid JSON (fail-closed)');
  }
  const p = parsed as Partial<SandboxPayload> | null;
  if (!p || typeof p.spec !== 'string' || p.spec.length === 0) {
    throw new Error('sandbox payload has no `spec` string (fail-closed)');
  }
  const creds = p.credentials as Record<string, unknown> | undefined | null;
  return {
    spec: p.spec,
    // Take ONLY the three known credential fields — an api that grew a fourth field cannot smuggle it into
    // the child env without this file changing too (and knownValues covering it).
    // ★ AND ONLY AS STRINGS. Field-NAME filtering alone left a type-confusion fail-OPEN: a non-string value
    //   (say `{"password": 12345678}`) was passed through, `credentialValues` filtered it out of knownValues
    //   (it checks typeof), but buildSandboxEnv tested plain truthiness and still published it to the spec.
    //   Net effect: sensitive=false ⇒ IDENTITY_REDACTOR, raw trace kept, SCREENSHOT KEPT, stdout unscrubbed —
    //   every protection off while the secret was still handed to the uploaded code. Coercing to
    //   string-or-undefined here makes the two predicates agree by construction.
    credentials: creds
      ? { username: asString(creds.username), password: asString(creds.password), bypassToken: asString(creds.bypassToken) }
      : undefined,
    // ★ FAIL-SAFE, and deliberately `=== false` rather than a truthiness test or a cast. Redaction is the
    //   protective state, so ONLY the literal boolean `false` turns it off: absent, null, `"false"` (a
    //   string — an api that stringified the field), `0`, or any other shape all resolve to ON. This is the
    //   same type-confusion class the credential fields above are coerced against, and here it fails the
    //   safe way round — a malformed payload over-redacts (an operator sees <redacted> and re-runs), it
    //   never silently under-redacts. The api mirror must send a real JSON boolean.
    redactCredentials: p.redactCredentials !== false,
  };
}

/** A credential field is a string or it is absent — never a number/object/boolean (see decodeSandboxPayload). */
function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** The blob side of the channel, injected so the ordering contract below is testable without Azure. */
export interface SandboxPayloadDeps {
  /**
   * Download `{token}.payload` and DELETE it, returning the ciphertext (or null if absent). The DELETE must
   * be awaited BEFORE this resolves — resolveSandboxPayload's ordering guarantee is only as strong as this.
   */
  fetchAndDeletePayload: (token: string) => Promise<string | null>;
}

/**
 * Resolve the spec + credentials for this execution.
 *
 * ★ ORDERING IS A SECURITY PROPERTY, NOT A STYLE CHOICE. The sequence is exactly:
 *      fetch {token}.payload → DELETE IT → decrypt → (caller) compile → (caller) execute
 * The delete lands BEFORE any uploaded code compiles or runs, so a hostile spec never executes while a
 * NEIGHBOUR's ciphertext is still resident in the shared container. Deleting after the run — or lazily via
 * the container's lifecycle rule — would leave that window open for the whole preview (up to 180s), which is
 * precisely the concurrent-read case the split-secret design exists to close.
 *
 * ★ BACKWARD COMPATIBLE (PR4 removes this): if there is no payload blob but the legacy SW_SANDBOX_SPEC_B64
 * is set, honour it. This lets the runner deploy BEFORE the api switches channels without breaking previews.
 * The legacy path carries NO credentials by construction — it is the leaky env channel, and a credential
 * must never travel on it.
 */
export async function resolveSandboxPayload(
  env: NodeJS.ProcessEnv,
  deps: SandboxPayloadDeps,
): Promise<ResolvedSandboxPayload> {
  const token = env.SW_SANDBOX_RESULT_TOKEN;
  const keyRaw = env.SW_SANDBOX_CRED_KEY;

  // ★ THE KEY ALONE DECLARES THE CHANNEL. Gating on `token && keyRaw` let a key-without-token config bug
  //   fall silently through to the legacy env path: a DIFFERENT spec would run, the credentials would be
  //   dropped, and — worst — the {token}.payload ciphertext would never be fetched or deleted, sitting for
  //   the ~1-day lifecycle floor while its key sits in ACA execution history permanently. That is exactly
  //   the both-halves-available window the split-secret design exists to deny, reached by a typo rather
  //   than the documented crash case. If the key is set, the payload channel is the ONLY acceptable answer.
  if (keyRaw) {
    if (!token) {
      throw new Error(
        'sandboxPayload: SW_SANDBOX_CRED_KEY is set (payload channel declared) but SW_SANDBOX_RESULT_TOKEN is ' +
          'missing — cannot locate the payload blob; refusing to execute (fail-closed)',
      );
    }
    // ★ SW_SANDBOX_CRED_KEY being set is the api DECLARING the payload channel. From here the legacy env is
    //   no longer an acceptable answer: falling back would (a) silently run a DIFFERENT spec than the one
    //   the user submitted, dropping their credentials, and (b) — if the fetch returned null because
    //   DELETE-ON-READ FAILED — execute uploaded code with a live ciphertext still sitting in the shared
    //   container, which is the exact window this design closes. Fail closed instead.
    // ★ STEP 1+2: fetch, then DELETE — both complete before we even look at the plaintext.
    const ciphertext = await deps.fetchAndDeletePayload(token);
    if (!ciphertext) {
      throw new Error(
        'sandboxPayload: SW_SANDBOX_CRED_KEY is set (payload channel declared) but `{token}.payload` could not be ' +
          'read AND deleted — refusing to execute (fail-closed)',
      );
    }
    // ★ STEP 3: only now decrypt. A throw here is fail-closed too — a present-but-undecryptable payload
    //   means tampering or a key mismatch, not absence.
    const key = parseAes256Key(keyRaw, 'SW_SANDBOX_CRED_KEY');
    return { payload: decodeSandboxPayload(ciphertext, key), source: 'payload-blob' };
  }

  const legacyB64 = env.SW_SANDBOX_SPEC_B64;
  if (legacyB64) {
    return { payload: { spec: Buffer.from(legacyB64, 'base64').toString('utf8') }, source: 'legacy-env' };
  }

  throw new Error(
    'sandboxPayload: no spec — neither `{token}.payload` (the api sets SW_SANDBOX_CRED_KEY + uploads the blob) ' +
      'nor the legacy SW_SANDBOX_SPEC_B64 was present',
  );
}
