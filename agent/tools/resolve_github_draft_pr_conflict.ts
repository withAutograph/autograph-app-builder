import { defineTool } from "eve/tools";
import { getSourceBoundSandbox } from "@/lib/agent/source-bound-sandbox";
import { z } from "zod";

import {
  draftReconciliationState,
  updateExactDraftReconciliation,
} from "@/lib/agent/draft-reconciliation-state";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { writeDraftReconciliationResolution } from "@/lib/repository/sandbox-draft-reconciliation";

export default defineTool({
  description:
    "Resolve one reported app-owned text conflict in Builder's isolated draft merge candidate. This changes no GitHub branch. The entire candidate must be validated and both resulting diffs reviewed afterward.",
  async execute(input, ctx) {
    const candidate = draftReconciliationState.get();
    const state = appBuilderWorkflowState.get();
    if (
      candidate === null ||
      state.phase !== "reviewed" ||
      state.githubSource?.digest !== candidate.githubSourceDigest ||
      state.reviewReceipt.digest !== candidate.originalReviewDigest
    ) {
      throw new Error(
        "The prepared draft candidate no longer matches the selected app and source review. Prepare reconciliation again before resolving conflicts.",
      );
    }
    await writeDraftReconciliationResolution({
      content: input.content,
      path: input.path,
      prepared: candidate,
      sandbox: await getSourceBoundSandbox(ctx),
    });
    updateExactDraftReconciliation({
      expected: candidate,
      operation: `resolving ${input.path}`,
      transition: () => {
        const next = { ...candidate };
        delete next.proposal;
        delete next.review;
        delete next.reviewReadProgress;
        delete next.validation;
        return next;
      },
    });
    return {
      next: "Validate the complete candidate, then review its base and prior-head diffs.",
      path: input.path,
      status: "resolution_written" as const,
    };
  },
  inputSchema: z.strictObject({
    content: z.string().nullable(),
    path: z.string().min(1),
  }),
});
// oxlint-disable github/filenames-match-regex -- Eve tool discovery requires the public snake_case tool name.
