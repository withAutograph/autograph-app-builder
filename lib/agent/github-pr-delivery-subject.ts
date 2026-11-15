import { isDeepStrictEqual } from "node:util";
import { assertCurrentGitHubDraftProposal } from "./workflow-state";
import type { AppBuilderWorkflowState } from "./workflow-state";
import type { DraftReconciliationCandidate } from "./draft-reconciliation-state";
import type { ExistingDraftReconciliationProposal } from "../repository/github-draft-reconciliation";
import { resolveDraftReviewedWorkflow } from "./draft-reviewed-lineage";
import { currentDraftCandidateSource, draftCandidateInstallation } from "./published-draft-repair";

interface GitHubPrDeliverySubject {
  appId: string;
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
    appId: reviewed.appSpec.appId,
    proposalDigest,
    installationId,
    reconciliation: currentCandidate?.publishedReconciliation,
  };
};

/** An inherited draft can still be useful for recovery but cannot prove the current revision live. */
export const resolveSavedGitHubPrObservationSubject = (
  workflow: AppBuilderWorkflowState,
  candidate: DraftReconciliationCandidate | null,
): GitHubPrDeliverySubject | null => {
  const subject = resolveGitHubPrDeliverySubject(workflow, candidate);
  if (subject === undefined) {
    return null;
  }
  const { reconciliation } = subject;
  if (reconciliation !== undefined) {
    return isDeepStrictEqual(candidate?.proposal, reconciliation) &&
      candidate?.review?.digest === reconciliation.reviewDigest
      ? subject
      : null;
  }
  const reviewed = resolveDraftReviewedWorkflow(workflow, candidate);
  const binding = reviewed?.githubDraftProposal;
  if (reviewed === undefined || binding === undefined) {
    return null;
  }
  const proposal = assertCurrentGitHubDraftProposal({
    binding,
    expectedProposalDigest: binding.proposal.digest,
    reviewDigest: reviewed.reviewReceipt.digest,
    changeSetDigest: reviewed.reviewReceipt.changeSetDigest,
    sourceReceiptDigest: reviewed.sourceReceipt.digest,
    githubSource: reviewed.githubSource,
    destinationReview: reviewed.githubDestinationReview,
  });
  // The provider will resolve the successful receipt for this sealed review's digest.
  return { ...subject, proposalDigest: proposal.digest };
};
