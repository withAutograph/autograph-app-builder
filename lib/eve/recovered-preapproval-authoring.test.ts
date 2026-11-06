/* oxlint-disable typescript/no-non-null-assertion, typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Focused fixtures provide only consumed native coordinates; real stores and producer paths validate authority separately. */
/* oxlint-disable eslint/require-await, eslint/no-await-in-loop, unicorn/no-await-expression-member -- Native lifecycle observations and durable store transitions are deliberately ordered; fixture ports preserve their asynchronous interface. */
/* oxlint-disable anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- The fixture supplies only the controller transport port; ownership and persistence use the real store. */
import { describe, expect, it, vi } from "vitest";
import { authoringScopeDigest, readInternalAuthoringMarker } from "../agent/preapproval-authoring";
import { continueHostedPreapprovalAuthoring } from "./preapproval-authoring-controller";
import { hostedEveOperationScopes } from "./hosted-auth";
import type { HostedPrincipal } from "./hosted-auth";
import type { HostedEveTransport } from "./hosted-service";
import { InMemoryHostedEveStore, toDurableHostedSessionRecord } from "./hosted-store";

const principal: HostedPrincipal = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/auth",
  ownerUserId: "owner",
  scopes: Object.values(hostedEveOperationScopes),
  workspaceId: "workspace",
};
const logicalSessionId = "original-logical-run";
const authoritySessionId = "original-public-session";
const childSessionId = "recovered-public-session";
const physicalOwnerRunId = "recovered-physical-run";
const scope = {
  acceptedByCallId: "accepted",
  appId: "spend-review",
  appSpecDigest: "a".repeat(64),
  artifactPath: "app-spec.md",
  artifactRevision: "revision",
  authoritySessionId: logicalSessionId,
  planningStateDigest: "d".repeat(64),
  sourceReceiptDigest: "b".repeat(64),
  workspaceDigest: "c".repeat(64),
  workspaceId: "same-private-workspace",
};
const decision = {
  adapterSessionId: logicalSessionId,
  decision: "runnable" as const,
  kind: "preapproval-authoring-decision-v1" as const,
  scope,
  scopeDigest: authoringScopeDigest(scope),
  turnId: "recovered-authoring-turn",
  turnSequence: 14,
  version: 1 as const,
};
const persistHostedAuthoringDecision = async (input: {
  decision: typeof decision;
  ownerSessionId: string;
  principal: HostedPrincipal;
  store: InMemoryHostedEveStore;
}) => {
  await input.store.recordPreapprovalAuthoringDecision({
    decision: input.decision,
    principal: input.principal,
    sessionId: input.ownerSessionId,
  });
};
const claimHostedAuthoringMessage = async (input: {
  logicalSessionId: string;
  messageSequence: number;
  nonce: string;
  operationId: string;
  ownerSessionId: string;
  principal: HostedPrincipal;
  store: InMemoryHostedEveStore;
  turnId: string;
  turnSequence: number;
}) =>
  await input.store.claimInternalAuthoringMessage({
    ...input,
    scopeDigest: decision.scopeDigest,
    sessionId: input.ownerSessionId,
  });

