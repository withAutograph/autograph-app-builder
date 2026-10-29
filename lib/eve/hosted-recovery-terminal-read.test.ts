import { describe, expect, it, vi } from "vitest";

import { hostedEveOperationScopes, tenantKeyFor } from "./hosted-auth";
import type { HostedPrincipal } from "./hosted-auth";
import { createHostedEveSessionService, HostedSubmissionUnknownError } from "./hosted-service";
import type { HostedEngineSnapshot, HostedEveTransport } from "./hosted-service";
import { durableHostedSessionRecordSchema, InMemoryHostedEveStore } from "./hosted-store";
import type {
  HostedCheckpointPage,
  HostedEveStore,
  HostedPagedCheckpointMetadata,
  HostedSessionRecord,
} from "./hosted-store";
import { nativeObservationStateSchema } from "./native-observation-state";

const principal: HostedPrincipal = {
  audience: "autograph-app-builder",
  issuer: "https://identity.example.test",
  ownerUserId: "user_1",
  scopes: Object.values(hostedEveOperationScopes),
  workspaceId: "workspace_1",
};
const failed: HostedEngineSnapshot = { events: [], status: "failed" };
const working: HostedEngineSnapshot = { events: [], status: "working" };
const checkpointId = "123e4567-e89b-42d3-a456-426614174004";
const observedCheckpointId = "123e4567-e89b-42d3-a456-426614174005";
const checkpointDigest = `sha256:${"d".repeat(64)}`;
const observedCheckpointDigest = `sha256:${"e".repeat(64)}`;

type TerminalStatus = "completed" | "failed" | "cancelled";
type ObservationMode = TerminalStatus | "working" | "partial" | "unavailable";

const nativeState = (status: TerminalStatus | "working") =>
  nativeObservationStateSchema.parse({
    adapterSessionId: "run_child",
    artifactReadback: {
      incompleteArtifacts: [],
      incompleteUiPreviews: [],
      legacy: false,
      markdownCalls: [],
      pending: [],
      references: { requested: [], requestedUiPreview: [] },
    },
    boundary: status,
    invalidInput: false,
    nextNativeIndex: 2,
    pendingRequests: [],
    prototypeProjector: {
      artifactReadRequests: [],
      readChunks: [],
      requested: [],
      transfers: [],
    },
    prototypeReference: { requested: [], requestedUiPreview: [] },
    publicEventCount: 1,
    version: 1,
  });

