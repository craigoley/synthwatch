// SynthWatch — RUNNER (data-plane) Azure footprint.
//
// Scope: the runner ONLY. The dashboard is a separate Next.js app on Vercel and
// is NOT provisioned here. Deploys INTO the existing resource group
// `synthwatch-rg` (eastus) and references the existing registry
// `synthwatcholey0620.azurecr.io`. This template creates neither the RG nor the
// ACR.
//
//   az deployment group create \
//     --resource-group synthwatch-rg \
//     --template-file infra/main.bicep \
//     --parameters postgresAdminPassword='<strong-password>' \
//                  acsEmailConnectionString='<acs-email-connection-string>'
//
// BOTH @secure params are REQUIRED (no defaults). They are template-owned (Postgres auth +
// the ACS_EMAIL_CONNECTION_STRING secretRef on both runner jobs), so passing them every
// deploy keeps them intact — and a deploy can no longer WIPE ACS (the recurring defect).
//
// Registry auth uses a user-assigned managed identity granted AcrPull on the
// existing ACR — no registry username/password is stored anywhere.

targetScope = 'resourceGroup'

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------
//
// IMPORTANT — these defaults MUST match the LIVE deployed stack, or a redeploy is
// not additive: it would provision a DUPLICATE parallel stack (new Postgres,
// storage, Log Analytics, managed environment) and re-home the runner job into a
// new environment. The live stack uses an `-e2` naming convention and lives in
// `eastus2` (the resource group itself is in `eastus`, so the region is pinned
// here explicitly rather than read from resourceGroup().location). Recover the
// live values with:
//   az deployment group show -g synthwatch-rg -n main --query properties.parameters
// Keep these in sync with that deployment. (Image params are CD-managed bootstrap
// tags — see runnerImage/migrateImage below.)

@description('Azure region. Pinned to eastus2 to match the live stack (the resource group is in eastus).')
param location string = 'eastus2'

@description('Existing Azure Container Registry name (without the .azurecr.io suffix).')
param acrName string = 'synthwatcholey0620'

// runnerImage/migrateImage are BOOTSTRAP tags. CD (deploy.yml) rolls the live
// jobs to :<git-sha> via `az containerapp job update`, so the running image will
// differ from these defaults. When re-running this template against a CD-managed
// deployment, pass runnerImage=<current live image> (query it first) to avoid
// reverting the runner — see README "Deploy".
@description('Runner image (BOOTSTRAP tag; CD rolls the live job to :<sha>).')
param runnerImage string = 'synthwatcholey0620.azurecr.io/synthwatch-runner:0.1.0'

@description('Migration image (BOOTSTRAP tag; CD rolls the live job to :<sha>).')
param migrateImage string = 'synthwatcholey0620.azurecr.io/synthwatch-migrate:0.1.0'

@description('PostgreSQL administrator login.')
param postgresAdminLogin string = 'synthadmin'

@description('PostgreSQL administrator password.')
@secure()
param postgresAdminPassword string

// ACS email transport secret. SECRET (contains an accesskey) -> handled exactly like
// postgresAdminPassword: a @secure param -> a job secret -> a secretRef env on both runner
// jobs (NOT a plain value). Declared here so a deploy can no longer WIPE it: it was set
// out-of-band (az containerapp job update --set-env-vars), so every `az deployment group
// create` reset the jobs to the declared env and dropped it (the recurring alerting-wipe;
// same class as #78 Postgres-auth / #80 AOAI-env). REQUIRED at deploy (no default) — pass
// it alongside postgresAdminPassword or email alerting goes dark. ALERT_EMAIL_FROM is a
// non-secret config param (alertEmailFrom) and is already owned — only the conn string
// needed adding.
@description('Azure Communication Services email connection string (ACS_EMAIL_CONNECTION_STRING). Secret — supply at deploy, like postgresAdminPassword.')
@secure()
param acsEmailConnectionString string

@description('Vercel Deployment Protection bypass token (VERCEL_BYPASS_TOKEN) — the fleet-wide token the runner injects to the protected Wegmans/Vercel hosts. Secret — supply out-of-band at deploy, like acsEmailConnectionString (deploy.sh requires it, so a redeploy never WIPES the secret). NEVER commit a value.')
@secure()
param vercelBypassToken string

@description('Model-B credential-value encryption key (env CRED_ENC_KEY) — base64 of 32 random bytes (AES-256). The api ENCRYPTS secret_headers/login_credentials values before store; the runner DECRYPTS them at run time (runner/crypto.ts ↔ synthwatch-api CredCrypto.cs). Secret — supplied at deploy from ~/.synthwatch.env, EXACTLY like vercelBypassToken (deploy.sh passes it inline; a redeploy re-asserts it → never dropped). Default \'\' → the runner fail-CLOSES on decrypt (login monitors go red) until set. ★ Craig MUST set a real key in ~/.synthwatch.env BEFORE deploy. NEVER commit a value.')
@secure()
param credEncKey string = ''

@description('Log Analytics workspace name (live stack uses the -e2 name).')
param logAnalyticsName string = 'synthwatch-logs-e2'

@description('PostgreSQL Flexible Server name (must match the live -e2 server).')
param postgresServerName string = 'synthwatch-pg-e2'

@description('Storage account name for failure artifacts (the live runner storage; NOT the stranded synthwatche2046f4733).')
@minLength(3)
@maxLength(24)
param storageAccountName string = 'synthwatche24e33105c'

@description('Container Apps managed environment name (live stack uses the -e2 name).')
param managedEnvironmentName string = 'synthwatch-env-e2'

@description('Container Apps Job name.')
param jobName string = 'synthwatch-runner-job'

// --- Second region: centralus (multi-location activation) -------------------
// A 2nd runner region. ACA managed environments are REGIONAL, so centralus needs
// its own env + job. Same image/identity/DB-secret as the primary; the only
// difference is region + SYNTHWATCH_LOCATION=centralus. The DB is reached via its
// FQDN + the AllowAllAzureServices firewall rule (region-agnostic, admin creds in
// the same secret — NOT MI-to-Postgres), and the SAME user-assigned identity pulls
// from the SAME ACR cross-region — so NO new MI and NO new Postgres grant.
@description('Second runner region.')
param centralusLocation string = 'centralus'

@description('Container Apps managed environment for the centralus runner.')
param centralusEnvName string = 'synthwatch-env-centralus'

@description('centralus Container Apps Job name.')
param centralusJobName string = 'synthwatch-runner-job-centralus'

// --- Third region: westus2 (2-of-3 quorum) ----------------------------------
// A 3rd, geographically DISTINCT vantage (east → central → west) so the incident
// quorum becomes 2-of-3: a single regional blip (1 of 3) is suppressed, ≥2 still
// pages (see evaluate.ts effectiveN — the value is killing east-vs-central ambiguity).
// Same image/identity/DB-secret/ACR as the others — NO new MI, NO new Postgres grant,
// NO new ACR grant (the shared user-assigned identity pulls cross-region). Only the
// region + SYNTHWATCH_LOCATION=westus2 differ. The runner's perf budgets are
// latency-tolerant for westus2 (physics headroom) so normal west-coast RTT isn't a
// false breach (evaluate.ts LOCATION_LATENCY_TOLERANCE).
@description('Third runner region (2-of-3 quorum; geographically distinct from eastus2/centralus).')
param westus2Location string = 'westus2'

@description('Container Apps managed environment for the westus2 runner.')
param westus2EnvName string = 'synthwatch-env-westus2'

@description('westus2 Container Apps Job name.')
param westus2JobName string = 'synthwatch-runner-job-westus2'

@description('One-off Container Apps Job that applies DB migrations (started by CD).')
param migrateJobName string = 'synthwatch-migrate-job'

@description('Daily Container Apps Job that computes the reporting rollup (daily_check_rollup).')
param rollupJobName string = 'synthwatch-rollup-job'

@description('Daily Container Apps Job that generates the Layer-3 AI report narratives (report_narratives).')
param narrativeJobName string = 'synthwatch-narrative-job'

@description('Daily Container Apps Job that reconciles the monitors-as-code manifest into checks (detect-only; writes reconcile_drift).')
param reconcileJobName string = 'synthwatch-reconcile-job'

@description('Daily Container Apps Job that prunes runs older than artifactRetentionDays (rows expire on the same 90d clock as the blob lifecycle; cascades run_steps/run_metrics).')
param retentionJobName string = 'synthwatch-retention-job'

@description('User-assigned managed identity name (used for ACR pull).')
param identityName string = 'synthwatch-runner-id'

// The Postgres Entra admin's objectId (a child resource NAME must be known at the
// start of deployment, so it can't be derived from identity.properties.principalId at
// runtime — hence a param). Default = the synthwatch-runner-id MI's principalId; the
// API authenticates to Postgres as this principal. tenantId is derived (subscription).
@description('objectId (principalId) of the synthwatch-runner-id MI — the Postgres Entra admin.')
param aadAdminObjectId string = '5ca727ad-06a2-42a9-b31c-4e7b9382ab96'

@description('''Re-assert the Postgres Entra admin child resource on deploy. DEFAULT FALSE: the wipe this
re-assert guarded is now prevented at the SERVER authConfig (activeDirectoryAuth: Enabled + tenantId,
below) — which an incremental deploy never removes — so re-asserting the admin is redundant and its
child-resource PUT RACES the server reconciliation, throwing the benign-but-failure-reporting
AadAuthOperationCannotBePerformedWhenServerIsNotAccessible (the deploy.sh "Failed-but-landed" cry-wolf).
An incremental deploy does NOT delete the existing admin when this is false, so AAD auth is preserved.
Set true only to (re)create the admin if it were ever actually lost.''')
param reassertPostgresEntraAdmin bool = false

