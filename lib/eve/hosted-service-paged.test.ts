import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { hostedEveOperationScopes, tenantKeyFor } from "./hosted-auth";
import type { HostedPrincipal } from "./hosted-auth";
import { createHostedEveSessionService, HostedSessionNotFoundError } from "./hosted-service";
import { HostedAdapterSessionUnavailableError } from "./hosted-errors";
import { HostedSessionReadTimeoutError } from "./hosted-session-read-timeout-error";
import type { HostedEveTransport } from "./hosted-service";
import {
  durableHostedSessionRecordSchema,
  hostedOperationRecordSchema,
  InMemoryHostedEveStore,
} from "./hosted-store";
import type {
  HostedEveStore,
  HostedPagedCheckpointMetadata,
  HostedSessionRecord,
} from "./hosted-store";
import type { PublicEveEvent } from "../mcp/contracts";

const principal: HostedPrincipal = {
  audience: "autograph-app-builder",
  issuer: "https://identity.example.test",
  ownerUserId: "user_1",
  scopes: Object.values(hostedEveOperationScopes),
  workspaceId: "workspace_1",
};

const emptySnapshot = { events: [], status: "waiting" as const };

const transport = (observe: NonNullable<HostedEveTransport["observe"]>): HostedEveTransport => ({
  // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous transport contract.
  cancel: vi.fn(async () => emptySnapshot),
  // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous transport contract.
  get: vi.fn(async () => emptySnapshot),
  observe,
  // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous transport contract.
  respond: vi.fn(async () => emptySnapshot),
  // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous transport contract.
  send: vi.fn(async () => emptySnapshot),
  // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous transport contract.
  start: vi.fn(async () => ({ adapterSessionId: "adapter_1", snapshot: emptySnapshot })),
});

