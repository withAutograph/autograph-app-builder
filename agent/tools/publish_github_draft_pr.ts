import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import {
  approvalReceiptSchema,
  approvalTargetFromGitHubSource,
  assertApprovalReceipt,
} from "@/lib/agent/approval-receipt";
import { githubPublicationRuntimeForSession } from "@/lib/agent/deployment-github-publication-runtime";
import { publicationContentSourceForReviewedWorkflow } from "@/lib/agent/github-publication-content-source";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";

export default defineTool({
  description:
    "After you approve creating a draft pull request, publish the current reviewed changes to GitHub. GitHub decides whether the account can write the repository and reports any real conflict or permission error. Approval is required only for this outward effect.",
  inputSchema: z.strictObject({
    expectedProposalDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    approvalReceipt: approvalReceiptSchema,
  }),
  approval: always(),
  async execute(input, ctx) {
    const state = appBuilderWorkflowState.get();
    if (
      state.phase !== "reviewed" ||
      state.githubDraftProposal === undefined ||
      state.githubSource === undefined
    )
      throw new Error(
        "Choose a repository and finish the implementation plan before opening a draft pull request.",
      );
    assertApprovalReceipt({
      actual: input.approvalReceipt,
      phase: "publication",
      target: approvalTargetFromGitHubSource(state.githubSource),
      subjectDigest: state.githubDraftProposal.proposal.digest,
    });
    const sandbox = await ctx.getSandbox();
    const contentSource = await publicationContentSourceForReviewedWorkflow({
      state,
      sandbox,
    });
    const runtime = await githubPublicationRuntimeForSession(ctx.session.auth);
    return runtime.publishDraftPullRequest({
      expectedProposalDigest: state.githubDraftProposal.proposal.digest,
      approvalReceipt: input.approvalReceipt,
      review: state.reviewReceipt,
      contentSource,
      approvedByCallId: ctx.callId,
    });
  },
});