const fixture = async () => {
  const base = new InMemoryHostedEveStore();
  let childSessionId = "";
  let publishedChild: HostedSessionRecord | null = null;
  let mode: ObservationMode = "failed";
  let ownerAllowed = true;
  let onObserve: (() => Promise<void>) | undefined;
  let onPersist: (() => Promise<void>) | undefined;
  let page: {
    id: string;
    digest: string;
    events: HostedCheckpointPage["events"];
    metadata: HostedPagedCheckpointMetadata;
  } | null = null;
  const beforeRead = vi.fn<
    NonNullable<Parameters<typeof createHostedEveSessionService>[0]["beforeRead"]>
  >(() => Promise.reject(new Error("beforeRead must stay fenced")));
  const assertNativeRecoveryOwner = vi.fn(() =>
    ownerAllowed ? Promise.resolve() : Promise.reject(new Error("Current owner revoked")),
  );
  const activateRecovery = vi.fn<NonNullable<HostedEveTransport["activateRecovery"]>>(() =>
    Promise.reject(new Error("Native activation HTTP 503")),
  );
  const observe = vi.fn<NonNullable<HostedEveTransport["observe"]>>(async (input) => {
    expect(input.adapterSessionId).toBe("run_child");
    expect(input.sessionId).toBe(childSessionId);
    await onObserve?.();
    if (mode === "unavailable") {
      throw new Error("Native read unavailable");
    }
    const status = mode === "partial" ? "failed" : mode;
    await input.onEvent({
      index: 0,
      text: `Native ${status} terminal observation`,
      turnId: "turn_terminal",
      type: "assistant.message",
    });
    return {
      artifactProjectionRequiresLegacyReadback: false,
      installedEventCount: 1,
      nativeObservationState: nativeState(status),
      nativeTailIndex: 1,
      nextNativeIndex: 2,
      observationComplete: mode !== "partial",
      pendingRequests: [],
      publicEventCount: 1,
      status,
    };
  });
  const start = vi
    .fn<HostedEveTransport["start"]>()
    .mockResolvedValueOnce({ adapterSessionId: "run_parent", snapshot: failed })
    .mockImplementationOnce(async ({ recovery }) => {
      if (recovery === undefined) {
        throw new Error("Expected typed native recovery");
      }
      const recoveryBinding = {
        ...recovery,
        ownerRunId: "run_child",
        provenance: {
          kind: "failed-turn-input" as const,
          sourceStepId: "step_terminal",
          sourceEventId: "event_terminal",
          sourceSlot: 1,
          checkpointVersion: 1 as const,
        },
      };
      await base.commitNativeRecoveryReceipt({
        descriptor: recovery,
        nowEpochMs: 4,
        principal,
        recoveryBinding,
      });
      return { adapterSessionId: "run_child", recoveryBinding, snapshot: working };
    });
  const transport: HostedEveTransport = {
    activateRecovery,
    cancel: vi.fn(() => Promise.resolve({ events: [], status: "cancelled" as const })),
    get: vi.fn(() => Promise.resolve(working)),
    observe,
    respond: vi.fn(() => Promise.resolve(working)),
    send: vi.fn(() => Promise.resolve(working)),
    start,
  };
  const seed = createHostedEveSessionService({
    assertNativeRecoveryOwner,
    principal,
    store: base,
    transport,
  });
  const original = await seed.start({ clientRequestId: "terminal_parent", prompt: "Build" });
  const settleSucceededPaged = vi.fn<NonNullable<HostedEveStore["settleSucceededPaged"]>>(
    async (input) => {
      const events: HostedCheckpointPage["events"] = [];
      for await (const event of input.events) {
        events.push(event);
      }
      page = { id: checkpointId, digest: checkpointDigest, events, metadata: input.metadata };
      childSessionId = input.session.sessionId;
      return await base.settleSucceeded({
        ...input,
        session: durableHostedSessionRecordSchema.parse({
          ...input.session,
          checkpointDigest,
          checkpointProgressDigest: `sha256:${"f".repeat(64)}`,
          checkpointRef: { digest: checkpointDigest, eventCount: events.length, id: checkpointId },
        }),
      });
    },
  );
  const getSession: HostedEveStore["getSession"] = async (owner, sessionId) => {
    if (tenantKeyFor(owner) !== tenantKeyFor(principal)) {
      return null;
    }
    return sessionId === childSessionId && publishedChild !== null
      ? publishedChild
      : await base.getSession(owner, sessionId);
  };
  const readCheckpointPage: NonNullable<HostedEveStore["readCheckpointPage"]> = (input) => {
    const current = page;
    if (current === null || current.id !== input.checkpointRef.id) {
      throw new Error("Unknown checkpoint page");
    }
    const events = current.events.slice(input.cursor, input.cursor + input.limit);
    return Promise.resolve({
      checkpointDigest: current.digest,
      cursor: input.cursor + events.length,
      events,
      metadata: current.metadata,
      totalEvents: current.events.length,
    });
  };
  const observeSessionPaged = vi.fn<NonNullable<HostedEveStore["observeSessionPaged"]>>(
    async (input) => {
      const previous = await getSession(input.principal, input.sessionId);
      if (previous?.version !== 2 || previous.checkpointDigest !== input.expectedCheckpointDigest) {
        throw new Error("Paged observation lost canonical child");
      }
      const events: HostedCheckpointPage["events"] = [];
      for await (const event of input.events) {
        events.push(event);
      }
      page = {
        id: observedCheckpointId,
        digest: observedCheckpointDigest,
        events,
        metadata: input.metadata,
      };
      publishedChild = durableHostedSessionRecordSchema.parse({
        ...previous,
        checkpointDigest: observedCheckpointDigest,
        checkpointProgressDigest: `sha256:${"a".repeat(64)}`,
        checkpointRef: {
          digest: observedCheckpointDigest,
          eventCount: events.length,
          id: observedCheckpointId,
        },
        lastProgressAtEpochMs: input.nowEpochMs,
        resumability: input.resumability,
        stage: input.stage,
        status: input.metadata.status,
        updatedAtEpochMs: input.nowEpochMs,
      });
      await onPersist?.();
      return publishedChild;
    },
  );
  const store: HostedEveStore = {
    getPrivateOperation: base.getPrivateOperation.bind(base),
    getSession,
    getStartOperation: base.getStartOperation.bind(base),
    listSessions: base.listSessions.bind(base),
    observeSessionPaged,
    readCheckpointPage,
    reserveOperation: base.reserveOperation.bind(base),
    settleSucceeded: base.settleSucceeded.bind(base),
    settleSucceededPaged,
    settleUnsuccessful: base.settleUnsuccessful.bind(base),
  };
  const service = createHostedEveSessionService({
    assertNativeRecoveryOwner,
    beforeRead,
    principal,
    store,
    transport,
  });
  const request = { clientRequestId: "terminal_recovery", resumeSessionId: original.sessionId };
  await expect(service.start(request)).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
  const operation = await base.getStartOperation(principal, request.clientRequestId);
  expect(operation?.state).toBe("succeeded");
  expect(childSessionId).not.toBe("");
  expect(await base.getSession(principal, childSessionId)).toMatchObject({
    adapterSessionId: "run_child",
    nativeRecoveryBinding: { sourcePublicSessionId: original.sessionId },
    status: "working",
  });
  expect(activateRecovery).toHaveBeenCalledOnce();
  return {
    activateRecovery,
    assertNativeRecoveryOwner,
    base,
    beforeRead,
    childSessionId,
    observe,
    observeSessionPaged,
    originalSessionId: original.sessionId,
    readCheckpointPage,
    service,
    setMode: (next: ObservationMode) => {
      mode = next;
    },
    setOnObserve: (effect: () => Promise<void>) => {
      onObserve = effect;
    },
    setOnPersist: (effect: () => Promise<void>) => {
      onPersist = effect;
    },
    setOwnerAllowed: (allowed: boolean) => {
      ownerAllowed = allowed;
    },
    start,
    transport,
  };
};

