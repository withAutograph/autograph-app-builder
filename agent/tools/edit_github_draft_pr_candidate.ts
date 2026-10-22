import { currentDraftCandidateSource } from "@/lib/agent/published-draft-repair";
import { defineTool } from "eve/tools";
import { getSourceBoundSandbox } from "@/lib/agent/source-bound-sandbox";
import { z } from "zod";

import {
  draftReconciliationState,
  updateExactDraftReconciliation,
} from "@/lib/agent/draft-reconciliation-state";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import {
  readDraftReconciliationCandidateFilePage,
  replaceDraftReconciliationCandidateText,
  restoreDraftReconciliationCandidateFile,
} from "@/lib/repository/sandbox-draft-reconciliation";

export default defineTool({
  description:
    "Read a current app-owned text file in bounded UTF-8 pages in Builder's isolated draft merge candidate. Continue with nextCursor and the whole-file digest as expectedDigest; an ordinary file change returns its fresh first page with sourceChanged. Replace one unique exact passage using the whole-file digest, or restore one app-owned file's exact bytes and mode from the retained draft head. Restore accepts only a path and preserves other repairs. This changes no GitHub branch. Revalidate and review both diffs after an edit.",
  async execute(input, ctx) {
    const candidate = draftReconciliationState.get();
    const state = appBuilderWorkflowState.get();
    if (
      candidate === null ||
      state.phase !== "reviewed" ||
      currentDraftCandidateSource(state, candidate) === undefined ||
      state.reviewReceipt.digest !== candidate.originalReviewDigest
    ) {
      throw new Error(
        "The prepared draft candidate no longer matches the selected app and source review. Prepare reconciliation again before editing.",
      );
    }
    const sandbox = await getSourceBoundSandbox(ctx);
    if (input.kind === "read") {
      return {
        ...(await readDraftReconciliationCandidateFilePage({
          cursor: input.cursor,
          expectedDigest: input.expectedDigest,
          path: input.path,
          prepared: candidate,
          sandbox,
        })),
        path: input.path,
        status: "current_file" as const,
      };
    }
    const result =
      input.kind === "restore"
        ? await restoreDraftReconciliationCandidateFile({
            path: input.path,
            prepared: candidate,
            sandbox,
          })
        : await replaceDraftReconciliationCandidateText({
            expectedDigest: input.expectedDigest,
            newText: input.newText,
            oldText: input.oldText,
            path: input.path,
            prepared: candidate,
            sandbox,
          });
    updateExactDraftReconciliation({
      expected: candidate,
      operation: `editing ${input.path}`,
      transition: () => {
        const next = { ...candidate };
        delete next.proposal;
        delete next.review;
        delete next.repairReview;
        delete next.reviewReadProgress;
        delete next.validation;
        delete next.validationRun;
        return next;
      },
    });
    return {
      ...result,
      next: "Validate the complete candidate, then review its base and prior-head diffs.",
      path: input.path,
      status: "candidate_edited" as const,
    };
  },
  inputSchema: z.discriminatedUnion("kind", [
    z.strictObject({
      cursor: z.number().int().nonnegative().optional(),
      expectedDigest: z
        .string()
        .regex(/^[0-9a-f]{64}$/u)
        .optional(),
      kind: z.literal("read"),
      path: z.string().min(1),
    }),
    z.strictObject({ kind: z.literal("restore"), path: z.string().min(1) }),
    z.strictObject({
      expectedDigest: z.string().regex(/^[0-9a-f]{64}$/u),
      kind: z.literal("replace"),
      newText: z.string(),
      oldText: z.string().min(1),
      path: z.string().min(1),
    }),
  ]),
});
// oxlint-disable github/filenames-match-regex -- Eve tool discovery requires the public snake_case tool name.
