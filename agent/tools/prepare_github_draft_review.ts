import { defineTool } from "eve/tools";
import { z } from "zod";

import { exactNormalizedChangeSet } from "./change_set_status";
import { githubPublicationRuntimeForSession } from "@/lib/agent/deployment-github-publication-runtime";
import {
  appBuilderWorkflowState,
  updateExactWorkflow,
  invalidateGitHubDestinationReview,
} from "@/lib/agent/workflow-state";
import { createGitHubDestinationReviewBinding } from "@/lib/repository/github-destination-review";
import { assertExistingAppReviewScope } from "@/lib/repository/reviewed-change-set";
import { appBaselineState } from "@/lib/agent/app-baseline-state";
import { checkedNativeToolResult } from "@/lib/eve/payload-envelope";
import { resolvePublicationTargetForTool } from "@/lib/agent/github-publication-destination";

export default defineTool({
  description:
    "Prepare a fresh initial draft-PR review against the selected GitHub repository's current default branch. For a fresh-template app, supply the intended existing repository in destination; its normal GitHub access connection is checked without replacing the starter checkout. A retained destination review can be refreshed without repeating that selector. Read only the intended app change paths, preserve the validated private app and original source provenance, and invalidate the old review and draft proposal. Use change_set_status with contentSide before or after to inspect destination content as needed. Then accept_change_set, seal the new proposal, and request separate publication approval. This never writes GitHub or updates an existing PR.",
  async execute(input, ctx) {
    const state = appBuilderWorkflowState.get();
    if (state.phase !== "validated" && state.phase !== "reviewed") {
      throw new Error("Validate the app before preparing a destination review.");
    }
    if (
      state.publishedGitHubDraftProposalDigest !== undefined ||
      (state.phase === "reviewed" && state.existingDraftUpdate !== undefined)
    ) {
      throw new Error(
        "Use the existing draft update or reconciliation workflow for an existing PR.",
      );
    }
    const resolved = await resolvePublicationTargetForTool({
      ctx,
      destination: input.destination,
      destinationReview: state.githubDestinationReview,
      githubSource: state.githubSource,
      sourceKind: state.sourceReceipt.sourceKind,
    });
    if (resolved.kind === "selection") {
      return resolved.access;
    }
    if (resolved.kind === "missing") {
      return {
        status: "publication-destination-required" as const,
        nextAction: {
          tool: "prepare_github_draft_review",
          requiredInput: "destination.repository",
        },
        reason:
          "Supply the intended existing publication repository as destination. Preserve the current starter source and app; do not call resolve_github_source or create a replacement repository.",
      };
    }
    const { target } = resolved;
    const changeSet = await exactNormalizedChangeSet({ sandbox: await ctx.getSandbox(), state });
    const candidatePaths = state.githubDestinationReview?.candidatePaths ?? changeSet.approvedPaths;
    assertExistingAppReviewScope(
      { approvedPaths: candidatePaths, sourceSha: changeSet.sourceSha },
      state.appSpec.appId,
      state.sourceReceipt.sourceKind,
      appBaselineState.get()?.receipt,
    );
    const runtime =
      target.destination === undefined
        ? await githubPublicationRuntimeForSession(ctx.session.auth)
        : await githubPublicationRuntimeForSession(ctx.session.auth, {
            selectedInstallationId: target.destination.installationId,
          });
    if (runtime.inspectDraftDestination === undefined) {
      throw new Error("The GitHub runtime does not support destination reviews.");
    }
    const destination = await runtime.inspectDraftDestination({
      existingProposal:
        state.phase === "reviewed" ? state.githubDraftProposal?.proposal : undefined,
      ...target,
      paths: candidatePaths,
    });
    const binding = createGitHubDestinationReviewBinding({
      ...destination,
      applyDigest: state.applyReceipt.digest,
      candidatePaths,
      postTreeDigest: changeSet.postTreeDigest,
      validationDigest: state.validationReceipt.digest,
    });
    updateExactWorkflow({
      expected: state,
      operation: "destination review preparation",
      transition: () => invalidateGitHubDestinationReview(state, binding),
    });
    return checkedNativeToolResult(
      {
        branch: binding.repository.defaultBranch,
        candidatePathCount: binding.candidatePaths.length,
        destinationReviewDigest: binding.digest,
        destinationReviewReference: {
          digest: binding.digest,
          kind: "current-session-destination-review",
          sessionId: ctx.session.id,
        },
        destinationSha: binding.repository.headSha,
        destinationTree: binding.repository.headTree,
        next: 'Inspect destination content as needed with change_set_status view="next-page" and contentSide="before" or "after"; view="read-progress" reports optional inspection progress. Then accept_change_set, seal_github_draft_pr_proposal, and request publication approval.',
        originalSourceSha: state.githubSource?.resolvedSha ?? state.sourceReceipt.sourceSha,
        repository: `${binding.repository.owner}/${binding.repository.name}`,
        status: "destination-review-required",
      },
      { callId: ctx.callId, toolName: "prepare_github_draft_review", turnId: ctx.session.turn.id },
    );
  },
  inputSchema: z.strictObject({
    destination: z
      .strictObject({
        repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
        selectedInstallationId: z
          .string()
          .regex(/^[1-9][0-9]*$/u)
          .nullable()
          .optional(),
      })
      .optional(),
  }),
});
