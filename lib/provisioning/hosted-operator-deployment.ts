import { readPrivateOperatorApproval } from "../eve/private-operator-approval-observation";
import { createHostedOperatorSandboxFetch } from "./hosted-operator-sandbox-fetch";
import {
  observeContinuityPlanningStage,
  advanceExportPlanningStage,
} from "./hosted-operator-consent-diagnostic";
import type { ExportPlanningStageObserver } from "./hosted-operator-consent-diagnostic";
import { createManagedRuntimeWorkerAsset } from "../agent/managed-runtime-worker-asset";
import { Sandbox } from "@vercel/sandbox";
import {
  createManagedRuntimeExecution,
  observeManagedRuntimePorts,
} from "../agent/managed-runtime-execution";
import { createHostedContinuityOperations } from "./hosted-operator-continuity";
import { createPostgresContinuityJournalStore } from "./postgres-hosted-operator-continuity-journal";
import { createContinuityCapabilityCustody } from "./hosted-operator-continuity-custody";
import { createContinuityDispatcher } from "./hosted-operator-continuity-transport";
import { createPrivateContinuityApprovalCapture } from "../eve/private-continuity-approval";
import { createHostedManagedRuntimeProjection } from "./hosted-operator-managed-runtime-projection";
import type {
  HostedContinuityPlan,
  ContinuityRuntimeSelection,
} from "./hosted-operator-continuity-contract";
import {
  readPrivateHostedApproval,
  privateHostedApprovalReceiptSchema,
} from "../eve/private-hosted-approval";
import type { PrivateHostedApprovalReceipt } from "../eve/private-hosted-approval";
import { readActiveAppInstallationCustomerIds } from "./hosted-operator-app-readiness";
import type { OperatorAppMetadataScope } from "./hosted-operator-app-readiness";
import type { HostedSessionRecord } from "../eve/hosted-store";
import {
  operatorOwnerContextSchema,
  HostedOperatorError,
  operatorPlanDigest,
  restrictedOperatorEnvironment,
  operatorRealmIdentityLinkSchema,
  projectPendingRealmIdentityLink,
  selectHostedOperatorOwnedOrganizationSpec,
  retainedOperatorAuthSchema,
  hostedOperatorOwnedOrganizationSpecSchema,
} from "./hosted-operator-contract";
import {
  createHostedTenantExportOperations,
  assertTenantExportCustomer,
} from "./hosted-operator-export";
import type { HostedTenantExportPlan } from "./hosted-operator-export-contract";
import { createPostgresTenantExportJournalStore } from "./postgres-hosted-operator-export-journal";
import { createPostgresPhysicalResourceLease } from "./postgres-physical-resource-lease";
import { createTenantExportSandbox } from "./hosted-operator-export-sandbox";
import { createTenantExportArtifacts } from "./hosted-operator-export-artifacts";
import { createTenantExportDispatcher } from "./hosted-operator-export-transport";
import { resolveExportOwnerOrganization } from "./hosted-operator-export-customer";
import { createPrivateTenantExportApprovalCapture } from "../eve/private-export-approval";
import { requireFinalResourceBindingPhase } from "./hosted-operator-resource-binding-phase";
import {
  readApprovedRetainedMembershipInspection,
  readApprovedRetainedMembershipInspections,
} from "./hosted-operator-membership-inspection";
import { nativeObservationStateSchema } from "../eve/native-observation-state";
import { realmContinuationPendingBaseline } from "./hosted-operator-realm-pending";
import { createHostedOperatorRealmIdentityWait } from "./hosted-operator-realm-identity-wait";
import { createHash, randomBytes } from "node:crypto";
import {
  createHostedOperatorRealmContinuation,
  observeRealmContinuationRecord,
  realmContinuationDispatchId,
  realmContinuationReceiptSchema,
  realmContinuationPath,
  isRealmContinuationTechnicalWait,
} from "./hosted-operator-realm-continuation";
import type {
  RealmContinuationRequest,
  RealmContinuationObservation,
} from "./hosted-operator-realm-continuation";
import {
  mintRealmContinuationAuthority,
  realmContinuationServiceIdentityForWorkload,
} from "../hosted/realm-continuation-authority";
import type { RealmContinuationAuthority } from "../hosted/realm-continuation-authority";
import { isDeepStrictEqual } from "node:util";
/* oxlint-disable sonarjs/no-nested-functions -- Owner authorization and journal CAS closures share the actual opened private database. */
import postgres from "postgres";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { z } from "zod";
import { createRemoteJWKSet, customFetch } from "jose";
import { createHostedOperatorNormalAuthTransport } from "./hosted-operator-normal-auth-transport";
import { createHostedOperatorRealmHttpTransport } from "./hosted-operator-realm-http-transport";
import { createHostedOperatorNormalActorOperations } from "./hosted-operator-normal-actor-operations";
import type { NormalActorOperationsDependencies } from "./hosted-operator-normal-actor-operations";
import { createHostedOperatorNormalActorProofCollector } from "./hosted-operator-normal-actor-proof";
import {
  assertCompletedParticipantBootstrapApproval,
  inspectPlanningParticipantBootstrap,
} from "./hosted-operator-participant-bootstrap";
import type { CompletedParticipantBootstrap } from "./hosted-operator-participant-bootstrap";
import { createNormalActorOrganizationWorkers } from "./hosted-operator-normal-actor-worker";
import { createNormalActorRuntimeBindings } from "./hosted-operator-normal-actor-runtime-bindings";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";
import { createNormalActorJournal } from "./hosted-operator-normal-actor-journal";
import type { NormalActorAccountPreparation } from "./hosted-operator-normal-actor-journal";
import {
  createRealmIdentityBrowserUrl,
  verifyCapturedRealmIdentityProof,
} from "./hosted-operator-auth-identity";
import { readHostedOperatorProviderInventory } from "./hosted-operator-provider-inventory";
import { createNormalActorJournalAuthority } from "./hosted-operator-normal-actor-authority";
import { confirmNormalActorCapture } from "./hosted-operator-normal-actor-confirmation";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, sql } from "drizzle-orm";

import { createPostgresPreviewOrganizationAuthority } from "../auth/postgres-organization-user-authority";
import {
  hostedRuntimePostgresOptions,
  parseHostedDatabaseUrl,
} from "../db/postgres-connection-policy";
import { parseProtectedResourceLockDatabaseUrl } from "../db/protected-resource-lock-database-url";
import { createVercelWorkloadIdentity } from "../eve/vercel-workload-identity";
import { parseHostedSessionRow, createPostgresHostedEveStore } from "../eve/postgres-hosted-store";
import { createHostedOperatorApprovalObserver } from "./hosted-operator-approval-observer";
import { createNativeTargetOnboardingDeployment } from "./native-target-onboarding-deployment";
import { createPostgresNativeTargetOnboardingStore } from "./native-target-onboarding-store";
import {
  account,
  agentOperations,
  agentSessionCheckpointChunks,
  agentSessionCheckpointItems,
  agentSessionCheckpointManifests,
  agentSessions,
  builderDrafts,
  builderHandoffs,
  builderProvisioningJournals,
  emulatePreviewState,
  githubInstallationAuthorizationStates,
  githubPublicationJournals,
  githubPublicationProposals,
  githubRepositoryAccessContinuations,
  hostedGitHubDraftAdoptions,
  hostedGitHubInstallationBindings,
  hostedGitHubInstallations,
  hostedGitHubPublicationJournals,
  hostedGitHubPublicationProposals,
  hostedGitHubUserCredentials,
  hostedVercelInstallations,
  hostedWorkspaceMemberships,
  invitation,
  jwks,
  member,
  oauthAccessToken,
  oauthClient,
  oauthClientAssertion,
  oauthClientResource,
  oauthConsent,
  oauthRefreshToken,
  oauthResource,
  organization,
  passkey,
  passkeyOnboarding,
  personalWorkspace,
  productSourceReviewJournal,
  prototypeArtifactChunks,
  sandboxExecutionLeases,
  session,
  user,
  validationLogChunks,
  validationLogManifests,
  verification,
  vercelInstallationAuthorizationStates,
} from "../db/schema";
import { hostedSessionRecordSchema, toDurableHostedSessionRecord } from "../eve/hosted-store";
import { createPostgresBuilderHandoffStore } from "../handoff/postgres-store";
import {
  readVercelInstallationBindings,
  readActiveVercelInstallationToken,
} from "../integrations/postgres-vercel-installation";
import {
  readVercelTokenKeyringEnvironment,
  encryptVercelToken,
  decryptVersionedVercelToken,
} from "../integrations/vercel-installation";
import type { HostedPrincipal } from "../eve/hosted-auth";
import type { OperatorWorkloadPolicy } from "./hosted-operator-workload";
import {
  createHostedOperatorOwnerAuthority,
  createHostedOperatorReadApproval,
  createHostedOperatorReadApprovedPlan,
} from "./hosted-operator-owner";
import { createHostedOperatorOwnerContextResolver } from "./hosted-operator-owner-context";
import type {
  HostedOperatorContext,
  HostedOperatorEffectContext,
  ProtectedHostedOperatorDependencies,
} from "./hosted-operator-service";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import {
  assertResourceCredentialCheckpoint,
  prepareHostedOperatorResourceCredentials,
  readHostedOperatorResourceBindings,
  readActiveHostedOperatorSharedAuth,
} from "./hosted-operator-resource-credentials";
import type { ProtectedResourceDatabase } from "./hosted-operator-resource-credentials";
import {
  createHostedOperatorSharedAuthAdoption,
  sameSharedAuthTargetCheckpoint,
} from "./hosted-operator-shared-auth-adoption";
import { createHostedOperatorAuthReadiness } from "./hosted-operator-auth-readiness";
import {
  assertHostedOperatorSharedGateway,
  describeHostedOperatorSharedGateway,
} from "./hosted-operator-shared-gateway";
import type {
  HostedRuntimeJournalRecord,
  HostedRuntimeJournalRow,
  HostedRuntimeJournalStore,
} from "./hosted-runtime-journal";
import { createPostgresOperatorArtifactStore } from "./hosted-operator-artifact-store";
import type { OperatorArtifactContext } from "./hosted-operator-artifact-store";
import { createPostgresOperatorArtifactSelections } from "./hosted-operator-artifact-selection";
import type { ExactCompiledOperatorReleaseLookup } from "./hosted-operator-artifact-selection";
import { createOperatorArtifactPublication } from "./hosted-operator-artifacts";
import {
  updateHostedRuntimeJournal,
  hostedRuntimeJournalRecordSchema,
} from "./hosted-runtime-journal";
import { createPostgresHostedRuntimeJournalStore } from "./postgres-hosted-runtime-journal";
import { createPostgresHostedOperatorResourceLease } from "./postgres-hosted-operator-resource-lease";

const PARTICIPANT_STAGE = "auth-participants";

const databaseSchema = {
  account,
  agentOperations,
  agentSessionCheckpointChunks,
  agentSessionCheckpointItems,
  agentSessionCheckpointManifests,
  agentSessions,
  builderDrafts,
  builderHandoffs,
  builderProvisioningJournals,
  emulatePreviewState,
  githubInstallationAuthorizationStates,
  githubPublicationJournals,
  githubPublicationProposals,
  githubRepositoryAccessContinuations,
  hostedGitHubDraftAdoptions,
  hostedGitHubInstallationBindings,
  hostedGitHubInstallations,
  hostedGitHubPublicationJournals,
  hostedGitHubPublicationProposals,
  hostedGitHubUserCredentials,
  hostedVercelInstallations,
  hostedWorkspaceMemberships,
  invitation,
  jwks,
  member,
  oauthAccessToken,
  oauthClient,
  oauthClientAssertion,
  oauthClientResource,
  oauthConsent,
  oauthRefreshToken,
  oauthResource,
  organization,
  passkey,
  passkeyOnboarding,
  personalWorkspace,
  productSourceReviewJournal,
  prototypeArtifactChunks,
  sandboxExecutionLeases,
  session,
  user,
  validationLogChunks,
  validationLogManifests,
  vercelInstallationAuthorizationStates,
  verification,
};

const forwardedSessionAuth = (principal: HostedPrincipal, sourceHandoffId?: string) => {
  const attributes = {
    "mcp:audience": principal.audience,
    "mcp:scopes": principal.scopes,
    "mcp:workspace-id": principal.workspaceId,
  };
  if (sourceHandoffId !== undefined) {
    Object.assign(attributes, {
      "autograph:source-handoff-id": sourceHandoffId,
    });
  }
  const current = {
    attributes,
    authenticator: "mcp-oauth-jwks" as const,
    issuer: principal.issuer,
    principalId: principal.ownerUserId,
    principalType: "user" as const,
    subject: principal.ownerUserId,
  };
  return { current, initiator: current };
};

const samePrincipal = (left: HostedPrincipal, right: HostedPrincipal) =>
  JSON.stringify([
    left.issuer,
    left.audience,
    left.workspaceId,
    left.ownerUserId,
    ...left.scopes.toSorted(),
  ]) ===
  JSON.stringify([
    right.issuer,
    right.audience,
    right.workspaceId,
    right.ownerUserId,
    ...right.scopes.toSorted(),
  ]);

type ResourceCredentialEffect = HostedOperatorEffectContext & { workerAttemptId?: string };

const isCompletedGatewayBindingObservation = (
  record: HostedRuntimeJournalRecord,
  input: ResourceCredentialEffect,
) => {
  const { operator } = record;
  return [
    input.workerAttemptId === undefined,
    input.plan.action === "prepare",
    input.plan.stage === "app",
    input.effect.kind === "gateway-bindings",
    operator?.receipts.some((receipt) => receipt.effectId === input.effect.id) === true,
    operator?.pendingEffectAttempt !== undefined,
    operator?.plan.effects.some(
      (effect) => effect.id === operator.pendingEffectId && effect.kind === "gateway-delivery",
    ) === true,
  ].every(Boolean);
};

const hasCurrentResourceCredentialEffectPhase = (
  record: HostedRuntimeJournalRecord,
  input: ResourceCredentialEffect,
  completedGatewayBindingObservation: boolean,
) => {
  const { operator } = record;
  if (operator === undefined) {
    return false;
  }
  if (input.workerAttemptId !== undefined) {
    return (
      operator.pendingEffectId === input.effect.id &&
      operator.pendingEffectAttempt?.id === input.workerAttemptId
    );
  }
  const pendingMutation =
    operator.pendingEffectId !== undefined || operator.pendingEffectAttempt !== undefined;
  if (!pendingMutation) {
    return true;
  }
  if (operator.pendingEffectId === input.effect.id && operator.pendingEffectAttempt !== undefined) {
    return true;
  }
  return (
    completedGatewayBindingObservation &&
    isCompletedGatewayBindingObservation(record, input) &&
    isDeepStrictEqual(input.privateState, record.privateState)
  );
};

const requireCurrentResourceCredentialRecord = (
  record: HostedRuntimeJournalRecord | undefined,
  input: ResourceCredentialEffect,
  completedGatewayBindingObservation = false,
): HostedRuntimeJournalRecord => {
  if (record === undefined || record.leaseId === undefined || record.leaseExpiresAt === undefined) {
    throw new HostedOperatorError("operation_in_progress");
  }
  const { operator } = record;
  if (Date.parse(record.leaseExpiresAt) <= Date.now() || operator === undefined) {
    throw new HostedOperatorError("operation_in_progress");
  }
  if (
    operator.operationRef !== input.operationRef ||
    operator.fenceGeneration !== input.fenceGeneration
  ) {
    throw new HostedOperatorError("operation_in_progress");
  }
  if (!hasCurrentResourceCredentialEffectPhase(record, input, completedGatewayBindingObservation)) {
    throw new HostedOperatorError("operation_in_progress");
  }
  if (
    operator.planDigest !== operatorPlanDigest(input.plan) ||
    operator.planDigest !== operatorPlanDigest(operator.plan)
  ) {
    throw new HostedOperatorError("operation_in_progress");
  }
  const plannedEffect = operator.plan.effects.find((effect) => effect.id === input.effect.id);
  if (JSON.stringify(plannedEffect) !== JSON.stringify(input.effect)) {
    throw new HostedOperatorError("operation_in_progress");
  }
  return record;
};

