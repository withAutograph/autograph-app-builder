import type { ToolContext } from "eve/tools";

import { githubPublicationRuntimeForSession } from "./deployment-github-publication-runtime";
import { retainedDirectProductionSchemaReadbackGrant } from "./direct-production-state";
import { draftReconciliationState } from "./draft-reconciliation-state";
import { resolveGitHubPrDeliverySubject } from "./github-pr-delivery-subject";
import { repositoryProductionClientForContext } from "./repository-production-client";
import { appBuilderWorkflowState } from "./workflow-state";

const unavailableMessage =
  "Builder could not verify the installed schema for this reviewed draft. The app’s data and delivery are unchanged.";

const approvalChanged = "approval-changed";

// oxlint-disable-next-line sonarjs/max-union-size -- Closed non-sensitive failure stages.
type ReadbackFailure =
  | "review-unavailable"
  | "approval-unavailable"
  | "github-read-unavailable"
  | "draft-changed"
  | "readback-authority-unavailable"
  | "operator-read-unavailable"
  | typeof approvalChanged;

const currentReviewedSubject = () =>
  resolveGitHubPrDeliverySubject(appBuilderWorkflowState.get(), draftReconciliationState.get());

/** Read the exact app's existing installation for the current approved draft only. */
export const readInstalledSchemaPredecessor = async (appId: string, ctx: ToolContext) => {
  ctx.abortSignal.throwIfAborted();
  let stage: ReadbackFailure = "review-unavailable";
  const unavailable = () => new Error(`${unavailableMessage} (${stage})`);
  try {
    const subject = currentReviewedSubject();
    if (subject?.appId !== appId || subject.installationId === undefined) {
      throw unavailable();
    }
    stage = "approval-unavailable";
    const scope = { appId, installationId: subject.installationId };
    const grant = retainedDirectProductionSchemaReadbackGrant(ctx, scope);
    const revision = grant?.subject.revision;
    const repair = revision?.reconciliation;
    const reviewedRepair =
      repair?.digest === subject.reconciliation?.digest &&
      (repair === undefined || repair.originPublicationDigest === subject.proposalDigest);
    if (
      grant === undefined ||
      revision?.schemaChange?.kind !== "add-optional-text-field" ||
      !reviewedRepair
    ) {
      throw unavailable();
    }
    stage = "github-read-unavailable";
    const { proposalDigest, reconciliation, installationId } = subject;
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
      target.repositoryId === grant.subject.repositoryId,
      `${target.owner}/${target.name}` === grant.subject.repositoryFullName,
      target.baseBranch === grant.subject.baseBranch,
      repair === undefined || target.pullRequestNumber === repair.pullRequestNumber,
    ].every(Boolean);
    if (!matches) {
      throw unavailable();
    }
    const stillCurrent = () => {
      ctx.abortSignal.throwIfAborted();
      const current = currentReviewedSubject();
      return [
        current?.appId === appId,
        current?.proposalDigest === proposalDigest,
        current?.installationId === installationId,
        current?.reconciliation?.digest === reconciliation?.digest,
        retainedDirectProductionSchemaReadbackGrant(ctx, scope)?.digest === grant.digest,
      ].every(Boolean);
    };
    stage = approvalChanged;
    if (!stillCurrent()) {
      throw unavailable();
    }
    stage = "readback-authority-unavailable";
    const { emitCurrentBuildWorkflowProjection } =
      await import("./approved-build-continuation-runtime");
    await emitCurrentBuildWorkflowProjection(ctx);
    stage = approvalChanged;
    if (!stillCurrent()) {
      throw unavailable();
    }
    stage = "operator-read-unavailable";
    const client = await repositoryProductionClientForContext(ctx);
    stage = approvalChanged;
    if (!stillCurrent()) {
      throw unavailable();
    }
    stage = "operator-read-unavailable";
    const result = await client.schemaPredecessor(appId, target.repositoryId, target.headSha);
    stage = approvalChanged;
    if (stillCurrent()) {
      return result;
    }
  } catch {
    ctx.abortSignal.throwIfAborted();
  }
  throw unavailable();
};