@description('principalId of the synthwatch-api Function App MI — granted Container Apps Jobs Operator on the runner job so its on-demand "Run now" / test-send ARM jobs/start succeeds, AND Storage Blob Delegator on the artifacts account so it can mint short-TTL user-delegation SAS URLs for the trace viewer.')
param apiManagedIdentityPrincipalId string = '67f2bd0c-1334-42a7-b521-3005064d7171'

@description('Origins allowed to fetch trace blobs cross-origin (blob-service CORS) — the dashboard the viewer runs on, so its direct SAS fetch of a large trace is not CORS-blocked. Exact origins (scheme+host, no trailing slash), never "*". Defaults to the prod dashboard; add preview origins here as needed.')
param dashboardCorsOrigins array = [
  'https://synthwatch-dashboard.vercel.app'
]

@description('Blob container for failure screenshots. Matches the runner default (AZURE_STORAGE_CONTAINER).')
param artifactContainerName string = 'synthwatch-artifacts'

@description('Retention (days) for failure artifacts — traces/ and root run-*.png screenshots are auto-deleted by the Blob lifecycle policy after this many days. Default 90.')
@minValue(1)
param artifactRetentionDays int = 90

@description('Retention (days) for sandbox PREVIEW artifacts (synthwatch-sandbox/*: result JSON + trace.zip + screenshot). A preview is an ephemeral scratchpad — it only needs to outlive the poll + a short review. Default 1 (Blob lifecycle min granularity).')
@minValue(1)
param sandboxRetentionDays int = 1

// AI root-cause analysis (RCA) — Azure OpenAI config. These are CONFIG, not secrets
// (the runner authenticates to AOAI with the synthwatch-runner-id Managed Identity's
// AAD token via its 'Cognitive Services OpenAI User' role — no API key). Declared
// here so a deploy PRESERVES them: they were added out-of-band, so the multi-location
// cutover's bicep redeploy WIPED them (resetting the env array), turning RCA off
// fleet-wide (rcaEnabled() = AZURE_OPENAI_ENDPOINT && AZURE_OPENAI_DEPLOYMENT). The
// template must own the complete env state (same fix shape as #78's AAD auth).
@description('Azure OpenAI endpoint for RCA (AZURE_OPENAI_ENDPOINT).')
param aoaiEndpoint string = 'https://synthwatch-aoai.openai.azure.com/'

@description('Azure OpenAI deployment name for RCA (AZURE_OPENAI_DEPLOYMENT).')
param aoaiDeployment string = 'gpt-5-mini'

// AZURE_OPENAI_API_VERSION — the Azure OpenAI REST api-version (a date the data-plane API
// recognizes), NOT the model version. The previous value '2025-08-07' was the gpt-5-mini
// MODEL version mistakenly used as the api-version: it 404s ("Resource not found" — the
// route doesn't exist), so EVERY fresh AOAI call (RCA + the Layer-3 narrative) returned
// null and fell back. '2025-04-01-preview' is a current api-version that routes AND
// supports the gpt-5-mini reasoning params the code sends (max_completion_tokens +
// reasoning_effort) — proven end-to-end: a fresh narrative call returned HTTP 200 +
// content (model=gpt-5-mini). Flows to all three jobs (both runner jobs for RCA + the
// narrative job). 2024-10-21 routes but predates the reasoning params; don't use it.
@description('Azure OpenAI REST api-version for AZURE_OPENAI_API_VERSION (a data-plane api-version date, e.g. 2025-04-01-preview — NOT the model version 2025-08-07, which 404s).')
param aoaiApiVersion string = '2025-04-01-preview'

@description('RCA completion-token budget (RCA_MAX_TOKENS).')
param rcaMaxTokens string = '4000'

@description('Verified ACS sender for alert emails (ALERT_EMAIL_FROM). NON-secret — a property of the ACS-owned domain, set once here; the ACS connection string stays out-of-band (secret).')
param alertEmailFrom string = 'donotreply@0ad660ff-ac71-4b63-a5f6-ce885666c796.azurecomm.net'

@description('Recipient mailbox for the notification CANARY probe (CANARY_EMAIL_TO on the runner jobs). A deliverability sink the operator does NOT watch: a healthy canary lands here (recorded, never paged); failures/staleness page the DB-managed critical channels instead. OPTIONAL — empty default => the email canary is off (surfaced as a throttled canary-misconfigured runner_errors row, never a silent gap). Supply a mailbox to activate it. NON-secret (like alertEmailFrom), kept out of git; set via deploy param or ~/.synthwatch.env. See runner/canary.ts.')
param canaryEmailTo string = ''

@description('Recipient address for the EXTERNAL fleet-liveness alerts (the Action Group below). An operator email — NOT a secret, but deliberately NOT committed (the repo keeps recipients out of git; the runner\'s own recipients are DB-managed). Supplied at deploy like postgresAdminPassword: scripts/deploy.sh sources it from ~/.synthwatch.env as ALERT_RECIPIENT_EMAIL. No default → a deploy without it fails fast rather than creating an Action Group that notifies nobody.')
param alertRecipientEmail string

// AcrPull built-in role.
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

// Container Apps Jobs Operator built-in role — grants Microsoft.App/jobs/*/action (incl. .../start).
// The API's managed identity needs this ON THE RUNNER JOB so its on-demand "Run now" / test-send ARM
// `jobs/start` call succeeds (without it the start 403s, StartAsync returns false, and the trigger
// silently never fires an off-schedule execution — the request only runs on the next */5 cron tick).
var jobsOperatorRoleId = 'b9a307c4-5aa3-4b52-ba60-2b17c136cd7b'

// Storage Blob Delegator built-in role — grants Microsoft.Storage/.../generateUserDelegationKey. The API MI
// needs this ON THE ARTIFACTS ACCOUNT to mint the read-only, single-blob, short-TTL user-delegation SAS the
// dashboard trace viewer fetches (the Vercel serverless proxy can't stream a 124 MB trace). Key-LESS SAS —
// AAD-signed, no account key. (It already holds Storage Blob Data Reader, granted in the API's own bicep.)
var storageBlobDelegatorRoleId = 'db58b8e5-c6ad-4a2a-8342-4190687cbf4a'

// Cost Management Reader built-in role — grants Microsoft.CostManagement/query + forecast (read-only). The
// RUNNER MI needs this at the RESOURCE-GROUP scope so the daily rollup job (azureCost.ts) can PULL the actual
// MTD + forecast the cost panel DISPLAYS (synthwatch-rg == the whole subscription's spend, so an RG-scoped
// figure equals the portal number). RG scope — creatable by this RG-scoped deployment, no subscription-scope
// deploy / elevated deployer needed. Absent → the pull 403s, refreshAzureCost writes nothing, and the UI
// falls back to a Cost Management deep link (honestly absent beats falsely precise).
var costManagementReaderRoleId = '72fafb9e-0641-4937-9268-a91bfd8191a3'

// ---------------------------------------------------------------------------
// Observability: Log Analytics workspace backing the ACA environment.
// ---------------------------------------------------------------------------
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL Flexible Server (Burstable B1ms, v16, 32GB) + database + firewall.
// ---------------------------------------------------------------------------
resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: postgresServerName
  location: location
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    storage: {
      storageSizeGB: 32
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    // OWN THE COMPLETE auth state. The API authenticates to Postgres via the
    // synthwatch-runner-id Managed Identity (AAD token), NOT a password — so a deploy
    // must PRESERVE AAD auth. A partial authConfig (e.g. activeDirectoryAuth omitted /
    // 'Disabled', no tenantId) RESETS the server to password-only and WIPES the Entra
    // admins, 500-ing every DB endpoint. Keep BOTH enabled + the tenant pinned.
    authConfig: {
      passwordAuth: 'Enabled'
      activeDirectoryAuth: 'Enabled'
      tenantId: subscription().tenantId
    }
  }
}

// Entra (AAD) admin for the Postgres server — the synthwatch-runner-id MANAGED
// IDENTITY (a ServicePrincipal). objectId/tenantId are DERIVED (the MI's own principalId + the
// subscription tenant), never hardcoded. Craig's personal user admin is intentionally
// NOT in IaC — incremental deploys don't delete unlisted admins, so it's preserved.
// ★ GATED default-OFF (reassertPostgresEntraAdmin): the wipe this re-assert guarded is now
// prevented at the server authConfig above; re-asserting races the server reconciliation and
// reports a benign failure. Omitting the resource (incremental mode) does NOT remove the live
// admin, so AAD auth stays intact. A REAL Entra/auth regression is still caught downstream by
// deploy.sh VERIFY (Postgres `SELECT 1` via the MI token + the API health probe).
resource postgresEntraAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = if (reassertPostgresEntraAdmin) {
  parent: postgres
  name: aadAdminObjectId
  properties: {
    principalType: 'ServicePrincipal'
    principalName: identityName
    tenantId: subscription().tenantId
  }
}

resource postgresDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: 'synthwatch'
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// Allow other Azure services (the ACA Job) to reach the server. The
// 0.0.0.0 sentinel is Azure's "allow Azure-internal traffic" rule.
resource postgresAllowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: postgres
  name: 'AllowAllAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