const readCurrentResourceCredentialRecord = async (input: {
  assertAuthorized: (
    context: HostedOperatorContext & { plan: ResourceCredentialEffect["plan"] },
  ) => Promise<void>;
  effect: ResourceCredentialEffect;
  store: Pick<HostedRuntimeJournalStore, "read">;
  completedGatewayBindingObservation?: boolean;
}) => {
  await input.assertAuthorized(input.effect);
  await input.effect.assertCurrent();
  const current = await input.store.read(input.effect);
  return requireCurrentResourceCredentialRecord(
    current?.record,
    input.effect,
    input.completedGatewayBindingObservation,
  );
};

/** Read the current effect's sealed bindings; completed Gateway observations never acquire mutation authority. */
export const readHostedOperatorEffectResourceBindings = async (
  input: Omit<
    Parameters<typeof readCurrentResourceCredentialRecord>[0],
    "completedGatewayBindingObservation"
  > & {
    config: Parameters<typeof readHostedOperatorResourceBindings>[0]["config"];
  },
) => {
  const read = async () =>
    await readCurrentResourceCredentialRecord({
      ...input,
      completedGatewayBindingObservation: true,
    });
  const record = await read();
  const completedObservation = isCompletedGatewayBindingObservation(record, input.effect);
  const bindings = readHostedOperatorResourceBindings({
    ...input.effect,
    config: input.config,
    record,
  });
  const current = await read();
  const sameObservation =
    !(completedObservation || isCompletedGatewayBindingObservation(current, input.effect)) ||
    [
      current.leaseId === record.leaseId,
      current.operator?.pendingEffectId === record.operator?.pendingEffectId,
      current.operator?.pendingEffectAttempt?.id === record.operator?.pendingEffectAttempt?.id,
      isDeepStrictEqual(
        current.operator?.receipts.find((receipt) => receipt.effectId === input.effect.effect.id),
        record.operator?.receipts.find((receipt) => receipt.effectId === input.effect.effect.id),
      ),
    ].every(Boolean);
  if (!sameObservation || !isDeepStrictEqual(current.privateState, record.privateState)) {
    throw new HostedOperatorError("operation_in_progress");
  }
  return bindings;
};

type ResourceBindingContext = HostedOperatorContext & {
  plan: ResourceCredentialEffect["plan"];
  privateState?: HostedRuntimeJournalRecord["privateState"];
};

/** Select only the original retained prepare evidence for a read-only binding request.
 * Approval, owner, completion, sealed checkpoint and second-read checks remain with the caller.
 */
export const selectAuthPlanningResourceBindingRow = (
  row: HostedRuntimeJournalRow | undefined,
  plan: ResourceBindingContext["plan"],
): HostedRuntimeJournalRow | undefined => {
  if (row === undefined || row.record.operator?.planDigest === operatorPlanDigest(plan)) {
    return row;
  }
  const parsed = retainedOperatorAuthSchema.safeParse(row.record.retainedAuth);
  if (!parsed.success) {
    return row;
  }
  const retained = parsed.data;
  if (retained.planDigest !== operatorPlanDigest(plan)) {
    return row;
  }
  const current = row.record.operator;
  // An idle app delivery cannot mutate the completed retained Auth credentials.
  // Keep unknown Auth/resource effects and cleanup behind the existing phase guard.
  const pendingAppDelivery =
    current?.plan.action === "prepare" &&
    current.plan.stage === "app" &&
    current.plan.effects.some(
      (effect) => effect.kind === "delivery" && effect.id === current.pendingEffectId,
    );
  const pendingMutation =
    !pendingAppDelivery &&
    (current?.pendingEffectId !== undefined || current?.pendingEffectAttempt !== undefined);
  if (
    row.record.leaseId !== undefined ||
    row.record.leaseExpiresAt !== undefined ||
    pendingMutation
  ) {
    throw new HostedOperatorError("operation_in_progress");
  }
  return {
    ...row,
    record: {
      ...row.record,
      approvedByCallId: retained.approvedByCallId,
      operator: {
        approvalId: retained.approvalId,
        authPreparation: retained.authPreparation,
        fenceGeneration: retained.fenceGeneration,
        gatewayEnvironment: retained.gatewayEnvironment,
        mode: "protected-operator-v1",
        operationRef: retained.operationRef,
        plan: retained.plan,
        planDigest: retained.planDigest,
        receipts: retained.receipts,
      },
      status: "prepared",
      step: "bound",
    },
  };
};

/** Compare transport only with the canonical approved plan; older plans retain their captured endpoint. */
export const matchesApprovedMembershipJwks = (
  plan: HostedOperatorPlan,
  capturedEndpointOrigin: string | undefined,
  jwksUrl: string,
): boolean =>
  `${plan.deploymentBoundary?.verification.gatewayOrigin ?? capturedEndpointOrigin}/_platform/jwks.json` ===
  jwksUrl;

/**
 * Composes the production control-plane readers and fences already owned by
 * Builder. This is intentionally not a complete operator adapter: planning,
 * Neon resource effects, installer reconciliation, verification and bindings
 * still require their concrete owner-authorized provider implementations.
 */
const membershipSpecForEffect = (input: HostedOperatorEffectContext) => {
  if (input.plan.authMembership === undefined) {
    throw new HostedOperatorError("auth_identity_required");
  }
  const membershipTarget = input.plan.normalActorProgram?.organizations.find(
    (candidate) => input.effect.id === `auth-membership:${candidate.organizationId}`,
  );
  return selectHostedOperatorOwnedOrganizationSpec(input.plan.authMembership, membershipTarget);
};

interface AppInstallationPlanningPort {
  readAppInstallationCustomerIds?: (
    context: HostedOperatorContext,
    plan: HostedOperatorPlan,
  ) => Promise<string[]>;
}

const unselectedInstallationScopes = (
  prior: HostedOperatorPlan,
  appId: string,
  currentTenants: ReadonlySet<string>,
  scopes: ReadonlyMap<string, OperatorAppMetadataScope>,
): OperatorAppMetadataScope[] => {
  const selected: OperatorAppMetadataScope[] = [];
  for (const grant of prior.access) {
    if (currentTenants.has(grant.organizationId)) {
      continue;
    }
    for (const role of grant.roles) {
      const scope = {
        appId,
        actorId: grant.actorId,
        organizationId: grant.organizationId,
        role,
      };
      if (!scopes.has(JSON.stringify(scope))) {
        selected.push(scope);
      }
    }
  }
  return selected;
};

