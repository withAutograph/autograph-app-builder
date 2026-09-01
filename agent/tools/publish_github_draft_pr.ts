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
import {
  appBuilderWorkflowState,
  assertCurrentGitHubDraftProposal,
} from "@/lib/agent/workflow-state";
import { assertPreparedSandboxReleasePolicy } from "@/lib/repository/supported-template";

export default defineTool({
  description:
    "After separate approval of the exact sealed proposal digest, publish only the approved path set to a deterministic branch and open one draft pull request. It refuses stale base, overlap, collision, release-gate drift, or digest drift; an already-enabled release gate is allowed only when its sealed state remains unchanged.",
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
    await assertPreparedSandboxReleasePolicy({
      sandbox,
      sourceSha: state.sourceReceipt.sourceSha,
      sourceTree: state.sourceReceipt.sourceTree,
      workspaceDigest: state.workspace.workspaceDigest,
    });
    const contentSource = await publicationContentSourceForReviewedWorkflow({
      state,
      sandbox,
    });
    const runtime = await githubPublicationRuntimeForSession(ctx.session.auth);
    return runtime.publishDraftPullRequest({
      expectedProposalDigest: input.expectedProposalDigest,
      approvalReceipt: input.approvalReceipt,
      review: state.reviewReceipt,
      contentSource,
      approvedByCallId: ctx.callId,
    });
  },
});
