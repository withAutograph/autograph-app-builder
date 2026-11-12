/* oxlint-disable github/filenames-match-regex, unicorn/filename-case -- Eve derives the public tool identifier from this existing filename. */
import { defineTool } from "eve/tools";
import { approvalReceiptForDraftProposal } from "@/lib/agent/approval-receipt";
import { z } from "zod";

import { githubPublicationRuntimeForSession } from "@/lib/agent/deployment-github-publication-runtime";
import { appBuilderWorkflowState, updateExactWorkflow } from "@/lib/agent/workflow-state";
import { sourceReceiptEvidence } from "@/lib/repository/source-receipt";
import { appBaselineState } from "@/lib/agent/app-baseline-state";
import { firstAppRegistrationPaths } from "@/lib/repository/github-destination-review";
import { assertExistingAppReviewScope } from "@/lib/repository/reviewed-change-set";
import { exactNormalizedChangeSet } from "./change_set_status";
import { publicationDestinationFromReview } from "@/lib/agent/github-publication-destination";
import { reviewedChangeSetReferenceSchema } from "@/lib/agent/review-result-summaries";
import { retainOwnedDraftPublicationSeal } from "@/lib/agent/github-draft-publication-lineage";

const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const title = z.string().trim().min(1).max(120);

export default defineTool({
  description:
    "After prepare_github_draft_review and accept_change_set, follow the review's nextCall with its current-session review reference to seal the draft against the same immutable destination. The server resolves source and destination from that review. Follow the returned nextCall to request the normal publication approval. Sealing does not publish or grant approval.",
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
    const { reviewReference } = input;
    const reviewMatches =
      reviewReference === undefined
        ? sourceMatches && state.reviewReceipt.digest === input.expectedReviewDigest
        : reviewReference.sessionId === ctx.session.id &&
          reviewReference.digest === state.reviewReceipt.digest;
    if (
      !reviewMatches ||
      (state.githubSource === undefined && state.sourceReceipt.sourceKind !== "fresh-template")
    ) {
      throw new Error(
        "The proposal request is not bound to the exact source or destination and review receipts.",
      );
    }
    assertExistingAppReviewScope(
      state.reviewReceipt,
      state.appSpec.appId,
      state.sourceReceipt.sourceKind,
      appBaselineState.get()?.receipt,
      firstAppRegistrationPaths(state.githubDestinationReview, state.appSpec.appId),
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
    if (state.githubSource !== undefined) {
      retainOwnedDraftPublicationSeal({
        appId: state.appSpec.appId,
        sessionId: ctx.session.id,
        installationId: state.githubDestinationReview.installation.installationId,
        proposal,
      });
    }
    const approvalReceipt = approvalReceiptForDraftProposal(proposal);
    return {
      ...proposal,
      approvalReceipt,
      nextCall: {
        tool: "publish_github_draft_pr" as const,
        input: { approvalReceipt, expectedProposalDigest: proposal.digest },
      },
    };
  },
  inputSchema: z
    .strictObject({
      expectedGitHubSourceDigest: digest.optional(),
      expectedDestinationReviewDigest: digest.optional(),
      expectedReviewDigest: digest.optional(),
      reviewReference: reviewedChangeSetReferenceSchema.optional(),
      title,
    })
    .refine((input) => {
      const sourceCount = [
        input.expectedGitHubSourceDigest,
        input.expectedDestinationReviewDigest,
      ].filter((value) => value !== undefined).length;
      return input.reviewReference === undefined
        ? input.expectedReviewDigest !== undefined && sourceCount === 1
        : input.expectedReviewDigest === undefined && sourceCount === 0;
    }, "Use the current-session review reference returned by Builder."),
});
