import type {
  AppBuilderWorkflowState,
  AppCreationProposal,
} from "./workflow-state";

export function plannedProposalForExecution(
  state: AppBuilderWorkflowState,
  expectedProposalDigest: string,
): AppCreationProposal {
  if (state.phase !== "planned")
    throw new Error(
      "Derive a canonical AppSpec-bound proposal before checking target command readiness.",
    );
  if (state.proposal.digest !== expectedProposalDigest)
    throw new Error(
      "The canonical proposal changed before execution readiness.",
    );
  return state.proposal;
}

export function targetExecutionBlockers(input: {
  imageConfigured: boolean;
  toolchainReady: boolean;
}): string[] {
  const blockers: string[] = [];
  if (!input.imageConfigured)
    blockers.push("No immutable sandbox image is configured.");
  if (!input.toolchainReady)
    blockers.push(
      "The sandbox does not prove the exact required Git, mise, and Bun toolchain.",
    );
  return blockers;
}
