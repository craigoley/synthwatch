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