// ---------------------------------------------------------------------------
// Storage account for failure-artifact blobs (Standard_LRS, no public access).
// ---------------------------------------------------------------------------
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    // Allow the dashboard origin to fetch a trace blob cross-origin via its short-TTL SAS URL (the viewer's
    // direct fetch bypasses the Vercel serverless proxy). GET/HEAD only; the blob stays private (public access
    // off) — CORS is not the auth boundary, the single-blob read SAS is. '*' headers/exposed cover the
    // viewer's Range requests on the zip. maxAge caches the preflight.
    cors: {
      corsRules: [
        {
          allowedOrigins: dashboardCorsOrigins
          allowedMethods: [ 'GET', 'HEAD' ]
          allowedHeaders: [ '*' ]
          exposedHeaders: [ '*' ]
          maxAgeInSeconds: 3600
        }
      ]
    }
  }
}

// ★ The API MI mints the trace-viewer's user-delegation SAS — grant it Storage Blob Delegator on the
// artifacts account (generateUserDelegationKey). Least-privilege: Delegator only permits obtaining a
// delegation key; the SAS it signs is itself read-only + single-blob + ~2 min. Deterministic guid() name →
// a redeploy adopts it idempotently.
resource apiBlobDelegatorAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, apiManagedIdentityPrincipalId, storageBlobDelegatorRoleId)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDelegatorRoleId)
    principalId: apiManagedIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource artifactContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: artifactContainerName
  properties: {
    publicAccess: 'None'
  }
}

// Lifecycle policy: auto-delete failure artifacts older than artifactRetentionDays
// (default 90). Covers BOTH per-run prefixes in the artifact container — traces/ (zip) and
// the root-level run-*.png screenshots — server-side, no cron/code. The DB still
// holds runs.trace_url/screenshot_url after deletion (a dangling reference the
// dashboard should 404 gracefully; tracked as a follow-up).
// ★ DELIBERATELY NOT purged (do NOT add these prefixes): the per-MONITOR stable, OVERWRITE keys
//   `baselines/check-<id>.png` (RCA visual baseline) and `success-latest/check-<id>.zip` (last-known-
//   good trace). Each is a single overwritten slot per monitor (never accumulates), and a monitor that
//   stays green for 90d must NOT lose its only baseline — so they live OUTSIDE this age-based purge.
resource artifactRetention 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          enabled: true
          name: 'expire-artifacts'
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [ 'blockBlob' ]
              prefixMatch: [
                '${artifactContainerName}/traces/'
                '${artifactContainerName}/run-'
              ]
            }
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: artifactRetentionDays
                }
              }
            }
          }
        }
        {
          // ★ B2: GC the sandbox PREVIEW artifacts. A preview is an EPHEMERAL scratchpad — result JSON + trace.zip
          //   + screenshot only need to outlive the poll (+ a short review). Without this the container was
          //   UNGOVERNED (no lifecycle covered it), so B2's trace/screenshot blobs would accumulate forever — the
          //   storage version of the #269 self-DoS, alongside the per-preview size caps in sandboxMain.ts.
          //   ONE policy named 'default' per account → this is a second RULE, not a second policy.
          enabled: true
          name: 'expire-sandbox-previews'
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [ 'blockBlob' ]
              prefixMatch: [
                '${sandboxContainerName}/'
              ]
            }
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: sandboxRetentionDays
                }
              }
            }
          }
        }
      ]
    }
  }
}

// ---------------------------------------------------------------------------
// User-assigned managed identity + AcrPull on the EXISTING registry.
// ---------------------------------------------------------------------------
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' existing = {
  name: acrName
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, identity.id, acrPullRoleId)
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// ★ Cost Management Reader for the RUNNER MI at the RESOURCE-GROUP scope (no `scope:` → this deployment's RG,
// per targetScope='resourceGroup'). Lets the daily rollup job PULL the actual MTD + forecast (azureCost.ts →
// azure_cost, 0090) the cost panel DISPLAYS. RG scope is deliberate: synthwatch-rg == the whole subscription's
// spend, so the figure equals the portal number, and this stays within the RG-scoped deploy's own authority
// (no subscription-scope role assignment / elevated deployer). Idempotent (deterministic guid name).
resource runnerCostReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, identity.id, costManagementReaderRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', costManagementReaderRoleId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// ★ (a) on-demand trigger fix: let the API's managed identity START the runner job (its `jobs/start`
// ARM call for "Run now" + test-sends). Scoped to JUST the primary runner job (least-privilege — that's
// the job the API's StartUrl targets). Without this the start 403s and the trigger silently never fires
// an off-schedule execution, so on-demand runs only happen on the next */5 cron tick. (`job` is declared
// below; bicep resolves the forward reference.)
resource apiRunnerJobStart 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(job.id, apiManagedIdentityPrincipalId, jobsOperatorRoleId)
  scope: job
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', jobsOperatorRoleId)
    principalId: apiManagedIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Reconcile-now prerequisite: let the API MI START the reconcile job too (the upcoming "Reconcile now"
// button's `jobs/start` call). Same role + principal as the runner grant above, scoped to JUST the
// reconcile job (least-privilege). Deterministic guid() name (same pattern) → a redeploy adopts it
// idempotently. (`reconcileJob` is declared below; bicep resolves the forward reference.)
resource apiReconcileJobStart 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(reconcileJob.id, apiManagedIdentityPrincipalId, jobsOperatorRoleId)
  scope: reconcileJob
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', jobsOperatorRoleId)
    principalId: apiManagedIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
// SANDBOX PREVIEW — the RCE-bounded, LOW-PRIVILEGE box for preview-running an UPLOADED, UNMERGED spec. A spec is
// arbitrary Node at runner privilege (runner/specfetch/compileSpec.ts's RCE boundary) WITHOUT the monitors-repo
// merge gate, so it runs under a SEPARATE identity that has NOTHING to steal and nowhere to write:
//   • its own MI (NOT synthwatch-runner-id — no Postgres Entra admin, no DB secret, no cost reader);
//   • a SECRET-FREE job env (no CRED_ENC_KEY, no prod database-url, no ACS) — the two prove-can-fails
//     (runner/sandbox/sandboxIsolation.test.ts) verify a hostile spec sees no secret and can't reach the DB;
//   • AcrPull only, and Blob write to a DEDICATED sandbox container ONLY — never prod traces, never the DB.
// The only path to a REAL monitor stays the repo PR. Pass-1 unauth-only (no test-cred store — a later gated tier).
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
@description('User-assigned MI for the sandbox preview job — DELIBERATELY separate from synthwatch-runner-id, minimal RBAC.')
param sandboxIdentityName string = 'synthwatch-sandbox-id'

@description('Sandbox artifacts blob container — the sandbox identity\'s ONLY storage grant, separate from synthwatch-artifacts so a hostile preview can never touch prod traces.')
param sandboxContainerName string = 'synthwatch-sandbox'

@description('Sandbox job hard wall-clock timeout (s) — the DoS-on-your-own-bill guard; mirrors runSandboxPreview\'s SANDBOX_DEFAULT_TIMEOUT_MS.')
param sandboxReplicaTimeout int = 180

// Storage Blob Data Contributor (built-in) — granted on the sandbox container ONLY, to two DISTINCT
// principals: the sandbox MI (writes its result/trace/screenshot, deletes the payload it read) and the API MI
// (writes the {token}.payload ciphertext, sweeps orphans). Both container-scoped; neither is account-scoped.
// ★ The API MI's assignment REPLACED a Storage Blob Data Reader one — see apiSandboxBlobWriter below. That
// removes this file's last use of storageBlobDataReaderRoleId, so the var is gone with it.
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource sandboxIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: sandboxIdentityName
  location: location
}

// AcrPull ONLY — pull the shared runner image. No other registry rights.
resource sandboxAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, sandboxIdentity.id, acrPullRoleId)
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: sandboxIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// A dedicated container for the sandbox's throwaway trace output — the sandbox MI's ONLY data-plane grant.
resource sandboxContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: sandboxContainerName
  properties: {
    publicAccess: 'None'
  }
}

// ★ Blob write SCOPED TO THE SANDBOX CONTAINER ONLY (not the account, not synthwatch-artifacts) — so even a
//   fully-hostile preview can only touch its own throwaway container, never the prod traces and never the DB.
resource sandboxBlobWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(sandboxContainer.id, sandboxIdentity.id, storageBlobDataContributorRoleId)
  scope: sandboxContainer
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
    principalId: sandboxIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// ★ Blob READ + WRITE + DELETE for the API MI, SCOPED TO THE SANDBOX CONTAINER ONLY.
