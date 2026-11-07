// oxlint-disable github/filenames-match-regex -- Eve discovers this tool by its snake_case name.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { githubPublicationRuntimeForSession } from "@/lib/agent/deployment-github-publication-runtime";
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
    const observation = await runtime.inspectPublishedPullRequest(
      state.githubDraftProposal.proposal.digest,
    );
    const checks = observation.draft ? "deferred" : observation.checks;
    const result = { ...observation, checks };
    if (
      runtime.runPublishedPullRequestEffect !== undefined &&
      observation.state === "open" &&
      observation.reviewedRevision
    ) {
      const target = { ...observation.reviewedTarget };
      const installed =
        installation === undefined ? target : { ...target, installationId: installation };
      const proposal = { ...installed, proposalDigest: state.githubDraftProposal.proposal.digest };
      const approval =
        observation.readyAt === undefined
          ? proposal
          : { ...proposal, readyAt: observation.readyAt };
      return {
        ...result,
        approval: { ...approval, sessionId: ctx.session.id },
      };
    }
    return result;
  },
  inputSchema: z.strictObject({}),
});
