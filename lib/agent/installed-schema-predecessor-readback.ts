import type { ToolContext } from "eve/tools";

import { githubPublicationRuntimeForSession } from "./deployment-github-publication-runtime";
import { currentDirectProductionGrant } from "./direct-production-state";
import { draftReconciliationState } from "./draft-reconciliation-state";
import { resolveGitHubPrDeliverySubject } from "./github-pr-delivery-subject";
import { repositoryProductionClientForContext } from "./repository-production-client";
import { appBuilderWorkflowState } from "./workflow-state";

const unavailableMessage =
  "Builder could not verify the installed schema for this reviewed draft. The app’s data and delivery are unchanged.";

const currentReviewedSubject = () =>
  resolveGitHubPrDeliverySubject(appBuilderWorkflowState.get(), draftReconciliationState.get());

/** Read the exact app's existing installation for the current approved draft only. */
export const readInstalledSchemaPredecessor = async (appId: string, ctx: ToolContext) => {
  ctx.abortSignal.throwIfAborted();
  try {
    const subject = currentReviewedSubject();
    if (subject?.appId !== appId || subject.installationId === undefined) {
      throw new Error(unavailableMessage);
    }
    const scope = { appId, installationId: subject.installationId };
    const grant = currentDirectProductionGrant(ctx, scope);
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
      throw new Error(unavailableMessage);
    }
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
      throw new Error(unavailableMessage);
    }
    const observation = await runtime.inspectPublishedPullRequest?.(proposalDigest, head);
    const target = observation?.reviewedTarget;
    const matches = [
      observation?.state === "open",
      observation?.draft === true,
      observation?.reviewedRevision === true,
      target?.repositoryId === grant.subject.repositoryId,
      `${target?.owner}/${target?.name}` === grant.subject.repositoryFullName,
      target?.baseBranch === grant.subject.baseBranch,
      repair === undefined || target?.pullRequestNumber === repair.pullRequestNumber,
    ].every(Boolean);
    if (target === undefined || !matches) {
      throw new Error(unavailableMessage);
    }
    const stillCurrent = () => {
      ctx.abortSignal.throwIfAborted();
      const current = currentReviewedSubject();
      return [
        current?.appId === appId,
        current?.proposalDigest === proposalDigest,
        current?.installationId === installationId,
        current?.reconciliation?.digest === reconciliation?.digest,
        currentDirectProductionGrant(ctx, scope)?.digest === grant.digest,
      ].every(Boolean);
    };
    const client = await repositoryProductionClientForContext(ctx);
    if (!stillCurrent()) {
      throw new Error(unavailableMessage);
    }
    const result = await client.schemaPredecessor(appId, target.repositoryId, target.headSha);
    if (stillCurrent()) {
      return result;
    }
  } catch {
    ctx.abortSignal.throwIfAborted();
  }
  throw new Error(unavailableMessage);
};
