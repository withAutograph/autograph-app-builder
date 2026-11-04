import { appIntegrationCapabilityOperationRef } from "./app-integration-capability-contract";
import { isDeepStrictEqual } from "node:util";
import type {
  AppIntegrationCapabilityPlan,
  IntegrationCapabilityReceipt,
  PreparedAppIntegrationCapability,
} from "./app-integration-capability-contract";

const assertProviderDestinationReceipt = (
  plan: AppIntegrationCapabilityPlan,
  receipt: Extract<IntegrationCapabilityReceipt, { effect: "prepare-provider-destination" }>,
) => {
  const target = plan.providerDestination;
  if (plan.version !== 2 || target === undefined) {
    throw new Error("app_integration_capability_receipt_unavailable");
  }
  const matches = [
    receipt.name === target.name,
    receipt.url === new URL(target.path, target.origin).href,
    target.existing === undefined ||
      isDeepStrictEqual(target.existing, {
        destinationId: receipt.destinationId,
        secretRef: receipt.secretRef,
        secretSha256: receipt.secretSha256,
      }),
  ];
  if (matches.includes(false)) {
    throw new Error("app_integration_capability_receipt_unavailable");
  }
};

/** A fixed worker's bounded response still has to match every approved resource/service scope. */
export const assertIntegrationCapabilityReceipt = (
  plan: AppIntegrationCapabilityPlan,
  receipt: IntegrationCapabilityReceipt,
  attemptGeneration?: number,
) => {
  const unavailable = () => new Error("app_integration_capability_receipt_unavailable");
  switch (receipt.effect) {
    case "prepare-provider-destination": {
      assertProviderDestinationReceipt(plan, receipt);
      break;
    }
    case "prepare-control-database":
      if (
        receipt.resourceId !== plan.control.database.resourceId ||
        receipt.database !== plan.control.database.database ||
        receipt.runtimeRole !== plan.control.database.runtimeRole ||
        receipt.migratorRole !== plan.control.database.migratorRole
      )
        throw unavailable();
      break;
    case "install-control-schema":
      if (receipt.schemaSha256 !== plan.control.schema.sha256) throw unavailable();
      break;
    case "bind-service-memberships": {
      const expected = new Map(
        plan.serviceMemberships.map((member) => [member.organizationId, member]),
      );
      if (
        receipt.memberships.length !== expected.size ||
        new Set(receipt.memberships.map((member) => member.organizationId)).size !==
          expected.size ||
        receipt.memberships.some(
          ({ fenceGeneration, ...member }) =>
            !isDeepStrictEqual(expected.get(member.organizationId), member) ||
            (attemptGeneration !== undefined && fenceGeneration !== attemptGeneration),
        )
      )
        throw unavailable();
      break;
    }
    case "register-central-app":
      const valid=[receipt.appId===plan.selection.appId,receipt.registrationRef===appIntegrationCapabilityOperationRef(plan),receipt.resourceProfileId===plan.control.resourceProfileId,attemptGeneration===undefined||receipt.principalGeneration===attemptGeneration];
      if(valid.includes(false)){
        throw unavailable();
      }
      break;
  }
};
export const assertPreparedIntegrationCapability = (
  plan: AppIntegrationCapabilityPlan,
  capability: PreparedAppIntegrationCapability,
  receipts: readonly IntegrationCapabilityReceipt[],
) => {
  const projectResource = (resource: AppIntegrationCapabilityPlan["control"]["database"]) => ({
    resourceId: resource.resourceId,
    hostname: resource.hostname,
    port: resource.port,
    database: resource.database,
    schema: resource.schema,
    runtimeRole: resource.runtimeRole,
  });
  const appDatabase = projectResource(plan.runtime.appDatabase);
  const controlDatabase = projectResource(plan.control.database);
  const memberships = receipts.find((receipt) => receipt.effect === "bind-service-memberships");
  const registration = receipts.find((receipt) => receipt.effect === "register-central-app");
  const destination = receipts.find((receipt) => receipt.effect === "prepare-provider-destination");
  if (plan.version === 2 && destination?.effect !== "prepare-provider-destination") {
    throw new Error("app_integration_capability_receipt_unavailable");
  }
  const expected = {
    kind: "app-integrations-development-v1",
    appId: plan.selection.appId,
    environment: "development",
    resourceProfile: "isolated-development",
    release: {
      id: plan.release.id,
      manifestSha256: plan.release.manifestSha256,
      artifactSha256: plan.release.artifactSha256,
    },
    appDatabase,
    control: {
      origin: plan.control.origin,
      resourceProfileId: plan.control.resourceProfileId,
      database: controlDatabase,
      activationKeyId: plan.control.activationKeyId,
      activationPublicKeySha256: plan.control.activationPublicKeySha256,
      principalGeneration:
        registration?.effect === "register-central-app"
          ? registration.principalGeneration
          : undefined,
    },
    provider: plan.provider,
    ...(destination?.effect === "prepare-provider-destination"
      ? {
          providerDestination: {
            destinationId: destination.destinationId,
            name: destination.name,
            url: destination.url,
            secretSha256: destination.secretSha256,
          },
        }
      : {}),
    serviceMemberships:
      memberships?.effect === "bind-service-memberships" ? memberships.memberships : undefined,
    ...(plan.machineIngress === undefined ? {} : { machineIngress: plan.machineIngress }),
    privateConfiguration: capability.privateConfiguration,
  };
  if (!isDeepStrictEqual(capability, expected)) {
    throw new Error("app_integration_capability_receipt_unavailable");
  }
};
