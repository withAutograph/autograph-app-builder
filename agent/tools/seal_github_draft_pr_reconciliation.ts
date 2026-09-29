import { defineTool } from "eve/tools";
import { z } from "zod";

import { githubPublicationRuntimeForSession } from "@/lib/agent/deployment-github-publication-runtime";
import {
  draftReconciliationState,
  updateExactDraftReconciliation,
} from "@/lib/agent/draft-reconciliation-state";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { inspectDraftReconciliation } from "@/lib/repository/sandbox-draft-reconciliation";

const digest = z.string().regex(/^[0-9a-f]{64}$/u);

export default defineTool({
  description:
    "Seal a proposal for the exact validated reconciliation of an existing draft PR. The proposal binds the live base, old head, resolved tree, both reviewed diffs, and selected repository. Separate approval is required to move the branch.",
  async execute(input, ctx) {
    const candidate = draftReconciliationState.get();
    const state = appBuilderWorkflowState.get();
    // oxlint-disable-next-line sonarjs/expression-complexity -- exact review, diff reads, validation, and source must all match.
    if (
      // oxlint-disable-next-line sonarjs/expression-complexity -- one exact candidate precondition.
      candidate === null ||
      candidate.review === undefined ||
      candidate.validation === undefined ||
      candidate.reviewReadProgress?.reviewDigest !== candidate.review?.digest ||
      !candidate.reviewReadProgress.baseComplete ||
      !candidate.reviewReadProgress.headComplete ||
      state.phase !== "reviewed" ||
      state.githubSource === undefined ||
      state.githubSource.digest !== candidate.githubSourceDigest ||
      state.reviewReceipt.digest !== candidate.originalReviewDigest ||
      candidate.review.digest !== input.expectedReviewDigest
    ) {
      throw new Error(
        "The selected app or resolved merge changed. Validate the candidate and review both current diffs before sealing.",
      );
    }
    const observed = await inspectDraftReconciliation({
      prepared: candidate,
      sandbox: await ctx.getSandbox(),
    });
    if (
      observed.unresolvedConflicts.length > 0 ||
      observed.resolvedTree !== candidate.review.resolvedTree ||
      observed.resolvedTree !== candidate.validation.resolvedTree
    ) {
      throw new Error(
        "The resolved files changed after review. Rerun candidate checks, review both diffs, and seal a new proposal.",
      );
    }
    const runtime = await githubPublicationRuntimeForSession(ctx.session.auth);
    const priorPublishedProposalDigest =
      state.publishedGitHubDraftProposalDigest ?? state.githubDraftProposal?.proposal.digest;
    const request = {
      githubSource: state.githubSource,
      pullRequestNumber: candidate.pullRequestNumber,
      review: candidate.review,
      selectedCheckoutHeadSha: candidate.headSha,
      selectedCheckoutHeadTree: candidate.headTree,
    };
    const proposal =
      priorPublishedProposalDigest === undefined
        ? await runtime.sealExistingDraftReconciliation(request)
        : await runtime.sealExistingDraftReconciliation({
            ...request,
            priorPublishedProposalDigest,
          });
    updateExactDraftReconciliation({
      expected: candidate,
      operation: "sealing the resolved draft proposal",
      transition: () => ({ ...candidate, proposal }),
    });
    return proposal;
  },
  inputSchema: z.strictObject({ expectedReviewDigest: digest }),
});
// oxlint-disable github/filenames-match-regex -- Eve tool discovery requires the public snake_case tool name.