//   Was READER. Promoted to CONTRIBUTOR because the API now owns the {token}.payload channel:
//     • WRITE — POST /api/preview seals {spec, credentials} under a per-run AES key and uploads the ciphertext
//       here. The spec and any user-typed credential can NO LONGER ride the ARM jobs/start env override: ACA
//       persists that override VERBATIM on the execution resource (observed via `az containerapp job execution
//       list`), readable by any Reader on this RG, and execution history is unbounded-by-contract for a
//       triggerType:'Manual' job. Only the per-run key rides the env now — worthless without this blob.
//       ★ NOTE the read/write asymmetry this creates with the SANDBOX MI, which holds Contributor on the same
//       container: a hostile spec can delete or overwrite a CONCURRENT preview's payload. Confidentiality
//       still holds (it cannot obtain the neighbour's key — that lives in the other execution's ARM env, and
//       the sandbox MI has no ARM read grant), but the neighbour fails closed. A DoS, not a disclosure.
//     • DELETE — the API sweeps an ORPHANED payload. The sandbox normally deletes on read; a preview that
//       died between upload and read would otherwise leave ciphertext to the blob lifecycle rule, whose floor
//       is ~1 DAY (daysAfterCreationGreaterThan is typed Integer — no fractional days — and a policy edit
//       takes up to 24h to take effect) while its key sits in execution history permanently. The sweep runs on
//       BOTH the poll and the create path — the create path is the one that matters, because the likeliest
//       orphan is an abandoned tab, and nobody polls an abandoned tab. So the bound is "the next preview by
//       any user", not a fixed interval, and NOT the 5 minutes an earlier draft of this comment claimed.
//     • READ — unchanged: GET /api/preview/{token} still polls the sandbox job's trace result here.
//   Container-scoped, NEVER account-scoped: the API MI must not gain write over the prod artifacts container.
//   ★ This is the API MI, a DIFFERENT principal from the sandbox MI — so verify_sandbox_least_privilege's
//   exact-two set (AcrPull + this container, for the SANDBOX identity) is untouched by this change.
resource apiSandboxBlobWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(sandboxContainer.id, apiManagedIdentityPrincipalId, storageBlobDataContributorRoleId)
  scope: sandboxContainer
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
    principalId: apiManagedIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// The sandbox job — Manual trigger (api-started per preview), the sandbox identity, a SECRET-FREE env.
resource sandboxJob 'Microsoft.App/jobs@2024-03-01' = {
  name: 'synthwatch-sandbox'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${sandboxIdentity.id}': {}
    }
  }
  properties: {
    environmentId: managedEnvironment.id
    configuration: {
      triggerType: 'Manual' // ★ event-triggered by the api per preview — never a cron.
      replicaTimeout: sandboxReplicaTimeout // ★ hard kill — bounds runaway/hostile code.
      replicaRetryLimit: 0 // a preview never retries.
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: acr.properties.loginServer
          identity: sandboxIdentity.id
        }
      ]
      // ★ NO `secrets:` block — deliberately absent. A secretRef here would defeat the isolation boundary.
    }
    template: {
      containers: [
        {
          name: 'sandbox'
          image: runnerImage
          command: [ 'node' ]
          args: [ 'dist/sandbox/sandboxMain.js' ]
          resources: {
            cpu: json('1.0')
            memory: '2.0Gi'
          }
          // ★ ALLOWLIST env — only non-secret vars. The spec + target are injected per-run by the api on
          //   jobs/start (SW_SANDBOX_SPEC_B64 / SW_SANDBOX_TARGET_URL); NOTHING sensitive is baked in.
          //   SANDBOX_STORAGE_ACCOUNT + AZURE_CLIENT_ID let sandboxMain (the TRUSTED parent) upload the result
          //   blob under the sandbox MI — both non-secret (an account name + the MI's own client-id GUID), and
          //   the executed spec never sees them (the child-process buildSandboxEnv allowlist excludes them).
          env: [
            {
              name: 'SW_SANDBOX'
              value: '1'
            }
            {
              name: 'SANDBOX_CONTAINER'
              value: sandboxContainerName
            }
            {
              name: 'SANDBOX_STORAGE_ACCOUNT'
              value: storageAccountName
            }
            {
              name: 'AZURE_CLIENT_ID'
              value: sandboxIdentity.properties.clientId
            }
          ]
        }
      ]
    }
  }
}

// Let the API MI START the sandbox job (jobs/start), scoped to JUST this job — same least-privilege pattern as
// apiRunnerJobStart / apiReconcileJobStart. The api gates the trigger (AuthGate editor/admin + rate/concurrency).
resource apiSandboxJobStart 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(sandboxJob.id, apiManagedIdentityPrincipalId, jobsOperatorRoleId)
  scope: sandboxJob
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', jobsOperatorRoleId)
    principalId: apiManagedIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// ★ CONFIRMATION-RETRY (0077 / D1): let the RUNNER's own managed identity START the runner job it is running as
// (its `jobs/start` ARM call for a failed browser/multistep check's confirmation run — a dedicated fresh
// execution with the full 660s to itself). One assignment per regional runner job, each scoped to JUST that job
// (least-privilege): a runner in region R fires jobs/start on its OWN job (CONTAINER_APP_JOB_NAME), so each job
// needs its shared UAMI granted start on itself. Same role (Container Apps Jobs Operator) as the API grants
// above. Best-effort at the app layer (a missing grant → next-tick drain), but declared so verify() asserts it.
resource runnerSelfStart 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(job.id, identity.id, jobsOperatorRoleId)
  scope: job
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', jobsOperatorRoleId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
resource runnerSelfStartCentralus 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(centralusJob.id, identity.id, jobsOperatorRoleId)
  scope: centralusJob
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', jobsOperatorRoleId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
resource runnerSelfStartWestus2 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(westus2Job.id, identity.id, jobsOperatorRoleId)
  scope: westus2Job
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', jobsOperatorRoleId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// ---------------------------------------------------------------------------
// Container Apps managed environment, wired to Log Analytics.
// ---------------------------------------------------------------------------
resource managedEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: managedEnvironmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Container Apps JOB — the runner, fired on a schedule.
// ---------------------------------------------------------------------------
resource job 'Microsoft.App/jobs@2024-03-01' = {
  name: jobName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: managedEnvironment.id
    configuration: {
      triggerType: 'Schedule'
      // 660s = the runner's MAX_FLOW_MS (600s, the long authenticated browser flows) + ~60s headroom
      // for browser teardown / trace upload (the original 180/240 ratio). Must stay ≥ MAX_FLOW_MS or a
      // long flow is stranded at the ACA kill. Fleet-wide CEILING: applies to every check this job runs,
      // but per-kind budgets still bound normal checks (multistep 180s, http/net/ssl seconds).
      replicaTimeout: 660
      replicaRetryLimit: 0
      scheduleTriggerConfig: {
        cronExpression: '*/5 * * * *'
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: acr.properties.loginServer
          identity: identity.id
        }
      ]
      secrets: [
        {
          // DATABASE_URL: PG FQDN + admin creds + TLS required.
          name: 'database-url'
          value: 'postgresql://${postgresAdminLogin}:${postgresAdminPassword}@${postgres.properties.fullyQualifiedDomainName}:5432/synthwatch?sslmode=require'
        }
        {
          // Storage connection string from the account's primary key.
          name: 'storage-conn'
          value: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'
        }
        {
          // ACS email transport secret (contains an accesskey). Bicep-owned so a deploy
          // can't wipe it — surfaced as the ACS_EMAIL_CONNECTION_STRING secretRef below.
          name: 'acs-email-conn'
          value: acsEmailConnectionString
        }
        {
          // Vercel Deployment Protection bypass token — fleet-wide secret, surfaced as the VERCEL_BYPASS_TOKEN
          // secretRef below. Bicep-owned so a redeploy preserves it; '' when unset → fail-soft (the runner
          // injects it ONLY to PROTECTED_BYPASS_HOSTS). Craig supplies the real value out-of-band; NEVER committed.
          name: 'vercel-bypass-token'
          value: vercelBypassToken
        }
        {
          // Model-B credential encryption key (CRED_ENC_KEY). Bicep-owned (value from the @secure param →
          // re-asserted every deploy from ~/.synthwatch.env). '' when unset → the runner fail-CLOSES on
          // decrypt. Craig supplies a real base64(32-byte) key in ~/.synthwatch.env; NEVER committed.
          name: 'cred-enc-key'
          value: credEncKey
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'runner'
          image: runnerImage
          // 2.0 CPU / 4Gi (was 1.0 / 2Gi), on all 3 runner jobs. A long browser flow (shop-flow ~530s)
          // OOM-killed the runner (exit 137) during POST-FLOW trace finalization — the in-memory
          // redacted-zip rebuild of a large trace exceeded 2Gi. 4Gi gives headroom; the streaming
          // redacted-trace build (traceRedact.ts) reduces peak memory durably. ACA Consumption requires
          // memory = 2×CPU, so 4Gi ⇒ 2.0 CPU (the plan max).
          resources: {
            cpu: json('2.0')
            memory: '4Gi'
          }
          env: [
            {
              name: 'DATABASE_URL'
              secretRef: 'database-url'
            }
            {
              name: 'AZURE_STORAGE_CONNECTION_STRING'
              secretRef: 'storage-conn'
            }
            {
              // NOTE: the runner reads AZURE_STORAGE_CONTAINER (see
              // runner/artifacts.ts), not ARTIFACT_CONTAINER.
              name: 'AZURE_STORAGE_CONTAINER'
              value: artifactContainerName
            }
            {
              // This region's vantage label, stamped onto every run + used for
              // per-location claiming. The original region is physically eastus2;
              // applying this template retires the legacy unset (='default') label.
              // ★ Must land WITH db/ops/relabel_default_to_eastus2.sql at cutover.
              name: 'SYNTHWATCH_LOCATION'
              value: location
            }
            {
              // ★ ARM coordinates for confirmation-retry's SELF jobs/start (0077 / jobTrigger.ts). subscription
              // + RG are identical for every runner job; the job to start is CONTAINER_APP_JOB_NAME (ACA-injected).
              name: 'AZURE_SUBSCRIPTION_ID'
              value: subscription().subscriptionId
            }
            {
              name: 'AZURE_RESOURCE_GROUP'
              value: resourceGroup().name
            }
            {
              // ★ Universal deployed-environment marker — present on EVERY job in this template
              // (mains AND aux), absent in any local shell. The A4 prod-guard's aux fan-out
              // (runner/prodGuard.ts step 2) will trust THIS var, so the aux jobs — which carry
              // no SYNTHWATCH_LOCATION — aren't gated on unverifiable ACA platform vars.
              // ★ ORDERING INVARIANT: this marker must be DEPLOYED + VERIFIED on all 8 jobs
              // BEFORE the guard fan-out PR merges, or the aux fleet refuses to start.
              // Named SYNTHWATCH_DEPLOYED (not SYNTHWATCH_ENV): otel.ts:82,107 already reads
              // SYNTHWATCH_ENV as the OTel deployment.environment attr (default 'production') —
              // reusing it would silently relabel telemetry. Template-owned so every
              // `az deployment group create` re-asserts it (the out-of-band-env wipe class).
              name: 'SYNTHWATCH_DEPLOYED'
              value: '1'
            }
            {
              // ★ COST MODEL — the runner (browser) job allocation being PRICED, deploy-stamped so the
              // two-meter ACA cost model (runner/costModel.ts ↔ api CostRate.cs) reads the LIVE shape and
              // re-prices automatically on a resize instead of silently drifting (the 0.00003 blended-rate
              // bug — 0.00003 was the 1.0cpu/2Gi blend, now 2× wrong at 2.0cpu/4Gi). MUST equal this job's
              // container resources.cpu above; verify() asserts stamped-env == live-resources (must-go-red).
              name: 'SYNTHWATCH_RUNNER_CPU'
              value: '2.0'
            }
            {
              name: 'SYNTHWATCH_RUNNER_MEMORY_GIB'
              value: '4'
            }
            {
              // RCA via Azure OpenAI (MI auth — no key). Declared so a redeploy can't
              // wipe RCA off (the cutover-wipe bug). rcaEnabled() needs ENDPOINT+DEPLOYMENT.
              name: 'AZURE_OPENAI_ENDPOINT'
              value: aoaiEndpoint
            }
            {
              name: 'AZURE_OPENAI_DEPLOYMENT'
              value: aoaiDeployment
            }
            {
              name: 'AZURE_OPENAI_API_VERSION'
              value: aoaiApiVersion
            }
            {
              name: 'RCA_MAX_TOKENS'
              value: rcaMaxTokens
            }
            {
              // Pin the user-assigned MI for the runner's in-process DefaultAzureCredential
              // (rca.ts AAD token for Azure OpenAI). The runner has a USER-ASSIGNED-ONLY MI;
              // a bare DefaultAzureCredential can't resolve which identity to use ->
              // "ChainedTokenCredential authentication failed" -> RCA token acquisition fails
              // (the intermittent-RCA root cause, masked by the 24h cache). DERIVED from the
              // MI resource (not a hardcoded GUID, can't drift); declared here so a deploy
              // can't wipe it (same lesson as the ACS/AOAI env).
              name: 'AZURE_CLIENT_ID'
              value: identity.properties.clientId
            }
            {
              // Email sender — non-secret transport property, now template-owned. Recipients (to[])
              // are DB-managed per channel; the ACS connection string stays out-of-band (secret).
              name: 'ALERT_EMAIL_FROM'
              value: alertEmailFrom
            }
            {
              // Notification-canary probe recipient (CANARY_EMAIL_TO). A deliverability sink the operator does
              // NOT watch: a healthy canary lands here (recorded, never paged). Empty => the email canary is
              // off (surfaced as a canary-misconfigured runner_errors row). See runner/canary.ts.
              name: 'CANARY_EMAIL_TO'
              value: canaryEmailTo
            }
            {
              // ACS email transport (secret) — from the bicep-owned secret above, so a
              // redeploy PRESERVES it instead of wiping it (ends the recurring defect).
              name: 'ACS_EMAIL_CONNECTION_STRING'
              secretRef: 'acs-email-conn'
            }
            {
              // Vercel Deployment Protection bypass token — from the bicep-owned secret above (preserved across
              // redeploys). The runner injects it ONLY to PROTECTED_BYPASS_HOSTS; unset/'' → fail-soft (no header).
              name: 'VERCEL_BYPASS_TOKEN'
              secretRef: 'vercel-bypass-token'
            }
            {
              // Model-B credential encryption key → process.env for runner/crypto.ts decrypt-on-read.
              // From the bicep-owned secret above (preserved across redeploys); unset/'' → decrypt fail-closes.
              name: 'CRED_ENC_KEY'
              secretRef: 'cred-enc-key'
            }
            // STILL out-of-band (NOT owned here) — a redeploy will NOT restore them:
            // the webhook channel (ALERT_WEBHOOK_URL[/_AUTH_HEADER]) + DASHBOARD_URL + OTel
            // (OTEL_EXPORTER_OTLP_*). Unset => those channels don't deliver. (ACS_EMAIL_CONNECTION_STRING
            // is now bicep-owned above — declaring the remaining secret ones is a tracked follow-up.)
          ]
        }
      ]
    }
  }
  // Ensure AcrPull is in place before the job attempts its first image pull.
  dependsOn: [
    acrPull
  ]
}

