import { isDeepStrictEqual } from "node:util";
import type { ToolContext } from "eve/tools";

import { githubPublicationRuntimeForSession } from "./deployment-github-publication-runtime";
import { draftReconciliationState } from "./draft-reconciliation-state";
import { resolveDraftReviewedWorkflow } from "./draft-reviewed-lineage";
import { resolveGitHubPrDeliverySubject } from "./github-pr-delivery-subject";
import { repositoryProductionClientForContext } from "./repository-production-client";
import { appBuilderWorkflowState } from "./workflow-state";

const unavailableMessage =
  "Builder could not verify the installed schema for this reviewed draft. The app’s data and delivery are unchanged.";

const reviewChanged = "review-changed";

// oxlint-disable-next-line sonarjs/max-union-size -- Closed non-sensitive failure stages.
type ReadbackFailure =
  | "review-unavailable"
  | "github-read-unavailable"
  | "draft-changed"
  | "readback-authority-unavailable"
  | "operator-read-unavailable"
  | typeof reviewChanged;

const currentReviewedDraft = (appId: string) => {
  const workflow = appBuilderWorkflowState.get();
  const candidate = draftReconciliationState.get();
  const review = resolveDraftReviewedWorkflow(workflow, candidate);
  const subject = resolveGitHubPrDeliverySubject(workflow, candidate);
  const repository =
    review?.githubSource?.repository ?? review?.githubDestinationReview?.repository;
  const installationId = subject?.installationId;
  if (
    review === undefined ||
    subject?.appId !== appId ||
    repository === undefined ||
    installationId === undefined
  ) {
    return null;
  }
  return {
    appSpecDigest: review.appSpec.digest,
    appReviewDigest: review.reviewReceipt.digest,
    installationId,
    proposalDigest: subject.proposalDigest,
    reconciliation: subject.reconciliation,
    repository: {
      repositoryId: repository.repositoryId,
      owner: repository.owner,
      name: repository.name,
      baseBranch: repository.defaultBranch,
    },
  };
};

/** Read the existing installation for the session's exact published draft. */
export const readInstalledSchemaPredecessor = async (appId: string, ctx: ToolContext) => {
  ctx.abortSignal.throwIfAborted();
  let stage: ReadbackFailure = "review-unavailable";
  const unavailable = () => new Error(`${unavailableMessage} (${stage})`);
  try {
    const scope = currentReviewedDraft(appId);
    if (scope === null) {
      throw unavailable();
    }
    stage = "github-read-unavailable";
    const { proposalDigest, reconciliation, installationId, repository } = scope;
    const runtime = await githubPublicationRuntimeForSession(ctx.session.auth, {
      selectedInstallationId: installationId,
    });
    const head =
      reconciliation === undefined
        ? undefined
        : ((await runtime.inspectPublishedReconciliationHead?.(proposalDigest, reconciliation)) ??
          undefined);
    if (reconciliation !== undefined && head === undefined) {
      stage = "draft-changed";
      throw unavailable();
    }
    const observation = await runtime.inspectPublishedPullRequest?.(proposalDigest, head);
    if (observation === undefined) {
      throw unavailable();
    }
    stage = "draft-changed";
    const { reviewedTarget: target } = observation;
    const matches = [
      observation.state === "open",
      observation.draft,
      observation.reviewedRevision,
      target.repositoryId === repository.repositoryId,
      target.owner === repository.owner,
      target.name === repository.name,
      target.baseBranch === repository.baseBranch,
      reconciliation === undefined ||
        (target.pullRequestNumber === reconciliation.pullRequestNumber && target.headSha === head),
    ].every(Boolean);
    if (!matches) {
      throw unavailable();
    }
    const stillCurrent = () => {
      ctx.abortSignal.throwIfAborted();
      return isDeepStrictEqual(currentReviewedDraft(appId), scope);
    };
    stage = reviewChanged;
    if (!stillCurrent()) {
      throw unavailable();
    }
    stage = "readback-authority-unavailable";
    const { emitCurrentBuildWorkflowProjection } =
      await import("./approved-build-continuation-runtime");
    await emitCurrentBuildWorkflowProjection(ctx);
    stage = reviewChanged;
    if (!stillCurrent()) {
      throw unavailable();
    }
    stage = "operator-read-unavailable";
    const client = await repositoryProductionClientForContext(ctx);
    stage = reviewChanged;
    if (!stillCurrent()) {
      throw unavailable();
    }
    stage = "operator-read-unavailable";
    const result = await client.schemaPredecessor(appId, target.repositoryId, target.headSha);
    stage = reviewChanged;
    if (stillCurrent()) {
      return result;
    }
  } catch {
    ctx.abortSignal.throwIfAborted();
  }
  throw unavailable();
};
