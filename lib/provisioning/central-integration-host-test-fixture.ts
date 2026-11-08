import { createHash, generateKeyPairSync } from "node:crypto";
import {
  centralHostSetupPlanSchema,
  centralHostSetupEffects,
} from "./central-integration-host-contract";
import { integrationCapabilityPlan } from "./app-integration-capability-test-fixture";

export const keys = generateKeyPairSync("ed25519");
export const activation = {
  keyId: "central-key",
  publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }),
  publicKeySha256: createHash("sha256")
    .update(keys.publicKey.export({ format: "der", type: "spki" }))
    .digest("hex"),
};
const { runtimeRole: _runtime, ...resource } = integrationCapabilityPlan.control.database;
void _runtime;
const intentId = "11111111-1111-4111-a111-111111111111";
const subscriptionRef = "22222222-2222-4222-a222-222222222222";
export const plan = centralHostSetupPlanSchema.parse({
  version: 1,
  kind: "central-integration-host-setup-v1",
  intentId,
  authority: integrationCapabilityPlan.authority,
  selection: { initiatingAppId: "invoice-app", sessionId: "original-session" },
  profile: { id: "isolated-central", digest: "a".repeat(64) },
  resourceProfileId: "isolated-central-resource",
  target: {
    environment: "preview",
    framework: "services",
    installationId: "owned-installation",
    projectId: "central-project",
    rootDirectory: ".",
    serviceId: "integrations",
    teamId: "owned-team",
  },
  control: {
    resource,
    centralRuntimeRole: "central_runtime",
    neon: integrationCapabilityPlan.runtime.neon,
    schemaSha256: "b".repeat(64),
  },
  provider: {
    kind: integrationCapabilityPlan.provider.kind,
    integrationId: integrationCapabilityPlan.provider.integrationId,
    projectId: integrationCapabilityPlan.provider.projectId,
    authorizationOrigins: integrationCapabilityPlan.provider.authorizationOrigins,
    payloadHosts: integrationCapabilityPlan.provider.payloadHosts,
  },
  activation,
  source: {
    repositoryId: "central-repository",
    installationId: "central-github-installation",
    reviewedSourceSha: "c".repeat(40),
    reviewDigest: "d".repeat(64),
    operationBranch: `builder/integrations-host/${intentId}`,
    expectedBranchAbsent: true,
    servicesManifestSha256: "e".repeat(64),
    serviceIds: ["gateway", "integrations"],
    configurationRef: "private-config-reference",
    configurationSha256: "f".repeat(64),
    applicationIngress: "signed-app-development-v1",
    deploymentProfile: "isolated-central-integrations-v1",
    buildReceiptSha256: "9".repeat(64),
    workers: {
      resources: { id: "neon-resource-bootstrap-v1", sha256: "d".repeat(64) },
      schema: { id: "central-integration-bootstrap-v1", sha256: "e".repeat(64) },
    },
  },
  environment: [{ key: "INTEGRATIONS_DATABASE_URL", sha256: "0".repeat(64) }],
  receiver: {
    subscriptionRef,
    publicOrigin: "https://builder.example",
    path: `/api/central-integrations/deployment-events/${subscriptionRef}`,
    events: ["deployment.created", "deployment.ready"],
  },
  inspector: {
    projectId: "operator-project",
    environment: "preview",
    targetEnvironment: "preview",
    priorGrantSha256: "1".repeat(64),
  },
  effects: centralHostSetupEffects,
});
const pointer = { operationRef: intentId, planDigest: "2".repeat(64) };
export const ready = {
  version: 1,
  kind: "central-integration-host-ready-v1",
  authority: plan.authority,
  setup: pointer,
  callerSetup: { operationRef: subscriptionRef, planDigest: "3".repeat(64) },
  profile: plan.profile,
  resourceProfileId: plan.resourceProfileId,
  control: plan.control,
  activation,
  provider: plan.provider,
  deployment: {
    projectId: plan.target.projectId,
    teamId: plan.target.teamId,
    installationId: plan.target.installationId,
    environment: "preview",
    serviceId: "integrations",
    providerDeploymentId: "accepted-provider-id",
    immutableOrigin: "https://native-immutable.vercel.app",
    configurationRef: plan.source.configurationRef,
    configurationSha256: plan.source.configurationSha256,
  },
  caller: {
    projectId: "normal-app-project",
    ownerId: "app-team",
    environment: "production",
    trustedSourcesGrantSha256: "4".repeat(64),
  },
};
