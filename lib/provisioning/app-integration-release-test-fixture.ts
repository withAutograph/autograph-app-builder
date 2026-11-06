import { createHash } from "node:crypto";
import { integrationCapabilityPlan as plan } from "./app-integration-capability-test-fixture";
import {
  appIntegrationCapabilityOperationRef,
  appIntegrationCapabilityPlanDigest,
  preparedAppIntegrationCapabilitySchema,
} from "./app-integration-capability-contract";
import {
  preparedIntegrationScopeDigest,
  appIntegrationReleaseAttachmentSchema,
} from "./app-integration-release-contract";

const resource = (value: typeof plan.control.database) => ({
  database: value.database,
  hostname: value.hostname,
  port: value.port,
  resourceId: value.resourceId,
  runtimeRole: value.runtimeRole,
  schema: value.schema,
});
export const integrationTestConfiguration = JSON.stringify({
  reference: plan.privateConfigurationSeed.reference,
  scopeSha256: "scope-is-not-used-by-this-signature-fixture",
  setupProofSecret: "r".repeat(32),
});
export const integrationTestCapability = preparedAppIntegrationCapabilitySchema.parse({
  appDatabase: resource(plan.runtime.appDatabase),
  appId: plan.selection.appId,
  control: {
    activationKeyId: plan.control.activationKeyId,
    activationPublicKeySha256: plan.control.activationPublicKeySha256,
    database: resource(plan.control.database),
    origin: plan.control.origin,
    principalGeneration: 8,
    resourceProfileId: plan.control.resourceProfileId,
  },
  environment: "development",
  kind: "app-integrations-development-v1",
  privateConfiguration: {
    reference: plan.privateConfigurationSeed.reference,
    sha256: createHash("sha256").update(integrationTestConfiguration).digest("hex"),
  },
  provider: plan.provider,
  release: {
    artifactSha256: plan.release.artifactSha256,
    id: plan.release.id,
    manifestSha256: plan.release.manifestSha256,
  },
  resourceProfile: "isolated-development",
  serviceMemberships: plan.serviceMemberships.map((member) => ({ ...member, fenceGeneration: 7 })),
});
export const integrationTestAttachment = appIntegrationReleaseAttachmentSchema.parse({
  capability: integrationTestCapability,
  operationRef: appIntegrationCapabilityOperationRef(plan),
  planDigest: appIntegrationCapabilityPlanDigest(plan),
  readinessPath: plan.readinessPath,
  scopeSha256: preparedIntegrationScopeDigest(integrationTestCapability),
});
