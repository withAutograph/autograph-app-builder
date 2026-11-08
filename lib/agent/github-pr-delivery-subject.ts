import type { AppBuilderWorkflowState } from "./workflow-state";
import type { DraftReconciliationCandidate } from "./draft-reconciliation-state";
import type { ExistingDraftReconciliationProposal } from "../repository/github-draft-reconciliation";
import { resolveDraftReviewedWorkflow } from "./draft-reviewed-lineage";
import { currentDraftCandidateSource, draftCandidateInstallation } from "./published-draft-repair";

interface GitHubPrDeliverySubject {
  proposalDigest: string;
  installationId?: string;
  reconciliation?: ExistingDraftReconciliationProposal;
}

/** Select retained publication provenance, never private candidate bytes or approval. */
export const resolveGitHubPrDeliverySubject = (
  workflow: AppBuilderWorkflowState,
  candidate: DraftReconciliationCandidate | null,
): GitHubPrDeliverySubject | undefined => {
  const reviewed = resolveDraftReviewedWorkflow(workflow, candidate);
  if (reviewed === undefined) {
    return undefined;
  }
  const currentCandidate =
    candidate?.appId === reviewed.appSpec.appId &&
    currentDraftCandidateSource(workflow, candidate) !== undefined
      ? candidate
      : undefined;
  const origin =
    currentCandidate?.kind === "published-draft-repair"
      ? currentCandidate.repair
      : currentCandidate?.publishedOrigin;
  const proposalDigest =
    origin?.publicationProposalDigest ??
    reviewed.publishedGitHubDraftProposalDigest ??
    reviewed.githubDraftProposal?.proposal.digest;
  if (proposalDigest === undefined) {
    return undefined;
  }
  const installationId =
    (currentCandidate === undefined
      ? undefined
      : draftCandidateInstallation(currentCandidate)?.selectedInstallationId) ??
    reviewed.githubDestinationReview?.installation.installationId;
  return {
    proposalDigest,
    installationId,
    reconciliation: currentCandidate?.publishedReconciliation,
  };
};
