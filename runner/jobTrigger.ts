// Fire a fresh execution of THIS runner job via ARM `jobs/start` (confirmation-retry, 0077 / D1).
//
// A failed scheduled browser/multistep run enqueues a confirmation run_request and then calls this to start a
// DEDICATED off-cadence execution — a fresh pod with the full 660s replicaTimeout to itself (a tick runs its
// checks SEQUENTIALLY, so leaving the confirmation to the next */5 tick would share that budget; a dedicated
// execution finds ≈0 due checks off-cadence, so the confirmation gets ~the whole budget).
//
// BEST-EFFORT: the durable enqueue is the run_requests INSERT (the next cron tick drains it regardless). This
// call is the IMMEDIACY optimization — if the runner MI lacks the self-start role (pre-infra-deploy) or ARM is
// transiently unavailable, we log and fall back to next-tick drain. Never throws into the caller past its catch.
//
// Mirrors the API's ArmRunnerJobTrigger: DefaultAzureCredential → management.azure.com token → POST an empty
// JSON body ("{}"; ARM's Microsoft.App/jobs/start REQUIRES application/json — a text/plain/empty body 415s) with
// no template override, so the started execution keeps the job's configured image + secretRefs. api-version
// pinned to the same 2024-03-01 the job resource uses.
import { DefaultAzureCredential } from '@azure/identity';

const ARM_ENDPOINT = 'https://management.azure.com';
const ARM_SCOPE = 'https://management.azure.com/.default';
const ARM_API_VERSION = '2024-03-01';
const ARM_TIMEOUT_MS = 15_000;

// One credential for the process (token acquisition is cached + refreshed inside the SDK).
let credential: DefaultAzureCredential | null = null;

/**
 * Start a fresh execution of the runner job this process is running as (CONTAINER_APP_JOB_NAME — the
 * ACA-platform-injected job metadata). Resolves on success; REJECTS on any failure so the caller's `.catch`
 * downgrades to next-tick drain. Skips cleanly (no throw) when the ARM coordinates aren't configured (local/dev).
 */
export async function fireRunnerJobStart(): Promise<void> {
  const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID;
  const resourceGroup = process.env.AZURE_RESOURCE_GROUP;
  const jobName = process.env.CONTAINER_APP_JOB_NAME; // ACA-injected: the job we ARE (self-start).
  if (!subscriptionId || !resourceGroup || !jobName) {
    console.warn(
      '[confirm] jobs/start skipped — AZURE_SUBSCRIPTION_ID / AZURE_RESOURCE_GROUP / CONTAINER_APP_JOB_NAME not all set',
    );
    return;
  }

  credential ??= new DefaultAzureCredential();
  const token = await credential.getToken(ARM_SCOPE);
  if (!token?.token) throw new Error('could not acquire an ARM management token');

  const url =
    `${ARM_ENDPOINT}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
    `/providers/Microsoft.App/jobs/${jobName}/start?api-version=${ARM_API_VERSION}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ARM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token.token}`,
        'content-type': 'application/json',
      },
      body: '{}',
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`jobs/start ${res.status} ${detail}`.trim());
    }
    console.log(`[confirm] fired jobs/start on ${jobName} — dedicated fresh execution for the confirmation run`);
  } finally {
    clearTimeout(timer);
  }
}
