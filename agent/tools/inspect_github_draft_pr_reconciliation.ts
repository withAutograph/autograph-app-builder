import { defineTool } from "eve/tools";
import { getSourceBoundSandbox } from "@/lib/agent/source-bound-sandbox";
import { z } from "zod";

import {
  draftReconciliationState,
  draftReconciliationCompletions,
} from "@/lib/agent/draft-reconciliation-state";
import { assertReconciliationCompletionOwnerForSession } from "@/lib/agent/compiled-operator-artifacts";
import { approvalReceiptForExistingDraftUpdate } from "@/lib/agent/approval-receipt";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { summarizeReconciliationChanges } from "@/lib/agent/draft-reconciliation-review-summary";
import {
  readDraftReconciliationConflict,
  readDraftReconciliationDiff,
} from "@/lib/repository/sandbox-draft-reconciliation";

export default defineTool({
  description:
    "Optionally inspect a merge conflict, recorded change metadata, or exact raw diff bytes against base or the old PR head. Metadata cursors are change indexes; raw diff cursors are byte offsets and may be requested independently. A raw diff may target one repository-relative path. For app_source_publication_required, kind=publication-recovery lists retained publication context for the current app and accepted specification, even if its current candidate failed. Copy a returned nextCall to request normal approval and verify the original Git result before recording the equivalent current capture; listed receipts describe approval subjects and grant no approval. Inspection is not a sealing prerequisite and does not update GitHub.",
  async execute(input, ctx) {
    const state = appBuilderWorkflowState.get();
    if (input.kind === "publication-recovery") {
      const currentAppSpec = "appSpec" in state ? state.appSpec : undefined;
      const completions = draftReconciliationCompletions
        .get()
        .filter(
          (completion) =>
            currentAppSpec !== undefined &&
            completion.appId === currentAppSpec.appId &&
            completion.appReview.appSpecDigest === currentAppSpec.digest,
        );
      const recoveries = [];
      for (const completion of completions) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Revalidate owner and accepted selection before exposing each retained context.
        await assertReconciliationCompletionOwnerForSession({
          completion,
          adapterSessionId: ctx.session.id,
          sessionAuth: ctx.session.auth,
        });
        const current = appBuilderWorkflowState.get();
        if (
          !("appSpec" in current) ||
          current.appSpec.appId !== completion.appId ||
          current.appSpec.digest !== completion.appReview.appSpecDigest
        ) {
          return {
            status: "selection-changed" as const,
            verification: "unverified" as const,
            recoveries: [],
            nextAction:
              "The accepted app specification changed while reading retained publication context. Read publication-recovery again for the current selection; no publication or association was attempted.",
          };
        }
        recoveries.push({
          proposalDigest: completion.proposal.digest,
          repositoryId: completion.proposal.repositoryId,
          branch: completion.proposal.branchName,
          ...(completion.compilation.release.status === "published"
            ? { releaseId: completion.compilation.release.selection.releaseId }
            : {}),
          nextCall: {
            tool: "reconcile_github_draft_pr" as const,
            arguments: {
              expectedProposalDigest: completion.proposal.digest,
              approvalReceipt: approvalReceiptForExistingDraftUpdate(completion.proposal),
              recordCurrentEquivalentRelease: true as const,
            },
          },
        });
      }
      return {
        status: "publication-recovery" as const,
        verification: "unverified" as const,
        recoveries,
        nextAction:
          recoveries.length === 0
            ? "No retained publication completion matches the current app and accepted specification. No publication, approval or source association was inferred. Continue the normal source-recording recovery in this session without republishing an already accepted Git result."
            : "Copy a retained nextCall to the existing reconciliation tool. These are unverified recovery candidates and approval-subject metadata, not approval grants or proof of applied Git publication. Normal approval, exact provider verification and full current-release matching still apply; no Git write is authorized by this listing.",
      };
    }
    const candidate = draftReconciliationState.get();
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
    z.strictObject({ kind: z.literal("publication-recovery") }),
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
