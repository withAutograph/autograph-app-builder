import type { HostedOperatorPlan } from "./hosted-operator-contract";

/** Keep the browser entrypoint separate from the observed Gateway transport URL. */
export const createHostedOperatorPublicGateway = (inventory: {
  gateway: { branch: string; projectId: string };
  verification: { publicOrigin: string };
}): NonNullable<HostedOperatorPlan["publicGateway"]> => ({
  branch: inventory.gateway.branch,
  origin: inventory.verification.publicOrigin,
  projectId: inventory.gateway.projectId,
});