/** Prior approvals identify retained scope; only live actor-bound metadata makes it a schema target. */
export const createRetainedAppInstallationCustomerReader =
  (deps: {
    readOwner: (context: HostedOperatorContext) => Promise<{ session: HostedSessionRecord }>;
    readApproval: (
      context: HostedOperatorContext,
      receipt: PrivateHostedApprovalReceipt,
    ) => Promise<PrivateHostedApprovalReceipt | null>;
    readActiveCustomers: (
      context: HostedOperatorContext,
      plan: HostedOperatorPlan,
      scopes: readonly OperatorAppMetadataScope[],
    ) => Promise<string[]>;
  }) =>
  async (context: HostedOperatorContext, plan: HostedOperatorPlan): Promise<string[]> => {
    const candidates = (canonicalSession: HostedSessionRecord) => {
      const currentOwner = operatorOwnerContextSchema.parse(context.ownerContext);
      if (
        canonicalSession.sessionId !== context.target.sessionId ||
        !samePrincipal(canonicalSession.principal, currentOwner.principal)
      ) {
        throw new HostedOperatorError("authorization_required");
      }
      const settled = new Map<string, PrivateHostedApprovalReceipt>();
      for (const raw of canonicalSession.version === 2
        ? (canonicalSession.privateApprovalReceipts ?? [])
        : []) {
        const receipt = privateHostedApprovalReceiptSchema.parse(raw);
        const prior = receipt.toolInput.plan;
        const sameOwnedResource = [
          isDeepStrictEqual(prior.appDatabase, plan.appDatabase),
          prior.neon.projectId === plan.neon.projectId,
          prior.neon.branchId === plan.neon.branchId,
          prior.neon.endpoint === plan.neon.endpoint,
        ].every(Boolean);
        const sameOwnerScope = [
          prior.selection.appId === context.target.appId,
          prior.selection.sessionId === context.target.sessionId,
          prior.selection.projectId === context.target.projectId,
          prior.selection.environment === context.target.environment,
        ].every(Boolean);
        if (
          [
            receipt.toolName !== "prepare-app-hosted-runtime",
            prior.action !== "prepare",
            ![undefined, "app"].includes(prior.stage),
            !sameOwnedResource,
            !sameOwnerScope,
          ].some(Boolean)
        ) {
          continue;
        }
        const key = JSON.stringify([receipt.toolInput.operationRef, receipt.toolInput.planDigest]);
        const previous = settled.get(key);
        if (previous === undefined || previous.sequence < receipt.sequence) {
          settled.set(key, receipt);
        }
      }
      return [...settled.values()].filter(
        (receipt) =>
          receipt.outcome === "approved" &&
          receipt.responderPrincipalId === currentOwner.principal.ownerUserId,
      );
    };
    const initial = await deps.readOwner(context);
    const receipts = candidates(initial.session).toSorted(
      (left, right) => right.sequence - left.sequence,
    );
    const currentTenants = new Set(plan.access.map((grant) => grant.organizationId));
    const scopes = new Map<string, OperatorAppMetadataScope>();
    const retained: PrivateHostedApprovalReceipt[] = [];
    for (const receipt of receipts) {
      const selected = unselectedInstallationScopes(
        receipt.toolInput.plan,
        plan.selection.appId,
        currentTenants,
        scopes,
      );
      if (selected.length === 0) {
        continue;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Canonically re-read only the latest approval adding each retained actor-bound scope.
      const canonical = await deps.readApproval(context, receipt);
      if (canonical === null || !isDeepStrictEqual(canonical, receipt)) {
        throw new HostedOperatorError("authorization_required");
      }
      retained.push(receipt);
      for (const scope of selected) {
        scopes.set(JSON.stringify(scope), scope);
      }
    }
    const active =
      scopes.size === 0 ? [] : await deps.readActiveCustomers(context, plan, [...scopes.values()]);
    const freshOwner = await deps.readOwner(context);
    const latest = candidates(freshOwner.session);
    if (
      retained.some((receipt) => !latest.some((current) => isDeepStrictEqual(current, receipt)))
    ) {
      throw new HostedOperatorError("authorization_required");
    }
    const allowed = new Set([...scopes.values()].map((scope) => scope.organizationId));
    if (active.some((customerId) => !allowed.has(customerId))) {
      throw new HostedOperatorError("resource_mismatch");
    }
    return [...new Set(active)];
  };

export const createHostedOperatorControlPlane = async (input: {
  environment?: Readonly<Record<string, string | undefined>>;
  workloadPolicy: OperatorWorkloadPolicy;
  sourceConfiguration: HostedOperatorSourceConfiguration;
  fetch?: typeof fetch;
}) => {
  const environment = input.environment ?? process.env;
  const config = z
    .strictObject({
      databaseUrl: z.string(),
      issuer: z.url().startsWith("https://"),
      resource: z.url().startsWith("https://"),
    })
    .parse({
      databaseUrl: parseHostedDatabaseUrl(environment.DATABASE_URL),
      issuer: environment.BETTER_AUTH_URL,
      resource: environment.MCP_RESOURCE_URL,
    });
  if (new URL(config.resource).pathname !== "/mcp") {
    throw new Error("Protected operator control-plane authority is unavailable.");
  }
  const tokenKeyring = readVercelTokenKeyringEnvironment(environment);

  const controlPlaneClient = postgres(config.databaseUrl, hostedRuntimePostgresOptions);
  const database = drizzle(controlPlaneClient, { schema: databaseSchema });
  const compose = () => {
    const eve = createPostgresHostedEveStore(database);
    const handoffs = createPostgresBuilderHandoffStore(database);
    const membership = createPostgresPreviewOrganizationAuthority(database, {
      audience: config.resource,
      issuer: config.issuer,
    });
    const installations = {
      async list(authority: Parameters<typeof readVercelInstallationBindings>[0]["authority"]) {
        return await readVercelInstallationBindings({ authority, database });
      },
    };
    const store = createPostgresHostedRuntimeJournalStore(database);
    const ownerContextResolver = createHostedOperatorOwnerContextResolver({
      audience: config.resource,
      handoffs,
      isActiveMember: async (authority) =>
        await membership.isActiveMember({
          audience: authority.audience,
          issuer: authority.issuer,
          ownerUserId: authority.ownerUserId,
          workspaceId: authority.workspaceId,
        }),
      issuer: config.issuer,
      sessions: eve,
    });

    const readCredential = async (
      authority: HostedOperatorContext["authority"],
      installationId: string,
    ) =>
      await readActiveVercelInstallationToken({
        authority,
        config: tokenKeyring,
        database,
        installationId,
      });
    const owner = createHostedOperatorOwnerAuthority({
      eve,
      journal: store,
      realmContinuation: {
        config: tokenKeyring,
        service: realmContinuationServiceIdentityForWorkload(input.workloadPolicy),
      },
      fetch: input.fetch,
      handoffs,
      listVercelInstallations: async (authority) => await installations.list(authority),
      membership: {
        isMember: async ({ principal, workspaceId }) =>
          await membership.isActiveMember({
            audience: principal.audience,
            issuer: principal.issuer,
            ownerUserId: principal.ownerUserId,
            workspaceId,
          }),
      },
      readVercelCredential: async ({ authority, installationId }) =>
        await readCredential(authority, installationId),
      readReadyNativeTarget: async (authority, appId) => {
        const row = await createPostgresNativeTargetOnboardingStore(database).read({
          authority,
          appId,
        });
        return row?.record.stage === "ready" ? row.record : undefined;
      },
      workloadPolicy: input.workloadPolicy,
    });

    const ownedArtifacts = (inputContext: HostedOperatorContext) => {
      const context = structuredClone({
        authority: inputContext.authority,
        ownerContext: inputContext.ownerContext,
        target: inputContext.target,
      });
      const artifactContext: OperatorArtifactContext = {
        authority: context.authority,
        target: { appId: context.target.appId, sessionId: context.target.sessionId },
      };
      const assertCurrentOwner = async (requested: OperatorArtifactContext) => {
        if (JSON.stringify(requested) !== JSON.stringify(artifactContext)) {
          throw new HostedOperatorError("authorization_required");
        }
        await owner.assertArtifactAuthorized(context);
      };
      const artifactStore = createPostgresOperatorArtifactStore({ assertCurrentOwner, database });
      return {
        context: artifactContext,
        publication: createOperatorArtifactPublication({
          assertCurrentOwner,
          store: artifactStore,
        }),
        selections: createPostgresOperatorArtifactSelections({ assertCurrentOwner, database }),
        store: artifactStore,
      };
    };

    const operatorIdentity = createVercelWorkloadIdentity();
    const approvalObserver = createHostedOperatorApprovalObserver({
      builderOrigin: new URL(config.resource).origin,
      verifyReadAuthority: async ({ adapterSessionId, principal, sessionId }) => {
        try {
          const rawSession = await eve.getSessionByAdapterSessionId?.(principal, adapterSessionId);
          const parsed = hostedSessionRecordSchema.safeParse(rawSession);
          if (!parsed.success) {
            return false;
          }
          const durableSession = toDurableHostedSessionRecord(parsed.data);
          if (
            durableSession.sessionId !== sessionId ||
            durableSession.adapterSessionId !== adapterSessionId ||
            !samePrincipal(durableSession.principal, principal)
          ) {
            return false;
          }
          const sourceHandoffId =
            parsed.data.version === 2 ? parsed.data.sourceHandoffId : undefined;
          const resolved = await ownerContextResolver({
            adapterSessionId,
            authority: {
              audience: principal.audience,
              issuer: principal.issuer,
              ownerUserId: principal.ownerUserId,
              workspaceId: principal.workspaceId,
            },
            principal,
            sessionAuth: forwardedSessionAuth(principal, sourceHandoffId),
          });
          return resolved.sessionId === sessionId && resolved.adapterSessionId === adapterSessionId;
        } catch {
          return false;
        }
      },
      workloadIdentity: operatorIdentity,
    });
    const readApproval = (
      context: Parameters<ReturnType<typeof createHostedOperatorReadApproval>>[0],
    ) =>
      createHostedOperatorReadApproval({
        eve,
        journal: store,
        observe: approvalObserver.forContext(context),
      })(context);
    const readApprovedPlan = createHostedOperatorReadApprovedPlan({
      eve,
      assertCanonicalOwner: owner.assertArtifactAuthorized,
    });
    const withResourceLease = createPostgresHostedOperatorResourceLease({
      openLockClient: (onConnectionClosed) =>
        postgres(parseProtectedResourceLockDatabaseUrl(config.databaseUrl), {
          ...hostedRuntimePostgresOptions,
          idle_timeout: 0,
          max: 1,
          max_lifetime: 0,
          onclose: onConnectionClosed,
        }),
      store,
    });

    const normalActorJournalPorts = createNormalActorJournalAuthority({
      store,
      keyring: tokenKeyring,
      now: Date.now,
      assertCanonicalOwner: owner.assertArtifactAuthorized,
      assertApprovedOwner: owner.assertAuthorized,
      readApproval,
    });
    const normalActorJournal = createNormalActorJournal(normalActorJournalPorts);
    const readKnownAuthBootstrap = async (context: HostedOperatorContext) => {
      const owned = await owner.readCurrentPlanningOwner(context);
      if (["cancelled", "completed"].includes(owned.session.status)) {
        throw new HostedOperatorError("authorization_required");
      }
      const current = await store.read(context);
      if (current === undefined || current.record.operator === undefined) {
        throw new HostedOperatorError("auth_schema_not_ready");
      }
      const { operator } = current.record;
      const idle = [
        operator.authPreparation !== undefined,
        operator.pendingEffectId === undefined,
        operator.pendingEffectAttempt === undefined,
        current.record.leaseId === undefined,
        current.record.leaseExpiresAt === undefined,
      ].every(Boolean);
      const completedBootstrap =
        operator.plan.stage === "auth-bootstrap" &&
        operator.plan.effects.every((effect) =>
          operator.receipts.some((receipt) => receipt.effectId === effect.id),
        );
      const retained = retainedOperatorAuthSchema.safeParse(current.record.retainedAuth);
      const participantReady =
        operator.plan.stage === PARTICIPANT_STAGE &&
        retained.success &&
        [
          isDeepStrictEqual(retained.data.plan.authDatabase, operator.plan.authDatabase),
          isDeepStrictEqual(retained.data.plan.neon, operator.plan.neon),
          retained.data.plan.bootstrap?.endpointId === operator.plan.bootstrap?.endpointId,
          retained.data.plan.authSchema?.targetDigest === operator.plan.authSchema?.targetDigest,
          isDeepStrictEqual(retained.data.authPreparation, operator.authPreparation),
        ].every(Boolean);
      if (![idle, completedBootstrap || participantReady].every(Boolean)) {
        throw new HostedOperatorError("auth_schema_not_ready");
      }
      if (participantReady && retained.success) {
        const approval = await readApproval({
          ...context,
          action: "prepare",
          callId: retained.data.approvedByCallId,
          planDigest: retained.data.planDigest,
        });
        if (
          ![
            approval?.approved,
            approval?.approvalId === retained.data.approvalId,
            approval?.callId === retained.data.approvedByCallId,
            approval?.planDigest === retained.data.planDigest,
          ].every(Boolean)
        ) {
          throw new HostedOperatorError("authorization_required");
        }
      }
      await owner.assertPlanningAuthorized(context);
      return { ...current, operator };
    };

    const reserveRealmIdentityLink = async (linkInput: {
      context: HostedOperatorContext;
      bootstrapPlanDigest: string;
      browserOrigin: string;
      authResourceId: string;
      issuer: string;
      endpointOrigin: string;
      audience: string;
      organizationId: string | null;
      nonceSha256: string;
      sealedNonce?: ReturnType<typeof encryptVercelToken> & { keyVersion: string };
      expiresAt: string;
      browserSession?: z.infer<typeof operatorRealmIdentityLinkSchema>["browserSession"];
    }) => {
      const known = await readKnownAuthBootstrap(linkInput.context);
      if (
        known.operator.planDigest !== linkInput.bootstrapPlanDigest ||
        known.operator.plan.authDatabase.resourceId !== linkInput.authResourceId
      ) {
        throw new HostedOperatorError("resource_mismatch");
      }
      if (known.operator.plan.stage === PARTICIPANT_STAGE) {
        const prepared = await normalActorJournal.read(linkInput.context);
        const { browserSession } = linkInput;
        const scoped = [
          prepared !== undefined,
          linkInput.organizationId === null,
          browserSession?.operationRef === prepared?.preparation.accountOperationRef,
          browserSession?.participantProgramDigest === prepared?.preparation.programDigest,
          linkInput.bootstrapPlanDigest === prepared?.preparation.accountPlanDigest,
          known.operator.operationRef === prepared?.preparation.accountOperationRef,
        ].every(Boolean);
        if (!scoped) {
          throw new HostedOperatorError("authorization_required");
        }
      } else if (linkInput.browserSession !== undefined) {
        throw new HostedOperatorError("authorization_required");
      }
      const link = operatorRealmIdentityLinkSchema.parse({
        audience: linkInput.audience,
        authResourceId: linkInput.authResourceId,
        bootstrapPlanDigest: linkInput.bootstrapPlanDigest,
        browserSession: linkInput.browserSession,
        browserOrigin: linkInput.browserOrigin,
        endpointOrigin: linkInput.endpointOrigin,
        expiresAt: linkInput.expiresAt,
        issuer: linkInput.issuer,
        nonceSha256: linkInput.nonceSha256,
        organizationId: linkInput.organizationId,
        ownerSessionId: linkInput.context.target.sessionId,
        sealedNonce: linkInput.sealedNonce,
      });
      if (Date.parse(link.expiresAt) <= Date.now()) {
        throw new HostedOperatorError("authorization_required");
      }
      const saved = await updateHostedRuntimeJournal({
        ...linkInput.context,
        now: Date.now,
        store,
        update: (record) => {
          const currentLinkScope = [
            record.operator?.planDigest === known.operator.planDigest,
            record.operator?.operationRef === known.operator.operationRef,
            record.leaseId === undefined,
            record.operator?.pendingEffectId === undefined,
            record.operator?.pendingEffectAttempt === undefined,
          ].every(Boolean);
          if (!currentLinkScope || record.operator === undefined) {
            throw new HostedOperatorError("operation_in_progress");
          }
          const existing = record.operator.identityLink;
          if (
            [
              record.operator.plan.normalActorProgram === undefined,
              existing?.browserSession === undefined,
              link.browserSession === undefined,
              existing?.bootstrapPlanDigest === link.bootstrapPlanDigest,
              existing?.consumedAt !== undefined,
            ].every(Boolean)
          ) {
            // Capture may finish while provider inventory is read. Never replace the same owner's proof.
            throw new HostedOperatorError("operation_in_progress");
          }
          if (
            existing !== undefined &&
            existing.consumedAt === undefined &&
            Date.parse(existing.expiresAt) > Date.now() &&
            existing.nonceSha256 !== link.nonceSha256
          ) {
            throw new HostedOperatorError("operation_in_progress");
          }
          return { ...record, operator: { ...record.operator, identityLink: link } };
        },
      });
      await owner.assertPlanningAuthorized(linkInput.context);
      return operatorRealmIdentityLinkSchema.parse(saved.record.operator?.identityLink);
    };
    const prepareRealmIdentityLink = async (
      linkInput: Omit<
        Parameters<typeof reserveRealmIdentityLink>[0],
        "nonceSha256" | "sealedNonce"
      >,
    ) => {
      const known = await readKnownAuthBootstrap(linkInput.context);
      const existing = known.operator.identityLink;
      const aad = JSON.stringify({
        authority: linkInput.context.authority,
        bootstrapPlanDigest: linkInput.bootstrapPlanDigest,
        organizationId: linkInput.organizationId,
        ownerSessionId: linkInput.context.target.sessionId,
        purpose: "realm-identity-link-nonce-v1",
        ...(linkInput.browserSession === undefined
          ? {}
          : { browserSession: linkInput.browserSession }),
      });
      if (
        existing !== undefined &&
        existing.consumedAt === undefined &&
        Date.parse(existing.expiresAt) > Date.now()
      ) {
        const samePending = [
          existing.sealedNonce !== undefined,
          existing.bootstrapPlanDigest === linkInput.bootstrapPlanDigest,
          existing.organizationId === linkInput.organizationId,
          existing.audience === linkInput.audience,
          existing.browserOrigin === linkInput.browserOrigin,
          existing.issuer === linkInput.issuer,
          existing.endpointOrigin === linkInput.endpointOrigin,
          isDeepStrictEqual(existing.browserSession, linkInput.browserSession),
        ].every(Boolean);
        if (!samePending || existing.sealedNonce === undefined) {
          throw new HostedOperatorError("operation_in_progress");
        }
        const nonce = z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .parse(
            decryptVersionedVercelToken({
              ...existing.sealedNonce,
              associatedData: aad,
              config: tokenKeyring,
            }),
          );
        if (createHash("sha256").update(nonce).digest("hex") !== existing.nonceSha256) {
          throw new HostedOperatorError("resource_mismatch");
        }
        await owner.assertPlanningAuthorized(linkInput.context);
        return { link: existing, nonce };
      }
      const nonce = randomBytes(32).toString("hex");
      const sealedNonce = {
        ...encryptVercelToken({ associatedData: aad, key: tokenKeyring.tokenKey, token: nonce }),
        keyVersion: tokenKeyring.tokenKeyVersion,
      };
      const link = await reserveRealmIdentityLink({
        ...linkInput,
        nonceSha256: createHash("sha256").update(nonce).digest("hex"),
        sealedNonce,
      });
      return { link, nonce };
    };
    const readCanonicalPendingIdentity = async (pendingInput: {
      ownerSessionId: string;
      nonceSha256: string;
      authority?: HostedOperatorContext["authority"];
    }) => {
      const sessionId = z.string().min(1).max(200).parse(pendingInput.ownerSessionId);
      const nonceSha256 = z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .parse(pendingInput.nonceSha256);
      const records = await database
        .select({
          record: builderProvisioningJournals.record,
          issuer: builderProvisioningJournals.issuer,
          audience: builderProvisioningJournals.audience,
          workspaceId: builderProvisioningJournals.workspaceId,
          ownerUserId: builderProvisioningJournals.ownerUserId,
        })
        .from(builderProvisioningJournals)
        .where(
          and(
            sql`${builderProvisioningJournals.record}->>'kind' = 'app-runtime'`,
            sql`${builderProvisioningJournals.record}->'operator'->'identityLink'->>'ownerSessionId' = ${sessionId}`,
            sql`${builderProvisioningJournals.record}->'operator'->'identityLink'->>'nonceSha256' = ${nonceSha256}`,
          ),
        )
        .limit(2);
      const saved = records.at(0);
      if (records.length !== 1 || saved === undefined) {
        throw new HostedOperatorError("authorization_required");
      }
      const authority = hostedTenantAuthoritySchema.parse({
        issuer: saved.issuer,
        audience: saved.audience,
        workspaceId: saved.workspaceId,
        ownerUserId: saved.ownerUserId,
      });
      if (
        authority.issuer !== config.issuer ||
        authority.audience !== config.resource ||
        (pendingInput.authority !== undefined &&
          !isDeepStrictEqual(authority, pendingInput.authority))
      ) {
        throw new HostedOperatorError("authorization_required");
      }
      const sessionRows = await database
        .select()
        .from(agentSessions)
        .where(
          and(
            eq(agentSessions.issuer, authority.issuer),
            eq(agentSessions.audience, authority.audience),
            eq(agentSessions.workspaceId, authority.workspaceId),
            eq(agentSessions.ownerUserId, authority.ownerUserId),
            eq(agentSessions.sessionId, sessionId),
          ),
        )
        .limit(1);
      const row = sessionRows.at(0);
      if (row === undefined) {
        throw new HostedOperatorError("authorization_required");
      }
      const parsedSession = parseHostedSessionRow(row);
      const durable = toDurableHostedSessionRecord(parsedSession);
      if (["cancelled", "completed"].includes(durable.status)) {
        throw new HostedOperatorError("authorization_required");
      }
      const ownerContext = await ownerContextResolver({
        adapterSessionId: durable.adapterSessionId,
        authority,
        principal: durable.principal,
        sessionAuth: forwardedSessionAuth(
          durable.principal,
          parsedSession.version === 2 ? parsedSession.sourceHandoffId : undefined,
        ),
      });
      const record = hostedRuntimeJournalRecordSchema.parse(saved.record);
      const context = { authority, ownerContext, target: record.request };
      const known = await readKnownAuthBootstrap(context);
      const link = known.operator.identityLink;
      const current = [
        record.request.sessionId === sessionId,
        durable.sessionId === sessionId,
        ownerContext.sessionId === sessionId,
        link?.ownerSessionId === sessionId,
        link?.nonceSha256 === nonceSha256,
        link?.consumedAt === undefined,
        Date.parse(link?.expiresAt ?? "") > Date.now(),
        known.operator.planDigest === link?.bootstrapPlanDigest,
        isDeepStrictEqual(record.operator?.identityLink, link),
      ].every(Boolean);
      if (!current || link === undefined) {
        throw new HostedOperatorError("authorization_required");
      }
      return { context, known, link };
    };
    const sharedAuth = createHostedOperatorSharedAuthAdoption({
      assertAuthorized: owner.assertAuthorized,
      assertPlanningAuthorized: owner.assertPlanningAuthorized,
      checkpointTarget: async ({ effect, expected, privateState }) => {
        await owner.assertAuthorized(effect);
        await effect.assertCurrent();
        await updateHostedRuntimeJournal({
          ...effect,
          now: Date.now,
          store,
          update: (record) => {
            requireCurrentResourceCredentialRecord(record, effect);
            if (!isDeepStrictEqual(record.privateState, expected)) {
              throw new HostedOperatorError("operation_in_progress");
            }
            return { ...record, privateState };
          },
        });
      },
      config: tokenKeyring,
      readApproval,
      readCurrentTarget: async (effect) =>
        await readCurrentResourceCredentialRecord({
          assertAuthorized: owner.assertAuthorized,
          effect,
          store,
        }),
      store,
    });

    const observeOwnerRealmContinuation = async (
      context: HostedOperatorContext,
    ): Promise<RealmContinuationObservation | undefined> => {
      // A wake observes saved state only. The protected prepare/effect
      // boundary rechecks actual provider deployment authority afterward.
      await owner.assertArtifactAuthorized(context);
      const { ownerContext } = context;
      if (ownerContext === undefined) {
        throw new HostedOperatorError("authorization_required");
      }
      const savedSession = await eve.getSession(ownerContext.principal, ownerContext.sessionId);
      if (savedSession === null) {
        throw new HostedOperatorError("authorization_required");
      }
      const ownedSession = toDurableHostedSessionRecord(savedSession);
      if (["cancelled", "completed"].includes(ownedSession.status)) {
        return undefined;
      }
      const current = await store.read(context);
      if (current?.record.operator === undefined) {
        return undefined;
      }
      const { operator } = current.record;
      const approval = await readApproval({
        ...context,
        action: operator.plan.action,
        callId: current.record.approvedByCallId,
        planDigest: operator.planDigest,
      });
      if (
        !approval?.approved ||
        approval.approvalId !== operator.approvalId ||
        approval.callId !== current.record.approvedByCallId ||
        approval.planDigest !== operator.planDigest
      ) {
        throw new HostedOperatorError("authorization_required");
      }
      const { initiator } = forwardedSessionAuth(
        ownedSession.principal,
        context.ownerContext?.kind === "handoff" ? context.ownerContext.sourceHandoffId : undefined,
      );
      const forwardedBy = input.workloadPolicy.subject;
      Object.assign(initiator.attributes, { "eve:forwarded-by": forwardedBy });
      const observed = observeRealmContinuationRecord({
        context,
        record: current.record,
        initiator,
        now: Date.now(),
      });
      if (observed?.reason.kind === "consumed-proof") {
        const artifacts = ownedArtifacts(context);
        const content = await artifacts.store.read(artifacts.context, observed.reason.proofRef, 0);
        if (
          content === undefined ||
          createHash("sha256").update(Buffer.from(content, "base64")).digest("hex") !==
            observed.reason.proofSha256
        ) {
          throw new HostedOperatorError("auth_identity_required");
        }
      }
      await owner.assertArtifactAuthorized(context);
      return observed;
    };
    const deliverRealmContinuation = async (
      request: RealmContinuationRequest,
      reconcile: boolean,
    ) => {
      const token = await operatorIdentity.token();
      const response = await (input.fetch ?? fetch)(
        new URL(
          `${realmContinuationPath}${reconcile ? "/reconcile" : ""}`,
          new URL(config.resource).origin,
        ),
        {
          method: "POST",
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
            "x-vercel-trusted-oidc-idp-token": token,
            accept: "application/json",
          },
          body: JSON.stringify(request),
        },
      );
      if (!response.ok) {
        throw new Error("Realm continuation delivery is unavailable.");
      }
      return realmContinuationReceiptSchema.parse(await response.json());
    };
    const reconcileOwnerRealmContinuation = createHostedOperatorRealmContinuation({
      store,
      observe: observeOwnerRealmContinuation,
      seal: (observed) =>
        mintRealmContinuationAuthority({
          config: tokenKeyring,
          observed,
          service: realmContinuationServiceIdentityForWorkload(input.workloadPolicy),
        }),
      dispatch: async (request) => await deliverRealmContinuation(request, false),
      reconcile: async (request) => await deliverRealmContinuation(request, true),
    });
    const continuationContext = async (claim: RealmContinuationAuthority) => {
      const rows = await database
        .select({ record: builderProvisioningJournals.record })
        .from(builderProvisioningJournals)
        .where(
          and(
            eq(builderProvisioningJournals.issuer, claim.authority.issuer),
            eq(builderProvisioningJournals.audience, claim.authority.audience),
            eq(builderProvisioningJournals.workspaceId, claim.authority.workspaceId),
            eq(builderProvisioningJournals.ownerUserId, claim.authority.ownerUserId),
            sql`${builderProvisioningJournals.record}->>'kind' = 'app-runtime'`,
            sql`${builderProvisioningJournals.record}->'request'->>'sessionId' = ${claim.ownerSessionId}`,
            sql`${builderProvisioningJournals.record}->'request'->>'appId' = ${claim.appId}`,
          ),
        )
        .limit(2);
      if (rows.length !== 1) {
        throw new HostedOperatorError("authorization_required");
      }
      const record = hostedRuntimeJournalRecordSchema.parse(rows[0]?.record);
      const principal = { ...claim.authority, scopes: claim.initiator.attributes["mcp:scopes"] };
      const ownerContext = await ownerContextResolver({
        adapterSessionId: claim.adapterSessionId,
        authority: claim.authority,
        principal,
        sessionAuth: { current: claim.initiator, initiator: claim.initiator },
      });
      const context = { authority: claim.authority, ownerContext, target: record.request };
      const current = await observeOwnerRealmContinuation(context);
      if (
        current === undefined ||
        realmContinuationDispatchId(current) !== realmContinuationDispatchId(claim)
      ) {
        throw new HostedOperatorError("authorization_required");
      }
      return context;
    };
    const realmIdentityWait = createHostedOperatorRealmIdentityWait({
      config: tokenKeyring,
      store,
      assertAuthorized: owner.assertArtifactAuthorized,
      observe: observeOwnerRealmContinuation,
    });

    const installationPlanning: AppInstallationPlanningPort = {
      readAppInstallationCustomerIds: createRetainedAppInstallationCustomerReader({
        readOwner: owner.readCurrentPlanningOwner,
        readApproval: async (context, receipt) =>
          await readPrivateHostedApproval({
            store: eve,
            principal: operatorOwnerContextSchema.parse(context.ownerContext).principal,
            sessionId: context.target.sessionId,
            callId: receipt.callId,
            action: "prepare",
            planDigest: receipt.toolInput.planDigest,
            selection: receipt.toolInput.plan.selection,
            requestId: receipt.requestId,
          }),
        readActiveCustomers: async (context, desired, scopes) => {
          await owner.assertPlanningAuthorized(context);
          const row = await store.read(context);
          const plan = row?.record.operator?.plan;
          if (row === undefined || plan === undefined) {
            throw new HostedOperatorError("resource_mismatch");
          }
          const sameResources = [
            isDeepStrictEqual(plan.appDatabase, desired.appDatabase),
            plan.neon.projectId === desired.neon.projectId,
            plan.neon.branchId === desired.neon.branchId,
            plan.neon.endpoint === desired.neon.endpoint,
          ].every(Boolean);
          if (!sameResources) {
            throw new HostedOperatorError("resource_mismatch");
          }
          const bindingInput = structuredClone({ plan, privateState: row.record.privateState });
          requireFinalResourceBindingPhase(row, bindingInput);
          const bindings = readHostedOperatorResourceBindings({
            ...context,
            config: tokenKeyring,
            record: row.record,
            plan,
          });
          return await readActiveAppInstallationCustomerIds({
            plan: desired,
            scopes,
            runtimeUrl: bindings.appDatabase.runtimeUrl,
            assertCurrent: async () => {
              await owner.assertPlanningAuthorized(context);
              requireFinalResourceBindingPhase(await store.read(context), bindingInput);
            },
          });
        },
      }),
    };
    const controlPlane = {
      ...installationPlanning,
      readApprovedPlan,
      registerOwnerRealmIdentityWait: (...args: Parameters<typeof realmIdentityWait.register>) =>
        realmIdentityWait.register(...args),
      acknowledgeOwnerRealmIdentityWait: (
        ...args: Parameters<typeof realmIdentityWait.acknowledge>
      ) => realmIdentityWait.acknowledge(...args),
      async readRealmIdentityWaitDelivery(claim: RealmContinuationAuthority) {
        return await realmIdentityWait.delivery(await continuationContext(claim));
      },
      async resolveOwnerRealmContinuationContext(request: {
        principal: HostedPrincipal;
        sessionId: string;
        adapterSessionId: string;
        sourceHandoffId?: string;
      }): Promise<HostedOperatorContext | undefined> {
        const raw = await eve.getSession(request.principal, request.sessionId);
        const parsed = hostedSessionRecordSchema.safeParse(raw);
        if (!parsed.success || parsed.data.version !== 2) {
          return undefined;
        }
        const durable = toDurableHostedSessionRecord(parsed.data);
        if (
          durable.adapterSessionId !== request.adapterSessionId ||
          parsed.data.sourceHandoffId !== request.sourceHandoffId ||
          !isDeepStrictEqual(
            hostedTenantAuthoritySchema.parse({
              issuer: durable.principal.issuer,
              audience: durable.principal.audience,
              workspaceId: durable.principal.workspaceId,
              ownerUserId: durable.principal.ownerUserId,
            }),
            hostedTenantAuthoritySchema.parse({
              issuer: request.principal.issuer,
              audience: request.principal.audience,
              workspaceId: request.principal.workspaceId,
              ownerUserId: request.principal.ownerUserId,
            }),
          )
        ) {
          throw new HostedOperatorError("authorization_required");
        }
        const authority = hostedTenantAuthoritySchema.parse({
          issuer: durable.principal.issuer,
          audience: durable.principal.audience,
          workspaceId: durable.principal.workspaceId,
          ownerUserId: durable.principal.ownerUserId,
        });
        const rows = await database
          .select({ record: builderProvisioningJournals.record })
          .from(builderProvisioningJournals)
          .where(
            and(
              eq(builderProvisioningJournals.issuer, authority.issuer),
              eq(builderProvisioningJournals.audience, authority.audience),
              eq(builderProvisioningJournals.workspaceId, authority.workspaceId),
              eq(builderProvisioningJournals.ownerUserId, authority.ownerUserId),
              sql`${builderProvisioningJournals.record}->>'kind' = 'app-runtime'`,
              sql`${builderProvisioningJournals.record}->'request'->>'sessionId' = ${request.sessionId}`,
            ),
          )
          .limit(2);
        if (rows.length === 0) {
          return undefined;
        }
        if (rows.length !== 1) {
          throw new HostedOperatorError("authorization_required");
        }
        const record = hostedRuntimeJournalRecordSchema.parse(rows[0]?.record);
        const ownerContext = await ownerContextResolver({
          adapterSessionId: durable.adapterSessionId,
          authority,
          principal: durable.principal,
          sessionAuth: forwardedSessionAuth(durable.principal, parsed.data.sourceHandoffId),
        });
        return { authority, ownerContext, target: record.request };
      },
      reconcileOwnerRealmContinuation,
      async readRealmContinuationPendingBaseline(claim: RealmContinuationAuthority) {
        const context = await continuationContext(claim);
        const principal = context.ownerContext?.principal;
        if (principal === undefined || eve.readCheckpointPage === undefined) {
          throw new HostedOperatorError("authorization_required");
        }
        const ownedSession = await eve.getSession(principal, claim.ownerSessionId);
        if (ownedSession === null) {
          throw new HostedOperatorError("authorization_required");
        }
        const durable = toDurableHostedSessionRecord(ownedSession);
        if (
          durable.adapterSessionId !== claim.adapterSessionId ||
          durable.checkpointRef === undefined
        ) {
          throw new HostedOperatorError("authorization_required");
        }
        const page = await eve.readCheckpointPage({
          principal,
          sessionId: claim.ownerSessionId,
          checkpointRef: durable.checkpointRef,
          cursor: 0,
          limit: 1,
        });
        const state = nativeObservationStateSchema.parse(page.metadata.nativeObservationState);
        if (
          state.adapterSessionId !== claim.adapterSessionId ||
          page.checkpointDigest !== durable.checkpointRef.digest ||
          page.totalEvents !== durable.checkpointRef.eventCount
        ) {
          throw new HostedOperatorError("authorization_required");
        }
        return realmContinuationPendingBaseline(state);
      },
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Raw native pending request is parsed by the exact structural guard.
      async isObsoleteRealmAuthWait(claim: RealmContinuationAuthority, request: unknown) {
        const context = await continuationContext(claim);
        const current = await store.read(context);
        return current !== undefined && isRealmContinuationTechnicalWait(current.record, request);
      },
      async readRealmContinuationDeliveryStartIndex(
        claim: RealmContinuationAuthority,
        dispatchId: string,
      ) {
        const context = await continuationContext(claim);
        if (realmContinuationDispatchId(claim) !== dispatchId) {
          throw new HostedOperatorError("authorization_required");
        }
        const current = await store.read(context);
        const state = current?.record.realmContinuation;
        return state?.dispatchId === dispatchId ? state.receiverStreamStartIndex : undefined;
      },
      async readRealmContinuationDeliveryTargetRequestId(
        claim: RealmContinuationAuthority,
        dispatchId: string,
      ) {
        const context = await continuationContext(claim);
        if (realmContinuationDispatchId(claim) !== dispatchId) {
          throw new HostedOperatorError("authorization_required");
        }
        const current = await store.read(context);
        const state = current?.record.realmContinuation;
        return state?.dispatchId === dispatchId ? state.receiverRequestId : undefined;
      },
      async acceptRealmContinuationDelivery(claim: RealmContinuationAuthority, dispatchId: string) {
        const context = await continuationContext(claim);
        if (realmContinuationDispatchId(claim) !== dispatchId) {
          throw new HostedOperatorError("authorization_required");
        }
        await updateHostedRuntimeJournal({
          ...context,
          now: Date.now,
          store,
          update: (record) => {
            const state = record.realmContinuation;
            if (state?.dispatchId !== dispatchId || state.receiverClaimedAt === undefined) {
              throw new HostedOperatorError("authorization_required");
            }
            return {
              ...record,
              realmContinuation: {
                ...state,
                status: "accepted",
                acceptedAt: state.acceptedAt ?? new Date().toISOString(),
              },
            };
          },
        });
      },
      async readRealmContinuationDeliveryReceipt(
        claim: RealmContinuationAuthority,
        dispatchId: string,
      ): Promise<"accepted" | "unknown" | "not-submitted"> {
        const context = await continuationContext(claim);
        if (realmContinuationDispatchId(claim) !== dispatchId) {
          throw new HostedOperatorError("authorization_required");
        }
        const current = await store.read(context);
        const state = current?.record.realmContinuation;
        if (state?.dispatchId === dispatchId && state.status === "accepted") {
          return "accepted";
        }
        return state?.dispatchId === dispatchId && state.receiverClaimedAt !== undefined
          ? "unknown"
          : "not-submitted";
      },
      async readRealmContinuationDeliveryClaim(
        claim: RealmContinuationAuthority,
        dispatchId: string,
      ) {
        const context = await continuationContext(claim);
        if (realmContinuationDispatchId(claim) !== dispatchId) {
          throw new HostedOperatorError("authorization_required");
        }
        const current = await store.read(context);
        const state = current?.record.realmContinuation;
        return state?.dispatchId === dispatchId && state.receiverClaimedAt !== undefined;
      },
      async claimRealmContinuationDelivery(
        claim: RealmContinuationAuthority,
        dispatchId: string,
        streamStartIndex: number,
        targetRequestId: string,
      ) {
        const receiverStreamStartIndex = z.number().int().nonnegative().parse(streamStartIndex);
        const receiverRequestId = z.string().min(1).max(200).parse(targetRequestId);
        const context = await continuationContext(claim);
        if (realmContinuationDispatchId(claim) !== dispatchId) {
          throw new HostedOperatorError("authorization_required");
        }
        const current = await store.read(context);
        const state = current?.record.realmContinuation;
        if (
          current === undefined ||
          state?.dispatchId !== dispatchId ||
          state.receiverClaimedAt !== undefined
        ) {
          return false;
        }
        const saved = await store.compareAndSet({
          ...context,
          expectedRevision: current.revision,
          now: new Date(),
          record: {
            ...current.record,
            realmContinuation: {
              ...state,
              receiverClaimedAt: new Date().toISOString(),
              receiverStreamStartIndex,
              receiverRequestId,
            },
          },
        });
        return saved !== undefined;
      },
      normalActorJournalPorts,
      assertAuthorized: owner.assertAuthorized,
      async assertMembershipCapture(inputContext: HostedOperatorEffectContext) {
        if (
          inputContext.effect.kind !== "auth-membership" ||
          inputContext.plan.authMembership === undefined
        ) {
          throw new HostedOperatorError("authorization_required");
        }
        await inputContext.assertCurrent();
        const record = await readCurrentResourceCredentialRecord({
          assertAuthorized: owner.assertAuthorized,
          effect: inputContext,
          store,
        });
        const link = record.operator?.identityLink;
        const capturedMembership = membershipSpecForEffect(inputContext);
        const matches = [
          link?.consumedAt === capturedMembership.identityCapture.capturedAt,
          link?.proofRef === capturedMembership.identityProof.reference,
          link?.proofSha256 === capturedMembership.identityProof.sha256,
          link?.nonceSha256 === capturedMembership.identityNonceSha256,
          link?.bootstrapPlanDigest === capturedMembership.bootstrapPlanDigest,
          link?.ownerSessionId === inputContext.target.sessionId,
          link?.authResourceId === inputContext.plan.authDatabase.resourceId,
          link?.issuer === capturedMembership.identityVerification.issuer,
          link?.audience === capturedMembership.identityVerification.audience,
          matchesApprovedMembershipJwks(
            inputContext.plan,
            link?.endpointOrigin,
            capturedMembership.identityVerification.jwksUrl,
          ),
        ].every(Boolean);
        if (!matches) {
          throw new HostedOperatorError("auth_identity_required");
        }
        const artifacts = ownedArtifacts(inputContext);
        const content = await artifacts.store.read(
          artifacts.context,
          capturedMembership.identityProof.reference,
          0,
        );
        if (
          content === undefined ||
          createHash("sha256").update(Buffer.from(content, "base64")).digest("hex") !==
            capturedMembership.identityProof.sha256
        ) {
          throw new HostedOperatorError("auth_identity_required");
        }
        const claims = z
          .object({ sessionId: z.string(), sub: z.string() })
          .parse(
            JSON.parse(
              Buffer.from(
                Buffer.from(content, "base64").toString("utf-8").split(".")[1] ?? "",
                "base64url",
              ).toString("utf-8"),
            ),
          );
        if (
          claims.sessionId !== capturedMembership.identityCapture.realmSessionId ||
          claims.sub !== capturedMembership.actorId
        ) {
          throw new HostedOperatorError("auth_identity_required");
        }
        await owner.assertAuthorized(inputContext);
      },
      // Fresh canonical ownership for read-only metadata; provider grants are checked at observation boundaries.
      assertCanonicalOwner: owner.assertArtifactAuthorized,
      assertPlanningAuthorized: owner.assertPlanningAuthorized,
      authorize: owner.authorize,
      checkpointSharedAuthAdoption: async (
        adoptionInput: Parameters<typeof sharedAuth.checkpoint>[0],
      ) => await sharedAuth.checkpoint(adoptionInput),
      async close() {
        await controlPlaneClient.end({ timeout: 5 });
      },
      async consumeOwnerRealmIdentityCallback(linkInput: {
        context: HostedOperatorContext;
        nonceSha256: string;
        proofRef: string;
        proofSha256: string;
      }) {
        await owner.assertPlanningAuthorized(linkInput.context);
        const current = await store.read(linkInput.context);
        const pending = current?.record.operator?.identityLink;
        const capture = current?.record.accountPreparation?.captures.find(
          (candidate) =>
            candidate.nonceSha256 === linkInput.nonceSha256 &&
            candidate.proofSha256 === linkInput.proofSha256,
        );
        const capturePayload =
          pending?.browserSession === undefined || capture === undefined
            ? undefined
            : await normalActorJournal.readCapture(linkInput.context, capture.reference);
        const saved = await updateHostedRuntimeJournal({
          ...linkInput.context,
          now: Date.now,
          store,
          update: (record) => {
            const link = record.operator?.identityLink;
            if (link === undefined || record.operator === undefined) {
              throw new HostedOperatorError("authorization_required");
            }
            if (link.browserSession !== undefined) {
              if (capturePayload === undefined) {
                throw new HostedOperatorError("auth_identity_required");
              }
              return confirmNormalActorCapture({
                context: linkInput.context,
                record,
                nonceSha256: linkInput.nonceSha256,
                proofRef: linkInput.proofRef,
                proofSha256: linkInput.proofSha256,
                payload: capturePayload,
                keyring: tokenKeyring,
                now: Date.now(),
              });
            }
            const currentLink = [
              link.nonceSha256 === linkInput.nonceSha256,
              link.consumedAt === undefined,
              Date.parse(link.expiresAt) > Date.now(),
              record.operator.planDigest === link.bootstrapPlanDigest,
              record.leaseId === undefined,
              record.operator.pendingEffectId === undefined,
              record.operator.pendingEffectAttempt === undefined,
            ].every(Boolean);
            if (!currentLink) {
              throw new HostedOperatorError("authorization_required");
            }
            const captured = operatorRealmIdentityLinkSchema.parse({
              ...link,
              consumedAt: new Date().toISOString(),
              proofRef: linkInput.proofRef,
              proofSha256: linkInput.proofSha256,
            });
            delete captured.sealedNonce;
            return { ...record, operator: { ...record.operator, identityLink: captured } };
          },
        });
        await owner.assertPlanningAuthorized(linkInput.context);
        return operatorRealmIdentityLinkSchema.parse(saved.record.operator?.identityLink);
      },
      prepareRealmIdentityLink,
      async prepareNormalActorCapture(
        captureInput: HostedOperatorContext & {
          preparation: NormalActorAccountPreparation;
          actorKey: string;
          organizationId?: string;
        },
      ) {
        const prepared = await normalActorJournal.read(captureInput);
        if (prepared === undefined) {
          throw new HostedOperatorError("auth_identity_required");
        }
        const { preparation } = prepared;
        const requested = captureInput.preparation;
        const exactPreparation = [
          requested.accountOperationRef === preparation.accountOperationRef,
          requested.programDigest === preparation.programDigest,
          requested.accountPlanDigest === preparation.accountPlanDigest,
          requested.accountApprovalId === preparation.accountApprovalId,
          requested.accountApprovedByCallId === preparation.accountApprovedByCallId,
          isDeepStrictEqual(requested.program, preparation.program),
        ].every(Boolean);
        const actor = preparation.program.actors.find(
          (entry) => entry.actorKey === captureInput.actorKey,
        );
        const approvedTarget =
          captureInput.organizationId === undefined ||
          preparation.program.memberships.some(
            (entry) =>
              entry.actorKey === captureInput.actorKey &&
              entry.organizationId === captureInput.organizationId,
          );
        if (!exactPreparation || actor?.account !== "capture-existing" || !approvedTarget) {
          throw new HostedOperatorError("authorization_required");
        }
        const known = await readKnownAuthBootstrap(captureInput);
        const { operator } = known;
        if (
          operator.plan.stage !== PARTICIPANT_STAGE ||
          operator.operationRef !== preparation.accountOperationRef ||
          operator.planDigest !== preparation.accountPlanDigest
        ) {
          throw new HostedOperatorError("authorization_required");
        }
        const candidate = operator.gatewayDeliveryCandidates?.find(
          (entry) =>
            entry.deploymentId === operator.deliveredGatewayDeploymentId &&
            entry.readyState === "READY",
        );
        const boundary = operator.plan.deploymentBoundary;
        const { gatewayBindings } = operator.plan;
        if (candidate === undefined || boundary === undefined || gatewayBindings === undefined) {
          throw new HostedOperatorError("reconciliation_required");
        }
        await readHostedOperatorProviderInventory({
          assertCurrentOwner: async () => {
            await owner.assertPlanningAuthorized(captureInput);
          },
          configuration: {
            app: { ...boundary.app, environment: "preview" },
            gateway: {
              branch: candidate.branch,
              deploymentId: candidate.deploymentId,
              environment: "preview",
              projectId: candidate.projectId,
            },
            operator: boundary.operator,
            verification: {
              gatewayOrigin: candidate.origin,
              publicOrigin: boundary.verification.publicOrigin,
            },
          },
          context: captureInput,
          phase: "bootstrap-planning",
          readVercelCredential: async ({ authority, installationId }) =>
            await readCredential(authority, installationId),
          fetch: input.fetch,
        });
        const pending = await prepareRealmIdentityLink({
          context: captureInput,
          audience: gatewayBindings.operatorOrigin,
          authResourceId: operator.plan.authDatabase.resourceId,
          bootstrapPlanDigest: preparation.accountPlanDigest,
          browserSession: {
            operationRef: preparation.accountOperationRef,
            participantProgramDigest: preparation.programDigest,
          },
          browserOrigin: preparation.program.origin,
          endpointOrigin: candidate.origin,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          issuer: boundary.verification.publicOrigin,
          organizationId: null,
        });
        await normalActorJournal.registerPendingCapture(captureInput, {
          actorKey: captureInput.actorKey,
          organizationId: captureInput.organizationId,
          nonceSha256: pending.link.nonceSha256,
          expiresAt: pending.link.expiresAt,
        });
        await owner.assertArtifactAuthorized(captureInput);
        return {
          browserUrl: createRealmIdentityBrowserUrl(pending),
          expiresAt: pending.link.expiresAt,
          operationRef: preparation.accountOperationRef,
          sessionId: captureInput.target.sessionId,
        };
      },
      async readPendingNormalActorCapture(captureInput: {
        ownerSessionId: string;
        nonceSha256: string;
      }) {
        const { context, link } = await readCanonicalPendingIdentity(captureInput);
        const prepared = await normalActorJournal.read(context);
        // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Verify the retained program and first account approval before looking up its pending actor mapping.
        const mapping = await normalActorJournal.readPendingCapture(context, link.nonceSha256);
        const scoped = [
          prepared !== undefined,
          mapping !== undefined,
          link.organizationId === null,
          link.browserSession?.operationRef === prepared?.preparation.accountOperationRef,
          link.browserSession?.participantProgramDigest === prepared?.preparation.programDigest,
          link.bootstrapPlanDigest === prepared?.preparation.accountPlanDigest,
        ].every(Boolean);
        if (!scoped || prepared === undefined || mapping === undefined) {
          throw new HostedOperatorError("authorization_required");
        }
        return {
          context,
          preparation: prepared.preparation,
          actorKey: mapping.actorKey,
          organizationId: mapping.organizationId,
          link,
        };
      },
      async prepareResourceCredentials(
        effectInput: ResourceCredentialEffect & { database: ProtectedResourceDatabase },
      ) {
        if (
          effectInput.effect.kind !== "resources" ||
          effectInput.effect.resourceId !== effectInput.plan[effectInput.database].resourceId
        ) {
          throw new HostedOperatorError("operation_in_progress");
        }
        const prepared = prepareHostedOperatorResourceCredentials({
          ...effectInput,
          config: tokenKeyring,
          record: await readCurrentResourceCredentialRecord({
            assertAuthorized: owner.assertAuthorized,
            effect: effectInput,
            store,
          }),
        });
        // The journal callback commits under the active lease before plaintext can escape.
        await effectInput.checkpoint(prepared.privateState);
        const acknowledged = await readCurrentResourceCredentialRecord({
          assertAuthorized: owner.assertAuthorized,
          effect: effectInput,
          store,
        });
        assertResourceCredentialCheckpoint(acknowledged.privateState, prepared.privateState);
        return {
          bytes: Buffer.from(prepared.credentialsBytes, "utf-8"),
          privateState: prepared.privateState,
          sha256: prepared.credentialsSha256,
        };
      },
      async publishAuthPlan(
        context: HostedOperatorContext,
        proposal: { content: Buffer; planDigest: string; targetDigest: string },
      ) {
        const artifacts = ownedArtifacts(context);
        return await artifacts.publication.publishAuthPlan({
          ...proposal,
          context: artifacts.context,
        });
      },
      async readActiveSharedAuth(context: HostedOperatorContext) {
        const frozen = structuredClone(context);
        await owner.assertPlanningAuthorized(frozen);
        const current = await store.read(frozen);
        const plan = current?.record.operator?.plan;
        if (current === undefined || plan === undefined || plan.authAdoption === undefined) {
          // oxlint-disable-next-line unicorn/no-useless-undefined -- Optional planning evidence has no value before activation.
          return undefined;
        }
        const active = readActiveHostedOperatorSharedAuth({
          ...frozen,
          config: tokenKeyring,
          plan,
          record: current.record,
        });
        await owner.assertAuthorized({ ...frozen, plan });
        const latest = await store.read(frozen);
        if (!isDeepStrictEqual(current, latest)) {
          throw new HostedOperatorError("operation_in_progress");
        }
        return active === undefined
          ? undefined
          : { adoption: active.adoption, authSchema: plan.authSchema };
      },
      readApproval,
      async readAuthPlan(
        context: HostedOperatorContext,
        selection: Parameters<
          ReturnType<typeof createOperatorArtifactPublication>["readAuthPlan"]
        >[1],
      ) {
        const artifacts = ownedArtifacts(context);
        return await artifacts.publication.readAuthPlan(artifacts.context, selection);
      },
      async readMembershipInspectionPlan(effect: HostedOperatorEffectContext) {
        return await readApprovedRetainedMembershipInspection({
          effect,
          readApproval,
          readCurrentRecord: async () =>
            await readCurrentResourceCredentialRecord({
              assertAuthorized: owner.assertAuthorized,
              effect,
              store,
            }),
        });
      },
      async readCapturedRealmIdentity(context: HostedOperatorContext) {
        await owner.assertPlanningAuthorized(context);
        const current = await store.read(context);
        const link = current?.record.operator?.identityLink;
        await owner.assertPlanningAuthorized(context);
        return link?.consumedAt === undefined ? null : operatorRealmIdentityLinkSchema.parse(link);
      },
      async readCapturedRealmIdentityProof(context: HostedOperatorContext) {
        await owner.assertPlanningAuthorized(context);
        const current = await store.read(context);
        const link = current?.record.operator?.identityLink;
        if (
          link?.consumedAt === undefined ||
          link.proofRef === undefined ||
          link.proofSha256 === undefined
        ) {
          throw new HostedOperatorError("auth_identity_required");
        }
        const expectedRef = `_protected-operator/artifacts/realm-identity-proof/${context.target.appId}/${link.proofSha256}`;
        if (link.proofRef !== expectedRef) {
          throw new HostedOperatorError("resource_mismatch");
        }
        const artifacts = ownedArtifacts(context);
        const content = await artifacts.store.read(artifacts.context, expectedRef, 0);
        if (content === undefined) {
          throw new HostedOperatorError("auth_identity_required");
        }
        const bytes = Buffer.from(content, "base64");
        const proof = bytes.toString("utf-8");
        if (
          bytes.length > 16 * 1024 ||
          bytes.toString("base64") !== content ||
          !Buffer.from(proof, "utf-8").equals(bytes) ||
          createHash("sha256").update(bytes).digest("hex") !== link.proofSha256
        ) {
          throw new HostedOperatorError("resource_mismatch");
        }
        await owner.assertPlanningAuthorized(context);
        return { link: operatorRealmIdentityLinkSchema.parse(link), proof };
      },
      readCredential,
      readCurrentPlanningOwner: owner.readCurrentPlanningOwner,
      async readGeneratedRelease(
        context: HostedOperatorContext,
        selection: Parameters<
          ReturnType<typeof createOperatorArtifactPublication>["readGeneratedRelease"]
        >[1],
      ) {
        const artifacts = ownedArtifacts(context);
        return await artifacts.publication.readGeneratedRelease(artifacts.context, selection);
      },
      async readGeneratedSelection(
        context: HostedOperatorContext,
        appSpecDigest: string,
        lookup?: ExactCompiledOperatorReleaseLookup,
      ) {
        const artifacts = ownedArtifacts(context);
        return lookup === undefined
          ? await artifacts.selections.read(artifacts.context, appSpecDigest)
          : await artifacts.selections.readExact?.(artifacts.context, { ...lookup, appSpecDigest });
      },
      async readPendingRealmIdentityLinkForStaging(stagingInput: {
        ownerSessionId: string;
        nonceSha256: string;
      }) {
        const { context, known, link } = await readCanonicalPendingIdentity(stagingInput);
        const { operator } = known;
        if (link.browserSession !== undefined) {
          const prepared = await normalActorJournal.read(context);
          // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Verify the retained program and first account approval before looking up its pending actor mapping.
          const mapping = await normalActorJournal.readPendingCapture(context, link.nonceSha256);
          const exactCapture = [
            prepared !== undefined,
            mapping !== undefined,
            link.browserSession.operationRef === prepared?.preparation.accountOperationRef,
            link.browserSession.participantProgramDigest === prepared?.preparation.programDigest,
            link.bootstrapPlanDigest === prepared?.preparation.accountPlanDigest,
            link.organizationId === null,
          ].every(Boolean);
          if (!exactCapture) {
            throw new HostedOperatorError("authorization_required");
          }
        }
        if (operator.plan.deploymentBoundary === undefined) {
          throw new HostedOperatorError("authorization_required");
        }
        const resource = operator.plan.authDatabase;
        return {
          bootstrapResource: {
            database: resource.database,
            environment: "preview" as const,
            hostname: operator.plan.neon.endpoint,
            migratorRole: resource.migratorRole,
            neon: {
              branchId: operator.plan.neon.branchId,
              projectId: operator.plan.neon.projectId,
            },
            port: 5432 as const,
            runtimeRole: resource.runtimeRole,
            schema: "public" as const,
            version: 1 as const,
          },
          jwksUrl: `${link.endpointOrigin}/_platform/jwks.json`,
          link: projectPendingRealmIdentityLink(link),
        };
      },
      async readRealmIdentityLink(context: HostedOperatorContext) {
        await owner.assertPlanningAuthorized(context);
        const current = await store.read(context);
        const link = current?.record.operator?.identityLink;
        await owner.assertPlanningAuthorized(context);
        return link === undefined ? null : operatorRealmIdentityLinkSchema.parse(link);
      },
      async readResourceBindings(effectInput: ResourceCredentialEffect | ResourceBindingContext) {
        if (
          effectInput.plan.action !== "prepare" &&
          (!("effect" in effectInput) ||
            !["revoke", "remove-bindings", "retire"].includes(effectInput.effect.kind))
        ) {
          throw new HostedOperatorError("authorization_required");
        }
        if ("effect" in effectInput) {
          return await readHostedOperatorEffectResourceBindings({
            assertAuthorized: owner.assertAuthorized,
            effect: effectInput,
            store,
            config: tokenKeyring,
          });
        }
        await owner.assertAuthorized(effectInput);
        const current = requireFinalResourceBindingPhase(
          selectAuthPlanningResourceBindingRow(await store.read(effectInput), effectInput.plan),
          effectInput,
        );
        const { operator } = current.record;
        if (operator === undefined) {
          throw new HostedOperatorError("operation_in_progress");
        }
        const approval = await readApproval({
          ...effectInput,
          action: "prepare",
          callId: current.record.approvedByCallId,
          planDigest: operator.planDigest,
        });
        if (!approval?.approved || approval.approvalId !== operator.approvalId) {
          throw new HostedOperatorError("authorization_required");
        }
        if (
          approval.callId !== current.record.approvedByCallId ||
          approval.planDigest !== operator.planDigest ||
          approval.action !== "prepare"
        ) {
          throw new HostedOperatorError("authorization_required");
        }
        const bindings = readHostedOperatorResourceBindings({
          ...effectInput,
          config: tokenKeyring,
          record: current.record,
        });
        await owner.assertAuthorized(effectInput);
        const latest = requireFinalResourceBindingPhase(
          selectAuthPlanningResourceBindingRow(await store.read(effectInput), effectInput.plan),
          effectInput,
        );
        if (
          latest.revision !== current.revision ||
          JSON.stringify(latest.record.operator) !== JSON.stringify(operator)
        ) {
          throw new HostedOperatorError("operation_in_progress");
        }
        return bindings;
      },
      async readRetirementResourceCredentials(effectInput: ResourceCredentialEffect) {
        if (
          effectInput.plan.action !== "cleanup" ||
          effectInput.effect.kind !== "retire" ||
          effectInput.effect.resourceId !== effectInput.plan.appDatabase.resourceId
        ) {
          throw new HostedOperatorError("authorization_required");
        }
        const current = await readCurrentResourceCredentialRecord({
          assertAuthorized: owner.assertAuthorized,
          effect: effectInput,
          store,
        });
        if (current.privateState === undefined) {
          throw new HostedOperatorError("operation_in_progress");
        }
        const prepared = prepareHostedOperatorResourceCredentials({
          ...effectInput,
          config: tokenKeyring,
          database: "appDatabase",
          record: current,
        });
        await readCurrentResourceCredentialRecord({
          assertAuthorized: owner.assertAuthorized,
          effect: effectInput,
          store,
        });
        return {
          bytes: Buffer.from(prepared.credentialsBytes, "utf-8"),
          privateState: prepared.privateState,
          sha256: prepared.credentialsSha256,
        };
      },
      async readSharedAuthAdoption(adoptionInput: Parameters<typeof sharedAuth.inspect>[0]) {
        const frozen = structuredClone(adoptionInput);
        const observed = await sharedAuth.inspect(frozen);
        const authSchema = observed.resourceRecord.operator?.plan.authSchema;
        if (authSchema === undefined) {
          throw new HostedOperatorError("reconciliation_required");
        }
        const sourceOperator = observed.resourceRecord.operator;
        if (sourceOperator === undefined) {
          throw new HostedOperatorError("reconciliation_required");
        }
        describeHostedOperatorSharedGateway(sourceOperator.plan, sourceOperator.gatewayEnvironment);
        const artifacts = ownedArtifacts(observed.source);
        const artifact = await artifacts.publication.readAuthPlan(artifacts.context, authSchema);
        const current = await sharedAuth.inspect(frozen);
        if (!isDeepStrictEqual(observed.row, current.row)) {
          throw new HostedOperatorError("reconciliation_required");
        }
        return { adoption: observed.adoption, authSchema, content: artifact.content };
      },
      async readSharedGatewayRows(adoptionInput: Parameters<typeof sharedAuth.checkpoint>[0]) {
        const effect = {
          ...adoptionInput.effect,
          ...structuredClone({
            authority: adoptionInput.effect.authority,
            effect: adoptionInput.effect.effect,
            ownerContext: adoptionInput.effect.ownerContext,
            plan: adoptionInput.effect.plan,
            target: adoptionInput.effect.target,
          }),
        };
        const source = structuredClone(adoptionInput.source);
        const target = await readCurrentResourceCredentialRecord({
          assertAuthorized: owner.assertAuthorized,
          effect,
          store,
        });
        const active = readActiveHostedOperatorSharedAuth({
          ...effect,
          config: tokenKeyring,
          record: target,
        });
        if (active !== undefined) {
          const rows = effect.plan.authAdoption?.gatewayEnvironment;
          if (rows === undefined) {
            throw new HostedOperatorError("resource_mismatch");
          }
          const current = await readCurrentResourceCredentialRecord({
            assertAuthorized: owner.assertAuthorized,
            effect,
            store,
          });
          if (!sameSharedAuthTargetCheckpoint(current, target)) {
            throw new HostedOperatorError("operation_in_progress");
          }
          return { active: true, rows };
        }
        if (source === undefined) {
          throw new HostedOperatorError("reconciliation_required");
        }
        const observed = await sharedAuth.inspect({ context: effect, source });
        const { operator } = observed.resourceRecord;
        if (
          operator === undefined ||
          !isDeepStrictEqual(observed.adoption, effect.plan.authAdoption)
        ) {
          throw new HostedOperatorError("resource_mismatch");
        }
        const rows = assertHostedOperatorSharedGateway(
          effect.plan,
          operator.plan,
          operator.gatewayEnvironment,
        );
        const current = await readCurrentResourceCredentialRecord({
          assertAuthorized: owner.assertAuthorized,
          effect,
          store,
        });
        if (!sameSharedAuthTargetCheckpoint(current, target)) {
          throw new HostedOperatorError("operation_in_progress");
        }
        return { active: false, rows };
      },
      reserveRealmIdentityLink,
      async resolveRealmIdentityCallbackContext(callbackInput: {
        authority?: HostedOperatorContext["authority"];
        ownerSessionId: string;
        nonceSha256: string;
      }): Promise<HostedOperatorContext> {
        const { context } = await readCanonicalPendingIdentity(callbackInput);
        return context;
      },
      store,
      async verifySharedAuthAdoption(
        adoptionInput: Omit<Parameters<typeof sharedAuth.verify>[0], "verifyReadiness">,
      ) {
        return await sharedAuth.verify({
          ...adoptionInput,
          verifyReadiness: async (verificationInput) => {
            const readiness = createHostedOperatorAuthReadiness({
              assertAuthorized: owner.assertAuthorized,
              readAuthPlan: async (context) => {
                if (context.plan.authSchema === undefined) {
                  throw new HostedOperatorError("resource_mismatch");
                }
                const artifacts = ownedArtifacts(context);
                const artifact = await artifacts.publication.readAuthPlan(
                  artifacts.context,
                  context.plan.authSchema,
                );
                return artifact.content;
              },
              readRuntimeUrl: async () => {
                await verificationInput.assertCurrent();
                return verificationInput.runtimeUrl;
              },
            });
            return await readiness.verify(verificationInput);
          },
        });
      },
      withResourceLease,
    };
    const configuration = structuredClone(input.sourceConfiguration);
    const assertCurrentPlan: NormalActorOperationsDependencies["assertCurrentPlan"] = async (
      currentInput,
    ) => {
      await owner.assertArtifactAuthorized(currentInput);
      const snapshot = await store.read(currentInput);
      if (snapshot === undefined || snapshot.record.operator === undefined) {
        throw new HostedOperatorError("operation_in_progress");
      }
      const { operator } = snapshot.record;
      const planDigest = operatorPlanDigest(currentInput.plan);
      const samePlan = [
        operator.planDigest === planDigest,
        operator.planDigest === operatorPlanDigest(operator.plan),
        currentInput.operationRef === undefined ||
          operator.operationRef === currentInput.operationRef,
      ].every(Boolean);
      if (!samePlan) {
        throw new HostedOperatorError("operation_in_progress");
      }
      const approval = await readApproval({
        ...currentInput,
        action: currentInput.plan.action,
        callId: snapshot.record.approvedByCallId,
        planDigest,
      });
      const approved = [
        approval?.approved,
        approval?.approvalId === operator.approvalId,
        approval?.callId === snapshot.record.approvedByCallId,
        approval?.planDigest === planDigest,
        approval?.action === currentInput.plan.action,
      ].every(Boolean);
      if (!approved) {
        throw new HostedOperatorError("authorization_required");
      }
      await owner.assertArtifactAuthorized(currentInput);
      const latest = await store.read(currentInput);
      if (latest === undefined || latest.record.operator === undefined) {
        throw new HostedOperatorError("operation_in_progress");
      }
      const remainsApproved = [
        latest.record.operator.planDigest === planDigest,
        latest.record.operator.operationRef === operator.operationRef,
        latest.record.operator.approvalId === operator.approvalId,
        latest.record.approvedByCallId === snapshot.record.approvedByCallId,
      ].every(Boolean);
      if (!remainsApproved) {
        throw new HostedOperatorError("operation_in_progress");
      }
    };
    const normalRealmFetch: NormalActorOperationsDependencies["normalRealmFetch"] = async ({
      context,
      origin,
    }) =>
      await createHostedOperatorNormalAuthTransport(
        {
          configuration,
          context,
          origin,
          assertPlanningAuthorized: owner.assertPlanningAuthorized,
          assertCurrentOwner: owner.assertArtifactAuthorized,
        },
        { fetch: input.fetch },
      );
    const sharedNormalActorDependencies = {
      journalPorts: normalActorJournalPorts,
      assertCurrentPlan,
      normalRealmFetch,
    };
    // Only planning owner-proof collection can reuse settled Auth beneath an unfinished app plan.
    // Identity-link reservation and browser capture continue using readKnownAuthBootstrap above.
    const readParticipantBootstrapForPlanning = async (context: HostedOperatorContext) => {
      const owned = await owner.readCurrentPlanningOwner(context);
      if (["cancelled", "completed"].includes(owned.session.status)) {
        throw new HostedOperatorError("authorization_required");
      }
      const current = await store.read(context);
      const operator = current?.record.operator;
      if (current === undefined || operator?.plan.stage !== "app") {
        return await readKnownAuthBootstrap(context);
      }
      const bootstrap = inspectPlanningParticipantBootstrap(
        {
          ...operator.plan,
          gatewayDelivery: {
            branch: configuration.gateway.branch,
            gitSha: configuration.gateway.gitSha,
            projectId: configuration.gateway.projectId,
            repoId: configuration.gateway.repoId,
          },
        },
        current.record,
      );
      if (bootstrap === undefined) {
        throw new HostedOperatorError("auth_schema_not_ready");
      }
      await assertCompletedParticipantBootstrapApproval(context, bootstrap, readApproval);
      await owner.assertPlanningAuthorized(context);
      return { ...current, operator };
    };
    const assertParticipantBootstrapCurrent = async (
      context: HostedOperatorContext,
      preparation: NormalActorAccountPreparation,
      desired: HostedOperatorPlan,
      bootstrap: CompletedParticipantBootstrap,
    ) => {
      await owner.assertArtifactAuthorized(context);
      const accounts = await normalActorJournal.read(context);
      if (
        ![
          accounts?.preparation.accountOperationRef === preparation.accountOperationRef,
          accounts?.preparation.accountPlanDigest === preparation.accountPlanDigest,
          accounts?.preparation.programDigest === preparation.programDigest,
          accounts?.preparation.accountApprovalId === preparation.accountApprovalId,
          accounts?.preparation.accountApprovedByCallId === preparation.accountApprovedByCallId,
        ].every(Boolean)
      ) {
        throw new HostedOperatorError("auth_identity_required");
      }
      await assertCompletedParticipantBootstrapApproval(context, bootstrap, readApproval);
      const latest = await store.read(context);
      if (
        !isDeepStrictEqual(inspectPlanningParticipantBootstrap(desired, latest?.record), bootstrap)
      ) {
        throw new HostedOperatorError("operation_in_progress");
      }
      await owner.assertArtifactAuthorized(context);
    };
    const collectOrganizationOwnerProof = createHostedOperatorNormalActorProofCollector({
      journalPorts: normalActorJournalPorts,
      assertPlanningAuthorized: owner.assertPlanningAuthorized,
      normalRealmFetch,
      ownedArtifacts: async (context) => {
        await owner.assertArtifactAuthorized(context);
        return ownedArtifacts(context);
      },
      resolveRealmBinding: async ({ context, preparation }) => {
        const known = await readParticipantBootstrapForPlanning(context);
        // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Recheck original account approval and decrypt its AAD-bound state after selecting the planning bootstrap.
        const current = await normalActorJournal.read(context);
        const candidate = known.operator.gatewayDeliveryCandidates?.find(
          (entry) =>
            entry.deploymentId === known.operator.deliveredGatewayDeploymentId &&
            entry.readyState === "READY",
        );
        const boundary = preparation.accountPlan.deploymentBoundary;
        const bindings = preparation.accountPlan.gatewayBindings;
        const desired = {
          ...known.operator.plan,
          gatewayDelivery: {
            branch: configuration.gateway.branch,
            gitSha: configuration.gateway.gitSha,
            projectId: configuration.gateway.projectId,
            repoId: configuration.gateway.repoId,
          },
        };
        const bootstrap = inspectPlanningParticipantBootstrap(desired, known.record);
        if (
          current === undefined ||
          candidate === undefined ||
          boundary === undefined ||
          bindings === undefined
        ) {
          throw new HostedOperatorError("auth_identity_required");
        }
        const originalAccount =
          known.operator.operationRef === preparation.accountOperationRef &&
          known.operator.planDigest === preparation.accountPlanDigest &&
          candidate.origin === boundary.verification.gatewayOrigin;
        const samePreparation = [
          current.preparation.accountOperationRef === preparation.accountOperationRef,
          current.preparation.accountPlanDigest === preparation.accountPlanDigest,
          current.preparation.programDigest === preparation.programDigest,
          current.preparation.accountApprovalId === preparation.accountApprovalId,
          current.preparation.accountApprovedByCallId === preparation.accountApprovedByCallId,
          originalAccount || bootstrap !== undefined,
          (bootstrap?.auth.plan.gatewayBindings?.operatorOrigin ?? bindings.operatorOrigin) ===
            bindings.operatorOrigin,
        ].every(Boolean);
        if (!samePreparation) {
          throw new HostedOperatorError("auth_identity_required");
        }
        const assertBootstrapCurrent =
          bootstrap === undefined
            ? undefined
            : async () => {
                await assertParticipantBootstrapCurrent(context, preparation, desired, bootstrap);
              };
        await assertBootstrapCurrent?.();
        const transport = createHostedOperatorRealmHttpTransport(
          configuration,
          "operator",
          {
            fetch: input.fetch,
          },
          candidate.origin,
        );
        const resource = preparation.accountPlan.authDatabase;
        return {
          ...(bootstrap === undefined || assertBootstrapCurrent === undefined
            ? {}
            : { bootstrap, assertBootstrapCurrent }),
          audience: bindings.operatorOrigin,
          authResourceId: resource.resourceId,
          bootstrapPlanDigest: preparation.accountPlanDigest,
          builderCallbackOrigin: configuration.builderCallbackOrigin,
          endpointOrigin: candidate.origin,
          issuer: preparation.program.origin,
          resource: {
            version: 1,
            database: resource.database,
            environment: "preview",
            hostname: preparation.accountPlan.neon.endpoint,
            migratorRole: resource.migratorRole,
            runtimeRole: resource.runtimeRole,
            port: 5432,
            schema: "public",
            neon: {
              branchId: preparation.accountPlan.neon.branchId,
              projectId: preparation.accountPlan.neon.projectId,
            },
          },
          getKey: createRemoteJWKSet(new URL(`${candidate.origin}/_platform/jwks.json`), {
            [customFetch]: transport,
          }),
          readback: async (request) => await transport(request),
          transportSource: configuration.nativeNeon.configuration.operator,
        };
      },
    });
    const organizationWorkers = createNormalActorOrganizationWorkers({
      configuration,
      assertAuthorized: owner.assertAuthorized,
      readResourceBindings: async (effect) => await controlPlane.readResourceBindings(effect),
      readMembershipInspections: async (effect, selected) =>
        await readApprovedRetainedMembershipInspections({
          effect,
          organizationId: selected.organizationId,
          readApproval,
          readCurrentRecord: async () =>
            await readCurrentResourceCredentialRecord({
              assertAuthorized: owner.assertAuthorized,
              effect,
              store,
            }),
        }),
      readMembershipInspectionProof: async (effect, historical, selected) => {
        if (historical.plan.authMembership === undefined) {
          throw new HostedOperatorError("reconciliation_required");
        }
        const spec = selectHostedOperatorOwnedOrganizationSpec(historical.plan.authMembership, {
          organizationId: selected.organizationId,
        });
        const retained = await normalActorJournal.read(effect);
        if (retained === undefined) {
          throw new HostedOperatorError("reconciliation_required");
        }
        const expectedRef = `_protected-operator/artifacts/realm-identity-proof/${effect.target.appId}/${spec.identityProof.sha256}`;
        if (spec.identityProof.reference !== expectedRef) {
          throw new HostedOperatorError("reconciliation_required");
        }
        const artifacts = ownedArtifacts(effect);
        const content = await artifacts.store.read(artifacts.context, expectedRef, 0);
        if (content === undefined) {
          throw new HostedOperatorError("reconciliation_required");
        }
        const bytes = Buffer.from(content, "base64");
        const proof = bytes.toString("utf-8");
        if (
          bytes.length > 16_384 ||
          bytes.toString("base64") !== content ||
          !Buffer.from(proof, "utf-8").equals(bytes) ||
          createHash("sha256").update(bytes).digest("hex") !== spec.identityProof.sha256
        ) {
          throw new HostedOperatorError("reconciliation_required");
        }
        await owner.assertArtifactAuthorized(effect);
        await effect.assertCurrent();
        return { proof, preparation: retained.preparation };
      },
      readGeneratedRelease: async (context, release) => {
        await owner.assertArtifactAuthorized(context);
        const current = await store.read(context);
        const plan = current?.record.operator?.plan;
        if (plan === undefined || !isDeepStrictEqual(plan.release, release)) {
          throw new HostedOperatorError("resource_mismatch");
        }
        const selection = await controlPlane.readGeneratedSelection(
          context,
          plan.contextId,
          plan.release.artifactRef === undefined
            ? undefined
            : { artifactRef: plan.release.artifactRef },
        );
        const sameRelease = [
          selection !== undefined,
          selection?.releaseId === release.id,
          selection?.manifestSha256 === release.sha256,
          selection?.artifactRef === release.artifactRef,
        ].every(Boolean);
        if (!sameRelease || selection === undefined) {
          throw new HostedOperatorError("resource_mismatch");
        }
        return await controlPlane.readGeneratedRelease(context, selection);
      },
      readOrganizationProof: async (context, selected) => {
        const retained = await normalActorJournal.read(context);
        const declaredOrganization = retained?.preparation.program.organizations.find(
          (entry) => entry.organizationId === selected.organizationId,
        );
        const captured = retained?.preparation.organizationProofs?.find(
          (entry) => entry.organizationId === selected.organizationId,
        );
        if (
          retained === undefined ||
          declaredOrganization === undefined ||
          captured === undefined
        ) {
          throw new HostedOperatorError("auth_identity_required");
        }
        const spec = hostedOperatorOwnedOrganizationSpecSchema.parse({
          kind: "create-owned-organization",
          organizationId: declaredOrganization.organizationId,
          name: declaredOrganization.name,
          slug: declaredOrganization.slug,
          actorId: captured.owner.actorId,
          bootstrapPlanDigest: captured.link.bootstrapPlanDigest,
          identityCapture: {
            capturedAt: captured.link.consumedAt,
            realmSessionId: captured.owner.realmSessionId,
          },
          identityNonceSha256: captured.link.nonceSha256,
          identityProof: { reference: captured.link.proofRef, sha256: captured.link.proofSha256 },
          identityVerification: {
            audience: captured.link.audience,
            issuer: captured.link.issuer,
            jwksUrl: `${captured.link.endpointOrigin}/_platform/jwks.json`,
            transportSource: captured.transportSource,
          },
        });
        const artifacts = ownedArtifacts(context);
        const content = await artifacts.store.read(
          artifacts.context,
          spec.identityProof.reference,
          0,
        );
        if (content === undefined) {
          throw new HostedOperatorError("auth_identity_required");
        }
        const bytes = Buffer.from(content, "base64");
        const proof = bytes.toString("utf-8");
        const matches = [
          bytes.length <= 16_384,
          bytes.toString("base64") === content,
          Buffer.from(proof, "utf-8").equals(bytes),
          createHash("sha256").update(bytes).digest("hex") === spec.identityProof.sha256,
          captured.owner.actorId === selected.owner.actorId,
          captured.owner.realmSessionId === selected.owner.realmSessionId,
          captured.owner.reference === selected.owner.reference,
        ].every(Boolean);
        if (!matches) {
          throw new HostedOperatorError("resource_mismatch");
        }
        await owner.assertArtifactAuthorized(context);
        return { preparation: retained.preparation, spec, proof };
      },
    });
    const normalActors = createHostedOperatorNormalActorOperations({
      ...sharedNormalActorDependencies,
      assertPlanningAuthorized: owner.assertPlanningAuthorized,
      prepareActorCapture: async (capture) => await controlPlane.prepareNormalActorCapture(capture),
      collectOrganizationOwnerProof,
      ...organizationWorkers,
    });
    const exportStore = createPostgresTenantExportJournalStore(database);
    const exportSandbox = createTenantExportSandbox(configuration.sandbox);
    const exportLease = createPostgresPhysicalResourceLease({
      openLockClient: (onConnectionClosed) =>
        postgres(parseProtectedResourceLockDatabaseUrl(config.databaseUrl), {
          ...hostedRuntimePostgresOptions,
          idle_timeout: 0,
          max: 1,
          max_lifetime: 0,
          onclose: onConnectionClosed,
        }),
    });
    const exportPreparationObserver = (diagnostic?: {
      onPlanStage: ExportPlanningStageObserver;
      setup: boolean;
    }) => {
      const stages =
        diagnostic?.setup === true
          ? ({
              owner: "setup_owner_authorization",
              journal: "setup_journal_read",
              phase: "setup_phase_validation",
              approval: "setup_approval_authorization",
            } as const)
          : ({
              owner: "prepared_owner_authorization",
              journal: "prepared_journal_read",
              phase: "prepared_phase_validation",
              approval: "prepared_approval_authorization",
            } as const);
      return (key: keyof typeof stages) => {
        advanceExportPlanningStage(diagnostic?.onPlanStage, stages[key]);
      };
    };
    const preparedForExport = async (
      context: HostedOperatorContext,
      catchUpApproval = false,
      retainedApproval?: {
        operationRef: string;
        planDigest: string;
        approvalId: string;
        approvedByCallId: string;
      },
      diagnostic?: { onPlanStage: ExportPlanningStageObserver; setup: boolean },
    ) => {
      const observe = exportPreparationObserver(diagnostic);
      observe("owner");
      await owner.assertArtifactAuthorized(context);
      observe("journal");
      const current = await store.read(context);
      const operator = current?.record.operator;
      observe("phase");
      if (operator === undefined || current === undefined || current.record.status !== "prepared") {
        throw new HostedOperatorError("operation_in_progress");
      }
      if (
        operator.plan.action !== "prepare" ||
        (operator.plan.stage !== undefined && operator.plan.stage !== "app")
      ) {
        throw new HostedOperatorError("authorization_required");
      }
      requireFinalResourceBindingPhase(current, {
        plan: operator.plan,
        privateState: current.record.privateState,
      });
      observe("approval");
      if (
        retainedApproval !== undefined &&
        isDeepStrictEqual(retainedApproval, {
          operationRef: operator.operationRef,
          planDigest: operator.planDigest,
          approvalId: operator.approvalId,
          approvedByCallId: current.record.approvedByCallId,
        })
      ) {
        return { current, operator };
      }
      const ownerContext = operatorOwnerContextSchema.parse(context.ownerContext);
      let approvedId: string | undefined;
      if (catchUpApproval) {
        const approval = await readApproval({
          ...context,
          action: "prepare",
          callId: current.record.approvedByCallId,
          planDigest: operator.planDigest,
        });
        if (approval?.approved) {
          approvedId = approval.approvalId;
        }
      } else {
        const receipt = await readPrivateHostedApproval({
          store: eve,
          principal: ownerContext.principal,
          sessionId: ownerContext.sessionId,
          action: "prepare",
          callId: current.record.approvedByCallId,
          planDigest: operator.planDigest,
          selection: operator.plan.selection,
          requestId: operator.approvalId,
        });
        if (
          receipt?.outcome === "approved" &&
          receipt.responderPrincipalId === ownerContext.principal.ownerUserId &&
          receipt.toolInput.operationRef === operator.operationRef
        ) {
          approvedId = receipt.requestId;
        }
      }
      if (approvedId === undefined || approvedId !== operator.approvalId) {
        throw new HostedOperatorError("authorization_required");
      }
      return { current, operator };
    };
    const resolveExportPlan = async (
      context: HostedOperatorContext,
      customerId: string,
      verifyRelease = false,
      onPlanStage?: ExportPlanningStageObserver,
    ) => {
      advanceExportPlanningStage(onPlanStage, "worker_configuration");
      if (configuration.sandbox.exportWorker === undefined) {
        throw new HostedOperatorError("protected_operator_required");
      }
      const { current, operator } = await preparedForExport(
        context,
        true,
        undefined,
        onPlanStage === undefined ? undefined : { onPlanStage, setup: false },
      );
      const plan = operator.plan;
      advanceExportPlanningStage(onPlanStage, "customer_authorization");
      assertTenantExportCustomer(plan, customerId);
      advanceExportPlanningStage(onPlanStage, "release_selection");
      const ownedRelease = ownedArtifacts(context);
      if (plan.release.artifactRef === undefined) {
        throw new HostedOperatorError("resource_mismatch");
      }
      const selected = await ownedRelease.selections.readExact?.(ownedRelease.context, {
        appSpecDigest: plan.contextId,
        artifactRef: plan.release.artifactRef,
      });
      advanceExportPlanningStage(onPlanStage, "release_match");
      if (
        selected === undefined ||
        selected.releaseId !== plan.release.id ||
        selected.manifestSha256 !== plan.release.sha256 ||
        selected.artifactRef !== plan.release.artifactRef
      ) {
        throw new HostedOperatorError("resource_mismatch");
      }
      if (verifyRelease) {
        advanceExportPlanningStage(onPlanStage, "release_read");
        await controlPlane.readGeneratedRelease(context, selected);
      }
      advanceExportPlanningStage(onPlanStage, "prepared_approval_authorization");
      if (operator.approvalId === undefined) {
        throw new HostedOperatorError("authorization_required");
      }
      return {
        version: 1 as const,
        kind: "tenant-export-plan" as const,
        authority: context.authority,
        target: {
          sessionId: context.target.sessionId,
          appId: context.target.appId,
          projectId: context.target.projectId,
          branch: context.target.branch,
        },
        originalSetup: {
          operationRef: operator.operationRef,
          planDigest: operator.planDigest,
          approvalId: operator.approvalId,
          approvedByCallId: current.record.approvedByCallId,
        },
        scope: { appId: plan.selection.appId, customerId },
        resource: {
          projectId: plan.neon.projectId,
          branchId: plan.neon.branchId,
          resourceId: plan.appDatabase.resourceId,
          environment: plan.selection.environment,
          hostname: plan.neon.endpoint,
          port: 5432,
          database: plan.appDatabase.database,
          schema: "public" as const,
          migratorRole: plan.appDatabase.migratorRole,
          runtimeRole: plan.appDatabase.runtimeRole,
        },
        release: {
          id: selected.releaseId,
          artifactHash: selected.schemaSha256,
          manifestRef: selected.artifactRef,
          manifestSha256: selected.manifestSha256,
        },
        selection: "public-app-customer-tables-v1" as const,
        format: "ndjson" as const,
      };
    };
    const assertExportSetup = async (
      context: HostedOperatorContext,
      plan: HostedTenantExportPlan,
      onPlanStage?: ExportPlanningStageObserver,
    ) => {
      const { current, operator } = await preparedForExport(
        context,
        false,
        undefined,
        onPlanStage === undefined ? undefined : { onPlanStage, setup: true },
      );
      const prepared = operator.plan;
      advanceExportPlanningStage(onPlanStage, "setup_customer_authorization");
      assertTenantExportCustomer(prepared, plan.scope.customerId);
      const observedSetup = {
        operationRef: operator.operationRef,
        planDigest: operator.planDigest,
        approvalId: operator.approvalId,
        approvedByCallId: current.record.approvedByCallId,
      };
      const observedResource = {
        projectId: prepared.neon.projectId,
        branchId: prepared.neon.branchId,
        resourceId: prepared.appDatabase.resourceId,
        environment: prepared.selection.environment,
        hostname: prepared.neon.endpoint,
        port: 5432,
        database: prepared.appDatabase.database,
        schema: "public",
        migratorRole: prepared.appDatabase.migratorRole,
        runtimeRole: prepared.appDatabase.runtimeRole,
      };
      advanceExportPlanningStage(onPlanStage, "setup_match");
      const comparisons = [
        isDeepStrictEqual(observedSetup, plan.originalSetup),
        isDeepStrictEqual(observedResource, plan.resource),
        prepared.release.id === plan.release.id,
        prepared.release.sha256 === plan.release.manifestSha256,
        prepared.release.artifactRef === plan.release.manifestRef,
        prepared.selection.appId === plan.scope.appId,
      ];
      if (!comparisons.every(Boolean)) {
        const failureStages = [
          "setup_match_original_setup",
          "setup_match_resource",
          "setup_match_release_id",
          "setup_match_release_manifest",
          "setup_match_release_ref",
          "setup_match_app",
        ] as const;
        const failedStage = failureStages[comparisons.indexOf(false)];
        if (failedStage !== undefined) {
          advanceExportPlanningStage(onPlanStage, failedStage);
        }
        throw new HostedOperatorError("resource_mismatch");
      }
    };
    const exportArtifacts = (context: HostedOperatorContext) => {
      const owned = ownedArtifacts(context);
      return {
        context: owned.context,
        artifacts: createTenantExportArtifacts({
          store: owned.store,
          assertCurrentOwner: async (requested) => {
            if (!isDeepStrictEqual(requested, owned.context)) {
              throw new HostedOperatorError("authorization_required");
            }
            await owner.assertArtifactAuthorized(context);
          },
        }),
      };
    };
    const exports = createHostedTenantExportOperations({
      store: exportStore,
      assertOwner: owner.assertArtifactAuthorized,
      resolvePlan: async (context, customerId, onPlanStage) =>
        await resolveExportPlan(context, customerId, true, onPlanStage),
      assertSetup: assertExportSetup,
      async readApproval(context, request, callId, observation) {
        await owner.assertArtifactAuthorized(context);
        const recorded = await exportStore.read({
          authority: context.authority,
          exportId: z.uuid().parse(request.planRef.split("/").at(-1)),
        });
        if (recorded === undefined) {
          throw new HostedOperatorError("resource_mismatch");
        }
        const ownerContext = operatorOwnerContextSchema.parse(context.ownerContext);
        return await readPrivateOperatorApproval({
          owner: ownerContext,
          ...(observation === undefined ? {} : { observation }),
          capture: (state) =>
            createPrivateTenantExportApprovalCapture({
              plan: recorded.journal.plan,
              request,
              principal: ownerContext.principal,
              ...(callId === undefined ? {} : { callId }),
              ...(state === undefined ? {} : { state }),
            }),
          readHistory: async (startIndex, onEvent) =>
            await approvalObserver.privateHistoryForContext(context)({
              adapterSessionId: ownerContext.adapterSessionId,
              sessionId: ownerContext.sessionId,
              principal: ownerContext.principal,
              startIndex,
              onEvent,
            }),
          assertOwner: async () => {
            await owner.assertArtifactAuthorized(context);
          },
        });
      },
      withResourceLease: exportLease,
      disposeWorker: async (locator) => {
        await exportSandbox.dispose(locator);
      },
      async inspect(context, worker, locator, assertCurrent) {
        const owned = exportArtifacts(context);
        const artifact = await owned.artifacts.inspect({ context: owned.context, worker });
        if (artifact.status !== "incomplete") {
          return artifact;
        }
        const observed = await exportSandbox.inspect(worker, locator);
        if (observed.status !== "terminal") {
          return { status: "unknown" };
        }
        if (observed.source === undefined) {
          return { status: "incomplete", workerTerminal: true };
        }
        try {
          const completion = await owned.artifacts.publish({
            context: owned.context,
            worker,
            source: observed.source,
            assertCurrent,
          });
          return { status: "complete", completion };
        } catch {
          return { status: "unknown" };
        }
      },
      async prepareWorker(_context, worker, assertCurrent) {
        return await exportSandbox.prepare(worker, assertCurrent);
      },
      async runWorker(context, worker, locator, assertCurrent, checkpoint) {
        await assertCurrent();
        const { current, operator } = await preparedForExport(context);
        const bindings = await controlPlane.readResourceBindings({
          ...context,
          plan: operator.plan,
          privateState: current.record.privateState,
        });
        await assertCurrent();
        return await exportSandbox.run(
          worker,
          locator,
          bindings.appDatabase.migrationUrl,
          assertCurrent,
          checkpoint,
        );
      },
      async publish(context, worker, source, assertCurrent) {
        const owned = exportArtifacts(context);
        return await owned.artifacts.publish({
          context: owned.context,
          worker,
          source,
          assertCurrent,
        });
      },
    });
    const exportRequest = createTenantExportDispatcher({
      store: exportStore,
      operations: exports,
      bindWorkload: approvalObserver.bindWorkload,
      verifyWorkload: owner.verifyWorkload,
      authorize: owner.authorize,
      authorizeRead: owner.authorizeArtifactRead,
      async resolveOwnerOrganization(context) {
        const { current, operator } = await preparedForExport(context, true);
        const { plan } = operator;
        const preparedOwner = operatorOwnerContextSchema.parse(context.ownerContext);
        // Resolve keys only through this currently prepared Realm's trusted Gateway,
        // never through a URL/issuer supplied by the historical JWT.
        const gateway = operator.gatewayDeliveryCandidates?.find(
          (candidate) =>
            candidate.deploymentId === operator.deliveredGatewayDeploymentId &&
            candidate.projectId === plan.gatewayDelivery?.projectId &&
            candidate.readyState === "READY",
        );
        const origin = gateway?.origin ?? plan.deploymentBoundary?.verification.gatewayOrigin;
        if (origin === undefined) {
          throw new HostedOperatorError("export_customer_selection_required");
        }
        const transport = createHostedOperatorRealmHttpTransport(
          configuration,
          "operator",
          { fetch: input.fetch },
          origin,
        );
        const getKey = createRemoteJWKSet(new URL("/_platform/jwks.json", origin), {
          [customFetch]: transport,
        });
        const assertCurrent = async () => {
          await owner.assertArtifactAuthorized(context);
          const fresh = await store.read(context);
          const active = fresh?.record.operator;
          const samePrepared = [
            fresh?.record.status === "prepared",
            fresh?.record.approvedByCallId === current.record.approvedByCallId,
            active?.operationRef === operator.operationRef,
            active?.approvalId === operator.approvalId,
            active?.planDigest === operator.planDigest,
            active !== undefined && operatorPlanDigest(active.plan) === operator.planDigest,
          ].every(Boolean);
          if (!samePrepared) {
            throw new HostedOperatorError("operation_in_progress");
          }
        };
        // Original terminal settlements are immutable facts. Cache this actual
        // canonical accessor only within this planning call; live owner checks do not use it.
        let approvalSession: ReturnType<typeof eve.getSession> | undefined;
        const approvalStore = {
          getSession: (principal: Parameters<typeof eve.getSession>[0], sessionId: string) => {
            if (
              !samePrincipal(principal, preparedOwner.principal) ||
              sessionId !== context.target.sessionId
            ) {
              throw new HostedOperatorError("authorization_required");
            }
            approvalSession ??= eve.getSession(principal, sessionId);
            return approvalSession;
          },
        };
        const proofCache = new Map<string, Promise<string>>();
        const artifacts = ownedArtifacts(context);
        return await resolveExportOwnerOrganization({
          context,
          prepared: plan,
          assertCurrent,
          readCurrentRecord: async () => {
            const fresh = await store.read(context);
            if (fresh === undefined) {
              throw new HostedOperatorError("resource_mismatch");
            }
            return fresh.record;
          },
          readApproval: async (witness) => {
            const receipt = await readPrivateHostedApproval({
              store: approvalStore,
              principal: preparedOwner.principal,
              sessionId: context.target.sessionId,
              callId: witness.approvedByCallId,
              action: "prepare",
              planDigest: witness.operator.planDigest,
              selection: witness.operator.plan.selection,
              requestId: witness.operator.approvalId,
            });
            return [
              receipt?.outcome === "approved",
              receipt?.requestId === witness.operator.approvalId,
              receipt?.responderPrincipalId === preparedOwner.principal.ownerUserId,
              receipt?.toolInput.operationRef === witness.operator.operationRef,
              receipt !== null && isDeepStrictEqual(receipt.toolInput.plan, witness.operator.plan),
            ].every(Boolean);
          },
          verifyProof: async (witness) => {
            const { reference, sha256 } = witness.membership.identityProof;
            const expected = `_protected-operator/artifacts/realm-identity-proof/${context.target.appId}/${sha256}`;
            if (reference !== expected) {
              throw new HostedOperatorError("resource_mismatch");
            }
            let proof = proofCache.get(reference);
            if (proof === undefined) {
              proof = (async () => {
                const content = await artifacts.store.read(artifacts.context, expected, 0);
                if (content === undefined) {
                  throw new HostedOperatorError("auth_identity_required");
                }
                const bytes = Buffer.from(content, "base64");
                const text = bytes.toString("utf-8");
                if (
                  bytes.length > 16_384 ||
                  bytes.toString("base64") !== content ||
                  !Buffer.from(text, "utf-8").equals(bytes) ||
                  createHash("sha256").update(bytes).digest("hex") !== sha256
                ) {
                  throw new HostedOperatorError("auth_identity_required");
                }
                return text;
              })();
              proofCache.set(reference, proof);
            }
            return await verifyCapturedRealmIdentityProof({
              proof: await proof,
              pending: witness.link,
              getKey,
              resource: {
                version: 1,
                database: plan.authDatabase.database,
                environment: "preview",
                hostname: plan.neon.endpoint,
                migratorRole: plan.authDatabase.migratorRole,
                runtimeRole: plan.authDatabase.runtimeRole,
                port: 5432,
                schema: "public",
                neon: { branchId: plan.neon.branchId, projectId: plan.neon.projectId },
              },
            });
          },
        });
      },
    });
    // This request-private association contains only the exact carrier already verified by
    // the dispatcher. No token enters the journal, model, worker files or app environment.
    const continuityWorkloads = new WeakMap<
      HostedOperatorContext,
      { token: () => string; signal: AbortSignal }
    >();
    const continuityStore = createPostgresContinuityJournalStore(database);
    const continuitySetupApprovals = new WeakMap<
      HostedOperatorContext,
      { operationRef: string; planDigest: string; approvalId: string; approvedByCallId: string }
    >();
    const preparedForContinuity = async (context: HostedOperatorContext, catchUp = false) => {
      const prepared = await preparedForExport(
        context,
        catchUp,
        continuitySetupApprovals.get(context),
      );
      if (prepared.operator.approvalId === undefined) {
        throw new HostedOperatorError("authorization_required");
      }
      continuitySetupApprovals.set(context, {
        operationRef: prepared.operator.operationRef,
        planDigest: prepared.operator.planDigest,
        approvalId: prepared.operator.approvalId,
        approvedByCallId: prepared.current.record.approvedByCallId,
      });
      return prepared;
    };
    const normalRuntime = createNormalActorRuntimeBindings(sharedNormalActorDependencies);
    const assertSelectedSandbox = async (
      context: HostedOperatorContext,
      selection: ContinuityRuntimeSelection,
    ) => {
      await owner.assertSandboxAuthorized(context, selection.sandboxId);
    };
    const continuitySetup = async (context: HostedOperatorContext, plan: HostedContinuityPlan) => {
      const { current, operator } = await preparedForContinuity(context);
      if (
        !isDeepStrictEqual(
          {
            operationRef: operator.operationRef,
            planDigest: operator.planDigest,
            approvalId: operator.approvalId,
            approvedByCallId: current.record.approvedByCallId,
          },
          plan.originalSetup,
        ) ||
        !isDeepStrictEqual(operator.plan, {
          ...plan.preparedPlan,
          gatewayDelivery: operator.plan.gatewayDelivery,
        }) ||
        plan.runtime.projectId !== configuration.workloadPolicy.projectId ||
        plan.runtime.ownerId !== configuration.workloadPolicy.ownerId
      ) {
        throw new HostedOperatorError("resource_mismatch");
      }
    };
    const getContinuitySandbox = async (
      context: HostedOperatorContext,
      selected: ContinuityRuntimeSelection,
    ) => {
      const workload = continuityWorkloads.get(context);
      if (workload === undefined) {
        throw new HostedOperatorError("authorization_required");
      }
      return await Sandbox.get({
        name: selected.sandboxId,
        resume: true,
        token: workload.token(),
        fetch: createHostedOperatorSandboxFetch(workload.token),
        projectId: configuration.workloadPolicy.projectId,
        teamId: configuration.workloadPolicy.ownerId,
        signal: workload.signal,
      });
    };
    const continuityWorkerAsset = createManagedRuntimeWorkerAsset({
      configuration: configuration.sandbox,
    });
    const continuityRuntime = createManagedRuntimeExecution({
      installWorkerAsset: async (assetInput) => {
        await continuityWorkerAsset.install(assetInput);
      },
      disposeWorkerAsset: async (assetInput) => {
        await continuityWorkerAsset.dispose(assetInput);
      },
      worker: configuration.sandbox.managedRuntimeWorker,
      assertSelectedSandbox,
      getSandbox: getContinuitySandbox,
      signal: (context) => continuityWorkloads.get(context)?.signal,
      async readExecution(context, plan, includeActors) {
        await continuitySetup(context, plan);
        const { current, operator } = await preparedForContinuity(context);
        const boundary = operator.plan.deploymentBoundary;
        const proof = current.record.proof;
        if (boundary === undefined || proof === undefined) {
          throw new HostedOperatorError("resource_mismatch");
        }
        const bindings = await controlPlane.readResourceBindings({
          ...context,
          plan: operator.plan,
          privateState: current.record.privateState,
        });
        const runtimeEnvironment = restrictedOperatorEnvironment(
          operator.plan,
          {
            [`${context.target.appId.toUpperCase().replaceAll("-", "_")}_DATABASE_URL`]:
              bindings.appDatabase.runtimeUrl,
            PLATFORM_JWKS_URL: boundary.verification.jwksUrl,
            PLATFORM_ORIGIN: boundary.verification.gatewayOrigin,
            PLATFORM_PUBLIC_ORIGIN: boundary.verification.publicOrigin,
          },
          context.authority,
        );
        return {
          environment: runtimeEnvironment,
          proof,
          ...(includeActors === true
            ? {
                normalActors: await normalRuntime({
                  ...context,
                  plan: operator.plan,
                  operationRef: operator.operationRef,
                }),
              }
            : {}),
        };
      },
      async readPublicJwks(context, url) {
        const transport = await normalRealmFetch({ context, origin: new URL(url).origin });
        const response = await transport(url, { method: "GET", redirect: "error" });
        if (!response.ok) {
          throw new HostedOperatorError("operator_unavailable");
        }
        const value: unknown = await response.json();
        return value;
      },
    });
    const continuities = createHostedContinuityOperations({
      store: continuityStore,
      assertOwner: owner.assertArtifactAuthorized,
      assertSetup: continuitySetup,
      async resolvePlan(context, runtime) {
        if (configuration.sandbox.managedRuntimeWorker === undefined) {
          throw new HostedOperatorError("protected_operator_required");
        }
        const [{ current, operator }] = await Promise.all([
          observeContinuityPlanningStage(context.target.sessionId, "prepared_runtime", () =>
            preparedForContinuity(context, true),
          ),
          observeContinuityPlanningStage(context.target.sessionId, "sandbox_authorization", () =>
            assertSelectedSandbox(context, runtime),
          ),
        ]);
        // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Verify canonical VM ownership and completed setup before resuming it for planning.
        const selectedSandbox = await observeContinuityPlanningStage(
          context.target.sessionId,
          "sandbox_resume",
          () => getContinuitySandbox(context, runtime),
          undefined,
          continuityWorkloads.get(context)?.signal,
        );
        const observedPorts = await observeContinuityPlanningStage(
          context.target.sessionId,
          "port_observation",
          () => observeManagedRuntimePorts(selectedSandbox),
        );
        if (operator.approvalId === undefined) {
          throw new HostedOperatorError("authorization_required");
        }
        const preparedPlan = structuredClone(operator.plan);
        preparedPlan.gatewayDelivery = {
          projectId: configuration.gateway.projectId,
          branch: configuration.gateway.branch,
          gitSha: configuration.gateway.gitSha,
          repoId: configuration.gateway.repoId,
        };
        return {
          version: 1,
          kind: "app-continuity-plan",
          authority: context.authority,
          target: context.target,
          originalSetup: {
            operationRef: operator.operationRef,
            planDigest: operator.planDigest,
            approvalId: operator.approvalId,
            approvedByCallId: current.record.approvedByCallId,
          },
          preparedPlan,
          runtime: {
            ...runtime,
            projectId: configuration.workloadPolicy.projectId,
            ownerId: configuration.workloadPolicy.ownerId,
            ...observedPorts,
          },
          gateway: {
            projectId: configuration.gateway.projectId,
            ownerId: configuration.teamId,
            environment: "preview",
            publicOrigin: configuration.gateway.publicOrigin,
          },
          actors: operator.plan.access.map(({ actorId, organizationId }) => ({
            actorId,
            organizationId,
          })),
        };
      },
      async readApproval(context, request, callId, observation) {
        await owner.assertArtifactAuthorized(context);
        const saved = await continuityStore.read({
          authority: context.authority,
          intentId: z.uuid().parse(request.planRef.split("/").at(-1)),
        });
        if (saved === undefined) {
          throw new HostedOperatorError("resource_mismatch");
        }
        const canonical = operatorOwnerContextSchema.parse(context.ownerContext);
        return await readPrivateOperatorApproval({
          owner: canonical,
          ...(observation === undefined ? {} : { observation }),
          capture: (state) =>
            createPrivateContinuityApprovalCapture({
              plan: saved.plan,
              request,
              principal: canonical.principal,
              ...(callId === undefined ? {} : { callId }),
              ...(state === undefined ? {} : { state }),
            }),
          readHistory: async (startIndex, onEvent) =>
            await approvalObserver.privateHistoryForContext(context)({
              adapterSessionId: canonical.adapterSessionId,
              sessionId: canonical.sessionId,
              principal: canonical.principal,
              startIndex,
              onEvent,
            }),
          assertOwner: async () => {
            await owner.assertArtifactAuthorized(context);
          },
        });
      },
      ...createContinuityCapabilityCustody(tokenKeyring),
      withResourceLease: exportLease,
      runtime: continuityRuntime,
      projection: createHostedManagedRuntimeProjection({
        assertOwner: owner.assertArtifactAuthorized,
        readCredential: controlPlane.readCredential,
        fetch: input.fetch,
      }),
    });
    const continuityRequest = createContinuityDispatcher({
      store: continuityStore,
      operations: continuities,
      verifyWorkload: owner.verifyWorkload,
      authorize: owner.authorize,
      authorizeRead: owner.authorizeArtifactRead,
      bindWorkload: (context, token, signal) => {
        continuityWorkloads.set(context, { token, signal });
        approvalObserver.bindWorkload(context, token, signal);
      },
    });
    const nativeTargetRequest = createNativeTargetOnboardingDeployment({
      database,
      configuration: input.sourceConfiguration,
      environment,
      owner,
      builderOrigin: new URL(config.resource).origin,
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    });
    const nativeTargetPort: Pick<ProtectedHostedOperatorDependencies, "nativeTargetRequest"> = {
      nativeTargetRequest,
    };
    return {
      ...controlPlane,
      ...normalActors,
      ...nativeTargetPort,
      exportRequest,
      continuityRequest,
      readNormalActorRuntimeBindings: createNormalActorRuntimeBindings(
        sharedNormalActorDependencies,
      ),
    };
  };
  try {
    return compose();
  } catch (error) {
    await controlPlaneClient.end({ timeout: 5 });
    throw error;
  }
};