// ---------------------------------------------------------------------------
// Second region (centralus): its own regional managed environment + runner job.
// Logs to the SAME Log Analytics workspace (cross-region shipping is allowed).
// Identical to the primary job except region + SYNTHWATCH_LOCATION=centralus.
// ---------------------------------------------------------------------------
resource centralusEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: centralusEnvName
  location: centralusLocation
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

resource centralusJob 'Microsoft.App/jobs@2024-03-01' = {
  name: centralusJobName
  location: centralusLocation
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: centralusEnvironment.id
    configuration: {
      triggerType: 'Schedule'
      // 660s: see the primary `job` above — MAX_FLOW_MS (600s) + ~60s teardown headroom.
      replicaTimeout: 660
      replicaRetryLimit: 0
      scheduleTriggerConfig: {
        cronExpression: '*/5 * * * *'
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: acr.properties.loginServer
          identity: identity.id
        }
      ]
      secrets: [
        {
          // Same admin creds + Postgres FQDN as the primary — reachable cross-region
          // via the AllowAllAzureServices firewall rule.
          name: 'database-url'
          value: 'postgresql://${postgresAdminLogin}:${postgresAdminPassword}@${postgres.properties.fullyQualifiedDomainName}:5432/synthwatch?sslmode=require'
        }
        {
          name: 'storage-conn'
          value: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'
        }
        {
          // ACS email transport secret (contains an accesskey). Bicep-owned so a deploy
          // can't wipe it — surfaced as the ACS_EMAIL_CONNECTION_STRING secretRef below.
          name: 'acs-email-conn'
          value: acsEmailConnectionString
        }
        {
          // Vercel Deployment Protection bypass token — fleet-wide secret, surfaced as the VERCEL_BYPASS_TOKEN
          // secretRef below. Bicep-owned so a redeploy preserves it; '' when unset → fail-soft (the runner
          // injects it ONLY to PROTECTED_BYPASS_HOSTS). Craig supplies the real value out-of-band; NEVER committed.
          name: 'vercel-bypass-token'
          value: vercelBypassToken
        }
        {
          // Model-B credential encryption key (CRED_ENC_KEY). Bicep-owned (value from the @secure param →
          // re-asserted every deploy from ~/.synthwatch.env). '' when unset → the runner fail-CLOSES on
          // decrypt. Craig supplies a real base64(32-byte) key in ~/.synthwatch.env; NEVER committed.
          name: 'cred-enc-key'
          value: credEncKey
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'runner'
          image: runnerImage
          // 2.0 CPU / 4Gi (was 1.0 / 2Gi), on all 3 runner jobs. A long browser flow (shop-flow ~530s)
          // OOM-killed the runner (exit 137) during POST-FLOW trace finalization — the in-memory
          // redacted-zip rebuild of a large trace exceeded 2Gi. 4Gi gives headroom; the streaming
          // redacted-trace build (traceRedact.ts) reduces peak memory durably. ACA Consumption requires
          // memory = 2×CPU, so 4Gi ⇒ 2.0 CPU (the plan max).
          resources: {
            cpu: json('2.0')
            memory: '4Gi'
          }
          env: [
            {
              name: 'DATABASE_URL'
              secretRef: 'database-url'
            }
            {
              name: 'AZURE_STORAGE_CONNECTION_STRING'
              secretRef: 'storage-conn'
            }
            {
              name: 'AZURE_STORAGE_CONTAINER'
              value: artifactContainerName
            }
            {
              // The vantage label for this region — claims/runs as 'centralus'.
              name: 'SYNTHWATCH_LOCATION'
              value: centralusLocation
            }
            {
              // ★ ARM coordinates for confirmation-retry's SELF jobs/start (0077 / jobTrigger.ts).
              name: 'AZURE_SUBSCRIPTION_ID'
              value: subscription().subscriptionId
            }
            {
              name: 'AZURE_RESOURCE_GROUP'
              value: resourceGroup().name
            }
            {
              // Universal deployed marker — see the primary job's SYNTHWATCH_DEPLOYED comment.
              name: 'SYNTHWATCH_DEPLOYED'
              value: '1'
            }
            {
              // ★ COST MODEL — the runner (browser) job allocation being PRICED, deploy-stamped so the
              // two-meter ACA cost model (runner/costModel.ts ↔ api CostRate.cs) reads the LIVE shape and
              // re-prices automatically on a resize instead of silently drifting (the 0.00003 blended-rate
              // bug — 0.00003 was the 1.0cpu/2Gi blend, now 2× wrong at 2.0cpu/4Gi). MUST equal this job's
              // container resources.cpu above; verify() asserts stamped-env == live-resources (must-go-red).
              name: 'SYNTHWATCH_RUNNER_CPU'
              value: '2.0'
            }
            {
              name: 'SYNTHWATCH_RUNNER_MEMORY_GIB'
              value: '4'
            }
            {
              // RCA via Azure OpenAI (MI auth). Identical to the primary job — both
              // regions open incidents, so both need RCA. Declared so a redeploy
              // preserves it.
              name: 'AZURE_OPENAI_ENDPOINT'
              value: aoaiEndpoint
            }
            {
              name: 'AZURE_OPENAI_DEPLOYMENT'
              value: aoaiDeployment
            }
            {
              name: 'AZURE_OPENAI_API_VERSION'
              value: aoaiApiVersion
            }
            {
              name: 'RCA_MAX_TOKENS'
              value: rcaMaxTokens
            }
            {
              // Pin the user-assigned MI for the runner's in-process DefaultAzureCredential
              // (rca.ts AAD token for Azure OpenAI). The runner has a USER-ASSIGNED-ONLY MI;
              // a bare DefaultAzureCredential can't resolve which identity to use ->
              // "ChainedTokenCredential authentication failed" -> RCA token acquisition fails
              // (the intermittent-RCA root cause, masked by the 24h cache). DERIVED from the
              // MI resource (not a hardcoded GUID, can't drift); declared here so a deploy
              // can't wipe it (same lesson as the ACS/AOAI env).
              name: 'AZURE_CLIENT_ID'
              value: identity.properties.clientId
            }
            {
              // Email sender — non-secret transport property, template-owned (see the eastus2 job).
              name: 'ALERT_EMAIL_FROM'
              value: alertEmailFrom
            }
            {
              // Notification-canary probe recipient (CANARY_EMAIL_TO). A deliverability sink the operator does
              // NOT watch: a healthy canary lands here (recorded, never paged). Empty => the email canary is
              // off (surfaced as a canary-misconfigured runner_errors row). See runner/canary.ts.
              name: 'CANARY_EMAIL_TO'
              value: canaryEmailTo
            }
            {
              // ACS email transport (secret) — from the bicep-owned secret above, so a
              // redeploy PRESERVES it instead of wiping it (ends the recurring defect).
              name: 'ACS_EMAIL_CONNECTION_STRING'
              secretRef: 'acs-email-conn'
            }
            {
              // Vercel Deployment Protection bypass token — from the bicep-owned secret above (preserved across
              // redeploys). The runner injects it ONLY to PROTECTED_BYPASS_HOSTS; unset/'' → fail-soft (no header).
              name: 'VERCEL_BYPASS_TOKEN'
              secretRef: 'vercel-bypass-token'
            }
            {
              // Model-B credential encryption key → process.env for runner/crypto.ts decrypt-on-read.
              // From the bicep-owned secret above (preserved across redeploys); unset/'' → decrypt fail-closes.
              name: 'CRED_ENC_KEY'
              secretRef: 'cred-enc-key'
            }
          ]
        }
      ]
    }
  }
  dependsOn: [
    acrPull
  ]
}

