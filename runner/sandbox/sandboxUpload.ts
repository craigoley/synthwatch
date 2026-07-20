// sandboxUpload — the sandbox job's ONLY egress. It writes the preview result + artifacts to the sandbox blob
// container under the sandbox MANAGED IDENTITY (Blob Data Contributor on THIS container only — infra/main.bicep),
// so the api's GET /preview/{token}* can read them. NO connection string / account key: the sandbox holds no
// secret, and DefaultAzureCredential resolves the MI from IMDS. Blob names MUST mirror the api read paths:
//   result   → `{container}/{token}.json`            (PreviewFunctions.TryReadSandboxTraceAsync)
//   trace     → `{container}/{token}/trace.zip`       (GET /preview/{token}/trace)
//   screenshot → `{container}/{token}/screenshot.png` (GET /preview/{token}/screenshot)
// The token is 32-char lowercase hex.
//
// Best-effort by design: a missing account/container/token or an upload failure is logged to stderr and
// swallowed — a failed upload must never crash the run (the api poll then times out cleanly via its stale-row
// sweep rather than the sandbox exiting non-zero for a non-spec reason).
import { DefaultAzureCredential } from '@azure/identity';
import { BlockBlobClient } from '@azure/storage-blob';

/** Resolve the sandbox blob env + a MI credential, or null when unavailable (local / misconfigured). */
function resolveTarget(token: string | undefined): { account: string; container: string; credential: DefaultAzureCredential } | null {
  const account = process.env.SANDBOX_STORAGE_ACCOUNT;
  const container = process.env.SANDBOX_CONTAINER;
  if (!account || !container || !token) {
    process.stderr.write(
      'sandboxUpload: SANDBOX_STORAGE_ACCOUNT / SANDBOX_CONTAINER / SW_SANDBOX_RESULT_TOKEN missing — skipping upload\n',
    );
    return null;
  }
  // ★ The sandbox MI is USER-ASSIGNED-only — a BARE DefaultAzureCredential can't resolve it (mirrors aoai.ts:25
  //   / rca.ts #90). Pin the client id from AZURE_CLIENT_ID; unset (local) → bare so the isolation test runs.
  const clientId = process.env.AZURE_CLIENT_ID;
  const credential = clientId
    ? new DefaultAzureCredential({ managedIdentityClientId: clientId })
    : new DefaultAzureCredential();
  return { account, container, credential };
}

async function upload(token: string | undefined, blobName: string, body: Buffer, contentType: string): Promise<boolean> {
  const t = resolveTarget(token);
  if (!t) return false;
  try {
    const url = `https://${t.account}.blob.core.windows.net/${t.container}/${blobName}`;
    const client = new BlockBlobClient(url, t.credential);
    await client.upload(body, body.byteLength, { blobHTTPHeaders: { blobContentType: contentType } });
    return true;
  } catch (e) {
    process.stderr.write(`sandboxUpload: upload of ${blobName} failed — ${e instanceof Error ? e.message : String(e)}\n`);
    return false;
  }
}

/** The result JSON → `{token}.json` (RAW token — mirrors the api's un-encoded read). */
export function uploadSandboxResult(token: string | undefined, resultJson: string): Promise<boolean> {
  return upload(token, `${token}.json`, Buffer.from(resultJson, 'utf8'), 'application/json');
}

/**
 * ★ THE PAYLOAD CHANNEL READ (sandboxPayload.ts owns the contract; this is its Azure half).
 * Download `{token}.payload` and DELETE it, returning the ciphertext (or null when absent).
 *
 * ★ DELETE-ON-READ IS AWAITED BEFORE RETURNING, and a FAILED delete FAILS THE READ (returns null → the run
 * has no spec → it exits rather than executing). That is deliberate and is the opposite of this module's
 * best-effort upload policy: an upload that fails costs a poll timeout, but ciphertext left resident in the
 * SHARED container while uploaded code runs is exactly the concurrent-neighbour exposure the split-secret
 * design exists to close. Better to lose the preview than to run a hostile spec beside a live ciphertext.
 * (The neighbour still could not DECRYPT it — its key is in the other execution's ARM env and the sandbox MI
 * has no ARM read grant — but we do not spend that margin just to salvage a run.)
 *
 * Unlike the uploads below, a missing account/container/token here returns null rather than being shrugged
 * off: with no payload there is nothing to execute.
 */
export async function fetchAndDeleteSandboxPayload(token: string | undefined): Promise<string | null> {
  const t = resolveTarget(token);
  if (!t) return null;
  const url = `https://${t.account}.blob.core.windows.net/${t.container}/${token}.payload`;
  const client = new BlockBlobClient(url, t.credential);
  let ciphertext: string;
  try {
    ciphertext = (await client.downloadToBuffer()).toString('utf8');
  } catch (e) {
    // 404 (never uploaded — e.g. the legacy env path) is indistinguishable here from a transient failure;
    // both mean "no payload from this channel", and the caller falls back or exits. NEVER logs the body.
    process.stderr.write(`sandboxUpload: no payload blob for this run — ${e instanceof Error ? e.message : String(e)}\n`);
    return null;
  }
  try {
    await client.delete();
  } catch (e) {
    // ★ FAIL THE READ. See above — we do not execute uploaded code beside a ciphertext we could not remove.
    process.stderr.write(
      `sandboxUpload: payload delete-on-read FAILED — refusing to execute — ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return null;
  }
  return ciphertext;
}

/** A binary artifact (trace.zip / screenshot.png) → `{token}/{name}`. The caller size-caps before calling. */
export function uploadSandboxArtifact(
  token: string | undefined,
  name: string,
  bytes: Buffer,
  contentType: string,
): Promise<boolean> {
  return upload(token, `${token}/${name}`, bytes, contentType);
}
