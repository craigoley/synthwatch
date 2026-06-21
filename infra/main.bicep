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
//     --parameters postgresAdminPassword='<strong-password>'
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

@description('One-off Container Apps Job that applies DB migrations (started by CD).')
param migrateJobName string = 'synthwatch-migrate-job'

@description('User-assigned managed identity name (used for ACR pull).')
param identityName string = 'synthwatch-runner-id'

@description('Blob container for failure screenshots. Matches the runner default (AZURE_STORAGE_CONTAINER).')
param artifactContainerName string = 'synthwatch-artifacts'

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
    authConfig: {
      passwordAuth: 'Enabled'
      activeDirectoryAuth: 'Disabled'
    }
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
            // Alert-channel vars (ALERT_EMAIL_TO, TEAMS_WEBHOOK_URL,
            // XMATTERS_*) are added per deployment; absent => channel disabled.
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
// Outputs
// ---------------------------------------------------------------------------
output postgresFqdn string = postgres.properties.fullyQualifiedDomainName
output storageAccountName string = storage.name
output jobName string = job.name
output migrateJobName string = migrateJob.name