describe("recovered child terminal read after activation transport failure", () => {
  it("keeps a committed recovered child working after successful current-owner activation", async () => {
    const f = await fixture();
    f.activateRecovery.mockImplementation(async () => {
      const child = await f.base.getSession(principal, f.childSessionId);
      if (child?.version !== 2 || child.nativeRecoveryBinding === undefined) {
        throw new Error("missing committed child receipt");
      }
      return child.nativeRecoveryBinding;
    });
    f.beforeRead.mockResolvedValue();
    f.setMode("working");
    const result = await f.service.get({ sessionId: f.childSessionId, cursor: 0, limit: 25 });
    expect(result.status).toBe("working");
    expect(f.beforeRead).toHaveBeenCalledOnce();
    expect(await f.base.getSession(principal, f.originalSessionId)).toMatchObject({
      status: "failed",
      resumability: "terminal",
    });
    expect(f.observeSessionPaged).toHaveBeenCalledOnce();
  });

  it.each(["failed", "completed", "cancelled"] as const)(
    "returns a fresh complete exact-owner %s terminal observation without continuation",
    async (status) => {
      const f = await fixture();
      f.setMode(status);
      const result = await f.service.get({ sessionId: f.childSessionId, cursor: 0, limit: 25 });
      expect(result.status).toBe(status);
      expect(result.events).toMatchObject([{ text: `Native ${status} terminal observation` }]);
      expect(f.observe).toHaveBeenCalledOnce();
      expect(f.observeSessionPaged).toHaveBeenCalledOnce();
      expect(f.beforeRead).not.toHaveBeenCalled();
      expect(f.transport.get).not.toHaveBeenCalled();
      expect(f.transport.send).not.toHaveBeenCalled();
      expect(f.start).toHaveBeenCalledTimes(2);
      expect(f.activateRecovery).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["working", "partial", "unavailable"] as const)(
    "keeps the original activation outcome unknown for %s native observation",
    async (mode) => {
      const f = await fixture();
      f.setMode(mode);
      await expect(
        f.service.get({ sessionId: f.childSessionId, cursor: 0, limit: 25 }),
      ).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
      expect(f.beforeRead).not.toHaveBeenCalled();
      expect(f.observeSessionPaged).not.toHaveBeenCalled();
      expect(f.transport.get).not.toHaveBeenCalled();
      expect(f.start).toHaveBeenCalledTimes(2);
    },
  );

  it("does not substitute a cached terminal checkpoint when the fresh native read is unavailable", async () => {
    const f = await fixture();
    await expect(
      f.service.get({ sessionId: f.childSessionId, cursor: 0, limit: 25 }),
    ).resolves.toMatchObject({ status: "failed" });
    f.setMode("unavailable");
    await expect(
      f.service.get({ sessionId: f.childSessionId, cursor: 0, limit: 25 }),
    ).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    expect(f.beforeRead).not.toHaveBeenCalled();
    expect(f.transport.get).not.toHaveBeenCalled();
  });

  it("rejects a revoked current owner before reading native history", async () => {
    const f = await fixture();
    f.setOwnerAllowed(false);
    await expect(
      f.service.get({ sessionId: f.childSessionId, cursor: 0, limit: 25 }),
    ).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    expect(f.observe).not.toHaveBeenCalled();
    expect(f.beforeRead).not.toHaveBeenCalled();
  });

  it.each(["source", "child"] as const)(
    "rejects a concurrent %s cancellation revision change after native observation",
    async (which) => {
      const f = await fixture();
      f.setOnObserve(async () => {
        await f.base.recordCancellationIntent({
          nowEpochMs: 10,
          principal,
          sessionId: which === "source" ? f.originalSessionId : f.childSessionId,
        });
      });
      await expect(
        f.service.get({ sessionId: f.childSessionId, cursor: 0, limit: 25 }),
      ).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
      expect(f.observe).toHaveBeenCalledOnce();
      expect(f.observeSessionPaged).not.toHaveBeenCalled();
      expect(f.beforeRead).not.toHaveBeenCalled();
    },
  );

  it("rejects an owner change after the terminal checkpoint write", async () => {
    const f = await fixture();
    f.setOnPersist(async () => {
      await f.base.recordCancellationIntent({
        nowEpochMs: 10,
        principal,
        sessionId: f.originalSessionId,
      });
    });
    await expect(
      f.service.get({ sessionId: f.childSessionId, cursor: 0, limit: 25 }),
    ).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    expect(f.observeSessionPaged).toHaveBeenCalledOnce();
    expect(f.beforeRead).not.toHaveBeenCalled();
  });
});
