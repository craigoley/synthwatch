// sandboxUpload — the sandbox job's ONLY egress. It writes the preview result JSON to the sandbox blob
// container under the sandbox MANAGED IDENTITY (Blob Data Contributor on THIS container only — infra/main.bicep),
// so the api's GET /preview/{token} can read it. NO connection string / account key: the sandbox holds no
// secret, and DefaultAzureCredential resolves the MI from IMDS. The blob name MUST mirror the api's read path
// (PreviewFunctions.TryReadSandboxTraceAsync → `{container}/{token}.json`); the token is 32-char lowercase hex.
//
// Best-effort by design: a missing account/container/token or an upload failure is logged to stderr and
// swallowed — the result also goes to stdout, and a failed upload must never crash the run (the api poll then
// times out cleanly via its stale-row sweep rather than the sandbox exiting non-zero for a non-spec reason).
import { DefaultAzureCredential } from '@azure/identity';
import { BlockBlobClient } from '@azure/storage-blob';

export async function uploadSandboxResult(token: string | undefined, resultJson: string): Promise<boolean> {
  const account = process.env.SANDBOX_STORAGE_ACCOUNT;
  const container = process.env.SANDBOX_CONTAINER;
  if (!account || !container || !token) {
    process.stderr.write(
      'sandboxUpload: SANDBOX_STORAGE_ACCOUNT / SANDBOX_CONTAINER / SW_SANDBOX_RESULT_TOKEN missing — skipping upload\n',
    );
    return false;
  }
  try {
    // ★ The sandbox MI is USER-ASSIGNED-only — a BARE DefaultAzureCredential can't resolve it (mirrors
    //   aoai.ts:25 / rca.ts #90). Pin the client id from AZURE_CLIENT_ID (set on the sandbox job env); unset
    //   (local) → bare credential so the isolation test still runs off-Azure.
    const clientId = process.env.AZURE_CLIENT_ID;
    const credential = clientId
      ? new DefaultAzureCredential({ managedIdentityClientId: clientId })
      : new DefaultAzureCredential();
    // RAW token (no encoding) — mirrors the api's un-encoded `{token}.json` read. Token is [0-9a-f]{32}.
    const url = `https://${account}.blob.core.windows.net/${container}/${token}.json`;
    const client = new BlockBlobClient(url, credential);
    const body = Buffer.from(resultJson, 'utf8');
    await client.upload(body, body.byteLength, { blobHTTPHeaders: { blobContentType: 'application/json' } });
    return true;
  } catch (e) {
    process.stderr.write(`sandboxUpload: upload failed — ${e instanceof Error ? e.message : String(e)}\n`);
    return false;
  }
}
