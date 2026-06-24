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

@description('One-off Container Apps Job that applies DB migrations (started by CD).')
param migrateJobName string = 'synthwatch-migrate-job'

@description('Daily Container Apps Job that computes the reporting rollup (daily_check_rollup).')
param rollupJobName string = 'synthwatch-rollup-job'

@description('Daily Container Apps Job that generates the Layer-3 AI report narratives (report_narratives).')
param narrativeJobName string = 'synthwatch-narrative-job'

@description('User-assigned managed identity name (used for ACR pull).')
param identityName string = 'synthwatch-runner-id'

// The Postgres Entra admin's objectId (a child resource NAME must be known at the
// start of deployment, so it can't be derived from identity.properties.principalId at
// runtime — hence a param). Default = the synthwatch-runner-id MI's principalId; the
// API authenticates to Postgres as this principal. tenantId is derived (subscription).
@description('objectId (principalId) of the synthwatch-runner-id MI — the Postgres Entra admin.')
param aadAdminObjectId string = '5ca727ad-06a2-42a9-b31c-4e7b9382ab96'

@description('Blob container for failure screenshots. Matches the runner default (AZURE_STORAGE_CONTAINER).')
param artifactContainerName string = 'synthwatch-artifacts'

@description('Retention (days) for failure artifacts — traces/ and root run-*.png screenshots are auto-deleted by the Blob lifecycle policy after this many days. Default 90.')
@minValue(1)
param artifactRetentionDays int = 90

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

// AcrPull built-in role.
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

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
// IDENTITY (a ServicePrincipal). Declared so a deploy re-asserts it (the bug above
// wiped it). objectId/tenantId are DERIVED (the MI's own principalId + the
// subscription tenant), never hardcoded. Craig's personal user admin is intentionally
// NOT in IaC — incremental deploys don't delete unlisted admins, so it's preserved.
resource postgresEntraAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = {
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
}

resource artifactContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: artifactContainerName
  properties: {
    publicAccess: 'None'
  }
}

// Lifecycle policy: auto-delete failure artifacts older than artifactRetentionDays
// (default 90). Covers BOTH prefixes in the artifact container — traces/ (zip) and
// the root-level run-*.png screenshots — server-side, no cron/code. The DB still
// holds runs.trace_url/screenshot_url after deletion (a dangling reference the
// dashboard should 404 gracefully; tracked as a follow-up).
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
      replicaTimeout: 240
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
      ]
    }
    template: {
      containers: [
        {
          name: 'runner'
          image: runnerImage
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
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
              // ACS email transport (secret) — from the bicep-owned secret above, so a
              // redeploy PRESERVES it instead of wiping it (ends the recurring defect).
              name: 'ACS_EMAIL_CONNECTION_STRING'
              secretRef: 'acs-email-conn'
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
      replicaTimeout: 240
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
      ]
    }
    template: {
      containers: [
        {
          name: 'runner'
          image: runnerImage
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
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
              // ACS email transport (secret) — from the bicep-owned secret above, so a
              // redeploy PRESERVES it instead of wiping it (ends the recurring defect).
              name: 'ACS_EMAIL_CONNECTION_STRING'
              secretRef: 'acs-email-conn'
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
// Outputs
// ---------------------------------------------------------------------------
output postgresFqdn string = postgres.properties.fullyQualifiedDomainName
output storageAccountName string = storage.name
output jobName string = job.name
output migrateJobName string = migrateJob.name
output rollupJobName string = rollupJob.name
output narrativeJobName string = narrativeJob.name
