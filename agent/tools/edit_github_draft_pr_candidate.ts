/* oxlint-disable unicorn/filename-case -- Eve derives the public tool identifier from this existing filename. */
import { resolveDraftReviewedWorkflow } from "@/lib/agent/draft-reviewed-lineage";
import { currentDraftCandidateSource } from "@/lib/agent/published-draft-repair";
import { defineTool } from "eve/tools";
import { getSourceBoundSandbox } from "@/lib/agent/source-bound-sandbox";
import { z } from "zod";

import {
  draftReconciliationState,
  samePersistedDraftCandidate,
  updateExactDraftReconciliation,
} from "@/lib/agent/draft-reconciliation-state";
import { appBuilderWorkflowState, assertExactWorkflowState } from "@/lib/agent/workflow-state";
import {
  createDraftReconciliationCandidateFile,
  DraftCandidateCreationUncertainError,
  readDraftReconciliationCandidateFilePage,
  replaceDraftReconciliationCandidateText,
  restoreDraftReconciliationCandidateFile,
} from "@/lib/repository/sandbox-draft-reconciliation";

interface PreservedCandidateSource {
  kind: "preserved-draft-candidate";
  nextAction: string;
  preservedWorkspaceIndex: number | undefined;
  reviewDigest: string;
}

interface CandidatePageMetadata {
  source?: PreservedCandidateSource;
}

export default defineTool({
  description:
    "Read a current app-owned text file in bounded UTF-8 pages in Builder's isolated draft merge candidate. A read may specify preservedWorkspaceIndex from the candidate's preservedWorkspaces to inspect a retained draft candidate; this never selects an arbitrary root and does not edit preserved work. Retained app-review content remains available through change_set_status with includeContent. Continue with nextCursor and the read source's whole-file digest as expectedDigest; an ordinary file change returns its fresh first page with sourceChanged. Read the current candidate separately before using its digest for an edit. Create a new app-owned text file with kind: create, path and content; creation requires an absent path and never overwrites existing files. Replace one unique exact passage using the current whole-file digest, or restore one app-owned file's exact bytes and mode from the retained draft head. Restore accepts only a path and preserves other repairs. This changes no GitHub branch. Revalidate the complete candidate, review both diffs, and obtain the exact update approval before publication.",
  async execute(input, ctx) {
    ctx.abortSignal?.throwIfAborted();
    const candidate = structuredClone(draftReconciliationState.get());
    const workflow = structuredClone(appBuilderWorkflowState.get());
    const state = resolveDraftReviewedWorkflow(workflow, candidate) ?? workflow;
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
    const assertCurrentCreation = () => {
      ctx.abortSignal?.throwIfAborted();
      assertExactWorkflowState(
        appBuilderWorkflowState.get(),
        workflow,
        "creating a draft candidate file",
      );
      if (!samePersistedDraftCandidate(draftReconciliationState.get(), candidate)) {
        throw new Error("The draft candidate changed before its new file could be created.");
      }
    };
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
      const page = {
        ...(await readDraftReconciliationCandidateFilePage({
          cursor: input.cursor,
          expectedDigest: input.expectedDigest,
          path: input.path,
          prepared: preserved === undefined ? candidate : { ...candidate, root: preserved.root },
          sandbox,
        })),
        path: input.path,
      };
      const metadata: CandidatePageMetadata = {};
      if (preserved !== undefined) {
        metadata.source = {
          kind: "preserved-draft-candidate",
          preservedWorkspaceIndex: input.preservedWorkspaceIndex,
          reviewDigest: preserved.reviewDigest,
          nextAction:
            "This digest belongs to preserved content. Read the current candidate separately before a deliberate replacement using its current digest.",
        };
      }
      return {
        ...page,
        ...metadata,
        status: preserved === undefined ? ("current_file" as const) : ("preserved_file" as const),
      };
    }
    const invalidateCandidateProof = () => {
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
    };
    let result: { digest: string; mode?: "644" | "755" };
    try {
      if (input.kind === "create") {
        result = await createDraftReconciliationCandidateFile({
          abortSignal: ctx.abortSignal,
          assertCurrent: assertCurrentCreation,
          content: input.content,
          path: input.path,
          prepared: candidate,
          sandbox,
        });
      } else if (input.kind === "restore") {
        result = await restoreDraftReconciliationCandidateFile({
          path: input.path,
          prepared: candidate,
          sandbox,
        });
      } else {
        result = await replaceDraftReconciliationCandidateText({
          expectedDigest: input.expectedDigest,
          newText: input.newText,
          oldText: input.oldText,
          path: input.path,
          prepared: candidate,
          sandbox,
        });
      }
    } catch (error) {
      if (
        input.kind === "create" &&
        error instanceof DraftCandidateCreationUncertainError &&
        samePersistedDraftCandidate(draftReconciliationState.get(), candidate)
      ) {
        invalidateCandidateProof();
      }
      throw error;
    }
    invalidateCandidateProof();
    if (input.kind === "create") {
      ctx.abortSignal?.throwIfAborted();
    }
    return {
      ...result,
      next: "Read or continue editing this isolated candidate with edit_github_draft_pr_candidate, then validate the complete candidate with validate_github_draft_pr_reconciliation and review its base and prior-head diffs. inspect_repository reads the original creation workspace rather than these draft edits; the explicit draft validator reports this candidate's actual source.",
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
      content: z.string(),
      kind: z.literal("create"),
      path: z.string().min(1),
    }),
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
