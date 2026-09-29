import { defineTool } from "eve/tools";
import { getSourceBoundSandbox } from "@/lib/agent/source-bound-sandbox";
import { z } from "zod";

import {
  draftReconciliationState,
  updateExactDraftReconciliation,
} from "@/lib/agent/draft-reconciliation-state";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import {
  readDraftReconciliationConflict,
  readDraftReconciliationDiff,
} from "@/lib/repository/sandbox-draft-reconciliation";

export default defineTool({
  description:
    "Read an app-owned merge conflict, or page through the exact resolved diff against live base or old PR head. Diff pages include a cursor so the complete review can be read without truncation. This does not update GitHub.",
  async execute(input, ctx) {
    const candidate = draftReconciliationState.get();
    const state = appBuilderWorkflowState.get();
    if (
      candidate === null ||
      state.phase !== "reviewed" ||
      state.githubSource?.digest !== candidate.githubSourceDigest ||
      state.reviewReceipt.digest !== candidate.originalReviewDigest
    ) {
      throw new Error("Prepare the current draft reconciliation before inspecting its files.");
    }
    const sandbox = await getSourceBoundSandbox(ctx);
    if (input.kind === "conflict") {
      return {
        content: await readDraftReconciliationConflict({
          path: input.path,
          prepared: candidate,
          sandbox,
        }),
        path: input.path,
        status: "conflict" as const,
      };
    }
    if (candidate.review === undefined || candidate.validation === undefined) {
      throw new Error(
        "Validate the resolved candidate and review both diffs before reading its approved diff pages.",
      );
    }
    const progress =
      candidate.reviewReadProgress?.reviewDigest === candidate.review.digest
        ? candidate.reviewReadProgress
        : {
            baseComplete: false,
            baseNextCursor: 0,
            headComplete: false,
            headNextCursor: 0,
            reviewDigest: candidate.review.digest,
          };
    const expectedCursor =
      input.against === "base" ? progress.baseNextCursor : progress.headNextCursor;
    if (expectedCursor === null || (input.cursor ?? 0) !== expectedCursor) {
      throw new Error(
        `Read the complete ${input.against} diff in order. Resume at cursor ${expectedCursor ?? "complete"}, or review the candidate again to restart.`,
      );
    }
    const page = await readDraftReconciliationDiff({
      against: input.against,
      cursor: input.cursor,
      prepared: candidate,
      resolvedTree: candidate.review.resolvedTree,
      sandbox,
    });
    updateExactDraftReconciliation({
      expected: candidate,
      operation: `reading the ${input.against} diff`,
      transition: () => ({
        ...candidate,
        reviewReadProgress:
          input.against === "base"
            ? {
                ...progress,
                baseComplete: page.nextCursor === null,
                baseNextCursor: page.nextCursor,
              }
            : {
                ...progress,
                headComplete: page.nextCursor === null,
                headNextCursor: page.nextCursor,
              },
      }),
    });
    return {
      against: input.against,
      content: Buffer.from(page.chunkBase64, "base64").toString("utf-8"),
      cursor: page.cursor,
      nextCursor: page.nextCursor,
      reviewDigest: candidate.review.digest,
      status: "diff" as const,
      totalBytes: page.totalBytes,
    };
  },
  inputSchema: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("conflict"), path: z.string().min(1) }),
    z.strictObject({
      against: z.enum(["base", "head"]),
      cursor: z.number().int().nonnegative().optional(),
      kind: z.literal("diff"),
    }),
  ]),
});
// oxlint-disable github/filenames-match-regex -- Eve tool discovery requires the public snake_case tool name.
