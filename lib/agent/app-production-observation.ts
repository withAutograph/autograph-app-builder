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
const savedObservationTimeoutMs = 15_000;
const providerRead = "provider-read";

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

type AppProductionObservationContext = Pick<
  WorkflowStepToolContext,
  "abortSignal" | "callId" | "session"
>;

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
  ctx: AppProductionObservationContext,
  expectedMergeSha?: string,
  includeActivationProof?: true,
  expectedSchemaGrantDigest?: string,
): Promise<AppProductionObservation> => {
  ctx.abortSignal.throwIfAborted();
  let clientResolved = false;
  try {
    const client = await repositoryProductionClientForContext(ctx);
    clientResolved = true;
    let observed: RepositoryProductionNativeStatus;
    if (expectedSchemaGrantDigest === undefined) {
      observed =
        includeActivationProof === true
          ? await client.nativeStatus(appId, expectedMergeSha, includeActivationProof)
          : await client.nativeStatus(appId, expectedMergeSha);
    } else {
      observed = await client.nativeStatus(
        appId,
        expectedMergeSha,
        undefined,
        expectedSchemaGrantDigest,
      );
    }
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
    return serviceUnavailable(appId, clientResolved ? providerRead : "configuration");
  }
};

/** Verified immutable merge metadata survives loss of its old Build, review or Ready call. */
export const observeMergedAppProduction = async (
  target: AppProductionDeliveryTarget,
  ctx: AppProductionObservationContext,
  expectedMergeSha?: string,
  includeActivationProof?: true,
  expectedSchemaGrantDigest?: string,
): Promise<AppProductionObservation> => {
  ctx.abortSignal.throwIfAborted();
  const observed = await observeAppProduction(
    target.appId,
    ctx,
    expectedMergeSha,
    includeActivationProof,
    expectedSchemaGrantDigest,
  );
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

/** Verify this grant's installed schema independently of the active deployment. */
export const readSettledMergedAppProductionSchema = async (
  target: AppProductionDeliveryTarget,
  ctx: AppProductionObservationContext,
  mergeSha: string,
  schemaGrantDigest: string,
) => {
  const observed = await observeMergedAppProduction(
    target,
    ctx,
    mergeSha,
    undefined,
    schemaGrantDigest,
  );
  if (observed.status === monitoringStoppedStatus || observed.appId !== target.appId) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Missing evidence is the caller's explicit optional result.
    return undefined;
  }
  const isLive =
    observed.status === "available" &&
    observed.requestedRevision === "live" &&
    observed.deployment.requestedRevisionActive === undefined;
  return isLive || observed.schemaSetupSettled === true ? observed : undefined;
};

const currentReviewedDelivery = () =>
  resolveGitHubPrDeliverySubject(appBuilderWorkflowState.get(), draftReconciliationState.get());

const readSavedAppProduction = async (
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
      ctx.abortSignal.throwIfAborted();
      const reconciledHead =
        reconciliation === undefined
          ? undefined
          : ((await runtime.inspectPublishedReconciliationHead?.(proposalDigest, reconciliation)) ??
            undefined);
      ctx.abortSignal.throwIfAborted();
      if (reconciliation === undefined || reconciledHead !== undefined) {
        const observed = await runtime.inspectPublishedPullRequest?.(
          proposalDigest,
          reconciledHead,
        );
        ctx.abortSignal.throwIfAborted();
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

/** Bound the optional saved-session read even if one upstream read ignores cancellation. */
export const observeSavedAppProduction = async (
  appId: string,
  ctx: WorkflowStepToolContext,
): Promise<AppProductionObservation> => {
  ctx.abortSignal.throwIfAborted();
  const deadline = new AbortController();
  const abortSignal = AbortSignal.any([ctx.abortSignal, deadline.signal]);
  const timer = setTimeout(() => {
    deadline.abort();
  }, savedObservationTimeoutMs);
  const aborted = Promise.withResolvers<null>();
  const onAbort = () => {
    aborted.resolve(null);
  };
  abortSignal.addEventListener("abort", onAbort, { once: true });
  try {
    const observed = await Promise.race([
      readSavedAppProduction(appId, { ...ctx, abortSignal }),
      aborted.promise,
    ]);
    ctx.abortSignal.throwIfAborted();
    return observed ?? serviceUnavailable(appId, providerRead);
  } catch (error) {
    ctx.abortSignal.throwIfAborted();
    if (deadline.signal.aborted) {
      return serviceUnavailable(appId, providerRead);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    abortSignal.removeEventListener("abort", onAbort);
  }
};
