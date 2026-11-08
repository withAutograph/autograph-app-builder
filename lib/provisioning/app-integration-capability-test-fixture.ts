import { appIntegrationReadObjectsDigest } from "../repository/app-integration-metadata";
import { appIntegrationCapabilityPlanSchema } from "./app-integration-capability-contract";
import { authority } from "./public-release-test-fixture";

const ISOLATED_READS_DESTINATION = "isolated-reads";

const resource = (name: string) => ({
  database: name,
  environment: "preview" as const,
  hostname: "ep-owned.neon.tech",
  migratorRole: `${name}_migrator`,
  port: 5432 as const,
  resourceId: `${name}-resource`,
  runtimeRole: `${name}_runtime`,
  schema: "public" as const,
});
export const integrationCapabilityPlan = appIntegrationCapabilityPlanSchema.parse({
  version: 1,
  kind: "app-integrations-capability-plan-v1",
  authority,
  selection: { appId: "invoice-app", sessionId: "saved-session" },
  project: {
    installationId: "installation",
    projectId: "owned-project",
    provisioningDigest: "a".repeat(64),
    provisioningRequestId: "11111111-1111-4111-a111-111111111111",
    teamId: "team",
  },
  release: {
    id: "release",
    artifactRef: "captured-release",
    manifestSha256: "b".repeat(64),
    artifactSha256: "c".repeat(64),
    appSpecDigest: "spec-digest",
  },
  runtime: {
    operationRef: "22222222-2222-4222-a222-222222222222",
    planDigest: "d".repeat(64),
    appDatabase: resource("invoice_app"),
    neon: {
      branchId: "isolated-branch",
      endpointId: "owned-endpoint",
      projectId: "owned-neon",
      source: "synthetic-only",
    },
  },
  profileId: "owner-development-profile",
  profileDigest: "e".repeat(64),
  publicOrigin: "https://invoice-app.example",
  workload: {
    audience: "https://vercel.com/team",
    environment: "production",
    issuer: "https://oidc.vercel.com/team",
    ownerId: "team",
    projectId: "owned-project",
    subject: "owner:team:project:owned-project:environment:production",
  },
  readinessPath: "/invoice-app/api/integrations/readiness",
  control: {
    origin: "https://integrations-development.example",
    resourceProfileId: "isolated-development-control",
    registrationIdentitySha256: "8".repeat(64),
    database: resource("development_integrations"),
    neon: {
      branchId: "control-development-branch",
      endpointId: "control-endpoint",
      projectId: "control-neon",
      source: "synthetic-only",
    },
    centralHostSetup: {
      operationRef: "55555555-5555-4555-a555-555555555555",
      planDigest: "5".repeat(64),
      callerOperationRef: "66666666-6666-4666-a666-666666666666",
      callerPlanDigest: "6".repeat(64),
      projectId: "central-project",
      teamId: "team",
      providerDeploymentId: "provider-central-deployment",
      trustedSourcesGrantSha256: "7".repeat(64),
    },
    schema: { artifactRef: "fixed-control-schema", sha256: "f".repeat(64) },
    activationKeyId: "development-verification-key",
    activationPublicKeySha256: "1".repeat(64),
  },
  provider: {
    kind: "quickbooksSandbox",
    projectId: "development-provider-project",
    integrationId: "quickbooks-development",
    recipeId: "quickbooks-read",
    recipeVersion: "1",
    readObjectsSha256: appIntegrationReadObjectsDigest({
      Vendor: { objectName: "Vendor", destination: ISOLATED_READS_DESTINATION },
    }),
    authorizationOrigins: ["https://sandbox-authorize.example"],
    payloadHosts: ["sandbox-data.example"],
  },
  providerConfiguration: {
    artifactRef: "captured-release",
    provider: "quickbooks",
    connectionProviderKey: "quickbooks-sandbox",
    recipeId: "quickbooks-read",
    recipeVersion: "1",
    readObjects: { Vendor: { objectName: "Vendor", destination: ISOLATED_READS_DESTINATION } },
    readObjectsSha256: appIntegrationReadObjectsDigest({
      Vendor: { objectName: "Vendor", destination: ISOLATED_READS_DESTINATION },
    }),
  },
  serviceMemberships: [
    {
      actorId: "owned-service-actor",
      organizationId: "owned-development-organization",
      role: "integration_writer",
    },
  ],
  worker: { reference: "fixed-integration-worker", sha256: "3".repeat(64) },
  privateConfigurationSeed: {
    reference: "33333333-3333-4333-a333-333333333333",
    sha256: "4".repeat(64),
  },
  effects: [
    "prepare-control-database",
    "install-control-schema",
    "bind-service-memberships",
    "register-central-app",
  ],
});
