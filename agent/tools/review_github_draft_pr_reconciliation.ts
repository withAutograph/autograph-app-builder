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
    const candidate = draftReconciliationState.get();
    const state = appBuilderWorkflowState.get();
    // oxlint-disable-next-line sonarjs/expression-complexity -- verify candidate, source, and validation as one precondition.
    if (
      // oxlint-disable-next-line sonarjs/expression-complexity -- one exact candidate precondition.
      candidate === null ||
      candidate.validation === undefined ||
      state.phase !== "reviewed" ||
      state.githubSource?.digest !== candidate.githubSourceDigest ||
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
    const review = createReconciliationReviewReceipt({
      appId: candidate.appId,
      baseChanges: observed.baseChanges,
      baseSha: candidate.baseSha,
      baseTree: candidate.baseTree,
      headChanges: observed.headChanges,
      headSha: candidate.headSha,
      headTree: candidate.headTree,
      resolvedTree: observed.resolvedTree,
      version: 1,
    });
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
      status: "reviewed" as const,
      reviewDigest: review.digest,
      baseChangeSummary,
      headChangeSummary,
      baseSha: review.baseSha,
      headSha: review.headSha,
      resolvedTree: review.resolvedTree,
      validation: candidate.validation,
      baseChanges,
      headChanges,
    };
  },
  inputSchema: z.strictObject({}),
});
// oxlint-disable github/filenames-match-regex -- Eve tool discovery requires the public snake_case tool name.
