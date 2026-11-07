import { describe, expect, it } from "vitest";
import { eveStartInputSchema } from "../mcp/contracts";
import {
  InMemoryHostedEveStore,
  durableHostedSessionRecordSchema,
  hostedOperationRecordSchema,
  assertNativeRecoverySourceBinding,
} from "./hosted-store";
import { hostedEveOperationScopes } from "./hosted-auth";

const principal = {
  audience: "builder",
  issuer: "https://owner.example",
  ownerUserId: "owner",
  scopes: Object.values(hostedEveOperationScopes),
  workspaceId: "workspace",
};
const source = durableHostedSessionRecordSchema.parse({
  adapterGeneration: 1,
  adapterSessionId: "native",
  checkpointDigest: `sha256:${"a".repeat(64)}`,
  checkpointProgressDigest: `sha256:${"d".repeat(64)}`,
  checkpointRef: {
    digest: `sha256:${"a".repeat(64)}`,
    eventCount: 0,
    id: "123e4567-e89b-42d3-a456-426614174001",
  },
  createdAtEpochMs: 1,
  lastProgressAtEpochMs: 1,
  originAdapterSessionId: "native",
  principal,
  resumability: "live",
  sessionId: "source",
  stage: "needs_attention",
  status: "input_required",
  title: "App",
  updatedAtEpochMs: 1,
  version: 2,
});
const descriptor = {
  executionTransfer: {
    kind: "pending-approval" as const,
    sourceCheckpointDigest: `sha256:${"a".repeat(64)}`,
  },
  logicalSessionId: source.adapterSessionId,
  operationId: "transfer",
  originalAuthoritySessionId: source.sessionId,
  parentCancellationRevision: 0,
  sourceAdapterGeneration: 1,
  sourceOwnerRunId: source.adapterSessionId,
  sourcePublicSessionId: source.sessionId,
  version: 1 as const,
};
const transfer = hostedOperationRecordSchema.parse({
  clientRequestId: "transfer",
  createdAtEpochMs: 2,
  kind: "start",
  nativeRecovery: descriptor,
  operationId: "transfer",
  principal,
  requestDigest: `sha256:${"b".repeat(64)}`,
  resumeSessionId: source.sessionId,
  state: "reserved",
  updatedAtEpochMs: 2,
  version: 1,
});
const response = (state: "reserved" | "submission_unknown", operationId = "response") =>
  hostedOperationRecordSchema.parse({
    version: 1,
    kind: "respond",
    clientRequestId: operationId,
    operationId,
    sessionId: source.sessionId,
    principal,
    state,
    ...(state === "submission_unknown" ? { safeErrorCode: "submission_unknown" } : {}),
    requestDigest: `sha256:${"c".repeat(64)}`,
    createdAtEpochMs: 1,
    updatedAtEpochMs: 1,
  });
const seed = async (store: InMemoryHostedEveStore, session: typeof source) => {
  const operation = hostedOperationRecordSchema.parse({
    ...transfer,
    clientRequestId: `initial-${session.sessionId}`,
    nativeRecovery: undefined,
    operationId: `initial-${session.sessionId}`,
    resumeSessionId: undefined,
  });
  await store.reserveOperation(principal, operation);
  await store.settleSucceeded({
    nowEpochMs: 2,
    operationId: operation.operationId,
    principal,
    requestDigest: operation.requestDigest,
    result: { cursor: 0, events: [], sessionId: session.sessionId, status: session.status },
    session,
  });
};
const fixture = async () => {
  const store = new InMemoryHostedEveStore();
  await seed(store, source);
  return store;
};

const disposition = async (
  store: InMemoryHostedEveStore,
  operation: Parameters<InMemoryHostedEveStore["reserveOperation"]>[1],
) => {
  const result = await store.reserveOperation(principal, operation);
  return result.disposition;
};

