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

export default defineTool({
  description:
    "Prepare a fresh initial draft-PR review against the selected GitHub repository's current default branch. Read only the intended app change paths, preserve the validated private app and original source provenance, and invalidate the old review and draft proposal. Then use change_set_status with contentSide before and after to review the complete destination diff, accept_change_set, seal the new proposal, and request separate publication approval. This never writes GitHub or updates an existing PR.",
  async execute(_input, ctx) {
    const state = appBuilderWorkflowState.get();
    if (
      (state.phase !== "validated" && state.phase !== "reviewed") ||
      state.githubSource === undefined
    ) {
      throw new Error("Validate the selected GitHub app before preparing a destination review.");
    }
    if (
      state.publishedGitHubDraftProposalDigest !== undefined ||
      (state.phase === "reviewed" && state.existingDraftUpdate !== undefined)
    ) {
      throw new Error(
        "Use the existing draft update or reconciliation workflow for an existing PR.",
      );
    }
    const changeSet = await exactNormalizedChangeSet({ sandbox: await ctx.getSandbox(), state });
    const candidatePaths = state.githubDestinationReview?.candidatePaths ?? changeSet.approvedPaths;
    assertExistingAppReviewScope(
      { approvedPaths: candidatePaths, sourceSha: changeSet.sourceSha },
      state.appSpec.appId,
      state.sourceReceipt.sourceKind,
      appBaselineState.get()?.receipt,
    );
    const runtime = await githubPublicationRuntimeForSession(ctx.session.auth);
    if (runtime.inspectDraftDestination === undefined) {
      throw new Error("The GitHub runtime does not support destination reviews.");
    }
    const destination = await runtime.inspectDraftDestination({
      existingProposal:
        state.phase === "reviewed" ? state.githubDraftProposal?.proposal : undefined,
      githubSource: state.githubSource,
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
        next: "Review change_set_status with includeContent=true and contentSide before and after, then accept_change_set before sealing and approving publication.",
        originalSourceSha: state.githubSource.resolvedSha,
        repository: `${binding.repository.owner}/${binding.repository.name}`,
        status: "destination-review-required",
      },
      { callId: ctx.callId, toolName: "prepare_github_draft_review", turnId: ctx.session.turn.id },
    );
  },
  inputSchema: z.strictObject({}),
});