// ---------------------------------------------------------------------------
// Third region (westus2): its own regional managed environment + runner job — the
// 2-of-3 quorum vantage. Logs to the SAME Log Analytics workspace. Identical to the
// other jobs except region + SYNTHWATCH_LOCATION=westus2. No new MI/ACR/Postgres grant
// (shared identity, same DB secret, region-agnostic firewall rule).
// ---------------------------------------------------------------------------
resource westus2Environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: westus2EnvName
  location: westus2Location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

resource westus2Job 'Microsoft.App/jobs@2024-03-01' = {
  name: westus2JobName
  location: westus2Location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: westus2Environment.id
    configuration: {
      triggerType: 'Schedule'
      // 660s: see the primary `job` above — MAX_FLOW_MS (600s) + ~60s teardown headroom.
      replicaTimeout: 660
      replicaRetryLimit: 0
      scheduleTriggerConfig: {
        cronExpression: '*/5 * * * *'
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: acr.properties.loginServer
          identity: identity.id
        }
      ]
      secrets: [
        {
          // Same admin creds + Postgres FQDN as the others — reachable cross-region
          // via the AllowAllAzureServices firewall rule.
          name: 'database-url'
          value: 'postgresql://${postgresAdminLogin}:${postgresAdminPassword}@${postgres.properties.fullyQualifiedDomainName}:5432/synthwatch?sslmode=require'
        }
        {
          name: 'storage-conn'
          value: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'
        }
        {
          // ACS email transport secret. Bicep-owned so a deploy can't wipe it.
          name: 'acs-email-conn'
          value: acsEmailConnectionString
        }
        {
          // Vercel Deployment Protection bypass token — fleet-wide secret, surfaced as the VERCEL_BYPASS_TOKEN
          // secretRef below. Bicep-owned so a redeploy preserves it; '' when unset → fail-soft (the runner
          // injects it ONLY to PROTECTED_BYPASS_HOSTS). Craig supplies the real value out-of-band; NEVER committed.
          name: 'vercel-bypass-token'
          value: vercelBypassToken
        }
        {
          // Model-B credential encryption key (CRED_ENC_KEY). Bicep-owned (value from the @secure param →
          // re-asserted every deploy from ~/.synthwatch.env). '' when unset → the runner fail-CLOSES on
          // decrypt. Craig supplies a real base64(32-byte) key in ~/.synthwatch.env; NEVER committed.
          name: 'cred-enc-key'
          value: credEncKey
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'runner'
          image: runnerImage
          // 2.0 CPU / 4Gi (was 1.0 / 2Gi), on all 3 runner jobs. A long browser flow (shop-flow ~530s)
          // OOM-killed the runner (exit 137) during POST-FLOW trace finalization — the in-memory
          // redacted-zip rebuild of a large trace exceeded 2Gi. 4Gi gives headroom; the streaming
          // redacted-trace build (traceRedact.ts) reduces peak memory durably. ACA Consumption requires
          // memory = 2×CPU, so 4Gi ⇒ 2.0 CPU (the plan max).
          resources: {
            cpu: json('2.0')
            memory: '4Gi'
          }
          env: [
            {
              name: 'DATABASE_URL'
              secretRef: 'database-url'
            }
            {
              name: 'AZURE_STORAGE_CONNECTION_STRING'
              secretRef: 'storage-conn'
            }
            {
              name: 'AZURE_STORAGE_CONTAINER'
              value: artifactContainerName
            }
            {
              // The vantage label for this region — claims/runs as 'westus2' (the 3rd quorum vote).
              name: 'SYNTHWATCH_LOCATION'
              value: westus2Location
            }
            {
              // ★ ARM coordinates for confirmation-retry's SELF jobs/start (0077 / jobTrigger.ts).
              name: 'AZURE_SUBSCRIPTION_ID'
              value: subscription().subscriptionId
            }
            {
              name: 'AZURE_RESOURCE_GROUP'
              value: resourceGroup().name
            }
            {
              // Universal deployed marker — see the primary job's SYNTHWATCH_DEPLOYED comment.
              name: 'SYNTHWATCH_DEPLOYED'
              value: '1'
            }
            {
              // ★ COST MODEL — the runner (browser) job allocation being PRICED, deploy-stamped so the
              // two-meter ACA cost model (runner/costModel.ts ↔ api CostRate.cs) reads the LIVE shape and
              // re-prices automatically on a resize instead of silently drifting (the 0.00003 blended-rate
              // bug — 0.00003 was the 1.0cpu/2Gi blend, now 2× wrong at 2.0cpu/4Gi). MUST equal this job's
              // container resources.cpu above; verify() asserts stamped-env == live-resources (must-go-red).
              name: 'SYNTHWATCH_RUNNER_CPU'
              value: '2.0'
            }
            {
              name: 'SYNTHWATCH_RUNNER_MEMORY_GIB'
              value: '4'
            }
            {
              // RCA via Azure OpenAI (MI auth). Identical to the other jobs — every region
              // opens incidents, so every region needs RCA. Declared so a redeploy preserves it.
              name: 'AZURE_OPENAI_ENDPOINT'
              value: aoaiEndpoint
            }
            {
              name: 'AZURE_OPENAI_DEPLOYMENT'
              value: aoaiDeployment
            }
            {
              name: 'AZURE_OPENAI_API_VERSION'
              value: aoaiApiVersion
            }
            {
              name: 'RCA_MAX_TOKENS'
              value: rcaMaxTokens
            }
            {
              // Pin the user-assigned MI for the runner's in-process DefaultAzureCredential
              // (rca.ts AAD token). DERIVED from the MI resource; declared so a deploy can't wipe it.
              name: 'AZURE_CLIENT_ID'
              value: identity.properties.clientId
            }
            {
              // Email sender — non-secret transport property, template-owned (see the eastus2 job).
              name: 'ALERT_EMAIL_FROM'
              value: alertEmailFrom
            }
            {
              // Notification-canary probe recipient (CANARY_EMAIL_TO). A deliverability sink the operator does
              // NOT watch: a healthy canary lands here (recorded, never paged). Empty => the email canary is
              // off (surfaced as a canary-misconfigured runner_errors row). See runner/canary.ts.
              name: 'CANARY_EMAIL_TO'
              value: canaryEmailTo
            }
            {
              // ACS email transport (secret) — from the bicep-owned secret above, so a
              // redeploy PRESERVES it instead of wiping it.
              name: 'ACS_EMAIL_CONNECTION_STRING'
              secretRef: 'acs-email-conn'
            }
            {
              // Vercel Deployment Protection bypass token — from the bicep-owned secret above (preserved across
              // redeploys). The runner injects it ONLY to PROTECTED_BYPASS_HOSTS; unset/'' → fail-soft (no header).
              name: 'VERCEL_BYPASS_TOKEN'
              secretRef: 'vercel-bypass-token'
            }
            {
              // Model-B credential encryption key → process.env for runner/crypto.ts decrypt-on-read.
              // From the bicep-owned secret above (preserved across redeploys); unset/'' → decrypt fail-closes.
              name: 'CRED_ENC_KEY'
              secretRef: 'cred-enc-key'
            }
          ]
        }
      ]
    }
  }
  dependsOn: [
    acrPull
  ]
}

