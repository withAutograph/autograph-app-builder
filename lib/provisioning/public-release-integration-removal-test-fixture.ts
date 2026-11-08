import { appIntegrationRemovalSchema } from "./app-integration-release-contract";
import { integrationTestAttachment as source } from "./app-integration-release-test-fixture";

export const removal = appIntegrationRemovalSchema.parse({
  kind: "disabled-app-integration-tombstone-v1",
  sourceCapability: { operationRef: source.operationRef, planDigest: source.planDigest },
  worker: { reference: "app-integration-bootstrap-v1", sha256: "f".repeat(64) },
  scopeSha256: source.scopeSha256,
  stoppedBindingsSha256: "d".repeat(64),
  bindingCount: 2,
  authority: {
    principalName: source.capability.control.database.runtimeRole,
    active: true,
    principalGeneration: source.capability.control.principalGeneration,
    expectedFencedGeneration: source.capability.control.principalGeneration + 1,
    configurationRef: source.capability.privateConfiguration.reference,
    configurationSha256: source.capability.privateConfiguration.sha256,
  },
});
export const retained = [
  {
    acceptedEnvId: "prior-cap",
    key: "APP_INTEGRATIONS_CAPABILITY",
    sha256: "a".repeat(64),
    sourceOperationRef: "11111111-1111-4111-a111-111111111111",
    sourcePlanDigest: "b".repeat(64),
  },
  {
    acceptedEnvId: "prior-config",
    key: "APP_INTEGRATIONS_RUNTIME_CONFIGURATION",
    sha256: "c".repeat(64),
    sourceOperationRef: "11111111-1111-4111-a111-111111111111",
    sourcePlanDigest: "b".repeat(64),
  },
];
