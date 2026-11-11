import { isDeepStrictEqual } from "node:util";
import { HostedOperatorError } from "./hosted-operator-contract";
import { repositoryProductionOperationRef } from "./repository-production-contract";
import type {
  RepositoryProductionIntent,
  RepositoryProductionRow,
  RepositoryProductionScope,
} from "./repository-production-contract";
import {
  repositoryProductionDeliveryStatusSchema,
  repositoryProductionDeliveryTargetSchema,
} from "./repository-production-delivery";
import type { RepositoryProductionDeliveryTarget } from "./repository-production-delivery";
import type { RepositoryProductionRequestOwner } from "./repository-production-dispatcher";
import { sameRepositoryProductionSetupEffects } from "./repository-production-intent";
import { assertRepositoryProductionManagementRecord } from "./repository-production-management-subject";
import type { ManagementProfile } from "./repository-production-management-subject";
import { repositoryProductionSetupComplete } from "./repository-production-setup";
import { canReuseCompletedRepositoryProductionSetup } from "./repository-production-setup-reuse";
import type {
  RepositoryProductionSetupResult,
  RepositoryProductionStore,
} from "./repository-production-setup";

interface DeliveryStatusDependencies {
  repositories: readonly ManagementProfile[];
  readSession: (owner: RepositoryProductionRequestOwner) => Promise<void>;
  readActiveRevision: (owner: RepositoryProductionRequestOwner) => Promise<{
    adapterSessionId: string;
    adapterGeneration: number;
    cancellationRevision: number;
  }>;
  resolveCurrent: (owner: RepositoryProductionRequestOwner) => Promise<{
    scope: RepositoryProductionScope;
    intent: RepositoryProductionIntent;
    publishedDescription?: boolean;
  }>;
  store: Pick<RepositoryProductionStore, "read">;
  isRuntimeBindingReady: (row: RepositoryProductionRow) => boolean;
}

/** Projects the current accepted setup subject without a lease, worker, or reconciliation. */
export const createRepositoryProductionDeliveryStatus =
  (deps: DeliveryStatusDependencies) =>
  async (
    owner: RepositoryProductionRequestOwner,
    requested: RepositoryProductionDeliveryTarget,
  ) => {
    const target = repositoryProductionDeliveryTargetSchema.parse(requested);
    await deps.readSession(owner);
    if (owner.sessionId !== owner.ownerContext.sessionId) {
      throw new HostedOperatorError("authorization_required");
    }
    const { repositoryId, repositoryFullName, reviewedHeadSha } = target;
    const result = { version: 1 as const, appId: owner.appId, repositoryId, repositoryFullName };
    const matches = deps.repositories.filter(
      (profile) =>
        profile.workspaceId === owner.ownerContext.authority.workspaceId &&
        profile.repositoryId === target.repositoryId &&
        profile.repositoryFullName === target.repositoryFullName,
    );
    if (matches.length === 0) {
      await deps.readSession(owner);
      return repositoryProductionDeliveryStatusSchema.parse({ ...result, applicable: false });
    }
    if (matches.length !== 1) {
      throw new HostedOperatorError("authorization_required");
    }
    const [profile] = matches;
    const scope: RepositoryProductionScope = {
      authority: owner.ownerContext.authority,
      appId: owner.appId,
      repositoryId: profile.repositoryId,
      repositoryFullName: profile.repositoryFullName,
      projectId: profile.projectId,
      organizationId: profile.organization.id,
      publicOrigin: profile.publicOrigin,
      environment: "production",
    };
    const saved = await deps.store.read(scope);
    const revisionOwner =
      saved !== undefined && saved.record.intent.sessionId !== owner.sessionId
        ? await deps.readActiveRevision(owner)
        : undefined;
    const current = await deps.resolveCurrent(owner);
    if (!isDeepStrictEqual(current.scope, scope) || current.intent.sessionId !== owner.sessionId) {
      throw new HostedOperatorError("authorization_required");
    }
    const row = await deps.store.read(scope);
    if (revisionOwner !== undefined) {
      const reuse =
        row !== undefined &&
        reviewedHeadSha === current.intent.sourceSha &&
        canReuseCompletedRepositoryProductionSetup({
          owner,
          scope,
          row,
          current,
          isRuntimeBindingReady: deps.isRuntimeBindingReady,
        });
      if (!reuse) {
        throw new HostedOperatorError("authorization_required");
      }
      if (!isDeepStrictEqual(await deps.readActiveRevision(owner), revisionOwner)) {
        throw new HostedOperatorError("authorization_required");
      }
      return repositoryProductionDeliveryStatusSchema.parse({
        ...result,
        applicable: true,
        operationRef: row.operationRef,
        preparationRequired: false,
        state: "ready",
      });
    }
    if (row !== undefined) {
      assertRepositoryProductionManagementRecord(owner, scope, row);
    }
    const sameEffects =
      row !== undefined && sameRepositoryProductionSetupEffects(row.record.intent, current.intent);
    const pending =
      row?.record.appAccessUpgrade?.state === "pending" ||
      row?.record.creatorRoleUpdate?.state === "pending" ||
      Object.values(row?.record.effects ?? {}).some((effect) => effect.state === "pending");
    const complete = row !== undefined && repositoryProductionSetupComplete(row.record);
    let runtimeReady = false;
    if (row !== undefined && sameEffects && complete) {
      runtimeReady = current.intent.storage.kind === "none" || deps.isRuntimeBindingReady(row);
    }
    const preparationRequired = row === undefined || !sameEffects || (complete && !runtimeReady);
    let state: RepositoryProductionSetupResult["state"] = "checking-access";
    if (row === undefined) {
      state = current.intent.storage.kind === "none" ? "checking-access" : "setting-up-data";
    } else if (!sameEffects || pending) {
      state = "reconciling";
    } else if (runtimeReady) {
      state = "ready";
    }
    await deps.readSession(owner);
    return repositoryProductionDeliveryStatusSchema.parse({
      ...result,
      applicable: true,
      operationRef: row?.operationRef ?? repositoryProductionOperationRef(scope),
      preparationRequired,
      state,
    });
  };