const fixture = async (observe: NonNullable<HostedEveTransport["observe"]>, currentTime = 2000) => {
  const base = new InMemoryHostedEveStore();
  const adapter = transport(observe);
  const starting = createHostedEveSessionService({
    now: () => 1000,
    principal,
    store: base,
    transport: adapter,
  });
  const started = await starting.start({ clientRequestId: randomUUID(), prompt: "Build an app" });
  let paged: HostedSessionRecord | null = null;
  let metadata: HostedPagedCheckpointMetadata | null = null;
  let eventCount = 0;
  let first: PublicEveEvent | undefined;
  let last: PublicEveEvent | undefined;
  const observeSessionPaged = vi.fn<NonNullable<HostedEveStore["observeSessionPaged"]>>(
    async (input) => {
      const previous = paged ?? (await base.getSession(principal, started.sessionId));
      if (previous?.version !== 2 || previous.checkpointDigest !== input.expectedCheckpointDigest) {
        throw new Error("Checkpoint observation raced.");
      }
      eventCount = 0;
      for await (const event of input.events) {
        first ??= event;
        last = event;
        eventCount += 1;
      }
      ({ metadata } = input);
      const { checkpoint: previousInlineCheckpoint, ...withoutInline } = previous;
      void previousInlineCheckpoint;
      const digest = `sha256:${"a".repeat(64)}`;
      paged = durableHostedSessionRecordSchema.parse({
        ...withoutInline,
        checkpointDigest: digest,
        checkpointProgressDigest: `sha256:${"b".repeat(64)}`,
        checkpointRef: { digest, eventCount, id: randomUUID() },
        lastProgressAtEpochMs: input.nowEpochMs,
        resumability: input.resumability,
        stage: input.stage,
        status: input.metadata.status,
        updatedAtEpochMs: input.nowEpochMs,
      });
      return paged;
    },
  );
  const readCheckpointPage = vi.fn<NonNullable<HostedEveStore["readCheckpointPage"]>>(
    // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous store contract.
    async (input) => {
      if (
        paged?.version !== 2 ||
        paged.checkpointRef?.id !== input.checkpointRef.id ||
        metadata === null
      ) {
        throw new Error("Unknown checkpoint reference.");
      }
      let event: PublicEveEvent | undefined;
      if (input.cursor === 0) {
        event = first;
      } else if (input.cursor === eventCount - 1) {
        event = last;
      }
      const events = event === undefined ? [] : [event];
      return {
        checkpointDigest: paged.checkpointRef.digest,
        cursor: input.cursor + events.length,
        events,
        metadata,
        totalEvents: eventCount,
      };
    },
  );
  const replaceSessionAdapterPaged = vi.fn<
    NonNullable<HostedEveStore["replaceSessionAdapterPaged"]>
  >(async (input) => {
    const previous = paged ?? (await base.getSession(principal, started.sessionId));
    if (
      previous?.version !== 2 ||
      previous.adapterGeneration !== input.expectedAdapterGeneration ||
      previous.checkpointDigest !== input.expectedCheckpointDigest
    ) {
      throw new Error("Hosted session recovery raced another continuation.");
    }
    let nextCount = 0;
    for await (const event of input.events) {
      first ??= event;
      last = event;
      nextCount += 1;
    }
    eventCount = nextCount;
    ({ metadata } = input);
    const { checkpoint: previousInlineCheckpoint, ...withoutInline } = previous;
    void previousInlineCheckpoint;
    const digest = `sha256:${"c".repeat(64)}`;
    paged = durableHostedSessionRecordSchema.parse({
      ...withoutInline,
      adapterGeneration: previous.adapterGeneration + 1,
      adapterSessionId: input.adapterSessionId,
      checkpointDigest: digest,
      checkpointProgressDigest: `sha256:${"d".repeat(64)}`,
      checkpointRef: { digest, eventCount, id: randomUUID() },
      lastProgressAtEpochMs: input.nowEpochMs,
      resumability: input.resumability,
      stage: input.stage,
      status: input.metadata.status,
      updatedAtEpochMs: input.nowEpochMs,
    });
    return paged;
  });
  const getSession = vi.fn<HostedEveStore["getSession"]>(async (candidate, sessionId) => {
    if (tenantKeyFor(candidate) !== tenantKeyFor(principal)) {
      return null;
    }
    return paged ?? (await base.getSession(candidate, sessionId));
  });
  const store: HostedEveStore = {
    getSession,
    listSessions: base.listSessions.bind(base),
    observeSession: base.observeSession.bind(base),
    observeSessionPaged,
    readCheckpointPage,
    replaceSessionAdapter: base.replaceSessionAdapter.bind(base),
    replaceSessionAdapterPaged,
    reserveOperation: base.reserveOperation.bind(base),
    settleIdleReservations: base.settleIdleReservations.bind(base),
    settleSucceeded: base.settleSucceeded.bind(base),
    settleUnsuccessful: base.settleUnsuccessful.bind(base),
  };
  const service = createHostedEveSessionService({
    now: () => currentTime,
    principal,
    store,
    transport: adapter,
  });
  return {
    adapter,
    base,
    getSession,
    observeSessionPaged,
    readCheckpointPage,
    replaceSessionAdapterPaged,
    service,
    sessionId: started.sessionId,
  };
};

