import { resolveDraftReviewedWorkflow } from "@/lib/agent/draft-reviewed-lineage";
import { createPublishedDraftRepairReview } from "@/lib/repository/published-draft-repair-review";
import {
  draftCandidateValidationDigest,
  currentDraftCandidateSource,
} from "@/lib/agent/published-draft-repair";
import { defineTool } from "eve/tools";
import { getSourceBoundSandbox } from "@/lib/agent/source-bound-sandbox";
import { z } from "zod";

import {
  draftReconciliationState,
  updateExactDraftReconciliation,
} from "@/lib/agent/draft-reconciliation-state";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { createReconciliationReviewReceipt } from "@/lib/repository/github-draft-reconciliation";
import { inspectDraftReconciliation } from "@/lib/repository/sandbox-draft-reconciliation";
import { summarizeReconciliationChanges } from "@/lib/agent/draft-reconciliation-review-summary";

export default defineTool({
  description:
    "Reobserve the validated isolated merge and record both exact diffs in server state. Return counts and the first bounded metadata page for each diff; use optional inspect_github_draft_pr_reconciliation change or raw diff pages for more detail. No complete diff read is required. This does not update GitHub.",
  async execute(_input, ctx) {
    ctx.abortSignal?.throwIfAborted();
    const candidate = draftReconciliationState.get();
    const workflow = appBuilderWorkflowState.get();
    const state = resolveDraftReviewedWorkflow(workflow, candidate) ?? workflow;
    // oxlint-disable-next-line sonarjs/expression-complexity -- verify candidate, source, and validation as one precondition.
    if (
      // oxlint-disable-next-line sonarjs/expression-complexity -- one exact candidate precondition.
      candidate === null ||
      candidate.validation === undefined ||
      state.phase !== "reviewed" ||
      currentDraftCandidateSource(state, candidate) === undefined ||
      state.reviewReceipt.digest !== candidate.originalReviewDigest
    ) {
      throw new Error(
        "Validate the current isolated draft merge candidate before reviewing its two diffs.",
      );
    }
    const observed = await inspectDraftReconciliation({
      prepared: candidate,
      sandbox: await getSourceBoundSandbox(ctx),
    });
    if (
      observed.unresolvedConflicts.length > 0 ||
      observed.resolvedTree !== candidate.validation.resolvedTree
    ) {
      throw new Error(
        "The merged files changed after validation or still contain conflicts. Resolve them, rerun all candidate checks, and review the current diffs.",
      );
    }
    if (candidate.kind === "published-draft-repair") {
      const repairReview = createPublishedDraftRepairReview({
        appId: candidate.appId,
        appSpecDigest: state.appSpec.digest,
        changes: [...observed.headChanges],
        headSha: candidate.headSha,
        headTree: candidate.headTree,
        originReviewDigest: candidate.originalReviewDigest,
        originSourceReceiptDigest: candidate.repair.originSourceReceiptDigest,
        publicationDigest: candidate.repair.publicationDigest,
        repairSourceDigest: candidate.repair.source.digest,
        resolvedTree: observed.resolvedTree,
        reviewedByCallId: ctx.callId,
        validationDigest: draftCandidateValidationDigest(candidate.validation),
      });
      updateExactDraftReconciliation({
        expected: candidate,
        operation: "reviewing the app-only draft-head repair",
        transition: () => ({ ...candidate, repairReview }),
      });
      return {
        baseline: "draft-head" as const,
        changes: repairReview.changes,
        headSha: repairReview.headSha,
        kind: "published-draft-repair" as const,
        nextCall: {
          arguments: {
            expectedGitHubSourceDigest: candidate.repair.source.digest,
            expectedReviewDigest: repairReview.digest,
            pullRequestNumber: candidate.pullRequestNumber,
          },
          tool: "seal_github_draft_pr_update",
        },
        resolvedTree: repairReview.resolvedTree,
        reviewDigest: repairReview.digest,
        status: "reviewed" as const,
        validation: candidate.validation,
      };
    }
    const app = { appId: candidate.appId };
    const scope =
      candidate.publicationScope === undefined
        ? app
        : { ...app, publicationScope: candidate.publicationScope };
    const catalog =
      candidate.dependencyCatalog === undefined
        ? scope
        : { ...scope, dependencyCatalog: candidate.dependencyCatalog };
    const reviewInput: Parameters<typeof createReconciliationReviewReceipt>[0] = {
      ...catalog,
      baseChanges: observed.baseChanges,
      baseSha: candidate.baseSha,
      baseTree: candidate.baseTree,
      headChanges: observed.headChanges,
      headSha: candidate.headSha,
      headTree: candidate.headTree,
      resolvedTree: observed.resolvedTree,
      version: 1,
    };
    const review = createReconciliationReviewReceipt(reviewInput);
    updateExactDraftReconciliation({
      expected: candidate,
      operation: "recording both reviewed merge diffs",
      transition: () => {
        const next = { ...candidate, review };
        delete next.proposal;
        delete next.reviewReadProgress;
        return next;
      },
    });
    const { changes: baseChanges, ...baseChangeSummary } = summarizeReconciliationChanges(
      review.baseChanges,
      candidate.appId,
    );
    const { changes: headChanges, ...headChangeSummary } = summarizeReconciliationChanges(
      review.headChanges,
      candidate.appId,
    );
    return {
      baseChangeSummary,
      baseChanges,
      baseSha: review.baseSha,
      headChangeSummary,
      headChanges,
      headSha: review.headSha,
      resolvedTree: review.resolvedTree,
      reviewDigest: review.digest,
      status: "reviewed" as const,
      validation: candidate.validation,
    };
  },
  inputSchema: z.strictObject({}),
});
// oxlint-disable github/filenames-match-regex -- Eve tool discovery requires the public snake_case tool name.
