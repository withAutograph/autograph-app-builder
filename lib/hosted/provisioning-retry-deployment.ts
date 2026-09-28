import { createPostgresPreviewOrganizationAuthority } from "../auth/postgres-organization-user-authority";
import { builderResourceProvisioningFlag } from "../feature-flags";
import { createBuilderProvisioningDependencies } from "../provisioning/deployment";
import { updateBuilderProvisionJournal } from "../provisioning/journal";
import { executeBuilderProvisioning } from "../provisioning/service";
import { retryDueProvisioning } from "./provisioning-retry-worker";

/** Resume only previously authorized, due work after checking live membership. */
export const retryDueProvisioningDeployment = async (
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Promise<{ paused: number; resumed: number }> => {
  if (!(await builderResourceProvisioningFlag())) {
    return { paused: 0, resumed: 0 };
  }
  const { database, dependencies, preview } = createBuilderProvisioningDependencies(environment);
  const { journal } = dependencies;
  const { listDue } = journal;
  if (!listDue) {
    throw new Error("Durable provisioning retry discovery is unavailable.");
  }
  const membership = createPostgresPreviewOrganizationAuthority(database, {
    audience: preview.resource,
    issuer: preview.issuer,
  });
  return await retryDueProvisioning({
    execute: async (item) => {
      const current = await journal.read({ authority: item.authority, requestId: item.requestId });
      if (!current || current.record.response[item.operation].status === "succeeded") {
        return;
      }
      await executeBuilderProvisioning({
        authority: item.authority,
        dependencies,
        request: { ...current.record.request, operation: item.operation },
      });
    },
    isActiveMember: async (authority) => await membership.isActiveMember(authority),
    listDue: async (input) => await listDue(input),
    pauseForRevokedAccess: async (item) => {
      await updateBuilderProvisionJournal({
        authority: item.authority,
        requestId: item.requestId,
        store: journal,
        update(current) {
          const state = current.operations[item.operation];
          if (state.nextRetryAt === undefined) {
            return current;
          }
          delete state.nextRetryAt;
          state.failureDetail = "membership-revoked";
          state.outcomeKnown = true;
          current.response[item.operation] = {
            code: "authorization_required",
            retryable: false,
            status: "failed",
          };
          return current;
        },
      });
    },
  });
};
