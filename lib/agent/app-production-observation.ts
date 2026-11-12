import type { WorkflowStepToolContext } from "eve/tools";
import { isDeepStrictEqual } from "node:util";
import { HostedSessionAuthorityError } from "../hosted/session-authority";
import { HostedOperatorError } from "../provisioning/hosted-operator-contract";
import type { RepositoryProductionNativeStatus } from "../provisioning/repository-production-native-status-contract";
import {
  repositoryProductionClientForContext,
  RepositoryProductionNativeAccessChangedError,
} from "./repository-production-client";
import { githubPublicationRuntimeForSession } from "./deployment-github-publication-runtime";
import { resolveGitHubPrDeliverySubject } from "./github-pr-delivery-subject";
import { appBuilderWorkflowState } from "./workflow-state";
import { draftReconciliationState } from "./draft-reconciliation-state";

const unassessed = "unassessed";
const monitoringStoppedStatus = "monitoring-stopped";

export type AppProductionObservation =
  | RepositoryProductionNativeStatus
  | {
      status: typeof monitoringStoppedStatus;
      requestedRevision: typeof unassessed;
    };

export interface AppProductionDeliveryTarget {
  appId: string;
  repositoryId: string;
  repositoryFullName: string;
}

const monitoringStopped = (): AppProductionObservation => ({
  status: monitoringStoppedStatus,
  requestedRevision: unassessed,
});

const serviceUnavailableStatus = "service-unavailable";

const serviceUnavailable = (
  appId: string,
  serviceIssue: "configuration" | "provider-read",
): RepositoryProductionNativeStatus => ({
  version: 1,
  appId,
  observedAt: new Date().toISOString(),
  status: serviceUnavailableStatus,
  deployment: { state: serviceUnavailableStatus },
  app: { state: serviceUnavailableStatus },
  requestedRevision: unassessed,
  serviceIssue,
});

/** An independent saved-session read uses canonical ownership, never old Build or merge state. */
export const observeAppProduction = async (
  appId: string,
  ctx: WorkflowStepToolContext,
  expectedMergeSha?: string,
): Promise<AppProductionObservation> => {
  ctx.abortSignal.throwIfAborted();
  let clientResolved = false;
  try {
    const client = await repositoryProductionClientForContext(ctx);
    clientResolved = true;
    const observed = await client.nativeStatus(appId, expectedMergeSha);
    ctx.abortSignal.throwIfAborted();
    return observed;
  } catch (error) {
    ctx.abortSignal.throwIfAborted();
    if (
      error instanceof RepositoryProductionNativeAccessChangedError ||
      error instanceof HostedSessionAuthorityError ||
      (error instanceof HostedOperatorError && error.code === "authorization_required")
    ) {
      return monitoringStopped();
    }
    return serviceUnavailable(appId, clientResolved ? "provider-read" : "configuration");
  }
};

/** Verified immutable merge metadata survives loss of its old Build, review or Ready call. */
export const observeMergedAppProduction = async (
  target: AppProductionDeliveryTarget,
  ctx: WorkflowStepToolContext,
  expectedMergeSha?: string,
): Promise<AppProductionObservation> => {
  ctx.abortSignal.throwIfAborted();
  const observed = await observeAppProduction(target.appId, ctx, expectedMergeSha);
  if (observed.status === monitoringStoppedStatus) {
    return observed;
  }
  if (observed.destination === undefined) {
    return observed.status === serviceUnavailableStatus && observed.app.url === undefined
      ? observed
      : serviceUnavailable(target.appId, "configuration");
  }
  return observed.destination.repositoryId === target.repositoryId &&
    observed.destination.repositoryFullName === target.repositoryFullName
    ? observed
    : monitoringStopped();
};

const currentReviewedDelivery = () =>
  resolveGitHubPrDeliverySubject(appBuilderWorkflowState.get(), draftReconciliationState.get());

/** A saved-session status read can recover the reviewed merge from GitHub without replaying delivery. */
export const observeSavedAppProduction = async (
  appId: string,
  ctx: WorkflowStepToolContext,
): Promise<AppProductionObservation> => {
  ctx.abortSignal.throwIfAborted();
  try {
    const subject = currentReviewedDelivery();
    if (subject?.appId === appId) {
      const { proposalDigest, reconciliation, installationId } = subject;
      const runtime = await githubPublicationRuntimeForSession(
        ctx.session.auth,
        installationId === undefined ? undefined : { selectedInstallationId: installationId },
      );
      const reconciledHead =
        reconciliation === undefined
          ? undefined
          : ((await runtime.inspectPublishedReconciliationHead?.(proposalDigest, reconciliation)) ??
            undefined);
      if (reconciliation === undefined || reconciledHead !== undefined) {
        const observed = await runtime.inspectPublishedPullRequest?.(
          proposalDigest,
          reconciledHead,
        );
        if (
          observed?.state === "merged" &&
          observed.reviewedRevision &&
          observed.mergeCommitSha !== undefined &&
          isDeepStrictEqual(currentReviewedDelivery(), subject)
        ) {
          const { repositoryId, owner, name } = observed.reviewedTarget;
          const status = await observeMergedAppProduction(
            { appId, repositoryId, repositoryFullName: `${owner}/${name}` },
            ctx,
            observed.mergeCommitSha,
          );
          if (
            status.status === monitoringStoppedStatus ||
            isDeepStrictEqual(currentReviewedDelivery(), subject)
          ) {
            return status;
          }
        }
      }
    }
  } catch {
    // Missing historical evidence still permits an independent owned app availability read.
    ctx.abortSignal.throwIfAborted();
  }
  return await observeAppProduction(appId, ctx);
};
