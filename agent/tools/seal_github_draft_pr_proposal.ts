import { defineTool } from "eve/tools";
import { z } from "zod";

import { githubPublicationRuntimeForSession } from "@/lib/agent/deployment-github-publication-runtime";
import { appBuilderWorkflowState, updateExactWorkflow } from "@/lib/agent/workflow-state";
import { sourceReceiptEvidence } from "@/lib/repository/source-receipt";
import { appBaselineState } from "@/lib/agent/app-baseline-state";
import { assertExistingAppReviewScope } from "@/lib/repository/reviewed-change-set";
import { exactNormalizedChangeSet } from "./change_set_status";

const digest = z.string().regex(/^[0-9a-f]{64}$/u);

export default defineTool({
  description:
    "After prepare_github_draft_review, complete before/after destination diff reads, and accept_change_set, seal the initial draft pull-request proposal against that same immutable destination snapshot with freshly verified publication permissions. This performs no branch, push, pull-request, release-gate, or repository mutation.",
  async execute(input, ctx) {
    const state = appBuilderWorkflowState.get();
    if (state.phase !== "reviewed" || state.githubSource === undefined) {
      throw new Error("No reviewed workflow with an immutable GitHub source is available.");
    }
    if (state.githubDestinationReview === undefined) {
      throw new Error(
        "Use prepare_github_draft_review, read both complete destination diff sides, and accept_change_set before sealing initial draft publication.",
      );
    }
    if (
      state.githubSource.digest !== input.expectedGitHubSourceDigest ||
      state.reviewReceipt.digest !== input.expectedReviewDigest
    ) {
      throw new Error(
        "The proposal request is not bound to the exact GitHub source and review receipts.",
      );
    }
    assertExistingAppReviewScope(
      state.reviewReceipt,
      state.appSpec.appId,
      state.sourceReceipt.sourceKind,
      appBaselineState.get()?.receipt,
    );
    const runtime = await githubPublicationRuntimeForSession(ctx.session.auth);
    if (state.githubDestinationReview !== undefined) {
      const current = await exactNormalizedChangeSet({ sandbox: await ctx.getSandbox(), state });
      if (current.digest !== state.reviewReceipt.changeSetDigest) {
        throw new Error("Accept the current destination diff before sealing its draft proposal.");
      }
    }
    const proposal = await runtime.sealDraftPullRequestProposal({
      destinationReview: state.githubDestinationReview,
      githubSource: state.githubSource,
      review: state.reviewReceipt,
      source: sourceReceiptEvidence(state.sourceReceipt),
      title: input.title,
    });
    if (
      proposal.reviewDigest !== state.reviewReceipt.digest ||
      proposal.changeSetDigest !== state.reviewReceipt.changeSetDigest ||
      proposal.repositoryId !== state.githubSource.repository.repositoryId
    ) {
      throw new Error(
        "The sealed draft pull-request proposal is not bound to the current reviewed workflow.",
      );
    }
    updateExactWorkflow({
      expected: state,
      operation: "draft pull-request proposal sealing",
      transition: (latest) => {
        if (latest.phase !== "reviewed" || latest.githubSource === undefined) {
          throw new Error("The reviewed GitHub workflow changed before proposal sealing.");
        }
        return {
          ...latest,
          githubDraftProposal: {
            githubSourceDigest: latest.githubSource.digest,
            proposal,
            sourceReceiptDigest: latest.sourceReceipt.digest,
          },
        };
      },
    });
    return proposal;
  },
  inputSchema: z.strictObject({
    expectedGitHubSourceDigest: digest,
    expectedReviewDigest: digest,
    title: z.string().trim().min(1).max(120),
  }),
});
