import type { WorkflowStepToolContext } from "eve/tools";
import { HostedSessionAuthorityError } from "../hosted/session-authority";
import { HostedOperatorError } from "../provisioning/hosted-operator-contract";
import type { RepositoryProductionNativeStatus } from "../provisioning/repository-production-native-status-contract";
import {
  repositoryProductionClientForContext,
  RepositoryProductionNativeAccessChangedError,
} from "./repository-production-client";

export type AppProductionObservation =
  | RepositoryProductionNativeStatus
  | {
      status: "monitoring-stopped";
      requestedRevision: "unassessed";
    };

export interface AppProductionDeliveryTarget {
  appId: string;
  repositoryId: string;
  repositoryFullName: string;
}

const monitoringStopped = (): AppProductionObservation => ({
  status: "monitoring-stopped",
  requestedRevision: "unassessed",
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
  requestedRevision: "unassessed",
  serviceIssue,
});

/** An independent saved-session read uses canonical ownership, never old Build or merge state. */
export const observeAppProduction = async (
  appId: string,
  ctx: WorkflowStepToolContext,
): Promise<AppProductionObservation> => {
  ctx.abortSignal.throwIfAborted();
  let clientResolved = false;
  try {
    const client = await repositoryProductionClientForContext(ctx);
    clientResolved = true;
    const observed = await client.nativeStatus(appId);
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
): Promise<AppProductionObservation> => {
  ctx.abortSignal.throwIfAborted();
  const observed = await observeAppProduction(target.appId, ctx);
  if (observed.status === "monitoring-stopped") {
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
