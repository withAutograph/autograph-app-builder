import type { HostedOperatorPlan } from "./hosted-operator-contract";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";
import type { AppGatewayDeliverySource } from "./hosted-operator-app-gateway-source-successor";

/** Preserve the canonical approved draft source while applying the configured owned project scope. */
export const gatewayDeliverySourceForPlan = (
  configuration: {
    gateway: Pick<
      HostedOperatorSourceConfiguration["gateway"],
      "branch" | "gitSha" | "projectId" | "repoId"
    >;
  },
  currentPlan?: HostedOperatorPlan,
): AppGatewayDeliverySource & { gitSha: string } => {
  const publishedSha =
    currentPlan?.stage === "app" && currentPlan.delivery?.repoId === configuration.gateway.repoId
      ? currentPlan.delivery.gitSha
      : undefined;
  const frozenBootstrapSource =
    currentPlan?.stage !== "app" && currentPlan?.gatewayDelivery?.gitRef !== undefined
      ? currentPlan.gatewayDelivery
      : undefined;
  const source: Pick<AppGatewayDeliverySource, "branch" | "gitRef"> = {
    branch: configuration.gateway.branch,
  };
  if (frozenBootstrapSource !== undefined) {
    source.gitRef = frozenBootstrapSource.gitRef;
  }
  return {
    ...source,
    gitSha: publishedSha ?? frozenBootstrapSource?.gitSha ?? configuration.gateway.gitSha,
    projectId: configuration.gateway.projectId,
    repoId: configuration.gateway.repoId,
  };
};
