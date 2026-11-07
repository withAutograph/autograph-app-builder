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
  activation,
  authority: integrationCapabilityPlan.authority,
  control: {
    centralRuntimeRole: "central_runtime",
    neon: integrationCapabilityPlan.runtime.neon,
    resource,
    schemaSha256: "b".repeat(64),
  },
  effects: centralHostSetupEffects,
  environment: [{ key: "INTEGRATIONS_DATABASE_URL", sha256: "0".repeat(64) }],
  inspector: {
    environment: "preview",
    priorGrantSha256: "1".repeat(64),
    projectId: "operator-project",
    targetEnvironment: "preview",
  },
  intentId,
  kind: "central-integration-host-setup-v1",
  profile: { digest: "a".repeat(64), id: "isolated-central" },
  provider: {
    authorizationOrigins: integrationCapabilityPlan.provider.authorizationOrigins,
    integrationId: integrationCapabilityPlan.provider.integrationId,
    kind: integrationCapabilityPlan.provider.kind,
    payloadHosts: integrationCapabilityPlan.provider.payloadHosts,
    projectId: integrationCapabilityPlan.provider.projectId,
  },
  receiver: {
    events: ["deployment.created", "deployment.ready"],
    path: `/api/central-integrations/deployment-events/${subscriptionRef}`,
    publicOrigin: "https://builder.example",
    subscriptionRef,
  },
  resourceProfileId: "isolated-central-resource",
  selection: { initiatingAppId: "invoice-app", sessionId: "original-session" },
  source: {
    applicationIngress: "signed-app-development-v1",
    buildReceiptSha256: "9".repeat(64),
    configurationRef: "private-config-reference",
    configurationSha256: "f".repeat(64),
    deploymentProfile: "isolated-central-integrations-v1",
    expectedBranchAbsent: true,
    installationId: "central-github-installation",
    operationBranch: `builder/integrations-host/${intentId}`,
    repositoryId: "central-repository",
    reviewDigest: "d".repeat(64),
    reviewedSourceSha: "c".repeat(40),
    serviceIds: ["gateway", "integrations"],
    servicesManifestSha256: "e".repeat(64),
    workers: {
      resources: { id: "neon-resource-bootstrap-v1", sha256: "d".repeat(64) },
      schema: { id: "central-integration-bootstrap-v1", sha256: "e".repeat(64) },
    },
  },
  target: {
    environment: "preview",
    framework: "services",
    installationId: "owned-installation",
    projectId: "central-project",
    rootDirectory: ".",
    serviceId: "integrations",
    teamId: "owned-team",
  },
  version: 1,
});
const pointer = { operationRef: intentId, planDigest: "2".repeat(64) };
export const ready = {
  activation,
  authority: plan.authority,
  caller: {
    environment: "production",
    ownerId: "app-team",
    projectId: "normal-app-project",
    trustedSourcesGrantSha256: "4".repeat(64),
  },
  callerSetup: { operationRef: subscriptionRef, planDigest: "3".repeat(64) },
  control: plan.control,
  deployment: {
    configurationRef: plan.source.configurationRef,
    configurationSha256: plan.source.configurationSha256,
    environment: "preview",
    immutableOrigin: "https://native-immutable.vercel.app",
    installationId: plan.target.installationId,
    projectId: plan.target.projectId,
    providerDeploymentId: "accepted-provider-id",
    serviceId: "integrations",
    teamId: plan.target.teamId,
  },
  kind: "central-integration-host-ready-v1",
  profile: plan.profile,
  provider: plan.provider,
  resourceProfileId: plan.resourceProfileId,
  setup: pointer,
  version: 1,
};
