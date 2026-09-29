import { defineTool } from "eve/tools";
import { getSourceBoundSandbox } from "@/lib/agent/source-bound-sandbox";
import { z } from "zod";

import {
  draftReconciliationState,
  updateExactDraftReconciliation,
} from "@/lib/agent/draft-reconciliation-state";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { inspectDraftReconciliation } from "@/lib/repository/sandbox-draft-reconciliation";
import {
  sanitizeValidationDiagnosticText,
  validationOutputExcerpt,
} from "@/lib/repository/target-validation";

const command = "mise run --skip-tools format:app";

export default defineTool({
  description:
    "Run the selected repository's app formatting task in Builder's isolated draft PR candidate. Builder accepts only changes under the selected app, then requires fresh validation and review of both diffs before any PR update. This does not update GitHub.",
  async execute(_input, ctx) {
    const candidate = draftReconciliationState.get();
    const state = appBuilderWorkflowState.get();
    if (
      candidate === null ||
      state.phase !== "reviewed" ||
      state.githubSource?.digest !== candidate.githubSourceDigest ||
      state.reviewReceipt.digest !== candidate.originalReviewDigest
    ) {
      throw new Error(
        "The prepared draft candidate no longer matches the selected app and source review. Prepare reconciliation again before formatting.",
      );
    }
    const sandbox = await getSourceBoundSandbox(ctx);
    const before = await inspectDraftReconciliation({ prepared: candidate, sandbox });
    if (before.unresolvedConflicts.length > 0) {
      return {
        conflicts: before.unresolvedConflicts,
        problem: "Resolve the listed app-owned conflicts before formatting this draft candidate.",
        status: "needs_resolution" as const,
      };
    }
    updateExactDraftReconciliation({
      expected: candidate,
      operation: "starting draft candidate formatting",
      transition: () => {
        const next = { ...candidate };
        delete next.validationRun;
        delete next.validation;
        delete next.review;
        delete next.reviewReadProgress;
        delete next.proposal;
        return next;
      },
    });
    let result: Awaited<ReturnType<typeof sandbox.run>>;
    try {
      result = await sandbox.run({
        abortSignal: ctx.abortSignal,
        command,
        workingDirectory: candidate.root,
      });
    } catch (error) {
      throw new Error(
        `Builder could not run ${command} in the isolated draft candidate. Check the sandbox and repository formatting task, then retry. Cause: ${sanitizeValidationDiagnosticText(error instanceof Error ? error.message : String(error))}`,
        { cause: error },
      );
    }
    if (result.exitCode !== 0) {
      return {
        command,
        exitCode: result.exitCode,
        output: validationOutputExcerpt(result.stdout, result.stderr),
        problem: `The selected repository's ${command} task failed. Repair the reported formatter or source issue, then retry before review.`,
        status: "needs_repair" as const,
      };
    }
    const after = await inspectDraftReconciliation({ prepared: candidate, sandbox });
    if (after.unresolvedConflicts.length > 0) {
      return {
        conflicts: after.unresolvedConflicts,
        problem:
          "Formatting left unresolved conflicts. Resolve the listed app-owned files, then revalidate.",
        status: "needs_resolution" as const,
      };
    }
    const previous = new Map(
      before.baseChanges.map((change) => [change.path, change.after?.digest]),
    );
    const formattedPaths = after.baseChanges
      .filter((change) => previous.get(change.path) !== change.after?.digest)
      .map((change) => change.path);
    return {
      command,
      formattedPaths,
      next: "Validate the complete candidate again, then review both current diffs before updating the draft PR.",
      resolvedTree: after.resolvedTree,
      status: "formatted" as const,
    };
  },
  inputSchema: z.strictObject({}),
});
// oxlint-disable github/filenames-match-regex -- Eve tool discovery requires the public snake_case tool name.
