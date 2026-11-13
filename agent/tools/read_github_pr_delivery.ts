/* oxlint-disable unicorn/filename-case -- Eve derives the public tool identifier from this existing filename. */
// oxlint-disable github/filenames-match-regex -- Eve discovers this tool by its snake_case name.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { githubPublicationRuntimeForSession } from "@/lib/agent/deployment-github-publication-runtime";
import { draftReconciliationState } from "@/lib/agent/draft-reconciliation-state";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { currentDirectProductionGrant } from "@/lib/agent/direct-production-state";
import { recordDirectProductionProgress } from "@/lib/agent/direct-production-progress";
import { readLiveMergedAppProduction } from "@/lib/agent/app-production-observation";
import { resolveGitHubPrDeliverySubject } from "@/lib/agent/github-pr-delivery-subject";
import {
  readGitHubProductionDeliveryReadiness,
  githubProductionSetupContinuation,
} from "@/lib/agent/github-production-delivery-readiness";

export default defineTool({
  description:
    "Read this session's reviewed pull request and required checks. For a first managed Production release, finish data and access setup after draft publication. For an approved revision, verify the existing setup. For a merged optional-field revision, report the confirmed live app or resume the already approved database update. Follow the returned nextCall for setup or reviewed delivery using the current release approval. A draft defers checks until Ready. Passing checks or setup do not claim native activation or hosted behavior.",
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
    const targetScope = {
      appId: subject.appId,
      repositoryId: observation.reviewedTarget.repositoryId,
      repositoryFullName: `${observation.reviewedTarget.owner}/${observation.reviewedTarget.name}`,
    };
    const grantScope: Parameters<typeof currentDirectProductionGrant>[1] = {
      ...targetScope,
      baseBranch: observation.reviewedTarget.baseBranch,
    };
    if (installation !== undefined) {
      grantScope.installationId = installation;
    }
    const grant = currentDirectProductionGrant(ctx, grantScope);
    const revision = grant?.subject.revision;
    const schemaRevision = revision?.schemaChange !== undefined;
    const schemaMergeSha =
      schemaRevision && observation.state === "merged" ? observation.mergeCommitSha : undefined;
    const canContinue = observation.state === "open" || schemaMergeSha !== undefined;
    if (!observation.reviewedRevision || !reconciliationIsReady || !canContinue) {
      return result;
    }
    if (grant !== undefined && schemaMergeSha !== undefined) {
      const nativeProduction = await readLiveMergedAppProduction(
        targetScope,
        ctx,
        schemaMergeSha,
        grant.digest,
      );
      const currentSubject = resolveGitHubPrDeliverySubject(
        appBuilderWorkflowState.get(),
        draftReconciliationState.get(),
      );
      const reviewMatches = [
        currentSubject?.appId === subject.appId,
        currentSubject?.proposalDigest === proposalDigest,
        currentSubject?.installationId === installation,
        currentSubject?.reconciliation?.digest === reconciliation?.digest,
      ].every(Boolean);
      if (
        !reviewMatches ||
        currentDirectProductionGrant(ctx, grantScope)?.digest !== grant.digest
      ) {
        return result;
      }
      if (nativeProduction !== undefined) {
        recordDirectProductionProgress(grant.digest, "live");
        return { ...result, nativeProduction };
      }
    }
    if (runtime.runPublishedPullRequestEffect === undefined) {
      return result;
    }
    if (observation.state === "open") {
      const productionSetup = await readGitHubProductionDeliveryReadiness(
        { ...targetScope, reviewedHeadSha: observation.reviewedTarget.headSha },
        ctx,
      );
      const setupChanged =
        !productionSetup.applicable ||
        productionSetup.state !== "ready" ||
        productionSetup.preparationRequired;
      const schemaVerified =
        productionSetup.applicable && productionSetup.schemaTransitionVerified === true;
      if (schemaRevision ? !schemaVerified : revision !== undefined && setupChanged) {
        return {
          ...result,
          status: "production-revision-setup-changed" as const,
          productionSetup,
        };
      }
      if (!schemaRevision && productionSetup.applicable && setupChanged) {
        return {
          ...result,
          productionSetup,
          nextCall: githubProductionSetupContinuation(productionSetup),
        };
      }
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
  },
  inputSchema: z.strictObject({}),
});
