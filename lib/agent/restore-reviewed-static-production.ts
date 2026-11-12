import type { ToolContext } from "eve/tools";
import { hostedOperatorCallbackExecution } from "../provisioning/hosted-operator-callback-owner";
import {
  hasCapturedStaticDescriptionForSession,
  publishCompiledOperatorArtifactsForSession,
} from "./compiled-operator-artifacts";
import { githubPublicationRuntimeForSession } from "./deployment-github-publication-runtime";
import {
  appBuilderWorkflowState,
  assertCurrentGitHubDraftProposal,
  assertExactWorkflowState,
} from "./workflow-state";

/** Restore older frontend metadata from the same approved checkout and still-current published draft. */
export const restoreReviewedStaticProduction = async (appId: string, ctx: ToolContext) => {
  const state = appBuilderWorkflowState.get();
  if (
    state.phase !== "reviewed" ||
    state.appBackendKind !== "static" ||
    state.appSpec.appId !== appId
  ) {
    return false;
  }
  const digest = state.githubDraftProposal?.proposal.digest;
  if (digest === undefined || (state.publishedGitHubDraftProposalDigest ?? digest) !== digest) {
    return false;
  }
  const capture = {
    adapterSessionId: ctx.session.id,
    callbackExecution: hostedOperatorCallbackExecution(ctx.session),
    appId,
    appSpecDigest: state.appSpec.digest,
    callId: ctx.callId,
    root: state.applyReceipt.applyRoot,
    sessionAuth: ctx.session.auth,
    signal: ctx.abortSignal,
  };
  if (await hasCapturedStaticDescriptionForSession(capture)) {
    return false;
  }
  const proposal = assertCurrentGitHubDraftProposal({
    binding: state.githubDraftProposal,
    changeSetDigest: state.reviewReceipt.changeSetDigest,
    destinationReview: state.githubDestinationReview,
    expectedProposalDigest: digest,
    githubSource: state.githubSource,
    reviewDigest: state.reviewReceipt.digest,
    sourceReceiptDigest: state.sourceReceipt.digest,
  });
  const selectedInstallationId = state.githubDestinationReview?.installation.installationId;
  const publication = await githubPublicationRuntimeForSession(
    ctx.session.auth,
    selectedInstallationId === undefined ? undefined : { selectedInstallationId },
  );
  const observed = await publication.inspectPublishedPullRequest?.(proposal.digest);
  if (observed?.state !== "open" || !observed.reviewedRevision) {
    return false;
  }
  ctx.abortSignal?.throwIfAborted();
  const [sandbox, { exactNormalizedChangeSet }] = await Promise.all([
    ctx.getSandbox(),
    import("../../agent/tools/change_set_status"),
  ]);
  const assertStaticRecoverySource = async () => {
    ctx.abortSignal?.throwIfAborted();
    assertExactWorkflowState(appBuilderWorkflowState.get(), state, "frontend Production recovery");
    const current = await exactNormalizedChangeSet({ sandbox, state });
    if (current.digest !== state.reviewReceipt.changeSetDigest) {
      throw new Error("The current frontend source differs from its reviewed draft.");
    }
    assertExactWorkflowState(appBuilderWorkflowState.get(), state, "frontend Production recovery");
  };
  await publishCompiledOperatorArtifactsForSession({
    ...capture,
    assertStaticRecoverySource,
    sandbox,
  });
  return true;
};
