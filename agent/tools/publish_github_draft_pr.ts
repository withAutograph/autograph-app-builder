import { hostedOperatorCallbackExecution } from "@/lib/provisioning/hosted-operator-callback-owner";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import {
  approvalReceiptSchema,
  approvalTargetFromDraftProposal,
  assertApprovalReceipt,
} from "@/lib/agent/approval-receipt";
import { githubPublicationRuntimeForSession } from "@/lib/agent/deployment-github-publication-runtime";
import { publicationContentSourceForReviewedWorkflow } from "@/lib/agent/github-publication-content-source";
import {
  appBuilderWorkflowState,
  assertCurrentGitHubDraftProposal,
} from "@/lib/agent/workflow-state";
import { appBaselineState } from "@/lib/agent/app-baseline-state";
import { recordPublishedAppSourceForSession } from "@/lib/agent/published-app-source";
import { assertExistingAppReviewScope } from "@/lib/repository/reviewed-change-set";

export default defineTool({
  approval: always(),
  description:
    "After you approve creating a draft pull request, publish the current reviewed changes to GitHub. After a reviewed-path-changed rejection, refresh and review the changes, reseal the proposal, and obtain fresh publication approval; this operation verifies branch and pull-request absence before recovering the rejected attempt. GitHub decides whether the account can write the repository and reports any real conflict or permission error. Approval is required only for this outward effect.",
  async execute(input, ctx) {
    const state = appBuilderWorkflowState.get();
    if (state.phase !== "reviewed" || state.githubDraftProposal === undefined) {
      throw new Error(
        "Choose a repository and finish the implementation plan before opening a draft pull request.",
      );
    }
    if (input.expectedProposalDigest !== state.githubDraftProposal.proposal.digest) {
      throw new Error(
        "The publication request names a different draft-PR proposal. Reopen the current sealed proposal before approving publication.",
      );
    }
    let selectedInstallationId: string | undefined;
    if (state.githubSource === undefined) {
      if (
        state.sourceReceipt.sourceKind !== "fresh-template" ||
        state.githubDestinationReview === undefined
      ) {
        throw new Error("Restore the selected GitHub source before publishing its draft.");
      }
      assertCurrentGitHubDraftProposal({
        binding: state.githubDraftProposal,
        changeSetDigest: state.reviewReceipt.changeSetDigest,
        destinationReview: state.githubDestinationReview,
        expectedProposalDigest: input.expectedProposalDigest,
        reviewDigest: state.reviewReceipt.digest,
        sourceReceiptDigest: state.sourceReceipt.digest,
      });
      selectedInstallationId = state.githubDestinationReview.installation.installationId;
    }
    assertApprovalReceipt({
      actual: input.approvalReceipt,
      phase: "publication",
      subjectDigest: state.githubDraftProposal.proposal.digest,
      target: approvalTargetFromDraftProposal(state.githubDraftProposal.proposal),
    });
    assertExistingAppReviewScope(
      state.reviewReceipt,
      state.appSpec.appId,
      state.sourceReceipt.sourceKind,
      appBaselineState.get()?.receipt,
    );
    const sandbox = await ctx.getSandbox();
    const contentSource = await publicationContentSourceForReviewedWorkflow({
      sandbox,
      state,
    });
    const runtime =
      selectedInstallationId === undefined
        ? await githubPublicationRuntimeForSession(ctx.session.auth)
        : await githubPublicationRuntimeForSession(ctx.session.auth, { selectedInstallationId });
    const publication = await runtime.publishDraftPullRequest({
      approvalReceipt: input.approvalReceipt,
      approvedByCallId: ctx.callId,
      contentSource,
      expectedProposalDigest: state.githubDraftProposal.proposal.digest,
      review: state.reviewReceipt,
    });
    try {
      const recording = await recordPublishedAppSourceForSession({
        appId: state.appSpec.appId,
        appSpecDigest: state.appSpec.digest,
        backendKind: state.appBackendKind,
        root: state.applyReceipt.applyRoot,
        adapterSessionId: ctx.session.id,
        callbackExecution: hostedOperatorCallbackExecution(ctx.session),
        sessionAuth: ctx.session.auth,
        callId: ctx.callId,
        review: state.reviewReceipt,
        publication,
      });
      return { ...publication, appSourceRecording: { status: recording.status } };
    } catch {
      return {
        ...publication,
        appSourceRecording: {
          status: "unavailable" as const,
          recoveryRequired: true,
          nextAction:
            "Resume this approved publication to record its source for Preview; the GitHub publication already succeeded. Preview source preparation remains unavailable until recording succeeds.",
        },
      };
    }
  },
  inputSchema: z.strictObject({
    approvalReceipt: approvalReceiptSchema,
    expectedProposalDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
});
