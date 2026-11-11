import type { WorkflowStepToolContext } from "eve/tools";
import {
  repositoryProductionDeliveryStatusSchema,
  repositoryProductionDeliveryTargetSchema,
} from "../provisioning/repository-production-delivery";
import type { RepositoryProductionDeliveryStatus } from "../provisioning/repository-production-delivery";
import {
  managedProductionDeliveryRequirements,
  retainManagedProductionDeliveryRequirement,
} from "./production-delivery-requirement";
import type { ManagedProductionDeliveryRequirement } from "./production-delivery-requirement";

interface Target {
  appId: string;
  repositoryId: string;
  repositoryFullName: string;
}

/** A known GitHub-only deployment stays generic; loss of previously observed service authority does not. */
export const resolveGitHubProductionDeliveryReadiness = async (input: {
  target: Target;
  operatorConfigured: boolean;
  requirements: readonly ManagedProductionDeliveryRequirement[];
  read: () => Promise<RepositoryProductionDeliveryStatus>;
  retain: (requirement: ManagedProductionDeliveryRequirement) => void;
}): Promise<RepositoryProductionDeliveryStatus> => {
  const { appId, repositoryId, repositoryFullName } = input.target;
  repositoryProductionDeliveryTargetSchema.parse({ repositoryId, repositoryFullName });
  const retained = input.requirements.find(
    (entry) => entry.appId === appId && entry.repositoryId === repositoryId,
  );
  if (!input.operatorConfigured) {
    if (retained !== undefined) {
      throw new Error(
        "Builder must restore this app’s saved Production setup service before merging. Its app, destination and setup are retained.",
      );
    }
    return { version: 1, appId, repositoryId, repositoryFullName, applicable: false };
  }
  const result = repositoryProductionDeliveryStatusSchema.parse(await input.read());
  if (
    result.appId !== appId ||
    result.repositoryId !== repositoryId ||
    result.repositoryFullName !== repositoryFullName
  ) {
    throw new Error(
      "Builder could not confirm Production setup for this reviewed app and repository.",
    );
  }
  if (!result.applicable) {
    if (retained !== undefined) {
      throw new Error(
        "Builder must restore this app’s existing managed Production destination before merging. Keep its original setup.",
      );
    }
    return result;
  }
  input.retain({ appId, repositoryId, repositoryFullName, operationRef: result.operationRef });
  return result;
};

export const githubProductionSetupContinuation = (
  setup: Extract<RepositoryProductionDeliveryStatus, { applicable: true }>,
) => ({
  tool: setup.preparationRequired ? "plan-app-production" : "get-app-production",
  input: { appId: setup.appId },
});

/** The app, repository and head come from the saved publication and its current GitHub observation. */
export const readGitHubProductionDeliveryReadiness = async (
  target: Target & { reviewedHeadSha: string },
  ctx: WorkflowStepToolContext,
  projection?: {
    requirements: readonly ManagedProductionDeliveryRequirement[];
    retain: (requirement: ManagedProductionDeliveryRequirement) => void;
  },
): Promise<RepositoryProductionDeliveryStatus> => {
  const { repositoryProductionClientForContext } = await import("./repository-production-client");
  return await resolveGitHubProductionDeliveryReadiness({
    target,
    operatorConfigured: Boolean(process.env.REPOSITORY_PRODUCTION_OPERATOR_URL),
    requirements: projection?.requirements ?? managedProductionDeliveryRequirements.get(),
    retain: projection?.retain ?? retainManagedProductionDeliveryRequirement,
    read: async () => {
      const client = await repositoryProductionClientForContext(ctx);
      return await client.deliveryStatus(target.appId, {
        repositoryId: target.repositoryId,
        repositoryFullName: target.repositoryFullName,
        reviewedHeadSha: target.reviewedHeadSha,
      });
    },
  });
};
