import { sealPublishedDraftRepair } from "@/lib/agent/published-draft-repair-publication";
import { defineTool } from "eve/tools";
import {
  draftPrerequisiteMessage,
  draftSealPrerequisiteDiagnostic,
} from "@/lib/agent/draft-reconciliation-prerequisites";
import { getSourceBoundSandbox } from "@/lib/agent/source-bound-sandbox";
import { z } from "zod";

import { approvalReceiptForExistingDraftUpdate } from "@/lib/agent/approval-receipt";
import { githubPublicationRuntimeForSession } from "@/lib/agent/deployment-github-publication-runtime";
import {
  draftReconciliationState,
  retainDraftReconciliationCompletion,
  updateExactDraftReconciliation,
} from "@/lib/agent/draft-reconciliation-state";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { inspectDraftReconciliation } from "@/lib/repository/sandbox-draft-reconciliation";

const digest = z.string().regex(/^[0-9a-f]{64}$/u);

export default defineTool({
  description:
    "Seal a proposal for the exact validated reconciliation of an existing draft PR. The result includes the exact approvalReceipt for the draft branch head; pass it verbatim to reconcile_github_draft_pr after separate approval. The proposal binds the live base, old head, resolved tree, both reviewed diffs, and selected repository.",
  async execute(input, ctx) {
    const candidate = draftReconciliationState.get();
    if (candidate?.kind === "published-draft-repair") {
      return await sealPublishedDraftRepair({
        ctx,
        expectedReviewDigest: input.expectedReviewDigest,
      });
    }

    const state = appBuilderWorkflowState.get();
    // oxlint-disable-next-line sonarjs/expression-complexity -- exact review, diff reads, validation, and source must all match.
    if (
      // oxlint-disable-next-line sonarjs/expression-complexity -- one exact candidate precondition.
      candidate === null ||
      candidate.review === undefined ||
      candidate.validation === undefined ||
      state.phase !== "reviewed" ||
      state.githubSource === undefined ||
      state.githubSource.digest !== candidate.githubSourceDigest ||
      state.reviewReceipt.digest !== candidate.originalReviewDigest ||
      candidate.review.digest !== input.expectedReviewDigest
    ) {
      throw new Error(
        draftPrerequisiteMessage(
          draftSealPrerequisiteDiagnostic({
            candidate,
            state,
            expectedReviewDigest: input.expectedReviewDigest,
          }),
          "The selected app or resolved merge changed. Validate the candidate and review both current diffs before sealing.",
        ),
      );
    }
    const observed = await inspectDraftReconciliation({
      prepared: candidate,
      sandbox: await getSourceBoundSandbox(ctx),
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
    const { compilation } = candidate.validation;
    if (compilation === undefined) {
      throw new Error(
        "completion_context_missing: Revalidate this candidate to retain its actual compiled release before sealing publication.",
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
    // This metadata becomes durable at the ensuing always()-approval checkpoint, before any Git write.
    // It records no approval grant; reconcile still validates its actual approved call and exact receipt.
    retainDraftReconciliationCompletion({
      preparation: "sealed-before-approval",
      proposal,
      review: candidate.review,
      appReview: {
        appSpecDigest: state.reviewReceipt.appSpecDigest,
        changeSetDigest: state.reviewReceipt.changeSetDigest,
        digest: state.reviewReceipt.digest,
      },
      appId: state.appSpec.appId,
      githubSourceDigest: candidate.githubSourceDigest,
      root: candidate.root,
      compilation,
    });
    return { ...proposal, approvalReceipt: approvalReceiptForExistingDraftUpdate(proposal) };
  },
  inputSchema: z.strictObject({ expectedReviewDigest: digest }),
});
// oxlint-disable github/filenames-match-regex -- Eve tool discovery requires the public snake_case tool name.
