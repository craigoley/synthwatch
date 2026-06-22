// Failure artifacts: upload a screenshot and a Playwright trace to Azure Blob.
//
// 100% env-config driven. If AZURE_STORAGE_CONNECTION_STRING is unset the upload
// silently no-ops and returns null — artifacts are an optional enhancement, not
// a requirement for the runner to function. Nothing tenant-specific in source.
// Both screenshots and traces share the same account/container (the connection
// string already authenticates); traces go under a `traces/` key prefix so a
// retention/lifecycle policy can target them.
import { BlobServiceClient } from '@azure/storage-blob';

const CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER = process.env.AZURE_STORAGE_CONTAINER ?? 'synthwatch-artifacts';

/**
 * Upload a PNG screenshot for a failed run. Returns the blob URL, or null if
 * storage is not configured (or the upload fails — never throws into the run).
 */
export async function uploadScreenshot(runId: number, data: Buffer): Promise<string | null> {
  if (!CONNECTION_STRING) return null; // channel disabled

  try {
    const service = BlobServiceClient.fromConnectionString(CONNECTION_STRING);
    const container = service.getContainerClient(CONTAINER);
    await container.createIfNotExists();

    const blobName = `run-${runId}-${Date.now()}.png`;
    const blob = container.getBlockBlobClient(blobName);
    await blob.uploadData(data, {
      blobHTTPHeaders: { blobContentType: 'image/png' },
    });
    return blob.url;
  } catch (err) {
    // Artifact upload must never fail a run; log and move on.
    console.error(`[artifacts] screenshot upload failed for run ${runId}:`, err);
    return null;
  }
}

/**
 * Upload a failed browser run's Playwright trace.zip (from a temp file path).
 * Streams the file (traces are 1-50MB). Returns the blob URL, or null if storage
 * is unconfigured or the upload fails — never throws into the run.
 */
export async function uploadTrace(runId: number, filePath: string): Promise<string | null> {
  if (!CONNECTION_STRING) return null; // storage disabled

  try {
    const service = BlobServiceClient.fromConnectionString(CONNECTION_STRING);
    const container = service.getContainerClient(CONTAINER);
    await container.createIfNotExists();

    const blobName = `traces/run-${runId}-${Date.now()}.zip`;
    const blob = container.getBlockBlobClient(blobName);
    await blob.uploadFile(filePath, {
      blobHTTPHeaders: { blobContentType: 'application/zip' },
    });
    return blob.url;
  } catch (err) {
    console.error(`[artifacts] trace upload failed for run ${runId}:`, err);
    return null;
  }
}

/**
 * Download a blob (by its full URL) as base64 — for feeding a failure screenshot to
 * the RCA vision model. Returns null if storage is unconfigured, the URL isn't in
 * our container, the blob is missing, or it's too large to inline. Never throws.
 */
export async function downloadBlobBase64(blobUrl: string | null): Promise<string | null> {
  if (!CONNECTION_STRING || !blobUrl) return null;
  try {
    // ".../<CONTAINER>/<blobName>" -> blobName (handles the traces/ prefix too).
    const marker = `/${CONTAINER}/`;
    const path = new URL(blobUrl).pathname;
    const idx = path.indexOf(marker);
    if (idx < 0) return null;
    const blobName = decodeURIComponent(path.slice(idx + marker.length));
    if (!blobName) return null;

    const service = BlobServiceClient.fromConnectionString(CONNECTION_STRING);
    const blob = service.getContainerClient(CONTAINER).getBlockBlobClient(blobName);
    const buf = await blob.downloadToBuffer();
    // Cap inline image size (a PNG screenshot is ~50-300KB; guard against anything huge).
    if (buf.byteLength > 5_000_000) return null;
    return buf.toString('base64');
  } catch (err) {
    console.warn('[artifacts] blob download failed (non-fatal):', err instanceof Error ? err.message : err);
    return null;
  }
}
