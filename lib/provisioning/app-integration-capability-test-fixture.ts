import { appIntegrationReadObjectsDigest } from "../repository/app-integration-metadata";
import { appIntegrationCapabilityPlanSchema } from "./app-integration-capability-contract";
import { authority } from "./public-release-test-fixture";

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
  authority,
  control: {
    activationKeyId: "development-verification-key",
    activationPublicKeySha256: "1".repeat(64),
    centralHostSetup: {
      callerOperationRef: "66666666-6666-4666-a666-666666666666",
      callerPlanDigest: "6".repeat(64),
      operationRef: "55555555-5555-4555-a555-555555555555",
      planDigest: "5".repeat(64),
      projectId: "central-project",
      providerDeploymentId: "provider-central-deployment",
      teamId: "team",
      trustedSourcesGrantSha256: "7".repeat(64),
    },
    database: resource("development_integrations"),
    neon: {
      branchId: "control-development-branch",
      endpointId: "control-endpoint",
      projectId: "control-neon",
      source: "synthetic-only",
    },
    origin: "https://integrations-development.example",
    registrationIdentitySha256: "8".repeat(64),
    resourceProfileId: "isolated-development-control",
    schema: { artifactRef: "fixed-control-schema", sha256: "f".repeat(64) },
  },
  effects: [
    "prepare-control-database",
    "install-control-schema",
    "bind-service-memberships",
    "register-central-app",
  ],
  kind: "app-integrations-capability-plan-v1",
  privateConfigurationSeed: {
    reference: "33333333-3333-4333-a333-333333333333",
    sha256: "4".repeat(64),
  },
  profileDigest: "e".repeat(64),
  profileId: "owner-development-profile",
  project: {
    installationId: "installation",
    projectId: "owned-project",
    provisioningDigest: "a".repeat(64),
    provisioningRequestId: "11111111-1111-4111-a111-111111111111",
    teamId: "team",
  },
  provider: {
    authorizationOrigins: ["https://sandbox-authorize.example"],
    integrationId: "quickbooks-development",
    kind: "quickbooksSandbox",
    payloadHosts: ["sandbox-data.example"],
    projectId: "development-provider-project",
    readObjectsSha256: appIntegrationReadObjectsDigest({
      Vendor: { destination: "isolated-reads", objectName: "Vendor" },
    }),
    recipeId: "quickbooks-read",
    recipeVersion: "1",
  },
  providerConfiguration: {
    artifactRef: "captured-release",
    connectionProviderKey: "quickbooks-sandbox",
    provider: "quickbooks",
    readObjects: { Vendor: { destination: "isolated-reads", objectName: "Vendor" } },
    readObjectsSha256: appIntegrationReadObjectsDigest({
      Vendor: { destination: "isolated-reads", objectName: "Vendor" },
    }),
    recipeId: "quickbooks-read",
    recipeVersion: "1",
  },
  publicOrigin: "https://invoice-app.example",
  readinessPath: "/invoice-app/api/integrations/readiness",
  release: {
    appSpecDigest: "spec-digest",
    artifactRef: "captured-release",
    artifactSha256: "c".repeat(64),
    id: "release",
    manifestSha256: "b".repeat(64),
  },
  runtime: {
    appDatabase: resource("invoice_app"),
    neon: {
      branchId: "isolated-branch",
      endpointId: "owned-endpoint",
      projectId: "owned-neon",
      source: "synthetic-only",
    },
    operationRef: "22222222-2222-4222-a222-222222222222",
    planDigest: "d".repeat(64),
  },
  selection: { appId: "invoice-app", sessionId: "saved-session" },
  serviceMemberships: [
    {
      actorId: "owned-service-actor",
      organizationId: "owned-development-organization",
      role: "integration_writer",
    },
  ],
  version: 1,
  worker: { reference: "fixed-integration-worker", sha256: "3".repeat(64) },
  workload: {
    audience: "https://vercel.com/team",
    environment: "production",
    issuer: "https://oidc.vercel.com/team",
    ownerId: "team",
    projectId: "owned-project",
    subject: "owner:team:project:owned-project:environment:production",
  },
});