describe("recovered accepted authoring continuation", () => {
  it("carries early projection into the canonical child, then dispatches and claims its logical marker", async () => {
    const store = new InMemoryHostedEveStore();
    const savedSession = async (sessionId: string) => {
      const record = await store.getSession(principal, sessionId);
      if (record === null) {
        throw new Error("Expected a saved hosted session.");
      }
      return toDurableHostedSessionRecord(record);
    };
    const parentStart = {
      clientRequestId: "initial",
      createdAtEpochMs: 1,
      kind: "start" as const,
      operationId: "initial-operation",
      principal,
      requestDigest: `sha256:${"d".repeat(64)}`,
      state: "reserved" as const,
      updatedAtEpochMs: 1,
      version: 1 as const,
    };
    await store.reserveOperation(principal, parentStart);
    await store.settleSucceeded({
      nowEpochMs: 1,
      operationId: parentStart.operationId,
      principal,
      requestDigest: parentStart.requestDigest,
      result: { cursor: 0, events: [], sessionId: authoritySessionId, status: "failed" },
      session: {
        adapterGeneration: 1,
        adapterSessionId: logicalSessionId,
        createdAtEpochMs: 1,
        lastProgressAtEpochMs: 1,
        originAdapterSessionId: logicalSessionId,
        principal,
        resumability: "terminal",
        sessionId: authoritySessionId,
        stage: "needs_attention",
        status: "failed",
        title: "Spend Review",
        updatedAtEpochMs: 1,
        version: 2,
      },
    });
    const recovery = {
      logicalSessionId,
      operationId: "recovery-operation",
      originalAuthoritySessionId: authoritySessionId,
      parentCancellationRevision: 0,
      sourceAdapterGeneration: 1,
      sourceOwnerRunId: logicalSessionId,
      sourcePublicSessionId: authoritySessionId,
      version: 1 as const,
    };
    const receipt = {
      ...recovery,
      ownerRunId: physicalOwnerRunId,
      provenance: {
        checkpointVersion: 1 as const,
        kind: "failed-turn-input" as const,
        sourceEventId: "event-one",
        sourceSlot: 1,
        sourceStepId: "step-one",
      },
    };
    const recoveryStart = {
      clientRequestId: "recover",
      createdAtEpochMs: 2,
      kind: "start" as const,
      nativeRecovery: recovery,
      operationId: recovery.operationId,
      principal,
      requestDigest: `sha256:${"e".repeat(64)}`,
      resumeSessionId: authoritySessionId,
      state: "reserved" as const,
      updatedAtEpochMs: 2,
      version: 1 as const,
    };
    await store.reserveOperation(principal, recoveryStart);
    await store.commitNativeRecoveryReceipt({
      descriptor: recovery,
      nowEpochMs: 2,
      principal,
      recoveryBinding: receipt,
    });

    // Native activation may run this hook before the public child row is settled.
    await persistHostedAuthoringDecision({
      decision,
      ownerSessionId: authoritySessionId,
      principal,
      store,
    });
    const savedAuthority = await savedSession(authoritySessionId);
    expect(savedAuthority.privateAuthoringDecision?.adapterSessionId).toBe(logicalSessionId);
    await store.settleSucceeded({
      nowEpochMs: 3,
      operationId: recoveryStart.operationId,
      principal,
      requestDigest: recoveryStart.requestDigest,
      result: { cursor: 0, events: [], sessionId: childSessionId, status: "waiting" },
      session: {
        adapterGeneration: 1,
        adapterSessionId: physicalOwnerRunId,
        createdAtEpochMs: 3,
        lastProgressAtEpochMs: 3,
        nativeRecoveryBinding: receipt,
        originAdapterSessionId: physicalOwnerRunId,
        parentSessionId: authoritySessionId,
        principal,
        resumability: "live",
        sessionId: childSessionId,
        stage: "ready",
        status: "waiting",
        title: "Spend Review",
        updatedAtEpochMs: 3,
        version: 2,
      },
    });
    const firstSavedChild = await savedSession(childSessionId);
    expect(firstSavedChild.privateAuthoringDecision?.adapterSessionId).toBe(physicalOwnerRunId);
    expect(firstSavedChild.privateAuthoringDecision?.scope).toEqual(scope);

    await persistHostedAuthoringDecision({
      decision: { ...decision, turnSequence: 15 },
      ownerSessionId: authoritySessionId,
      principal,
      store,
    });
    const savedChild = await savedSession(childSessionId);
    expect(savedChild.privateAuthoringDecision).toMatchObject({
      adapterSessionId: physicalOwnerRunId,
      turnSequence: 15,
    });
    const sendAccepted = vi.fn<NonNullable<HostedEveTransport["sendAccepted"]>>(async () => {
      await Promise.resolve();
    });
    // SAFETY: The controller exercises only this transport port; all persistence uses the real store.
    const transport = {
      observe: async () => ({ pendingRequests: [], status: "waiting" }),
      sendAccepted,
    } as unknown as HostedEveTransport;
    const controller = {
      assertCurrentOwner: vi.fn(async () => {
        await Promise.resolve();
      }),
      now: () => 4,
      principal,
      result: { cursor: 0, events: [], sessionId: childSessionId, status: "waiting" as const },
      sessionId: childSessionId,
      store,
      transport,
    };
    expect(await continueHostedPreapprovalAuthoring(controller)).toMatchObject({
      status: "working",
    });
    expect(sendAccepted).toHaveBeenCalledTimes(1);
    const [sent] = sendAccepted.mock.calls[0] ?? [];
    expect(sent).toMatchObject({ adapterSessionId: physicalOwnerRunId, logicalSessionId });
    const marker = readInternalAuthoringMarker(sent?.message ?? "");
    if (marker?.operationId === undefined || marker.nonce === undefined) {
      throw new Error("Missing private build marker.");
    }
    expect(
      await claimHostedAuthoringMessage({
        logicalSessionId,
        messageSequence: 1,
        nonce: marker.nonce,
        operationId: marker.operationId,
        ownerSessionId: authoritySessionId,
        principal,
        store,
        turnId: "delivered-child-turn",
        turnSequence: 16,
      }),
    ).toBe(true);
    expect(
      await claimHostedAuthoringMessage({
        logicalSessionId,
        messageSequence: 2,
        nonce: marker.nonce,
        operationId: marker.operationId,
        ownerSessionId: authoritySessionId,
        principal,
        store,
        turnId: "delivered-child-turn",
        turnSequence: 16,
      }),
    ).toBe(false);
    await continueHostedPreapprovalAuthoring(controller);
    expect(sendAccepted).toHaveBeenCalledTimes(1);
  });
});
