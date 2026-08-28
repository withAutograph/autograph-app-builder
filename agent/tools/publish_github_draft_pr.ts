import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import {
  approvalReceiptSchema,
  approvalTargetFromGitHubSource,
  assertApprovalReceipt,
} from "@/lib/agent/approval-receipt";
import { publicationContentSourceForReviewedWorkflow } from "@/lib/agent/github-publication-content-source";
import { githubPublicationRuntime } from "@/lib/agent/github-publication-runtime";
import {
  appBuilderWorkflowState,
  assertCurrentGitHubDraftProposal,
} from "@/lib/agent/workflow-state";

export default defineTool({
  description:
    "After separate approval of the exact sealed proposal digest, publish only the approved path set to a deterministic branch and open one draft pull request. It refuses stale base, overlap, collision, digest drift, or an enabled release gate.",
  inputSchema: z.strictObject({
    expectedProposalDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    approvalReceipt: approvalReceiptSchema,
  }),
  approval: always(),
  async execute(input, ctx) {
    const state = appBuilderWorkflowState.get();
    if (state.phase !== "reviewed" || state.githubSource === undefined)
      throw new Error(
        "An exact reviewed GitHub-bound change set is required before publication.",
      );
    assertCurrentGitHubDraftProposal({
      binding: state.githubDraftProposal,
      expectedProposalDigest: input.expectedProposalDigest,
      reviewDigest: state.reviewReceipt.digest,
      changeSetDigest: state.reviewReceipt.changeSetDigest,
      sourceReceiptDigest: state.sourceReceipt.digest,
      githubSource: state.githubSource,
    });
    assertApprovalReceipt({
      actual: input.approvalReceipt,
      phase: "publication",
      target: approvalTargetFromGitHubSource(state.githubSource),
      subjectDigest: input.expectedProposalDigest,
    });
    const sandbox = await ctx.getSandbox();
    return githubPublicationRuntime.publishDraftPullRequest({
      expectedProposalDigest: input.expectedProposalDigest,
      approvalReceipt: input.approvalReceipt,
      review: state.reviewReceipt,
      contentSource: await publicationContentSourceForReviewedWorkflow({
        state,
        sandbox,
      }),
      approvedByCallId: ctx.callId,
    });
  },
});
