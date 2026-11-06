import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
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
  hostedGitHubInstallations,
  hostedGitHubInstallationBindings,
  hostedGitHubPrEffectJournals,
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
} from "../../lib/db/schema";
import { hostedEveOperationScopes } from "../../lib/eve/hosted-auth";
import type { HostedPrincipal } from "../../lib/eve/hosted-auth";
import { createHostedEveSessionService } from "../../lib/eve/hosted-service";
import type { HostedEngineSnapshot, HostedEveTransport } from "../../lib/eve/hosted-service";
import type { HostedEveStore } from "../../lib/eve/hosted-store";
import { toDurableHostedSessionRecord } from "../../lib/eve/hosted-store";
import { createPostgresHostedEveStore } from "../../lib/eve/postgres-hosted-store";
import { sanitizeEvidence } from "./self-reproduction-evidence";

const snapshot = (status: HostedEngineSnapshot["status"]): HostedEngineSnapshot => ({
  events: [],
  status,
});

/** Direct production-service proof, intentionally not a browser parity receipt. */
export const exerciseReferenceLifecycle = async (input: {
  store: HostedEveStore;
  principal: HostedPrincipal;
}) => {
  const snapshots = new Map<string, HostedEngineSnapshot>();
  const counts = { cancels: 0, sends: 0, starts: 0 };
  const transport: HostedEveTransport = {
    cancel: ({ adapterSessionId }) => {
      counts.cancels += 1;
      const value = snapshot("cancelled");
      snapshots.set(adapterSessionId, value);
      return value;
    },
    get: ({ adapterSessionId }) => {
      const value = snapshots.get(adapterSessionId);
      if (!value) {
        throw new Error(`Missing snapshot for ${adapterSessionId}.`);
      }
      return value;
    },
    respond: () => {
      throw new Error("This fixture does not support approval responses.");
    },
    send: async ({ adapterSessionId, onAccepted }) => {
      counts.sends += 1;
      const deliveryId = randomUUID();
      await onAccepted?.(deliveryId);
      const value: HostedEngineSnapshot = {
        ...snapshot("completed"),
        nativeDeliveryState: {
          turns: [
            {
              boundary: "session.completed",
              boundaryDeliveryIds: [deliveryId],
              deliveryIds: [deliveryId],
              turnId: randomUUID(),
            },
          ],
          version: 1,
        },
      };
      snapshots.set(adapterSessionId, value);
      return value;
    },
    start: () => {
      counts.starts += 1;
      const adapterSessionId = randomUUID();
      const value = snapshot("working");
      snapshots.set(adapterSessionId, value);
      return { adapterSessionId, snapshot: value };
    },
  };
  const service = () =>
    createHostedEveSessionService({
      ...input,
      assertSendDeliveryOwner: async (ownedSession) => {
        const current = await input.store.getSession(input.principal, ownedSession.sessionId);
        if (!current) {
          throw new Error("Controlled continuation owner is unavailable.");
        }
        const binding = toDurableHostedSessionRecord(current);
        if (
          binding.adapterSessionId !== ownedSession.adapterSessionId ||
          binding.adapterGeneration !== ownedSession.adapterGeneration ||
          !snapshots.has(binding.adapterSessionId)
        ) {
          throw new Error("Controlled continuation ownership changed.");
        }
      },
      transport,
    });
  const cancellation = await service().start({
    clientRequestId: randomUUID(),
    prompt: "Controlled pending reference operation",
  });
  const [cancelled, persistedCancel] = await Promise.all([
    service().cancel({ sessionId: cancellation.sessionId }),
    service().get({ cursor: 0, limit: 100, sessionId: cancellation.sessionId }),
  ]);
  if (persistedCancel === null) {
    throw new Error("Cancellation session was not persisted.");
  }
  const [reopenedCancel, lateResult] = await Promise.all([
    input.store.getSession(input.principal, cancellation.sessionId),
    service().get({
      cursor: 0,
      limit: 100,
      sessionId: cancellation.sessionId,
    }),
  ]);
  const cancelledAdapter = toDurableHostedSessionRecord(persistedCancel).adapterSessionId;
  snapshots.set(cancelledAdapter, snapshot("completed"));
  const recovery = await service().start({
    clientRequestId: randomUUID(),
    prompt: "Controlled interrupted reference operation",
  });
  const request = {
    clientRequestId: randomUUID(),
    message: "Continue controlled operation",
    sessionId: recovery.sessionId,
  };
  const [reopened, first, repeated, persistedResult] = await Promise.all([
    service().get({ cursor: 0, limit: 100, sessionId: recovery.sessionId }),
    service().send(request),
    service().send(request),
    input.store.getSession(input.principal, recovery.sessionId),
  ]);
  return {
    assertions: [
      {
        id: "cancel-acknowledged",
        passed: cancelled.status === "cancelled" && counts.cancels === 1,
      },
      {
        id: "terminal-state-persists",
        passed: persistedCancel?.status === "cancelled" && reopenedCancel.status === "cancelled",
      },
      {
        id: "late-completion-does-not-revive-cancelled-session",
        passed: lateResult.status === "cancelled",
      },
      {
        id: "service-recreation-restores-session",
        passed: reopened.sessionId === recovery.sessionId && reopened.status === "working",
      },
      {
        id: "repeated-continuation-dispatches-once",
        passed: counts.sends === 1 && first.sessionId === repeated.sessionId,
      },
      { id: "continuation-result-persists", passed: persistedResult?.status === "completed" },
    ],
    browserParityEvidence: false,
    counts,
    generationEvidence: false,
    observedStatuses: {
      cancellation: cancelled.status,
      lateResult: lateResult.status,
      persistedCancel: persistedCancel?.status,
      persistedResult: persistedResult?.status,
      recovered: reopened.status,
      reopenedCancel: reopenedCancel.status,
    },
    producer: "evaluator",
    schemaVersion: "self-reproduction-reference-lifecycle/v1",
    scope: "production hosted session service and supplied store; controlled transport",
    sessionIds: [cancellation.sessionId, recovery.sessionId],
    unassessed: [
      "browser cancellation",
      "browser recovery",
      "failed-job retry",
      "preview authorization",
      "independent child generation",
    ],
  };
};

