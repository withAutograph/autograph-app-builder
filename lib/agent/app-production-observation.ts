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
import { resolveSavedGitHubPrObservationSubject } from "./github-pr-delivery-subject";
import { appBuilderWorkflowState } from "./workflow-state";
import { draftReconciliationState } from "./draft-reconciliation-state";

const unassessed = "unassessed";
const monitoringStoppedStatus = "monitoring-stopped";
const savedGitHubObservationTimeoutMs = 15_000;
const ownedAppObservationTimeoutMs = 30_000;
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
type SavedSchemaBinding = { kind: "unverified" } | { kind: "verified"; grantDigest: string } | null;
type ReadSavedSchemaBinding = (
  ctx: AppProductionObservationContext,
  target: AppProductionDeliveryTarget,
) => SavedSchemaBinding;

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
  resolveSavedGitHubPrObservationSubject(
    appBuilderWorkflowState.get(),
    draftReconciliationState.get(),
  );

const readSavedMergedRevision = async (
  ctx: WorkflowStepToolContext,
  subject: NonNullable<ReturnType<typeof currentReviewedDelivery>>,
): Promise<{ target: AppProductionDeliveryTarget; mergeSha: string } | undefined> => {
  const { appId, proposalDigest, reconciliation, installationId } = subject;
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
  if (reconciliation !== undefined && reconciledHead === undefined) {
    return undefined;
  }
  const observed = await runtime.inspectPublishedPullRequest?.(proposalDigest, reconciledHead);
  ctx.abortSignal.throwIfAborted();
  if (
    observed?.state !== "merged" ||
    !observed.reviewedRevision ||
    observed.mergeCommitSha === undefined ||
    !isDeepStrictEqual(currentReviewedDelivery(), subject)
  ) {
    return undefined;
  }
  const { repositoryId, owner, name } = observed.reviewedTarget;
  return {
    target: { appId, repositoryId, repositoryFullName: `${owner}/${name}` },
    mergeSha: observed.mergeCommitSha,
  };
};

const readOwnedAppProduction = async (
  appId: string,
  ctx: WorkflowStepToolContext,
  subject: ReturnType<typeof currentReviewedDelivery>,
  revision: Awaited<ReturnType<typeof readSavedMergedRevision>>,
  readSchemaBinding: ReadSavedSchemaBinding,
): Promise<AppProductionObservation> => {
  ctx.abortSignal.throwIfAborted();
  try {
    if (revision !== undefined && isDeepStrictEqual(currentReviewedDelivery(), subject)) {
      const { target, mergeSha } = revision;
      const schemaBinding = readSchemaBinding(ctx, target);
      const status = await observeMergedAppProduction(
        target,
        ctx,
        mergeSha,
        undefined,
        schemaBinding?.kind === "verified" ? schemaBinding.grantDigest : undefined,
      );
      if (status.status === monitoringStoppedStatus) {
        return status;
      }
      if (
        isDeepStrictEqual(currentReviewedDelivery(), subject) &&
        isDeepStrictEqual(readSchemaBinding(ctx, target), schemaBinding)
      ) {
        const schemaPending =
          schemaBinding !== null &&
          (schemaBinding.kind === "unverified" || status.schemaSetupSettled !== true);
        return status.requestedRevision === "live" && schemaPending
          ? { ...status, requestedRevision: "awaiting-activation" }
          : status;
      }
    }
  } catch {
    // Missing historical evidence still permits an independent owned app availability read.
    ctx.abortSignal.throwIfAborted();
  }
  return await observeAppProduction(appId, ctx);
};

/** Keep each read bounded even if an upstream read ignores cancellation. */
const readBeforeDeadline = async <T>(
  ctx: WorkflowStepToolContext,
  phase: "saved-github-revision" | "owned-app-status",
  timeoutMs: number,
  read: (scoped: WorkflowStepToolContext) => Promise<T>,
): Promise<T | undefined> => {
  ctx.abortSignal.throwIfAborted();
  const startedAt = performance.now();
  const deadline = new AbortController();
  const abortSignal = AbortSignal.any([ctx.abortSignal, deadline.signal]);
  const timer = setTimeout(() => {
    deadline.abort();
  }, timeoutMs);
  const aborted = Promise.withResolvers<null>();
  const onAbort = () => {
    aborted.resolve(null);
  };
  abortSignal.addEventListener("abort", onAbort, { once: true });
  try {
    const observed = await Promise.race([read({ ...ctx, abortSignal }), aborted.promise]);
    ctx.abortSignal.throwIfAborted();
    return observed ?? undefined;
  } catch (error) {
    ctx.abortSignal.throwIfAborted();
    if (deadline.signal.aborted) {
      return undefined;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    abortSignal.removeEventListener("abort", onAbort);
    console.info(
      JSON.stringify({
        event: "app_builder.saved_production_observation",
        phase,
        elapsedMs: Math.round(performance.now() - startedAt),
        timedOut: deadline.signal.aborted,
      }),
    );
  }
};

/** Optional GitHub history cannot consume the current owned app's read budget. */
export const observeSavedAppProduction = async (
  appId: string,
  ctx: WorkflowStepToolContext,
  readSchemaBinding: ReadSavedSchemaBinding,
): Promise<AppProductionObservation> => {
  ctx.abortSignal.throwIfAborted();
  let subject: ReturnType<typeof currentReviewedDelivery> = null;
  let revision: Awaited<ReturnType<typeof readSavedMergedRevision>>;
  try {
    const reviewed = currentReviewedDelivery();
    subject = reviewed;
    if (reviewed?.appId === appId) {
      revision = await readBeforeDeadline(
        ctx,
        "saved-github-revision",
        savedGitHubObservationTimeoutMs,
        async (scoped) => await readSavedMergedRevision(scoped, reviewed),
      );
    }
  } catch {
    // Missing historical evidence still permits an independent owned app availability read.
    ctx.abortSignal.throwIfAborted();
  }
  const observed = await readBeforeDeadline(
    ctx,
    "owned-app-status",
    ownedAppObservationTimeoutMs,
    async (scoped) =>
      await readOwnedAppProduction(appId, scoped, subject, revision, readSchemaBinding),
  );
  return observed ?? serviceUnavailable(appId, providerRead);
};
