/* oxlint-disable unicorn/filename-case -- Eve derives the public tool identifier from this existing filename. */
// oxlint-disable github/filenames-match-regex -- Eve discovers this tool by its snake_case name.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { githubPublicationRuntimeForSession } from "@/lib/agent/deployment-github-publication-runtime";
import { draftReconciliationState } from "@/lib/agent/draft-reconciliation-state";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { currentDirectProductionGrant } from "@/lib/agent/direct-production-state";
import { resolveGitHubPrDeliverySubject } from "@/lib/agent/github-pr-delivery-subject";
import {
  readGitHubProductionDeliveryReadiness,
  githubProductionSetupContinuation,
} from "@/lib/agent/github-production-delivery-readiness";

export default defineTool({
  description:
    "Read this session's reviewed pull request and required checks. For a first managed Production release, finish data and access setup after draft publication. For an approved revision, verify the existing setup. Follow the returned nextCall for setup or reviewed delivery using the current release approval. A draft defers checks until Ready. Passing checks or setup do not claim native activation or hosted behavior.",
  async execute(_input, ctx) {
    const subject = resolveGitHubPrDeliverySubject(
      appBuilderWorkflowState.get(),
      draftReconciliationState.get(),
    );
    if (subject === undefined) {
      throw new Error("This session has no reviewed draft pull request publication.");
    }
    const { proposalDigest, reconciliation, installationId: installation } = subject;
    const runtime = await githubPublicationRuntimeForSession(
      ctx.session.auth,
      installation === undefined ? undefined : { selectedInstallationId: installation },
    );
    if (runtime.inspectPublishedPullRequest === undefined) {
      throw new Error("GitHub pull request status is unavailable for this session.");
    }
    const reconciledHead =
      reconciliation === undefined
        ? undefined
        : ((await runtime.inspectPublishedReconciliationHead?.(proposalDigest, reconciliation)) ??
          undefined);
    const observation = await runtime.inspectPublishedPullRequest(proposalDigest, reconciledHead);
    const checks = observation.draft ? "deferred" : observation.checks;
    const result = { ...observation, checks };
    const reconciliationIsReady = reconciliation === undefined || reconciledHead !== undefined;
    if (
      runtime.runPublishedPullRequestEffect !== undefined &&
      observation.state === "open" &&
      observation.reviewedRevision &&
      reconciliationIsReady
    ) {
      const targetScope = {
        appId: subject.appId,
        repositoryId: observation.reviewedTarget.repositoryId,
        repositoryFullName: `${observation.reviewedTarget.owner}/${observation.reviewedTarget.name}`,
      };
      const productionSetup = await readGitHubProductionDeliveryReadiness(
        { ...targetScope, reviewedHeadSha: observation.reviewedTarget.headSha },
        ctx,
      );
      const revision = currentDirectProductionGrant(ctx, targetScope)?.subject.revision;
      if (
        revision !== undefined &&
        (!productionSetup.applicable ||
          productionSetup.state !== "ready" ||
          productionSetup.preparationRequired)
      ) {
        return {
          ...result,
          status: "production-revision-setup-changed" as const,
          productionSetup,
        };
      }
      if (
        productionSetup.applicable &&
        (productionSetup.state !== "ready" || productionSetup.preparationRequired)
      ) {
        return {
          ...result,
          productionSetup,
          nextCall: githubProductionSetupContinuation(productionSetup),
        };
      }
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
      return {
        ...result,
        approval,
        nextCall: { tool: "finish-github-pr-delivery" as const, input: approval },
      };
    }
    return result;
  },
  inputSchema: z.strictObject({}),
});
