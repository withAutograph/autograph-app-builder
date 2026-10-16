import { defineTool } from "eve/tools";
import { getSourceBoundSandbox } from "@/lib/agent/source-bound-sandbox";
import { z } from "zod";

import { draftReconciliationState } from "@/lib/agent/draft-reconciliation-state";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { summarizeReconciliationChanges } from "@/lib/agent/draft-reconciliation-review-summary";
import {
  readDraftReconciliationConflict,
  readDraftReconciliationDiff,
} from "@/lib/repository/sandbox-draft-reconciliation";

export default defineTool({
  description:
    "Optionally inspect a merge conflict, recorded change metadata, or exact raw diff bytes against base or the old PR head. Metadata cursors are change indexes; raw diff cursors are byte offsets and may be requested independently. A raw diff may target one repository-relative path. Inspection is not a sealing prerequisite and does not update GitHub.",
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
    if (input.kind === "conflict") {
      const sandbox = await getSourceBoundSandbox(ctx);
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
        "Validate and record the current candidate review before inspecting its changes.",
      );
    }
    if (input.kind === "changes") {
      return {
        against: input.against,
        ...summarizeReconciliationChanges(
          input.against === "base" ? candidate.review.baseChanges : candidate.review.headChanges,
          candidate.appId,
          input.cursor,
        ),
        reviewDigest: candidate.review.digest,
        status: "changes" as const,
      };
    }
    const sandbox = await getSourceBoundSandbox(ctx);
    const page = await readDraftReconciliationDiff({
      against: input.against,
      cursor: input.cursor,
      path: input.path,
      prepared: candidate,
      resolvedTree: candidate.review.resolvedTree,
      sandbox,
    });
    return {
      against: input.against,
      content: Buffer.from(page.chunkBase64, "base64").toString("utf-8"),
      cursor: page.cursor,
      path: input.path,
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
      path: z.string().min(1).optional(),
    }),
    z.strictObject({
      against: z.enum(["base", "head"]),
      cursor: z.number().int().nonnegative().optional(),
      kind: z.literal("changes"),
    }),
  ]),
});
// oxlint-disable github/filenames-match-regex -- Eve tool discovery requires the public snake_case tool name.
