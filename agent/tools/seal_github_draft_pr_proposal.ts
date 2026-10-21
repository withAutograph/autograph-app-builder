import { defineTool } from "eve/tools";
import { z } from "zod";

import { githubPublicationRuntimeForSession } from "@/lib/agent/deployment-github-publication-runtime";
import { appBuilderWorkflowState, updateExactWorkflow } from "@/lib/agent/workflow-state";
import { sourceReceiptEvidence } from "@/lib/repository/source-receipt";
import { appBaselineState } from "@/lib/agent/app-baseline-state";
import { assertExistingAppReviewScope } from "@/lib/repository/reviewed-change-set";
import { exactNormalizedChangeSet } from "./change_set_status";
import { publicationDestinationFromReview } from "@/lib/agent/github-publication-destination";

const digest = z.string().regex(/^[0-9a-f]{64}$/u);

export default defineTool({
  description:
    "After prepare_github_draft_review and accept_change_set, seal the initial draft pull-request proposal against that same immutable destination snapshot with freshly verified publication permissions. For a fresh-template app use expectedDestinationReviewDigest; an acquired GitHub source uses expectedGitHubSourceDigest. This performs no branch, push, pull-request, release-gate, or repository mutation.",
  async execute(input, ctx) {
    const state = appBuilderWorkflowState.get();
    if (state.phase !== "reviewed") {
      throw new Error("No reviewed workflow is available.");
    }
    if (state.githubDestinationReview === undefined) {
      throw new Error(
        "Use prepare_github_draft_review and accept_change_set before sealing initial draft publication.",
      );
    }
    const sourceMatches =
      state.githubSource === undefined
        ? state.sourceReceipt.sourceKind === "fresh-template" &&
          state.githubDestinationReview.digest === input.expectedDestinationReviewDigest
        : state.githubSource.digest === input.expectedGitHubSourceDigest;
    if (!sourceMatches || state.reviewReceipt.digest !== input.expectedReviewDigest) {
      throw new Error(
        "The proposal request is not bound to the exact source or destination and review receipts.",
      );
    }
    assertExistingAppReviewScope(
      state.reviewReceipt,
      state.appSpec.appId,
      state.sourceReceipt.sourceKind,
      appBaselineState.get()?.receipt,
    );
    const runtime =
      state.githubSource === undefined
        ? await githubPublicationRuntimeForSession(ctx.session.auth, {
            selectedInstallationId: state.githubDestinationReview.installation.installationId,
          })
        : await githubPublicationRuntimeForSession(ctx.session.auth);
    if (state.githubDestinationReview !== undefined) {
      const current = await exactNormalizedChangeSet({ sandbox: await ctx.getSandbox(), state });
      if (current.digest !== state.reviewReceipt.changeSetDigest) {
        throw new Error("Accept the current destination diff before sealing its draft proposal.");
      }
    }
    const proposal = await runtime.sealDraftPullRequestProposal({
      destinationReview: state.githubDestinationReview,
      ...(state.githubSource === undefined
        ? { destination: publicationDestinationFromReview(state.githubDestinationReview) }
        : { githubSource: state.githubSource }),
      review: state.reviewReceipt,
      source: sourceReceiptEvidence(state.sourceReceipt),
      title: input.title,
    });
    if (
      proposal.reviewDigest !== state.reviewReceipt.digest ||
      proposal.changeSetDigest !== state.reviewReceipt.changeSetDigest ||
      proposal.repositoryId !== state.githubDestinationReview.repository.repositoryId
    ) {
      throw new Error(
        "The sealed draft pull-request proposal is not bound to the current reviewed workflow.",
      );
    }
    updateExactWorkflow({
      expected: state,
      operation: "draft pull-request proposal sealing",
      transition: (latest) => {
        if (latest.phase !== "reviewed" || latest.githubDestinationReview === undefined) {
          throw new Error("The reviewed GitHub workflow changed before proposal sealing.");
        }
        return {
          ...latest,
          githubDraftProposal:
            latest.githubSource === undefined
              ? {
                  destinationReviewDigest: latest.githubDestinationReview.digest,
                  proposal,
                  sourceReceiptDigest: latest.sourceReceipt.digest,
                }
              : {
                  githubSourceDigest: latest.githubSource.digest,
                  proposal,
                  sourceReceiptDigest: latest.sourceReceipt.digest,
                },
        };
      },
    });
    return proposal;
  },
  inputSchema: z
    .strictObject({
      expectedGitHubSourceDigest: digest.optional(),
      expectedDestinationReviewDigest: digest.optional(),
      expectedReviewDigest: digest,
      title: z.string().trim().min(1).max(120),
    })
    .refine(
      (input) =>
        (input.expectedGitHubSourceDigest === undefined) !==
        (input.expectedDestinationReviewDigest === undefined),
      "Supply the GitHub source digest for an acquired repository, or the destination review digest for a fresh-template app.",
    ),
});
