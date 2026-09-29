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
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { appBaselineState } from "@/lib/agent/app-baseline-state";
import { assertExistingAppReviewScope } from "@/lib/repository/reviewed-change-set";

export default defineTool({
  approval: always(),
  description:
    "After you approve creating a draft pull request, publish the current reviewed changes to GitHub. GitHub decides whether the account can write the repository and reports any real conflict or permission error. Approval is required only for this outward effect.",
  async execute(input, ctx) {
    const state = appBuilderWorkflowState.get();
    if (
      state.phase !== "reviewed" ||
      state.githubDraftProposal === undefined ||
      state.githubSource === undefined
    ) {
      throw new Error(
        "Choose a repository and finish the implementation plan before opening a draft pull request.",
      );
    }
    if (input.expectedProposalDigest !== state.githubDraftProposal.proposal.digest) {
      throw new Error(
        "The publication request names a different draft-PR proposal. Reopen the current sealed proposal before approving publication.",
      );
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
    const runtime = await githubPublicationRuntimeForSession(ctx.session.auth);
    return runtime.publishDraftPullRequest({
      approvalReceipt: input.approvalReceipt,
      approvedByCallId: ctx.callId,
      contentSource,
      expectedProposalDigest: state.githubDraftProposal.proposal.digest,
      review: state.reviewReceipt,
    });
  },
  inputSchema: z.strictObject({
    approvalReceipt: approvalReceiptSchema,
    expectedProposalDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
});
