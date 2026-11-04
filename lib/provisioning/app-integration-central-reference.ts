/* oxlint-disable sonarjs/expression-complexity -- Compare the complete immutable resource/reference tuple without changing frozen legacy receipt meaning. */
import { isDeepStrictEqual } from "node:util";
import type {
  CentralIntegrationHostReadyReceipt,
  ReadCentralIntegrationHostReady,
} from "./app-integration-central-authority";
import type { AppIntegrationCapabilityPlan } from "./app-integration-capability-contract";
import {
  existingPlatformIntegrationPlanReference,
  existingPlatformIntegrationReadySchema,
} from "./existing-platform-integration-contract";
import type { ExistingPlatformIntegrationReady } from "./existing-platform-integration-contract";
import { AppIntegrationCapabilityPrerequisiteError } from "./app-integration-capability-prerequisite";

export type AppIntegrationCentralReference =
  | CentralIntegrationHostReadyReceipt
  | ExistingPlatformIntegrationReady;
export type ReadExistingPlatformIntegrationReady = (
  scope: Parameters<ReadCentralIntegrationHostReady>[0] & { appInstallationId?: string },
) => Promise<ExistingPlatformIntegrationReady | undefined>;
export const readAppIntegrationCentralReference = async (input: {
  planVersion: 1 | 2 | 3;
  scope: Parameters<ReadCentralIntegrationHostReady>[0] & { appInstallationId?: string };
  readLegacy?: ReadCentralIntegrationHostReady;
  readExisting?: ReadExistingPlatformIntegrationReady;
}): Promise<AppIntegrationCentralReference> => {
  if (input.planVersion === 3) {
    const value = await input.readExisting?.(input.scope);
    if (value === undefined) {
      throw new AppIntegrationCapabilityPrerequisiteError(
        "app_integration_existing_platform_required",
      );
    }
    return existingPlatformIntegrationReadySchema.parse(value);
  }
  const { appInstallationId, ...legacyScope } = input.scope;
  void appInstallationId;
  const value = await input.readLegacy?.(legacyScope);
  if (value === undefined) {
    throw new AppIntegrationCapabilityPrerequisiteError("app_integration_central_host_required");
  }
  return value;
};
export const appIntegrationCentralReferenceMatches = (
  plan: AppIntegrationCapabilityPlan,
  central: AppIntegrationCentralReference,
) => {
  if (plan.version === 3) {
    if (central.kind !== "existing-platform-integrations-ready-v1") {
      return false;
    }
    const { runtimeRole, ...resource } = plan.control.database;
    void runtimeRole;
    return (
      isDeepStrictEqual(
        plan.control.existingPlatform,
        existingPlatformIntegrationPlanReference(central),
      ) &&
      plan.control.origin === central.deployment.immutableOrigin &&
      plan.control.resourceProfileId === central.resourceProfileId &&
      isDeepStrictEqual(resource, central.control.resource) &&
      isDeepStrictEqual(plan.control.neon, central.control.neon) &&
      plan.control.schema.sha256 === central.control.schemaSha256 &&
      plan.control.activationKeyId === central.activation.keyId &&
      plan.control.activationPublicKeySha256 === central.activation.publicKeySha256 &&
      plan.provider.kind === central.provider.kind &&
      plan.provider.projectId === central.provider.projectId &&
      plan.provider.integrationId === central.provider.integrationId
    );
  }
  const old = plan.control.centralHostSetup;
  return (
    central.kind === "central-integration-host-ready-v1" &&
    old !== undefined &&
    central.setup.operationRef === old.operationRef &&
    central.setup.planDigest === old.planDigest &&
    central.callerSetup.operationRef === old.callerOperationRef &&
    central.callerSetup.planDigest === old.callerPlanDigest &&
    central.deployment.providerDeploymentId === old.providerDeploymentId &&
    central.caller.trustedSourcesGrantSha256 === old.trustedSourcesGrantSha256
  );
};
