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
  issuer: "https://owner.example",
  audience: "builder",
  workspaceId: "workspace",
  ownerUserId: "owner",
  scopes: Object.values(hostedEveOperationScopes),
};
const source = durableHostedSessionRecordSchema.parse({
  version: 2,
  sessionId: "source",
  adapterSessionId: "native",
  adapterGeneration: 1,
  originAdapterSessionId: "native",
  principal,
  status: "input_required",
  stage: "needs_attention",
  resumability: "live",
  title: "App",
  createdAtEpochMs: 1,
  updatedAtEpochMs: 1,
  lastProgressAtEpochMs: 1,
  checkpointRef: {
    digest: `sha256:${"a".repeat(64)}`,
    eventCount: 0,
    id: "123e4567-e89b-42d3-a456-426614174001",
  },
  checkpointDigest: `sha256:${"a".repeat(64)}`,
  checkpointProgressDigest: `sha256:${"d".repeat(64)}`,
});
const descriptor = {
  version: 1 as const,
  operationId: "transfer",
  sourcePublicSessionId: source.sessionId,
  sourceOwnerRunId: source.adapterSessionId,
  sourceAdapterGeneration: 1,
  logicalSessionId: source.adapterSessionId,
  originalAuthoritySessionId: source.sessionId,
  parentCancellationRevision: 0,
  executionTransfer: {
    kind: "pending-approval" as const,
    sourceCheckpointDigest: `sha256:${"a".repeat(64)}`,
  },
};
const transfer = hostedOperationRecordSchema.parse({
  version: 1,
  kind: "start",
  clientRequestId: "transfer",
  operationId: "transfer",
  resumeSessionId: source.sessionId,
  nativeRecovery: descriptor,
  principal,
  state: "reserved",
  requestDigest: `sha256:${"b".repeat(64)}`,
  createdAtEpochMs: 2,
  updatedAtEpochMs: 2,
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
    // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Preserve conditional fields and evaluation order.
    ...(state === "submission_unknown" ? { safeErrorCode: "submission_unknown" } : {}),
    requestDigest: `sha256:${"c".repeat(64)}`,
    createdAtEpochMs: 1,
    updatedAtEpochMs: 1,
  });
const seed = async (store: InMemoryHostedEveStore, session: typeof source) => {
  const operation = hostedOperationRecordSchema.parse({
    ...transfer,
    // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Preserve the existing explicit undefined value.
    nativeRecovery: undefined,
    // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Preserve the existing explicit undefined value.
    resumeSessionId: undefined,
    operationId: `initial-${session.sessionId}`,
    clientRequestId: `initial-${session.sessionId}`,
  });
  await store.reserveOperation(principal, operation);
  await store.settleSucceeded({
    principal,
    operationId: operation.operationId,
    requestDigest: operation.requestDigest,
    nowEpochMs: 2,
    session,
    result: { sessionId: session.sessionId, status: session.status, cursor: 0, events: [] },
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
      principal,
      sessionId: source.sessionId,
      nowEpochMs: 3,
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
      principal,
      operationId: reserved.operationId,
      requestDigest: reserved.requestDigest,
      state: "submission_unknown",
      safeErrorCode: "submission_unknown",
      nowEpochMs: 2,
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
      principal,
      sessionId: source.sessionId,
      nowEpochMs: 3,
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
      sessionId: "child",
      adapterSessionId: "new-native",
      originAdapterSessionId: "new-native",
    });
    expect(
      await disposition(store, {
        ...response("reserved", "child-response"),
        sessionId: "child",
      }),
    ).toBe("reserved");
  });
});