// ---------------------------------------------------------------------------
// Container Apps JOB — one-off DB migrations. Manual trigger; CD (deploy.yml)
// rolls its image, starts it, and waits for success BEFORE rolling the runner.
// It runs db/migrate.sh from INSIDE Azure, so it is covered by the
// AllowAllAzureServices Postgres firewall rule — no firewall hole for GitHub
// runners. It reuses the SAME `database-url` secret as the runner job, so the DB
// password never leaves Azure (GitHub never sees it).
// ---------------------------------------------------------------------------
resource migrateJob 'Microsoft.App/jobs@2024-03-01' = {
  name: migrateJobName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: managedEnvironment.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 600
      replicaRetryLimit: 0
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: acr.properties.loginServer
          identity: identity.id
        }
      ]
      secrets: [
        {
          // Same value/shape as the runner job's database-url secret.
          name: 'database-url'
          value: 'postgresql://${postgresAdminLogin}:${postgresAdminPassword}@${postgres.properties.fullyQualifiedDomainName}:5432/synthwatch?sslmode=require'
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'migrate'
          image: migrateImage
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: [
            {
              name: 'DATABASE_URL'
              secretRef: 'database-url'
            }
            {
              // Universal deployed marker — see the primary job's SYNTHWATCH_DEPLOYED comment.
              name: 'SYNTHWATCH_DEPLOYED'
              value: '1'
            }
          ]
        }
      ]
    }
  }
  dependsOn: [
    acrPull
  ]
}

// ---------------------------------------------------------------------------
// Daily reporting rollup job — a SEPARATE Schedule Job (own daily cron, own execution;
// not entangled with the */5 check loop). Reuses the RUNNER image but overrides the
// command to run the rollup entry point (the image's default CMD is the check loop). Runs
// at 00:07 UTC: rolls up the just-completed previous UTC day (today, partial, is read from
// raw by reports). One-time historical backfill is run manually:
//   az containerapp job start -g <rg> -n synthwatch-rollup-job \
//     --command node --args dist/rollupMain.js --args --backfill
// (or `node dist/rollupMain.js --backfill` against the DB). Only DATABASE_URL is needed —
// no ACS/AOAI/storage (the rollup just reads runs/run_metrics/incidents + writes the table).
// ---------------------------------------------------------------------------
resource rollupJob 'Microsoft.App/jobs@2024-03-01' = {
  name: rollupJobName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: managedEnvironment.id
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 600
      replicaRetryLimit: 1
      scheduleTriggerConfig: {
        cronExpression: '7 0 * * *'
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: acr.properties.loginServer
          identity: identity.id
        }
      ]
      secrets: [
        {
          // Same value/shape as the runner job's database-url secret.
          name: 'database-url'
          value: 'postgresql://${postgresAdminLogin}:${postgresAdminPassword}@${postgres.properties.fullyQualifiedDomainName}:5432/synthwatch?sslmode=require'
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'rollup'
          image: runnerImage
          // Override the image's default CMD (dist/index.js, the check loop) -> the rollup
          // entry. Nightly mode rolls up yesterday (no args).
          command: [
            'node'
          ]
          args: [
            'dist/rollupMain.js'
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: [
            {
              name: 'DATABASE_URL'
              secretRef: 'database-url'
            }
            {
              // Universal deployed marker — see the primary job's SYNTHWATCH_DEPLOYED comment.
              name: 'SYNTHWATCH_DEPLOYED'
              value: '1'
            }
          ]
        }
      ]
    }
  }
  dependsOn: [
    acrPull
  ]
}

// ---------------------------------------------------------------------------
// Daily report-NARRATIVE job (Reporting Layer 3 — "Smart Reports"). A SEPARATE Schedule
// Job, eastus2 only (a daily batch over the reporting data — not multi-region monitoring).
// Reuses the RUNNER image, overriding the command to run the narrative entry point. Runs
// at 00:30 UTC — AFTER the rollup ('7 0 * * *') so the daily rollup is fresh when the
// narrative reads it (the narrative cites the rollup + recomputes percentiles from raw).
// Needs DATABASE_URL + the AOAI env (AZURE_OPENAI_* + RCA_MAX_TOKENS) — which is also the
// OPT-IN: present => Layer 3 generates; absent => narrativeMain no-ops (dark). AZURE_CLIENT_ID
// (derived from the MI, like #90) pins DefaultAzureCredential for the AOAI token. No ACS
// (no alerting). One-off run: `az containerapp job start -n synthwatch-narrative-job`.
// ---------------------------------------------------------------------------
resource narrativeJob 'Microsoft.App/jobs@2024-03-01' = {
  name: narrativeJobName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: managedEnvironment.id
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 600
      replicaRetryLimit: 1
      scheduleTriggerConfig: {
        cronExpression: '30 0 * * *'
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: acr.properties.loginServer
          identity: identity.id
        }
      ]
      secrets: [
        {
          // Same value/shape as the runner job's database-url secret.
          name: 'database-url'
          value: 'postgresql://${postgresAdminLogin}:${postgresAdminPassword}@${postgres.properties.fullyQualifiedDomainName}:5432/synthwatch?sslmode=require'
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'narrative'
          image: runnerImage
          // Override the image's default CMD (dist/index.js, the check loop) -> the
          // narrative entry. Generates the 7d fleet + per-monitor narratives.
          command: [
            'node'
          ]
          args: [
            'dist/narrativeMain.js'
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: [
            {
              name: 'DATABASE_URL'
              secretRef: 'database-url'
            }
            {
              // Universal deployed marker — see the primary job's SYNTHWATCH_DEPLOYED comment.
              name: 'SYNTHWATCH_DEPLOYED'
              value: '1'
            }
            {
              // ★ COST MODEL — the narrative job COMPUTES fleet cost (costFacts), so it carries the RUNNER
              // (browser) allocation being priced, NOT its own aux 0.25/0.5. Deploy-stamped 2.0/4 to match the
              // runner jobs' resources; verify() asserts it equals the primary runner job's live cpu/memory.
              name: 'SYNTHWATCH_RUNNER_CPU'
              value: '2.0'
            }
            {
              name: 'SYNTHWATCH_RUNNER_MEMORY_GIB'
              value: '4'
            }
            // AOAI — the SAME config the runner jobs carry. This IS the Layer-3 opt-in:
            // present => narratives generate; absent => narrativeMain no-ops (dark).
            {
              name: 'AZURE_OPENAI_ENDPOINT'
              value: aoaiEndpoint
            }
            {
              name: 'AZURE_OPENAI_DEPLOYMENT'
              value: aoaiDeployment
            }
            {
              name: 'AZURE_OPENAI_API_VERSION'
              value: aoaiApiVersion
            }
            {
              name: 'RCA_MAX_TOKENS'
              value: rcaMaxTokens
            }
            {
              // Pin the user-assigned MI for DefaultAzureCredential (the AOAI token) — the
              // #90 fix; derived from the MI resource, not hardcoded. Without it the AAD
              // token acquisition fails (ChainedTokenCredential) and narration falls back.
              name: 'AZURE_CLIENT_ID'
              value: identity.properties.clientId
            }
          ]
        }
      ]
    }
  }
  dependsOn: [
    acrPull
  ]
}

