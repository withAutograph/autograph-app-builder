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
  approval: always(),
  description:
    "After you approve creating a draft pull request, publish the current reviewed changes to GitHub. GitHub decides whether the account can write the repository and reports any real conflict or permission error. Approval is required only for this outward effect.",
  async execute(input, ctx) {
    const state = appBuilderWorkflowState.get();
    if (
      state.phase !== "reviewed" ||
      state.githubDraftProposal === undefined ||
      state.githubSource === undefined
    )
      {throw new Error(
        "Choose a repository and finish the implementation plan before opening a draft pull request.",
      );}
    assertApprovalReceipt({
      actual: input.approvalReceipt,
      phase: "publication",
      subjectDigest: state.githubDraftProposal.proposal.digest,
      target: approvalTargetFromGitHubSource(state.githubSource),
    });
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
