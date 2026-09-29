import { defineTool } from "eve/tools";
import { z } from "zod";

import { approvalReceiptForExistingDraftUpdate } from "@/lib/agent/approval-receipt";
import { githubPublicationRuntimeForSession } from "@/lib/agent/deployment-github-publication-runtime";
import { appBuilderWorkflowState, updateExactWorkflow } from "@/lib/agent/workflow-state";
import { assertExistingAppReviewScope } from "@/lib/repository/reviewed-change-set";
import { inspectGitHubSourceSandboxWorkspace } from "@/lib/repository/sandbox-github-source";

const digest = z.string().regex(/^[0-9a-f]{64}$/u);

export default defineTool({
  description:
    "Inspect an existing open draft pull request in the selected GitHub repository and seal a proposal to update its current head with the reviewed app-owned change set. The result includes the exact approvalReceipt for the draft branch head; pass it verbatim to update_github_draft_pr after separate approval. This is read-only.",
  async execute(input, ctx) {
    const state = appBuilderWorkflowState.get();
    if (state.phase !== "reviewed" || state.githubSource === undefined) {
      throw new Error(
        "Review the current app changes in the selected GitHub repository before proposing a draft PR update.",
      );
    }
    if (
      state.githubSource.digest !== input.expectedGitHubSourceDigest ||
      state.reviewReceipt.digest !== input.expectedReviewDigest
    ) {
      throw new Error(
        "The GitHub source or reviewed app diff changed. Review the current diff before sealing the draft update.",
      );
    }
    assertExistingAppReviewScope(
      state.reviewReceipt,
      state.appSpec.appId,
      state.sourceReceipt.sourceKind,
    );
    const checkout = await inspectGitHubSourceSandboxWorkspace({
      githubSource: state.githubSource,
      sandbox: await ctx.getSandbox(),
    });
    const runtime = await githubPublicationRuntimeForSession(ctx.session.auth);
    const priorPublishedProposalDigest =
      state.publishedGitHubDraftProposalDigest ?? state.githubDraftProposal?.proposal.digest;
    const baseRequest = {
      githubSource: state.githubSource,
      pullRequestNumber: input.pullRequestNumber,
      review: state.reviewReceipt,
      selectedCheckoutHeadSha: checkout.sourceSha,
      selectedCheckoutHeadTree: checkout.sourceTree,
    };
    const proposal =
      priorPublishedProposalDigest === undefined
        ? await runtime.sealExistingDraftUpdate(baseRequest)
        : await runtime.sealExistingDraftUpdate({ ...baseRequest, priorPublishedProposalDigest });
    updateExactWorkflow({
      expected: state,
      operation: "draft pull-request update proposal sealing",
      transition: (latest) => {
        if (latest.phase !== "reviewed" || latest.githubSource === undefined) {
          throw new Error("The reviewed GitHub workflow changed before sealing the draft update.");
        }
        return {
          ...latest,
          existingDraftUpdate: {
            githubSourceDigest: latest.githubSource.digest,
            proposal,
            reviewDigest: latest.reviewReceipt.digest,
          },
        };
      },
    });
    return { ...proposal, approvalReceipt: approvalReceiptForExistingDraftUpdate(proposal) };
  },
  inputSchema: z.strictObject({
    expectedGitHubSourceDigest: digest,
    expectedReviewDigest: digest,
    pullRequestNumber: z.number().int().positive(),
  }),
});
