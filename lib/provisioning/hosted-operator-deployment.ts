import { createHash, randomBytes } from "node:crypto";
/* oxlint-disable sonarjs/no-nested-functions -- Owner authorization and journal CAS closures share the actual opened private database. */
import postgres from "postgres";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { z } from "zod";
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
} from "./hosted-operator-contract";
import {
  prepareHostedOperatorResourceCredentials,
  readHostedOperatorResourceBindings,
} from "./hosted-operator-resource-credentials";
import type { ProtectedResourceDatabase } from "./hosted-operator-resource-credentials";
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
      handoffs,
      listVercelInstallations: async (authority) => await installations.list(authority),
      fetch: input.fetch,
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
        await owner.assertPlanningAuthorized(context);
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

    const readKnownAuthBootstrap = async (context: HostedOperatorContext) => {
      const owned = await owner.readCurrentPlanningOwner(context);
      if (["cancelled", "completed"].includes(owned.session.status)) {
        throw new HostedOperatorError("authorization_required");
      }
      const current = await store.read(context);
      const operator = current?.record.operator;
      const ready = [
        operator !== undefined,
        operator?.plan.stage === "auth-bootstrap",
        operator?.authPreparation !== undefined,
        operator?.pendingEffectId === undefined,
        operator?.pendingEffectAttempt === undefined,
        current?.record.leaseId === undefined,
        operator?.plan.effects.every((effect) =>
          operator.receipts.some((receipt) => receipt.effectId === effect.id),
        ) === true,
      ].every(Boolean);
      if (!ready || operator === undefined || current === undefined) {
        throw new HostedOperatorError("auth_schema_not_ready");
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
    }) => {
      const known = await readKnownAuthBootstrap(linkInput.context);
      if (
        known.operator.planDigest !== linkInput.bootstrapPlanDigest ||
        known.operator.plan.authDatabase.resourceId !== linkInput.authResourceId
      ) {
        throw new HostedOperatorError("resource_mismatch");
      }
      const link = operatorRealmIdentityLinkSchema.parse({
        audience: linkInput.audience,
        authResourceId: linkInput.authResourceId,
        bootstrapPlanDigest: linkInput.bootstrapPlanDigest,
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
          if (
            record.operator?.planDigest !== known.operator.planDigest ||
            record.leaseId !== undefined ||
            record.operator.pendingEffectId !== undefined ||
            record.operator.pendingEffectAttempt !== undefined
          ) {
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

    return {
      assertAuthorized: owner.assertAuthorized,
      assertPlanningAuthorized: owner.assertPlanningAuthorized,
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
        const membership = inputContext.plan.authMembership;
        const matches = [
          link?.consumedAt === membership.identityCapture.capturedAt,
          link?.proofRef === membership.identityProof.reference,
          link?.proofSha256 === membership.identityProof.sha256,
          link?.nonceSha256 === membership.identityNonceSha256,
          link?.bootstrapPlanDigest === membership.bootstrapPlanDigest,
          link?.ownerSessionId === inputContext.target.sessionId,
          link?.authResourceId === inputContext.plan.authDatabase.resourceId,
          link?.issuer === membership.identityVerification.issuer,
          link?.audience === membership.identityVerification.audience,
          `${link?.endpointOrigin}/_platform/jwks.json` === membership.identityVerification.jwksUrl,
        ].every(Boolean);
        if (!matches) {
          throw new HostedOperatorError("auth_identity_required");
        }
        const artifacts = ownedArtifacts(inputContext);
        const content = await artifacts.store.read(
          artifacts.context,
          membership.identityProof.reference,
          0,
        );
        if (
          content === undefined ||
          createHash("sha256").update(Buffer.from(content, "base64")).digest("hex") !==
            membership.identityProof.sha256
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
          claims.sessionId !== membership.identityCapture.realmSessionId ||
          claims.sub !== membership.actorId
        ) {
          throw new HostedOperatorError("auth_identity_required");
        }
        await owner.assertAuthorized(inputContext);
      },
      authorize: owner.authorize,
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
        const saved = await updateHostedRuntimeJournal({
          ...linkInput.context,
          now: Date.now,
          store,
          update: (record) => {
            const link = record.operator?.identityLink;
            if (link === undefined || record.operator === undefined) {
              throw new HostedOperatorError("authorization_required");
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
      async prepareRealmIdentityLink(
        linkInput: Omit<
          Parameters<typeof reserveRealmIdentityLink>[0],
          "nonceSha256" | "sealedNonce"
        >,
      ) {
        const known = await readKnownAuthBootstrap(linkInput.context);
        const existing = known.operator.identityLink;
        const aad = JSON.stringify({
          authority: linkInput.context.authority,
          bootstrapPlanDigest: linkInput.bootstrapPlanDigest,
          organizationId: linkInput.organizationId,
          ownerSessionId: linkInput.context.target.sessionId,
          purpose: "realm-identity-link-nonce-v1",
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
        const sessionId = z.string().min(1).max(200).parse(stagingInput.ownerSessionId);
        const nonceSha256 = z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .parse(stagingInput.nonceSha256);
        const rows = await database
          .select({ record: builderProvisioningJournals.record })
          .from(builderProvisioningJournals)
          .where(
            and(
              sql`${builderProvisioningJournals.record}->>'kind' = 'app-runtime'`,
              sql`${builderProvisioningJournals.record}->'operator'->'identityLink'->>'ownerSessionId' = ${sessionId}`,
              sql`${builderProvisioningJournals.record}->'operator'->'identityLink'->>'nonceSha256' = ${nonceSha256}`,
            ),
          )
          .limit(2);
        if (rows.length !== 1) {
          throw new HostedOperatorError("authorization_required");
        }
        const record = hostedRuntimeJournalRecordSchema.parse(rows.at(0)?.record);
        const { operator } = record;
        const link = operator?.identityLink;
        if (operator === undefined || link === undefined) {
          throw new HostedOperatorError("authorization_required");
        }
        const current = [
          link.ownerSessionId === sessionId,
          link.nonceSha256 === nonceSha256,
          link.consumedAt === undefined,
          Date.parse(link.expiresAt) > Date.now(),
          operator.plan.stage === "auth-bootstrap",
          operator.authPreparation !== undefined,
          operator.planDigest === link.bootstrapPlanDigest,
          operator.pendingEffectId === undefined,
          operator.pendingEffectAttempt === undefined,
          record.leaseId === undefined,
        ].every(Boolean);
        if (!current || operator.plan.deploymentBoundary === undefined) {
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
          jwksUrl: operator.plan.deploymentBoundary.verification.jwksUrl,
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
      reserveRealmIdentityLink,
      async resolveRealmIdentityCallbackContext(callbackInput: {
        authority: HostedOperatorContext["authority"];
        ownerSessionId: string;
        nonceSha256: string;
      }): Promise<HostedOperatorContext> {
        const authority = hostedTenantAuthoritySchema.parse(callbackInput.authority);
        if (authority.issuer !== config.issuer || authority.audience !== config.resource) {
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
              eq(agentSessions.sessionId, callbackInput.ownerSessionId),
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
        // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Resolve the saved owner binding before reading its private pending callback journal.
        const records = await database
          .select({ record: builderProvisioningJournals.record })
          .from(builderProvisioningJournals)
          .where(
            and(
              eq(builderProvisioningJournals.issuer, authority.issuer),
              eq(builderProvisioningJournals.audience, authority.audience),
              eq(builderProvisioningJournals.workspaceId, authority.workspaceId),
              eq(builderProvisioningJournals.ownerUserId, authority.ownerUserId),
              sql`${builderProvisioningJournals.record}->'operator'->'identityLink'->>'ownerSessionId' = ${callbackInput.ownerSessionId}`,
              sql`${builderProvisioningJournals.record}->'operator'->'identityLink'->>'nonceSha256' = ${callbackInput.nonceSha256}`,
            ),
          )
          .limit(2);
        if (records.length !== 1) {
          throw new HostedOperatorError("authorization_required");
        }
        const record = hostedRuntimeJournalRecordSchema.parse(records.at(0)?.record);
        const context = { authority, ownerContext, target: record.request };
        await readKnownAuthBootstrap(context);
        if (
          record.operator?.identityLink?.consumedAt !== undefined ||
          Date.parse(record.operator?.identityLink?.expiresAt ?? "") <= Date.now()
        ) {
          throw new HostedOperatorError("authorization_required");
        }
        return context;
      },
      store,
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
