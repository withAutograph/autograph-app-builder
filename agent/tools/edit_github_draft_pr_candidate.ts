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
    "Read a current app-owned text file in bounded UTF-8 pages in Builder's isolated draft merge candidate. A read may specify preservedWorkspaceIndex from the candidate's preservedWorkspaces to inspect a retained draft candidate; this never selects an arbitrary root and does not edit preserved work. Retained app-review content remains available through change_set_status with includeContent. Continue with nextCursor and the read source's whole-file digest as expectedDigest; an ordinary file change returns its fresh first page with sourceChanged. Read the current candidate separately before using its digest for an edit. Replace one unique exact passage using the current whole-file digest, or restore one app-owned file's exact bytes and mode from the retained draft head. Restore accepts only a path and preserves other repairs. This changes no GitHub branch. Revalidate and review both diffs after an edit.",
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
      const preserved =
        input.preservedWorkspaceIndex === undefined
          ? undefined
          : candidate.preservedWorkspaces?.[input.preservedWorkspaceIndex];
      if (input.preservedWorkspaceIndex !== undefined && preserved === undefined) {
        throw new Error("Choose a preserved workspace index returned for this current candidate.");
      }
      if (preserved !== undefined && preserved.kind !== "draft-candidate") {
        throw new Error(
          "Read the preserved app review through change_set_status with includeContent. This reader opens only retained draft candidates.",
        );
      }
      return {
        ...(await readDraftReconciliationCandidateFilePage({
          cursor: input.cursor,
          expectedDigest: input.expectedDigest,
          path: input.path,
          prepared: preserved === undefined ? candidate : { ...candidate, root: preserved.root },
          sandbox,
        })),
        path: input.path,
        source:
          preserved === undefined
            ? { kind: "current-draft-candidate" as const }
            : {
                kind: "preserved-draft-candidate" as const,
                preservedWorkspaceIndex: input.preservedWorkspaceIndex,
                reviewDigest: preserved.reviewDigest,
                nextAction:
                  "This digest belongs to preserved content. Read the current candidate separately before a deliberate replacement using its current digest.",
              },
        status: preserved === undefined ? ("current_file" as const) : ("preserved_file" as const),
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
      preservedWorkspaceIndex: z.number().int().nonnegative().optional(),
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