/** Uses the evaluator-owned disposable reference database; retains rows for readback. */
export const runReferenceLifecycle = async (input: { databaseUrl: string; outputRoot: string }) => {
  const sql = postgres(input.databaseUrl, { max: 1 });
  const runId = randomUUID();
  const principal: HostedPrincipal = {
    audience: "reference-lifecycle",
    issuer: "https://self-reproduction.example.test",
    ownerUserId: runId,
    scopes: Object.values(hostedEveOperationScopes),
    workspaceId: runId,
  };
  try {
    const result = await exerciseReferenceLifecycle({
      principal,
      store: createPostgresHostedEveStore(
        drizzle(sql, {
          schema: {
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
            hostedGitHubPrEffectJournals,
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
          },
        }),
      ),
    });
    const evidence = { ...result, persistence: "PostgreSQL", principal };
    await mkdir(input.outputRoot, { recursive: true });
    await writeFile(
      path.join(input.outputRoot, "reference-lifecycle.json"),
      JSON.stringify(sanitizeEvidence(evidence), null, 2),
      { mode: 0o600 },
    );
    return evidence;
  } catch (error) {
    await mkdir(input.outputRoot, { recursive: true });
    await writeFile(
      path.join(input.outputRoot, "reference-lifecycle-error.json"),
      JSON.stringify(
        sanitizeEvidence({
          generationEvidence: false,
          producer: "evaluator",
          reason: error instanceof Error ? error.message : String(error),
          scope: "reference durable-service diagnostic",
          stack: error instanceof Error ? error.stack : undefined,
        }),
        null,
        2,
      ),
      { mode: 0o600 },
    );
    throw error;
  } finally {
    await sql.end();
  }
};