describe("paged hosted session observation", () => {
  it("returns a paged no-op cancellation without dispatch when no turn is active", async () => {
    const observe = vi.fn<NonNullable<HostedEveTransport["observe"]>>(async () => {
      await Promise.resolve();
      return {
        artifactProjectionRequiresLegacyReadback: false,
        installedEventCount: 0,
        pendingRequests: [],
        publicEventCount: 0,
        status: "waiting",
      };
    });
    const { adapter, service, sessionId } = await fixture(observe);
    adapter.cancelAccepted = vi.fn(async () => {
      await Promise.resolve();
    });
    const result = await service.cancel({ sessionId });
    expect(result.status).toBe("waiting");
    expect(adapter.cancelAccepted).not.toHaveBeenCalled();
    expect(adapter.cancel).not.toHaveBeenCalled();
  });

  it("releases only an old reserved mutation after observing an idle session", async () => {
    const observe = vi.fn<NonNullable<HostedEveTransport["observe"]>>(async () => {
      await Promise.resolve();
      return {
        artifactProjectionRequiresLegacyReadback: false,
        installedEventCount: 0,
        pendingRequests: [],
        publicEventCount: 0,
        status: "waiting",
      };
    });
    const { adapter, base, service, sessionId } = await fixture(observe, 400_000);
    adapter.cancelAccepted = vi.fn(async () => {
      await Promise.resolve();
    });
    const old = hostedOperationRecordSchema.parse({
      clientRequestId: "old-send",
      createdAtEpochMs: 1000,
      kind: "send",
      operationId: "op-old",
      principal,
      requestDigest: `sha256:${"a".repeat(64)}`,
      sessionId,
      state: "reserved",
      updatedAtEpochMs: 1000,
      version: 1,
    });
    const next = hostedOperationRecordSchema.parse({
      ...old,
      clientRequestId: "next-send",
      operationId: "op-next",
      requestDigest: `sha256:${"b".repeat(64)}`,
      updatedAtEpochMs: 400_000,
    });
    const firstReservation = await base.reserveOperation(principal, old);
    const blockedReservation = await base.reserveOperation(principal, next);
    expect(firstReservation.disposition).toBe("reserved");
    expect(blockedReservation.disposition).toBe("rejected");
    const result = await service.cancel({ sessionId });
    expect(result.error?.code).toBe("idle_continuation_recovered");
    expect(await base.reserveOperation(principal, old)).toMatchObject({
      disposition: "existing",
      operation: { safeErrorCode: "submission_unknown", state: "submission_unknown" },
    });
    const nextReservation = await base.reserveOperation(principal, next);
    expect(nextReservation.disposition).toBe("reserved");
    const repeat = await service.cancel({ sessionId });
    expect(repeat.error?.code).not.toBe("idle_continuation_recovered");
    expect(await base.reserveOperation(principal, next)).toMatchObject({
      disposition: "existing",
      operation: { state: "reserved" },
    });
  });

  it("returns a cancelled session after accepted cancellation and fresh checkpoint", async () => {
    const observe = vi.fn<NonNullable<HostedEveTransport["observe"]>>(async ({ onEvent }) => {
      await onEvent({ index: 0, text: "cancelled", turnId: "turn_1", type: "assistant.message" });
      return {
        activeTurnId: "turn_1",
        artifactProjectionRequiresLegacyReadback: false,
        installedEventCount: 1,
        pendingRequests: [],
        publicEventCount: 1,
        status: "cancelled",
      };
    });
    const { adapter, service, sessionId } = await fixture(observe);
    adapter.cancelAccepted = vi.fn(async () => {
      await Promise.resolve();
    });
    const result = await service.cancel({ sessionId, turnId: "turn_1" });
    expect(result.status).toBe("cancelled");
    expect(adapter.cancelAccepted).toHaveBeenCalledOnce();
    expect(adapter.cancel).not.toHaveBeenCalled();
  });

  it("settles an accepted send only after a fresh paged checkpoint is durable", async () => {
    const observe = vi.fn<NonNullable<HostedEveTransport["observe"]>>(async ({ onEvent }) => {
      await onEvent({ index: 0, text: "accepted", turnId: "turn_1", type: "assistant.message" });
      return {
        artifactProjectionRequiresLegacyReadback: false,
        installedEventCount: 1,
        pendingRequests: [],
        publicEventCount: 1,
        status: "waiting",
      };
    });
    const { adapter, service, sessionId } = await fixture(observe);
    adapter.sendAccepted = vi.fn(async () => {
      await Promise.resolve();
    });
    const result = await service.send({
      clientRequestId: randomUUID(),
      message: "continue",
      sessionId,
    });
    expect(result.events[0]).toMatchObject({ text: "accepted" });
    expect(adapter.sendAccepted).toHaveBeenCalledOnce();
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it("shows the saved page with a retry instruction when Eve readback times out", async () => {
    let reads = 0;
    const observe = vi.fn<NonNullable<HostedEveTransport["observe"]>>(async ({ onEvent }) => {
      reads += 1;
      if (reads > 1) {
        throw new HostedSessionReadTimeoutError();
      }
      await onEvent({ index: 0, text: "saved", turnId: "turn_1", type: "assistant.message" });
      return {
        artifactProjectionRequiresLegacyReadback: false,
        installedEventCount: 1,
        pendingRequests: [],
        publicEventCount: 1,
        status: "waiting",
      };
    });
    const { service, sessionId } = await fixture(observe);
    await service.get({ cursor: 0, limit: 1, sessionId });
    const delayed = await service.get({ cursor: 0, limit: 1, sessionId });
    expect(delayed.events[0]).toMatchObject({ text: "saved" });
    expect(delayed).toMatchObject({
      error: { code: "session_read_delayed" },
      inputRequests: [],
      status: "working",
    });
  });

  it("streams more than 100,000 public events through the private spool and serves a page", async () => {
    const observe = vi.fn<NonNullable<HostedEveTransport["observe"]>>(async ({ onEvent }) => {
      for (let index = 0; index < 100_001; index += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Verify callback backpressure for every event.
        await onEvent({
          index,
          text: `event ${index}`,
          turnId: "turn_1",
          type: "assistant.message",
        });
      }
      return {
        artifactProjectionRequiresLegacyReadback: false,
        installedEventCount: 100_001,
        pendingRequests: [],
        publicEventCount: 100_001,
        status: "waiting",
      };
    });
    const { adapter, observeSessionPaged, service, sessionId } = await fixture(observe);
    const result = await service.get({ cursor: 100_000, limit: 1, sessionId });
    expect(result.events).toEqual([
      { index: 100_000, text: "event 100000", turnId: "turn_1", type: "assistant_message" },
    ]);
    expect(result.cursor).toBe(100_001);
    expect(observeSessionPaged).toHaveBeenCalledOnce();
    expect(adapter.get).not.toHaveBeenCalled();
  }, 60_000);

  it("keeps every legacy request in a checkpoint larger than the inline format", async () => {
    const requests = Array.from({ length: 40 }, (_, index) => ({
      allowFreeform: true,
      description: `request ${index}: ${"x".repeat(16_000)}`,
      kind: "question" as const,
      requestId: `request_${index}`,
      title: `Question ${index}`,
    }));
    const observe = vi.fn<NonNullable<HostedEveTransport["observe"]>>(async () => {
      await Promise.resolve();
      return {
        artifactProjectionRequiresLegacyReadback: true,
        installedEventCount: 1,
        pendingRequests: requests,
        prototype: {
          content: "<html>Legacy preview</html>",
          digest: "a".repeat(64),
          mediaType: "text/html",
          path: "prototype/example/index.html",
          revision: "b".repeat(64),
        },
        publicEventCount: 0,
        status: "input_required",
      };
    });
    const { adapter, observeSessionPaged, service, sessionId } = await fixture(observe);
    const result = await service.get({ cursor: 0, limit: 1, sessionId });
    expect(result.inputRequests).toHaveLength(40);
    expect(result.prototype?.content).toBe("<html>Legacy preview</html>");
    expect(
      new TextEncoder().encode(JSON.stringify(observeSessionPaged.mock.calls[0]?.[0].metadata))
        .byteLength,
    ).toBeGreaterThan(512 * 1024);
    expect(adapter.get).not.toHaveBeenCalled();
  });

  it("replaces an interrupted adapter with a paged checkpoint and keeps its session ID", async () => {
    const initial = vi.fn<NonNullable<HostedEveTransport["observe"]>>(async ({ onEvent }) => {
      await onEvent({ index: 0, text: "old", turnId: "turn_1", type: "assistant.message" });
      return {
        artifactProjectionRequiresLegacyReadback: false,
        installedEventCount: 1,
        pendingRequests: [],
        publicEventCount: 1,
        status: "waiting",
      };
    });
    const { adapter, getSession, replaceSessionAdapterPaged, service, sessionId } =
      await fixture(initial);
    await service.get({ cursor: 0, limit: 1, sessionId });
    const before = await getSession(principal, sessionId);
    adapter.observe = vi.fn(async () => {
      await Promise.resolve();
      throw new HostedAdapterSessionUnavailableError();
    });
    adapter.start = vi.fn(async () => {
      await Promise.resolve();
      return {
        adapterSessionId: "replacement_adapter",
        snapshot: emptySnapshot,
      };
    });
    adapter.observeStarted = vi.fn<NonNullable<HostedEveTransport["observeStarted"]>>(
      async ({ onEvent }) => {
        for (let index = 0; index < 100_001; index += 1) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- Verify the replacement stream backpressures each event.
          await onEvent({
            index,
            text: `event ${index}`,
            turnId: "turn_2",
            type: "assistant.message",
          });
        }
        return {
          artifactProjectionRequiresLegacyReadback: false,
          installedEventCount: 100_001,
          pendingRequests: [],
          publicEventCount: 100_001,
          status: "waiting",
        };
      },
    );
    const result = await service.start({
      clientRequestId: randomUUID(),
      resumeSessionId: sessionId,
    });
    const after = await getSession(principal, sessionId);
    expect(result.sessionId).toBe(sessionId);
    expect(after).toMatchObject({ adapterGeneration: 2, adapterSessionId: "replacement_adapter" });
    expect(after?.version === 2 && after.checkpointRef?.eventCount).toBe(100_001);
    expect(before?.version === 2 && before.checkpointRef?.id).not.toBe(
      after?.version === 2 && after.checkpointRef?.id,
    );
    expect(replaceSessionAdapterPaged).toHaveBeenCalledOnce();
    expect(adapter.get).not.toHaveBeenCalled();
  }, 60_000);

  it("keeps the old checkpoint and adapter when paged replacement rejects a stale digest", async () => {
    const observe = vi.fn<NonNullable<HostedEveTransport["observe"]>>(async ({ onEvent }) => {
      await onEvent({ index: 0, text: "old", turnId: "turn_1", type: "assistant.message" });
      return {
        artifactProjectionRequiresLegacyReadback: false,
        installedEventCount: 1,
        pendingRequests: [],
        publicEventCount: 1,
        status: "waiting",
      };
    });
    const { adapter, getSession, replaceSessionAdapterPaged, service, sessionId } =
      await fixture(observe);
    await service.get({ cursor: 0, limit: 1, sessionId });
    const before = await getSession(principal, sessionId);
    adapter.observe = vi.fn(async () => {
      await Promise.resolve();
      throw new HostedAdapterSessionUnavailableError();
    });
    adapter.start = vi.fn(async () => {
      await Promise.resolve();
      return { adapterSessionId: "replacement", snapshot: emptySnapshot };
    });
    adapter.observeStarted = vi.fn<NonNullable<HostedEveTransport["observeStarted"]>>(async () => {
      await Promise.resolve();
      return {
        artifactProjectionRequiresLegacyReadback: false,
        installedEventCount: 0,
        pendingRequests: [],
        publicEventCount: 0,
        status: "waiting",
      };
    });
    replaceSessionAdapterPaged.mockImplementationOnce(async (input) => {
      for await (const event of input.events) {
        void event;
      }
      throw new Error("stale checkpoint digest");
    });
    await expect(
      service.start({ clientRequestId: randomUUID(), resumeSessionId: sessionId }),
    ).rejects.toThrow();
    expect(await getSession(principal, sessionId)).toEqual(before);
  });

  it("retains the previous checkpoint when staging fails and rejects another tenant before observation", async () => {
    const observe = vi.fn<NonNullable<HostedEveTransport["observe"]>>(async ({ onEvent }) => {
      await onEvent({ index: 0, text: "new", turnId: "turn_1", type: "assistant.message" });
      return {
        artifactProjectionRequiresLegacyReadback: false,
        installedEventCount: 1,
        pendingRequests: [],
        publicEventCount: 1,
        status: "waiting",
      };
    });
    const fixtureValue = await fixture(observe);
    const previous = await fixtureValue.base.getSession(principal, fixtureValue.sessionId);
    fixtureValue.observeSessionPaged.mockRejectedValueOnce(
      new Error("Injected stage interruption"),
    );
    await expect(
      fixtureValue.service.get({ cursor: 0, limit: 1, sessionId: fixtureValue.sessionId }),
    ).rejects.toThrow("Injected stage interruption");
    expect(await fixtureValue.base.getSession(principal, fixtureValue.sessionId)).toEqual(previous);
    const other = createHostedEveSessionService({
      principal: { ...principal, workspaceId: "other" },
      store: fixtureValue.base,
      transport: fixtureValue.adapter,
    });
    await expect(
      other.get({ cursor: 0, limit: 1, sessionId: fixtureValue.sessionId }),
    ).rejects.toBeInstanceOf(HostedSessionNotFoundError);
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it("uses the existing verified snapshot path when an artifact receipt is present", async () => {
    // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous observation contract.
    const observe = vi.fn<NonNullable<HostedEveTransport["observe"]>>(async () => ({
      artifactProjectionRequiresLegacyReadback: true,
      installedEventCount: 1,
      pendingRequests: [],
      publicEventCount: 0,
      status: "waiting",
    }));
    const { adapter, observeSessionPaged, service, sessionId } = await fixture(observe);
    const result = await service.get({ cursor: 0, limit: 1, sessionId });
    expect(result.status).toBe("waiting");
    expect(adapter.get).toHaveBeenCalledOnce();
    expect(observeSessionPaged).not.toHaveBeenCalled();
  });
});
