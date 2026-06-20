// Failure artifacts: upload a screenshot to Azure Blob Storage.
//
// 100% env-config driven. If AZURE_STORAGE_CONNECTION_STRING is unset the upload
// silently no-ops and returns null — artifacts are an optional enhancement, not
// a requirement for the runner to function. Nothing tenant-specific in source.
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
