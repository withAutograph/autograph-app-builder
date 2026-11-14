import type { ToolContext } from "eve/tools";

import type { ImmutableGitHubSourceReceipt } from "../repository/github-publication";
import { githubPublicationRuntimeForSession } from "./deployment-github-publication-runtime";
import type { DraftReconciliationCandidate } from "./draft-reconciliation-state";
import type { DraftReviewedWorkflow } from "./draft-reviewed-lineage";
import { draftInspectionRecoveryForSession } from "./prepare-published-draft-repair";
import { draftCandidateInstallation } from "./published-draft-repair";

/** Verify the live provider draft immediately before touching its private generated release. */
export const assertOwnedDraftSchemaCandidate = async (input: {
  candidate: DraftReconciliationCandidate;
  ctx: ToolContext;
  source: ImmutableGitHubSourceReceipt;
  state: DraftReviewedWorkflow;
  expectedInstallationId?: string;
}): Promise<void> => {
  const { candidate, ctx, source, state, expectedInstallationId } = input;
  const { owner, name, repositoryId } = source.repository;
  const priorPublishedProposalDigest =
    candidate.publishedOrigin?.publicationProposalDigest ??
    candidate.publicationScope?.proposal.digest ??
    state.publishedGitHubDraftProposalDigest ??
    state.githubDraftProposal?.proposal.digest;
  if (
    candidate.kind === "published-draft-repair" ||
    candidate.appId !== state.appSpec.appId ||
    candidate.repositoryId !== repositoryId ||
    priorPublishedProposalDigest === undefined
  ) {
    throw new Error("Prepare ordinary reconciliation for this app's owned draft first.");
  }
  const retainedInstallationId =
    draftCandidateInstallation(candidate)?.selectedInstallationId ??
    state.githubDestinationReview?.installation.installationId;
  if (
    expectedInstallationId !== undefined &&
    retainedInstallationId !== undefined &&
    retainedInstallationId !== expectedInstallationId
  ) {
    throw new Error("The verified draft installation changed before schema recovery.");
  }
  const installationId = expectedInstallationId ?? retainedInstallationId;
  const runtime = await githubPublicationRuntimeForSession(
    ctx.session.auth,
    installationId === undefined ? undefined : { selectedInstallationId: installationId },
  );
  const [{ draft, base, publishedHeadSha }, publication] = await Promise.all([
    runtime.inspectExistingDraftReconciliationSource({
      name,
      owner,
      priorPublishedProposalDigest,
      pullRequestNumber: candidate.pullRequestNumber,
      recovery: draftInspectionRecoveryForSession({
        ctx,
        appId: candidate.appId,
        appSpecDigest: state.appSpec.digest,
        root: candidate.root,
        pullRequestNumber: candidate.pullRequestNumber,
        priorPublishedProposalDigest,
      }),
      repositoryId,
    }),
    runtime.readSucceededDraftPublication?.(priorPublishedProposalDigest),
  ]);
  const exactLiveCandidate = [
    publication !== undefined,
    draft.state === "open",
    draft.draft,
    draft.repositoryId === repositoryId,
    draft.number === candidate.pullRequestNumber,
    draft.pullRequestId === publication?.pullRequestId,
    draft.verifiedBuilderOrigin?.marker === publication?.idempotencyKey,
    draft.headSha === candidate.headSha,
    draft.headTree === candidate.headTree,
    publishedHeadSha === candidate.headSha,
    base.headSha === candidate.baseSha,
    base.headTree === candidate.baseTree,
  ].every(Boolean);
  if (!exactLiveCandidate) {
    throw new Error(
      "The owned draft or its base has changed. Prepare current reconciliation before editing.",
    );
  }
};
