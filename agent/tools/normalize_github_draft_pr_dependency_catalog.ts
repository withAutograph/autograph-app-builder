import { defineTool } from "eve/tools";
import { z } from "zod";

import { currentDraftCandidateSource } from "@/lib/agent/published-draft-repair";
import { getSourceBoundSandbox } from "@/lib/agent/source-bound-sandbox";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import {
  draftReconciliationState,
  updateExactDraftReconciliation,
} from "@/lib/agent/draft-reconciliation-state";
import {
  catalogDependencyName,
  normalizeCandidateDependencyCatalog,
  planCandidateDependencyCatalog,
} from "@/lib/repository/candidate-dependency-catalog";
import { inspectDraftReconciliation } from "@/lib/repository/sandbox-draft-reconciliation";

export default defineTool({
  description:
    "Normalize one dependency already declared by the selected app in the current private draft candidate into the repository's shared Bun catalog, preserving its existing concrete version across consumers. Regenerate lock metadata with the repository-pinned Bun and disabled install scripts. No arbitrary path, source, version upgrade, framework change, publication, or provider effect. Returns exact changed metadata paths; complete normal validation/review and approval before publication. Use this when app dependency declarations need shared catalog alignment; do not use frameworkUpgrade to repair generic dependency metadata.",
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
        "The candidate no longer matches the selected app and source review. Prepare the current draft before normalizing dependencies.",
      );
    }
    const sandbox = await getSourceBoundSandbox(ctx);
    if (candidate.dependencyCatalogPending === undefined) {
      await inspectDraftReconciliation({ sandbox, prepared: candidate });
    } else if (candidate.dependencyCatalogPending.dependency !== input.dependency) {
      throw new Error(
        "Resume the pending dependency normalization before selecting another dependency.",
      );
    }
    const intent =
      candidate.dependencyCatalogPending ??
      (await planCandidateDependencyCatalog({
        sandbox,
        prepared: candidate,
        dependency: input.dependency,
        signal: ctx.abortSignal,
      }));
    updateExactDraftReconciliation({
      expected: candidate,
      operation: "preparing candidate dependency normalization",
      transition: () => {
        const next = { ...candidate, dependencyCatalogPending: intent };
        delete next.proposal;
        delete next.review;
        delete next.repairReview;
        delete next.reviewReadProgress;
        delete next.validation;
        delete next.validationRun;
        return next;
      },
    });
    const current = draftReconciliationState.get();
    if (current === null) {
      throw new Error("The candidate is unavailable after preparing dependency normalization.");
    }
    const result = await normalizeCandidateDependencyCatalog({
      sandbox,
      prepared: current,
      intent,
      signal: ctx.abortSignal,
    });
    updateExactDraftReconciliation({
      expected: current,
      operation: "recording normalized dependency metadata",
      transition: () => ({
        ...current,
        dependencyCatalogPending: undefined,
        dependencyCatalog: {
          files: [
            ...(current.dependencyCatalog?.files ?? []).filter(
              (file) => !result.receipt.files.some((changed) => changed.path === file.path),
            ),
            ...result.receipt.files,
          ],
          nonAppIndexDigest: result.receipt.nonAppIndexDigest,
        },
      }),
    });
    return {
      ...result,
      status: result.lockGenerated ? "normalized" : "lock_generation_failed",
      next: "Validate the current candidate, including check:package-manifests; review all metadata changes before requesting outward approval.",
    };
  },
  inputSchema: z.strictObject({ dependency: catalogDependencyName }),
});

// oxlint-disable github/filenames-match-regex -- Eve tool discovery requires the public snake_case tool name.