// ---------------------------------------------------------------------------
// Daily monitors-as-code RECONCILE job (Phase 6b). A SEPARATE Schedule Job, eastus2 only
// (a daily config reconcile — not multi-region monitoring, so no centralus twin). Reuses
// the RUNNER image, overriding the command to run the reconcile entry point. Runs at
// 01:00 UTC — clear of the rollup ('7 0') and narrative ('30 0'), a periodic drift refresh.
//
// REPORT-ONLY (this phase): reconcileMain fetches synthwatch-monitors' manifest.json over
// PUBLIC HTTPS (raw.githubusercontent.com — egress is already fine; the other jobs make
// external calls), diffs it against `checks`, and writes reconcile_drift. It applies NOTHING
// to live config. So only DATABASE_URL is needed — NO ACS/AOAI/storage (no email/AI/blobs).
// AZURE_CLIENT_ID pins the user-assigned MI for DefaultAzureCredential (the #90 pattern);
// reconcile makes no AAD calls today (DB is password-auth, manifest is public), so it is
// belt-and-suspenders / future-proofing, carried to match the other jobs.
// One-off run: `az containerapp job start -n synthwatch-reconcile-job`.
// ---------------------------------------------------------------------------
resource reconcileJob 'Microsoft.App/jobs@2024-03-01' = {
  name: reconcileJobName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: managedEnvironment.id
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 600
      replicaRetryLimit: 1
      scheduleTriggerConfig: {
        cronExpression: '0 * * * *'
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: acr.properties.loginServer
          identity: identity.id
        }
      ]
      secrets: [
        {
          // Same value/shape as the runner job's database-url secret.
          name: 'database-url'
          value: 'postgresql://${postgresAdminLogin}:${postgresAdminPassword}@${postgres.properties.fullyQualifiedDomainName}:5432/synthwatch?sslmode=require'
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'reconcile'
          image: runnerImage
          // Override the image's default CMD (dist/index.js, the check loop) -> the reconcile
          // entry. Detect-only: computes drift + writes reconcile_drift, applies nothing.
          command: [
            'node'
          ]
          args: [
            'dist/reconcileMain.js'
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: [
            {
              name: 'DATABASE_URL'
              secretRef: 'database-url'
            }
            {
              // Universal deployed marker — see the primary job's SYNTHWATCH_DEPLOYED comment.
              name: 'SYNTHWATCH_DEPLOYED'
              value: '1'
            }
            {
              // Pin the user-assigned MI for DefaultAzureCredential (the #90 pattern),
              // derived from the MI resource. Reconcile makes no AAD calls today; carried
              // to match the other jobs and future-proof any AAD need.
              name: 'AZURE_CLIENT_ID'
              value: identity.properties.clientId
            }
          ]
        }
      ]
    }
  }
  dependsOn: [
    acrPull
  ]
}

// ---------------------------------------------------------------------------
// Daily row-RETENTION job. Prunes runs older than RETENTION_DAYS (=90 in runner/retention.ts,
// MUST stay equal to artifactRetentionDays) so the runs family stops growing unbounded and the
// rows expire on the SAME 90d clock as the blob lifecycle (closing the dangling-ref window).
// Reuses the RUNNER image, overriding the command to run the retention entry point. Runs at
// 00:45 UTC — AFTER rollup ('7 0') and narrative ('30 0'), so the day's rollup is captured before
// any raw run becomes prune-eligible (the long-horizon series is safe). CASCADE cleans
// run_steps/run_metrics; incident-pinned runs are excluded in code. DATABASE_URL only (no AOAI/ACS).
// One-off run: `az containerapp job start -n synthwatch-retention-job`.
// ---------------------------------------------------------------------------
resource retentionJob 'Microsoft.App/jobs@2024-03-01' = {
  name: retentionJobName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: managedEnvironment.id
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 600
      replicaRetryLimit: 1
      scheduleTriggerConfig: {
        cronExpression: '45 0 * * *'
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: acr.properties.loginServer
          identity: identity.id
        }
      ]
      secrets: [
        {
          // Same value/shape as the runner job's database-url secret.
          name: 'database-url'
          value: 'postgresql://${postgresAdminLogin}:${postgresAdminPassword}@${postgres.properties.fullyQualifiedDomainName}:5432/synthwatch?sslmode=require'
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'retention'
          image: runnerImage
          // Override the image's default CMD (dist/index.js, the check loop) -> the retention
          // entry. Prunes runs older than RETENTION_DAYS (cascades children).
          command: [
            'node'
          ]
          args: [
            'dist/retentionMain.js'
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: [
            {
              name: 'DATABASE_URL'
              secretRef: 'database-url'
            }
            {
              // Universal deployed marker — see the primary job's SYNTHWATCH_DEPLOYED comment.
              name: 'SYNTHWATCH_DEPLOYED'
              value: '1'
            }
          ]
        }
      ]
    }
  }
  dependsOn: [
    acrPull
  ]
}

// ---------------------------------------------------------------------------
// EXTERNAL fleet-liveness detection (the 2026-07-06 outage fix).
//
// SynthWatch's own alerting runs INSIDE the runner — so when the A4 prod-guard made every
// runner job REFUSE TO START, the alerting was dead too and nothing noticed for ~23h. These
// Azure Monitor scheduled-query rules run in Azure's CONTROL PLANE, query the Log Analytics
// workspace, and survive the runner being completely dead — they detect the exact failure
// mode the runner's self-alerting cannot. Created by the bicep apply (scripts/deploy.sh);
// take effect on the next infra deploy.
//
// Column names + KQL were confirmed live against ContainerAppConsoleLogs_CL (2026-07-06):
//   - Log_s              — the runner's stdout/stderr line
//   - ContainerJobName_s — STABLE ACA job name (no replica suffix); the per-job identifier
//   - location is embedded in the heartbeat line: "... (location=<region>)"
// Both queries were proven to FIRE on the historical incident window (see the PR body).
// ---------------------------------------------------------------------------

// Action Group — where a fired rule sends notifications. Global resource (not regional).
resource fleetAlertActionGroup 'microsoft.insights/actionGroups@2023-01-01' = {
  name: 'synthwatch-fleet-alerts'
  location: 'global'
  properties: {
    groupShortName: 'swfleet' // SMS/short-name field, ≤12 chars
    enabled: true
    emailReceivers: [
      {
        name: 'fleet-admin'
        emailAddress: alertRecipientEmail
        useCommonAlertSchema: true
      }
    ]
  }
}

// Rule 1 — GUARD REFUSAL / fleet-down. Any "REFUSING TO START … SYNTHWATCH_DEPLOYED" line in
// the last 15m fires this. This is the DIRECT signal of the 2026-07-06 incident. Count of
// matching rows > 0 ⇒ fire. windowSize controls the time range (no ago() in the query).
resource fleetGuardRefusalAlert 'microsoft.insights/scheduledQueryRules@2023-12-01' = {
  name: 'synthwatch-fleet-guard-refusal'
  location: location
  kind: 'LogAlert'
  properties: {
    displayName: 'SynthWatch fleet — prod-guard REFUSING TO START'
    description: 'A runner entrypoint refused to start because SYNTHWATCH_DEPLOYED != 1 (the A4 prod-guard). This is the exact 2026-07-06 fleet-down signal. External to the runner, so it fires even when the runner (and its own alerting) is dead.'
    severity: 1
    enabled: true
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    scopes: [
      logAnalytics.id
    ]
    criteria: {
      allOf: [
        {
          query: 'ContainerAppConsoleLogs_CL | where Log_s has "REFUSING TO START" and Log_s has "SYNTHWATCH_DEPLOYED"'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    autoMitigate: true
    actions: {
      actionGroups: [
        fleetAlertActionGroup.id
      ]
    }
  }
}

// Rule 2 — RUNS STALE / heartbeat absent, PER REGION. The healthy heartbeat is the runner's
// "[runner] tick summary: … (location=<region>)" line, emitted every tick per region. This
// left-joins the EXPECTED region set against the regions actually seen in the last 15m and
// returns a row for each region with ZERO heartbeats — so a SINGLE dead region fires it (the
// F-4 silent-dead-region class), not only an all-three-dead fleet. Count of dead-region rows
// > 0 ⇒ fire. windowSize controls the time range (no ago() in the query).
// ★ windowSize MUST be one of Azure's supported granularities {5,10,15,30,45,60,120,180,240,
// 300,360,720,1440,2880} minutes — PT20M is NOT supported and Azure rejects the WHOLE ARM
// deploy (the 2026-07-06 detection deploy failed on exactly this). PT15M is supported and, at a
// 5-min evaluationFrequency, still catches a dead region within ~15min. Keep both fields on
// this list; see the guard-refusal rule above (PT15M / PT5M, both supported).
resource fleetHeartbeatAbsentAlert 'microsoft.insights/scheduledQueryRules@2023-12-01' = {
  name: 'synthwatch-fleet-heartbeat-absent'
  location: location
  kind: 'LogAlert'
  properties: {
    displayName: 'SynthWatch fleet — region heartbeat absent (no tick summary)'
    description: 'An expected runner region emitted no "tick summary" heartbeat in the last 15m — that region is stalled or dead. Fires per-region so one silent region is caught, not just a total outage. External to the runner.'
    severity: 1
    enabled: true
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    scopes: [
      logAnalytics.id
    ]
    criteria: {
      allOf: [
        {
          query: 'let expected = datatable(location:string)["eastus2","centralus","westus2"]; let seen = ContainerAppConsoleLogs_CL | where Log_s has "tick summary" | extend location = extract("location=([a-z0-9]+)", 1, Log_s) | summarize Heartbeats = count() by location; expected | join kind=leftouter seen on location | extend Heartbeats = coalesce(Heartbeats, toint(0)) | where Heartbeats == 0'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    autoMitigate: true
    actions: {
      actionGroups: [
        fleetAlertActionGroup.id
      ]
    }
  }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------
output postgresFqdn string = postgres.properties.fullyQualifiedDomainName
output storageAccountName string = storage.name
output jobName string = job.name
output migrateJobName string = migrateJob.name
output rollupJobName string = rollupJob.name
output narrativeJobName string = narrativeJob.name
output reconcileJobName string = reconcileJob.name
output retentionJobName string = retentionJob.name
output fleetAlertActionGroupName string = fleetAlertActionGroup.name
output fleetGuardRefusalAlertName string = fleetGuardRefusalAlert.name
output fleetHeartbeatAbsentAlertName string = fleetHeartbeatAbsentAlert.name
