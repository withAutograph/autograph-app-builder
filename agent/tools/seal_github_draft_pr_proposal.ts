import { defineTool } from "eve/tools";
import { z } from "zod";

import { githubPublicationRuntimeForSession } from "@/lib/agent/deployment-github-publication-runtime";
import {
  appBuilderWorkflowState,
  updateExactWorkflow,
} from "@/lib/agent/workflow-state";
import { sourceReceiptEvidence } from "@/lib/repository/source-receipt";

const digest = z.string().regex(/^[0-9a-f]{64}$/u);

export default defineTool({
  description:
    "Read the exact reviewed workflow and fresh GitHub default-branch observation, then durably seal a draft pull-request proposal. This performs no branch, push, pull-request, release-gate, or repository mutation.",
  inputSchema: z.strictObject({
    expectedGitHubSourceDigest: digest,
    expectedReviewDigest: digest,
    title: z.string().trim().min(1).max(120),
  }),
  async execute(input, ctx) {
    const state = appBuilderWorkflowState.get();
    if (state.phase !== "reviewed" || state.githubSource === undefined)
      throw new Error(
        "No reviewed workflow with an immutable GitHub source is available.",
      );
    if (
      state.githubSource.digest !== input.expectedGitHubSourceDigest ||
      state.reviewReceipt.digest !== input.expectedReviewDigest
    )
      throw new Error(
        "The proposal request is not bound to the exact GitHub source and review receipts.",
      );
    const runtime = await githubPublicationRuntimeForSession(ctx.session.auth);
    const proposal = await runtime.sealDraftPullRequestProposal({
      githubSource: state.githubSource,
      source: sourceReceiptEvidence(state.sourceReceipt),
      review: state.reviewReceipt,
      title: input.title,
    });
    if (
      proposal.reviewDigest !== state.reviewReceipt.digest ||
      proposal.changeSetDigest !== state.reviewReceipt.changeSetDigest ||
      proposal.repositoryId !== state.githubSource.repository.repositoryId
    )
      throw new Error(
        "The sealed draft pull-request proposal is not bound to the current reviewed workflow.",
      );
    updateExactWorkflow({
      expected: state,
      operation: "draft pull-request proposal sealing",
      transition: (latest) => {
        if (latest.phase !== "reviewed" || latest.githubSource === undefined)
          throw new Error(
            "The reviewed GitHub workflow changed before proposal sealing.",
          );
        return {
          ...latest,
          githubDraftProposal: {
            proposal,
            sourceReceiptDigest: latest.sourceReceipt.digest,
            githubSourceDigest: latest.githubSource.digest,
          },
        };
      },
    });
    return proposal;
  },
});
