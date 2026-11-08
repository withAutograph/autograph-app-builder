// oxlint-disable github/filenames-match-regex -- Eve discovers this tool by its snake_case name.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { githubPublicationRuntimeForSession } from "@/lib/agent/deployment-github-publication-runtime";
import { draftReconciliationState } from "@/lib/agent/draft-reconciliation-state";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";

export default defineTool({
  description:
    "Read the current GitHub pull request, required checks, and merge status for this session's published draft. A draft defers checks until ready for review. A passing check or a merge does not verify the hosted app.",
  async execute(_input, ctx) {
    const state = appBuilderWorkflowState.get();
    if (state.phase !== "reviewed" || state.githubDraftProposal === undefined) {
      throw new Error("This session has no reviewed draft pull request publication.");
    }
    const installation = state.githubDestinationReview?.installation.installationId;
    const runtime = await githubPublicationRuntimeForSession(
      ctx.session.auth,
      installation === undefined ? undefined : { selectedInstallationId: installation },
    );
    if (runtime.inspectPublishedPullRequest === undefined) {
      throw new Error("GitHub pull request status is unavailable for this session.");
    }
    const proposalDigest = state.githubDraftProposal.proposal.digest;
    const candidate = draftReconciliationState.get();
    const reconciliation =
      candidate?.appId === state.appSpec.appId ? candidate.publishedReconciliation : undefined;
    const reconciledHead =
      reconciliation === undefined
        ? undefined
        : ((await runtime.inspectPublishedReconciliationHead?.(proposalDigest, reconciliation)) ??
          undefined);
    const observation = await runtime.inspectPublishedPullRequest(proposalDigest, reconciledHead);
    const checks = observation.draft ? "deferred" : observation.checks;
    const result = { ...observation, checks };
    if (
      runtime.runPublishedPullRequestEffect !== undefined &&
      observation.state === "open" &&
      observation.reviewedRevision
    ) {
      const target: typeof observation.reviewedTarget & { installationId?: string } = {
        ...observation.reviewedTarget,
      };
      if (installation !== undefined) {
        target.installationId = installation;
      }
      const approval: typeof target & {
        proposalDigest: string;
        reconciliationDigest?: string;
        readyAt?: string;
      } = { ...target, proposalDigest };
      if (reconciledHead !== undefined && reconciliation !== undefined) {
        approval.reconciliationDigest = reconciliation.digest;
      }
      if (observation.readyAt !== undefined) {
        approval.readyAt = observation.readyAt;
      }
      return { ...result, approval };
    }
    return result;
  },
  inputSchema: z.strictObject({}),
});