describe("explicit live native takeover", () => {
  it("reserves an explicit idle checkpoint once and fences later source sends", async () => {
    const store = new InMemoryHostedEveStore();
    const idle = { ...source, status: "waiting" as const };
    await seed(store, idle);
    const recovery = hostedOperationRecordSchema.parse({
      ...transfer,
      nativeRecovery: {
        ...descriptor,
        executionTransfer: { ...descriptor.executionTransfer, kind: "idle-checkpoint" },
      },
    });
    expect(await disposition(store, recovery)).toBe("reserved");
    expect(await disposition(store, recovery)).toBe("existing");
    expect(await disposition(store, { ...response("reserved"), kind: "send" })).toBe("rejected");
    const cancelled = await store.recordCancellationIntent({
      nowEpochMs: 3,
      principal,
      sessionId: source.sessionId,
    });
    expect(() => {
      assertNativeRecoverySourceBinding(recovery, cancelled, {
        ...descriptor,
        executionTransfer: { ...descriptor.executionTransfer, kind: "idle-checkpoint" },
      });
    }).toThrow();
  });
  it("does not reserve idle recovery over a pending approval or a changed checkpoint", async () => {
    const recovery = hostedOperationRecordSchema.parse({
      ...transfer,
      nativeRecovery: {
        ...descriptor,
        executionTransfer: { ...descriptor.executionTransfer, kind: "idle-checkpoint" },
      },
    });
    expect(await disposition(await fixture(), recovery)).toBe("conflict");
    const store = new InMemoryHostedEveStore();
    await seed(store, { ...source, status: "waiting" });
    expect(await disposition(store, transfer)).toBe("conflict");
    expect(
      await disposition(store, {
        ...recovery,
        nativeRecovery: {
          ...descriptor,
          executionTransfer: {
            kind: "idle-checkpoint",
            sourceCheckpointDigest: `sha256:${"e".repeat(64)}`,
          },
        },
      }),
    ).toBe("conflict");
  });
  it("refuses an idle transfer while an ordinary source mutation is reserved", async () => {
    const store = new InMemoryHostedEveStore();
    await seed(store, { ...source, status: "waiting" });
    await store.reserveOperation(principal, { ...response("reserved"), kind: "send" });
    expect(
      await disposition(store, {
        ...transfer,
        nativeRecovery: {
          ...descriptor,
          executionTransfer: { ...descriptor.executionTransfer, kind: "idle-checkpoint" },
        },
      }),
    ).toBe("rejected");
  });
  it("requires an explicit existing-session recovery request", () => {
    expect(
      eveStartInputSchema.safeParse({
        clientRequestId: "x",
        prompt: "new app",
        resumeMode: "recover",
      }).success,
    ).toBe(false);
    expect(
      eveStartInputSchema.parse({
        clientRequestId: "x",
        resumeMode: "recover",
        resumeSessionId: source.sessionId,
      }).resumeMode,
    ).toBe("recover");
  });
  it("rejects takeover while an original response is still reserved", async () => {
    const store = await fixture();
    await store.reserveOperation(principal, response("reserved"));
    expect(await disposition(store, transfer)).toBe("rejected");
  });
  it("fences later responses while retaining the unknown original outcome", async () => {
    const store = await fixture();
    const unknown = response("submission_unknown");
    const reserved = response("reserved");
    await store.reserveOperation(principal, reserved);
    await store.settleUnsuccessful({
      nowEpochMs: 2,
      operationId: reserved.operationId,
      principal,
      requestDigest: reserved.requestDigest,
      safeErrorCode: "submission_unknown",
      state: "submission_unknown",
    });
    expect(await disposition(store, transfer)).toBe("reserved");
    expect(await disposition(store, response("reserved", "later"))).toBe("rejected");
    expect(await disposition(store, transfer)).toBe("existing");
    const retained = await store.getPrivateOperation(principal, unknown.operationId);
    expect(retained?.state).toBe("submission_unknown");
  });
  it("allows cancellation intent and immediately invalidates takeover authority", async () => {
    const store = await fixture();
    await store.reserveOperation(principal, transfer);
    const cancelled = await store.recordCancellationIntent({
      nowEpochMs: 3,
      principal,
      sessionId: source.sessionId,
    });
    expect(() => {
      assertNativeRecoverySourceBinding(transfer, cancelled, descriptor);
    }).toThrow();
  });
  it("does not fence an independent successor session", async () => {
    const store = await fixture();
    await store.reserveOperation(principal, transfer);
    await seed(store, {
      ...source,
      adapterSessionId: "new-native",
      originAdapterSessionId: "new-native",
      sessionId: "child",
    });
    expect(
      await disposition(store, {
        ...response("reserved", "child-response"),
        sessionId: "child",
      }),
    ).toBe("reserved");
  });
});
