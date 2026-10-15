import type { HostedOperatorPlan, OperatorDeploymentCandidate } from "./hosted-operator-contract";

/** Failure-triggered source recovery guidance; unchanged-source retries retain their existing semantics. */
export const hasFailedGatewayDelivery = (
  input: {
    effect: { kind: string };
    operationRef: string;
    plan: Pick<HostedOperatorPlan, "gatewayDelivery">;
  },
  observed: { status: string; candidates?: OperatorDeploymentCandidate[] },
  configuredGitSha: string,
) => {
  if (
    input.effect.kind !== "gateway-delivery" ||
    observed.status !== "retryable" ||
    observed.candidates === undefined
  ) {
    return false;
  }
  return (
    observed.candidates.length > 0 &&
    configuredGitSha !== input.plan.gatewayDelivery?.gitSha &&
    observed.candidates.every(
      (candidate) =>
        candidate.operationRef === input.operationRef &&
        ["ERROR", "CANCELED"].includes(candidate.readyState) &&
        candidate.gatewayAliasAttempted !== true,
    )
  );
};
