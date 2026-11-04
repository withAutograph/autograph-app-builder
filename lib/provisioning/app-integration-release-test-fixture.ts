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
  resourceId: value.resourceId,
  hostname: value.hostname,
  port: value.port,
  database: value.database,
  schema: value.schema,
  runtimeRole: value.runtimeRole,
});
export const integrationTestConfiguration = JSON.stringify({
  reference: plan.privateConfigurationSeed.reference,
  scopeSha256: "scope-is-not-used-by-this-signature-fixture",
  setupProofSecret: "r".repeat(32),
});
export const integrationTestCapability = preparedAppIntegrationCapabilitySchema.parse({
  kind: "app-integrations-development-v1",
  appId: plan.selection.appId,
  environment: "development",
  resourceProfile: "isolated-development",
  release: {
    id: plan.release.id,
    manifestSha256: plan.release.manifestSha256,
    artifactSha256: plan.release.artifactSha256,
  },
  appDatabase: resource(plan.runtime.appDatabase),
  control: {
    origin: plan.control.origin,
    resourceProfileId: plan.control.resourceProfileId,
    principalGeneration: 8,
    database: resource(plan.control.database),
    activationKeyId: plan.control.activationKeyId,
    activationPublicKeySha256: plan.control.activationPublicKeySha256,
  },
  provider: plan.provider,
  serviceMemberships: plan.serviceMemberships.map((member) => ({ ...member, fenceGeneration: 7 })),
  privateConfiguration: {
    reference: plan.privateConfigurationSeed.reference,
    sha256: createHash("sha256").update(integrationTestConfiguration).digest("hex"),
  },
});
export const integrationTestAttachment = appIntegrationReleaseAttachmentSchema.parse({
  operationRef: appIntegrationCapabilityOperationRef(plan),
  planDigest: appIntegrationCapabilityPlanDigest(plan),
  capability: integrationTestCapability,
  scopeSha256: preparedIntegrationScopeDigest(integrationTestCapability),
  readinessPath: plan.readinessPath,
});
