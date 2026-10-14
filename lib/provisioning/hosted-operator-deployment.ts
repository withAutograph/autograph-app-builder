import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
/* oxlint-disable sonarjs/no-nested-functions -- Owner authorization and journal CAS closures share the actual opened private database. */
import postgres from "postgres";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { z } from "zod";
import { createNormalActorJournal } from "./hosted-operator-normal-actor-journal";
import type { NormalActorAccountPreparation } from "./hosted-operator-normal-actor-journal";
import { createRealmIdentityBrowserUrl } from "./hosted-operator-auth-identity";
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
import { createVercelWorkloadIdentity } from "../eve/vercel-workload-identity";
import { parseHostedSessionRow, createPostgresHostedEveStore } from "../eve/postgres-hosted-store";
import { createSameOriginEveTransport } from "../eve/same-origin-http";
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
} from "./hosted-operator-owner";
import { createHostedOperatorOwnerContextResolver } from "./hosted-operator-owner-context";
import type { HostedOperatorContext, HostedOperatorEffectContext } from "./hosted-operator-service";
import {
  HostedOperatorError,
  operatorPlanDigest,
  operatorRealmIdentityLinkSchema,
  projectPendingRealmIdentityLink,
  selectHostedOperatorOwnedOrganizationSpec,
  retainedOperatorAuthSchema,
} from "./hosted-operator-contract";
import {
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

const requireCurrentResourceCredentialRecord = (
  record: HostedRuntimeJournalRecord | undefined,
  input: ResourceCredentialEffect,
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
  if (input.workerAttemptId !== undefined) {
    if (
      operator.pendingEffectId !== input.effect.id ||
      operator.pendingEffectAttempt?.id !== input.workerAttemptId
    ) {
      throw new HostedOperatorError("operation_in_progress");
    }
  } else if (
    (operator.pendingEffectId !== undefined || operator.pendingEffectAttempt !== undefined) &&
    (operator.pendingEffectId !== input.effect.id || operator.pendingEffectAttempt === undefined)
  ) {
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
  store: HostedRuntimeJournalStore;
}) => {
  await input.assertAuthorized(input.effect);
  await input.effect.assertCurrent();
  const current = await input.store.read(input.effect);
  return requireCurrentResourceCredentialRecord(current?.record, input.effect);
};

type ResourceBindingContext = HostedOperatorContext & {
  plan: ResourceCredentialEffect["plan"];
  privateState?: HostedRuntimeJournalRecord["privateState"];
};

const requireFinalResourceBindingPhase = (
  row: HostedRuntimeJournalRow | undefined,
  input: ResourceBindingContext,
) => {
  if (row === undefined || row.record.operator === undefined) {
    throw new HostedOperatorError("operation_in_progress");
  }
  const { record } = row;
  const { operator } = row.record;
  if (
    operator.plan.action !== "prepare" ||
    input.plan.action !== "prepare" ||
    operator.approvalId === undefined
  ) {
    throw new HostedOperatorError("authorization_required");
  }
  if (
    operator.fenceGeneration === undefined ||
    operator.pendingEffectId !== undefined ||
    operator.pendingEffectAttempt !== undefined
  ) {
    throw new HostedOperatorError("operation_in_progress");
  }
  if (
    operator.planDigest !== operatorPlanDigest(input.plan) ||
    operator.planDigest !== operatorPlanDigest(operator.plan)
  ) {
    throw new HostedOperatorError("resource_mismatch");
  }
  const complete = operator.plan.effects.every((effect) =>
    operator.receipts.some(
      (receipt) =>
        receipt.effectId === effect.id &&
        (effect.kind !== "access" || receipt.fenceGeneration === operator.fenceGeneration),
    ),
  );
  if (!complete || JSON.stringify(input.privateState) !== JSON.stringify(record.privateState)) {
    throw new HostedOperatorError("operation_in_progress");
  }
  const leasedFinalVerification =
    record.status === "pending" &&
    record.leaseId !== undefined &&
    record.leaseExpiresAt !== undefined &&
    Date.parse(record.leaseExpiresAt) > Date.now();
  const preparedRead =
    record.status === "prepared" && record.step === "bound" && record.leaseId === undefined;
  if (!leasedFinalVerification && !preparedRead) {
    throw new HostedOperatorError("operation_in_progress");
  }
  return row;
};

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

export const createHostedOperatorControlPlane = async (input: {
  environment?: Readonly<Record<string, string | undefined>>;
  workloadPolicy: OperatorWorkloadPolicy;
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
    const eveObserver = createSameOriginEveTransport({
      config: { baseUrl: new URL(config.resource).origin },
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
    if (eveObserver.observe === undefined) {
      throw new Error("Protected operator approval observation is unavailable.");
    }
    const readApproval = createHostedOperatorReadApproval({
      eve,
      journal: store,
      observe: eveObserver.observe,
    });
    const withResourceLease = createPostgresHostedOperatorResourceLease({
      openLockClient: (onConnectionClosed) =>
        postgres(parseHostedDatabaseUrl(config.databaseUrl), {
          ...hostedRuntimePostgresOptions,
          max: 1,
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

    return {
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
          `${link?.endpointOrigin}/_platform/jwks.json` ===
            capturedMembership.identityVerification.jwksUrl,
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
        if (JSON.stringify(acknowledged.privateState) !== JSON.stringify(prepared.privateState)) {
          throw new HostedOperatorError("operation_in_progress");
        }
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
      async readGeneratedSelection(context: HostedOperatorContext, appSpecDigest: string) {
        const artifacts = ownedArtifacts(context);
        return await artifacts.selections.read(artifacts.context, appSpecDigest);
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
          const record = await readCurrentResourceCredentialRecord({
            assertAuthorized: owner.assertAuthorized,
            effect: effectInput,
            store,
          });
          const bindings = readHostedOperatorResourceBindings({
            ...effectInput,
            config: tokenKeyring,
            record,
          });
          const current = await readCurrentResourceCredentialRecord({
            assertAuthorized: owner.assertAuthorized,
            effect: effectInput,
            store,
          });
          if (JSON.stringify(current.privateState) !== JSON.stringify(record.privateState)) {
            throw new HostedOperatorError("operation_in_progress");
          }
          return bindings;
        }
        await owner.assertAuthorized(effectInput);
        const current = requireFinalResourceBindingPhase(
          await store.read(effectInput),
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
        const latest = requireFinalResourceBindingPhase(await store.read(effectInput), effectInput);
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
  };
  try {
    return compose();
  } catch (error) {
    await controlPlaneClient.end({ timeout: 5 });
    throw error;
  }
};
