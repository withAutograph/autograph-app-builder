import postgres from "postgres";
import { z } from "zod";
import { drizzle } from "drizzle-orm/postgres-js";

import { createPostgresPreviewOrganizationAuthority } from "../auth/postgres-organization-user-authority";
import {
  hostedRuntimePostgresOptions,
  parseHostedDatabaseUrl,
} from "../db/postgres-connection-policy";
import { createVercelWorkloadIdentity } from "../eve/vercel-workload-identity";
import { createPostgresHostedEveStore } from "../eve/postgres-hosted-store";
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
import { readVercelTokenKeyringEnvironment } from "../integrations/vercel-installation";
import type { HostedPrincipal } from "../eve/hosted-auth";
import type { OperatorWorkloadPolicy } from "./hosted-operator-workload";
import {
  createHostedOperatorOwnerAuthority,
  createHostedOperatorReadApproval,
} from "./hosted-operator-owner";
import { createHostedOperatorOwnerContextResolver } from "./hosted-operator-owner-context";
import type {
  HostedOperatorContext,
  HostedOperatorEffectContext,
  HostedOperatorWorkerEffectContext,
} from "./hosted-operator-service";
import { HostedOperatorError, operatorPlanDigest } from "./hosted-operator-contract";
import {
  prepareHostedOperatorResourceCredentials,
  readHostedOperatorResourceBindings,
} from "./hosted-operator-resource-credentials";
import type { ProtectedResourceDatabase } from "./hosted-operator-resource-credentials";
import type {
  HostedRuntimeJournalRecord,
  HostedRuntimeJournalStore,
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
    operator.fenceGeneration !== input.fenceGeneration ||
    operator.pendingEffectId !== input.effect.id ||
    operator.pendingEffectAttempt?.id !== input.workerAttemptId
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

/**
 * Composes the production control-plane readers and fences already owned by
 * Builder. This is intentionally not a complete operator adapter: planning,
 * Neon resource effects, installer reconciliation, verification and bindings
 * still require their concrete owner-authorized provider implementations.
 */
export const createHostedOperatorControlPlane = async (input: {
  environment?: Readonly<Record<string, string | undefined>>;
  workloadPolicy: OperatorWorkloadPolicy;
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
      authorize: owner.authorize,
      async close() {
        await controlPlaneClient.end({ timeout: 5 });
      },
      async prepareResourceCredentials(
        effectInput: HostedOperatorWorkerEffectContext & { database: ProtectedResourceDatabase },
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
      readApproval,
      readCredential,
      async readResourceBindings(effectInput: ResourceCredentialEffect) {
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
