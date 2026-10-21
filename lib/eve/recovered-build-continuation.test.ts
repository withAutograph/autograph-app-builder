/* oxlint-disable anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- The fixture supplies only the controller transport port; ownership and persistence use the real store. */
import { describe, expect, it, vi } from "vitest";
import {
  persistHostedBuildDecision,
  claimHostedBuildMessage,
} from "../agent/approved-build-continuation-runtime";
import { readInternalBuildMarker } from "../agent/approved-build-continuation";
import { continueApprovedHostedBuild } from "./approved-build-controller";
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
const decision = {
  adapterSessionId: logicalSessionId,
  decision: "runnable" as const,
  scope: {
    appId: "spend-review",
    appSpecDigest: "a".repeat(64),
    proposalDigest: "b".repeat(64),
    sessionId: logicalSessionId,
    workspaceId: "private-workspace",
  },
  turnId: "recovered-build-turn",
  turnSequence: 14,
  validation: {
    attemptDigest: "c".repeat(64),
    command: "test" as const,
    exitCode: 1,
    reason: "command-failed" as const,
  },
  version: 1 as const,
  workflowPhase: "validation_failed",
};

describe("recovered approved build continuation", () => {
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
      version: 1 as const,
      operationId: "recovery-operation",
      sourcePublicSessionId: authoritySessionId,
      sourceOwnerRunId: logicalSessionId,
      sourceAdapterGeneration: 1,
      logicalSessionId,
      originalAuthoritySessionId: authoritySessionId,
      parentCancellationRevision: 0,
    };
    const receipt = {
      ...recovery,
      ownerRunId: physicalOwnerRunId,
      provenance: {
        kind: "failed-turn-input" as const,
        sourceStepId: "step-one",
        sourceEventId: "event-one",
        sourceSlot: 1,
        checkpointVersion: 1 as const,
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
    await persistHostedBuildDecision({
      decision,
      ownerSessionId: authoritySessionId,
      principal,
      store,
    });
    const savedAuthority = await savedSession(authoritySessionId);
    expect(savedAuthority.privateBuildDecision?.adapterSessionId).toBe(logicalSessionId);
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
    expect(firstSavedChild.privateBuildDecision?.adapterSessionId).toBe(physicalOwnerRunId);

    await persistHostedBuildDecision({
      decision: { ...decision, turnSequence: 15 },
      ownerSessionId: authoritySessionId,
      principal,
      store,
    });
    const savedChild = await savedSession(childSessionId);
    expect(savedChild.privateBuildDecision).toMatchObject({
      adapterSessionId: physicalOwnerRunId,
      turnSequence: 15,
    });
    const sendAccepted = vi.fn<NonNullable<HostedEveTransport["sendAccepted"]>>(async () => {
      await Promise.resolve();
    });
    // SAFETY: The controller exercises only this transport port; all persistence uses the real store.
    const transport = { sendAccepted } as unknown as HostedEveTransport;
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
    expect(await continueApprovedHostedBuild(controller)).toMatchObject({ status: "working" });
    expect(sendAccepted).toHaveBeenCalledTimes(1);
    const [sent] = sendAccepted.mock.calls[0] ?? [];
    expect(sent).toMatchObject({ adapterSessionId: physicalOwnerRunId, logicalSessionId });
    const marker = readInternalBuildMarker(sent?.message ?? "");
    if (marker?.operationId === undefined || marker.nonce === undefined) {
      throw new Error("Missing private build marker.");
    }
    expect(
      await claimHostedBuildMessage({
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
      await claimHostedBuildMessage({
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
    await continueApprovedHostedBuild(controller);
    expect(sendAccepted).toHaveBeenCalledTimes(1);
  });
});
