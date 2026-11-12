import { defineState } from "eve/context";
import { readPrivateApplyAuthority } from "./private-apply-authority";
import { appBuilderWorkflowState } from "./workflow-state";

const initialBuildPlan = defineState<{ sessionId: string; proposalDigest: string } | null>(
  "autograph-app-builder.initial-build-plan.v1",
  () => null,
);

/** Freezing a new build-ready plan permits drafting the card in this session. */
export const recordInitialBuildAuthoring = (sessionId: string): void => {
  const state = appBuilderWorkflowState.get();
  if (state.phase === "planned" && !("operation" in state.proposal.target)) {
    initialBuildPlan.update(() => ({ sessionId, proposalDigest: state.proposal.digest }));
  }
};

export const currentInitialBuildAuthoring = (sessionId: string): string | undefined => {
  const plan = initialBuildPlan.get();
  const state = appBuilderWorkflowState.get();
  if (
    state.phase !== "planned" ||
    "operation" in state.proposal.target ||
    plan?.sessionId !== sessionId ||
    plan.proposalDigest !== state.proposal.digest
  ) {
    return undefined;
  }
  const { grant, terminalDecisions } = readPrivateApplyAuthority();
  const decided = [grant, ...(terminalDecisions ?? []).map(({ scope }) => scope)].some(
    (scope) => scope?.proposalDigest === plan.proposalDigest && scope.sessionId === sessionId,
  );
  return decided ? undefined : plan.proposalDigest;
};
