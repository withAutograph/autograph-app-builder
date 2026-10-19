import { z } from "zod";
import type { MessageStreamEvent } from "eve/client";
import { describe, expect, it, vi } from "vitest";
import { createHostedEveSessionService, HostedSubmissionUnknownError } from "./hosted-service";
import type { HostedEngineSnapshot, HostedEveTransport } from "./hosted-service";
import { hostedEveOperationScopes } from "./hosted-auth";
import type { HostedPrincipal } from "./hosted-auth";
import {
  bindSendDelivery,
  canProjectQueuedSendAcknowledgement,
  hostedOperationRecordSchema,
  InMemoryHostedEveStore,
  isProvedSendDelivery,
  mayReviveCancelledSession,
  toDurableHostedSessionRecord,
  durableHostedSessionRecordSchema,
} from "./hosted-store";
import type {
  HostedEveStore,
  HostedSessionRecord,
  HostedPagedCheckpointMetadata,
} from "./hosted-store";
import type { PublicEveEvent } from "../mcp/contracts";
import { digest, stableId } from "./hosted-operation-identifiers";
import { nativeDeliveryForEvents, provesNativeDelivery } from "./native-delivery-state";
import { projectInstalledEveEvent } from "./public-events";
import { createSameOriginEveTransport, observeSameOriginEveStream } from "./same-origin-http";

const principal = {
  audience: "autograph-app-builder",
  issuer: "https://identity.example.test",
  ownerUserId: "owner",
  scopes: Object.values(hostedEveOperationScopes),
  workspaceId: "workspace",
};
const turnEvent = (
  type: "turn.started" | "turn.completed",
  turnId: string,
  deliveryIds: string[],
): MessageStreamEvent => ({
  data: { sequence: 1, turnId },
  meta: { at: "2026-10-14T00:00:00Z", deliveryIds, id: `${type}:${turnId}` },
  type,
});
const waiting = (deliveryIds: string[] = []): MessageStreamEvent => ({
  data: { continuationToken: "native", wait: "next-user-message" },
  meta: { at: "2026-10-14T00:00:00Z", deliveryIds, id: "waiting" },
  type: "session.waiting",
});
const snapshot = (events: MessageStreamEvent[]): HostedEngineSnapshot => ({
  events: events.flatMap((event, index) => projectInstalledEveEvent(event, index)),
  nativeDeliveryState: nativeDeliveryForEvents(events),
  status: events.at(-1)?.type === "turn.started" ? "working" : "waiting",
});
const operationId = (clientRequestId: string) =>
  stableId("op", {
    clientRequestId,
    kind: "send",
    tenant: [principal.issuer, principal.audience, principal.workspaceId, principal.ownerUserId],
  });
const fixture = async (
  options: { acknowledge?: boolean; failReadback?: boolean; store?: InMemoryHostedEveStore } = {},
) => {
  const store = options.store ?? new InMemoryHostedEveStore();
  const diagnostics = vi.fn();
  let events: MessageStreamEvent[] = [waiting()];
  let failReadback = options.failReadback ?? false;
  // oxlint-disable-next-line eslint/require-await -- The authority fixture preserves its asynchronous contract.
  const owner = vi.fn(async () => {});
  // oxlint-disable-next-line eslint/require-await -- Native reads are asynchronous in this fixture.
  const get = vi.fn(async () => snapshot(events));
  const send = vi.fn<HostedEveTransport["send"]>(async (input) => {
    if (options.acknowledge !== false) {
      await input.onAccepted?.("ack");
    }
    if (failReadback) {
      throw new Error("Readback failed after ACK");
    }
    return snapshot(events);
  });
  const adapter: HostedEveTransport = {
    cancel: get,
    get,
    respond: get,
    send,
    // oxlint-disable-next-line eslint/require-await -- Preserve native asynchronous start acceptance.
    start: vi.fn(async () => ({ adapterSessionId: "native", snapshot: snapshot(events) })),
  };
  const create = () =>
    createHostedEveSessionService({
      assertSendDeliveryOwner: owner,
      onSubmissionDiagnostic: diagnostics,
      principal,
      store,
      transport: adapter,
    });
  const started = await create().start({ clientRequestId: "start", prompt: "App" });
  const request = { clientRequestId: "send", message: "Continue", sessionId: started.sessionId };
  return {
    adapter,
    getEvents: () => events,
    create,
    diagnostics,
    operation: async () =>
      await store.getPrivateOperation(principal, operationId(request.clientRequestId)),
    owner,
    request,
    send,
    setEvents: (next: MessageStreamEvent[]) => {
      events = next;
      failReadback = false;
    },
    store,
  };
};

class PagedSendDiagnosticStore extends InMemoryHostedEveStore {
  private paged: HostedSessionRecord | undefined;
  private metadata: HostedPagedCheckpointMetadata | undefined;
  private events: PublicEveEvent[] = [];
  private revision = 0;

  constructor(queuedAcknowledgements = false) {
    super();
    if (!queuedAcknowledgements) {
      this.readUnsettledSendAcknowledgements = undefined;
    }
  }

  override async getSession(candidate: HostedPrincipal, sessionId: string) {
    const owned = await super.getSession(candidate, sessionId);
    if (owned === null || this.paged === undefined) {
      return owned;
    }
    if (
      owned.status === "cancelled" ||
      (owned.version === 2 &&
        this.paged.version === 2 &&
        owned.adapterGeneration !== this.paged.adapterGeneration)
    ) {
      return owned;
    }
    return {
      ...this.paged,
      ...(owned.version === 2 ? { cancellationRevision: owned.cancellationRevision } : {}),
    };
  }
  observeSessionPaged: NonNullable<HostedEveStore["observeSessionPaged"]> = async (input) => {
    const current = await this.getSession(input.principal, input.sessionId);
    if (current?.version !== 2 || current.checkpointDigest !== input.expectedCheckpointDigest) {
      throw new Error("Fixture checkpoint mismatch");
    }
    if (current.status === "cancelled") {
      return current;
    }
    const events: PublicEveEvent[] = [];
    for await (const event of input.events) {
      events.push(event);
    }
    this.events = events;
    this.metadata = input.metadata;
    this.revision += 1;
    const checkpointDigest = digest({ revision: this.revision });
    const { checkpoint, ...withoutInline } = current;
    void checkpoint;
    this.paged = durableHostedSessionRecordSchema.parse({
      ...withoutInline,
      checkpointDigest,
      checkpointProgressDigest: digest(events),
      checkpointRef: {
        id: "9b7a1463-3626-4730-bcbf-b2c226cc1c45",
        digest: checkpointDigest,
        eventCount: events.length,
      },
      lastProgressAtEpochMs: input.nowEpochMs,
      updatedAtEpochMs: input.nowEpochMs,
      resumability: input.resumability,
      stage: input.stage,
      status: input.metadata.status,
    });
    return this.paged;
  };
  readCheckpointPage: NonNullable<HostedEveStore["readCheckpointPage"]> = (input) => {
    if (
      this.metadata === undefined ||
      this.paged?.version !== 2 ||
      this.paged.checkpointRef?.digest !== input.checkpointRef.digest
    ) {
      return Promise.reject(new Error("Unknown fixture checkpoint"));
    }
    const events = this.events.slice(input.cursor, input.cursor + input.limit);
    return Promise.resolve({
      checkpointDigest: input.checkpointRef.digest,
      cursor: input.cursor + events.length,
      events,
      metadata: this.metadata,
      totalEvents: this.events.length,
    });
  };
}

const attachPagedTransport = (f: Awaited<ReturnType<typeof fixture>>) => {
  let deliverySequence = 0;
  const observe = vi.fn<NonNullable<HostedEveTransport["observe"]>>(
    async (input) =>
      await observeSameOriginEveStream({
        config: { baseUrl: "https://builder.example.test", timeoutMs: 1000 },
        workloadIdentity: { token: () => Promise.resolve("synthetic-oidc") },
        fetchImplementation: (url) => {
          const start = Number(
            new URL(url instanceof Request ? url.url : url).searchParams.get("startIndex") ?? 0,
          );
          return Promise.resolve(
            new Response(
              `${f
                .getEvents()
                .slice(start)
                .map((event) => JSON.stringify(event))
                .join("\n")}\n`,
              {
                headers: {
                  "content-type": "application/x-ndjson",
                  "x-eve-session-id": "native",
                  "x-eve-stream-format": "ndjson",
                  "x-eve-stream-tail-index": String(f.getEvents().length - 1),
                  "x-eve-stream-version": "25",
                },
              },
            ),
          );
        },
        onEvent: input.onEvent,
        onPrivateEvent: input.onPrivateEvent,
        sessionId: input.adapterSessionId,
        nativeObservationState: input.nativeObservationState,
      }),
  );
  f.adapter.observe = observe;
  const accepted = vi.fn<NonNullable<HostedEveTransport["sendAccepted"]>>(async (input) => {
    deliverySequence += 1;
    await input.onAccepted?.(deliverySequence === 1 ? "ack" : `ack-${deliverySequence}`);
  });
  f.adapter.sendAccepted = accepted;
  return { observe, accepted };
};
const queuedFixture = async () => {
  const f = await fixture({ store: new PagedSendDiagnosticStore(true) });
  return { ...f, ...attachPagedTransport(f) };
};

describe("canonical SEND delivery acknowledgement", () => {
  it("acknowledges saved queued SEND and keeps GET working until exact native start without replay", async () => {
    const f = await queuedFixture();
    const submitted = await f.create().send(f.request);
    expect(submitted).toMatchObject({ status: "working", events: [] });
    expect(submitted.error).toBeUndefined();
    expect(f.observe).toHaveBeenCalledTimes(2);
    expect(f.accepted).toHaveBeenCalledOnce();
    expect(await f.operation()).toMatchObject({
      state: "submission_unknown",
      sendDelivery: { deliveryId: "ack" },
    });
    expect(JSON.stringify(await f.operation())).not.toContain("cancellationRevisionAtDispatch");
    const saved = await f.store.getSession(principal, f.request.sessionId);
    expect(saved?.status).toBe("waiting");
    expect(
      await f.create().get({ sessionId: f.request.sessionId, cursor: 0, limit: 100 }),
    ).toMatchObject({ status: "working" });
    expect(await f.create().send(f.request)).toMatchObject({ status: "working" });
    expect(f.accepted).toHaveBeenCalledOnce();
    expect(await f.operation()).toMatchObject({ state: "submission_unknown" });
    f.setEvents([...f.getEvents(), turnEvent("turn.started", "delivered", ["ack"])]);
    expect(
      await f.create().get({ sessionId: f.request.sessionId, cursor: 0, limit: 100 }),
    ).toMatchObject({ status: "working" });
    expect(await f.operation()).toMatchObject({ state: "succeeded" });
    expect(f.accepted).toHaveBeenCalledOnce();
    f.setEvents([
      ...f.getEvents(),
      turnEvent("turn.completed", "delivered", ["ack"]),
      waiting(["ack"]),
    ]);
    expect(
      await f.create().get({ sessionId: f.request.sessionId, cursor: 0, limit: 100 }),
    ).toMatchObject({ status: "waiting" });
  });
  it.each(["before-ack", "after-ack"] as const)(
    "preserves a newer Stop %s and never replays SEND",
    async (when) => {
      const f = await queuedFixture();
      f.accepted.mockImplementationOnce(async (input) => {
        if (when === "after-ack") {
          await input.onAccepted?.("ack");
        }
        await f.store.recordCancellationIntent({
          principal,
          sessionId: f.request.sessionId,
          nowEpochMs: Date.now(),
        });
        if (when === "before-ack") {
          await input.onAccepted?.("ack");
        }
      });
      await expect(f.create().send(f.request)).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
      expect(await f.store.getSession(principal, f.request.sessionId)).toMatchObject({
        cancellationRevision: 1,
      });
      await expect(f.create().send(f.request)).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
      expect(f.accepted).toHaveBeenCalledOnce();
      expect(await f.operation()).toMatchObject({ state: "submission_unknown" });
    },
  );
  it("lets an observed Stop win over an earlier queued ACK on GET", async () => {
    const f = await queuedFixture();
    await f.create().send(f.request);
    await f.store.recordCancellationIntent({
      principal,
      sessionId: f.request.sessionId,
      nowEpochMs: Date.now(),
    });
    await f.store.observeSession({
      principal,
      sessionId: f.request.sessionId,
      checkpoint: { capturedAtEpochMs: Date.now(), events: [], status: "cancelled", version: 1 },
      nowEpochMs: Date.now(),
      resumability: "terminal",
      stage: "needs_attention",
    });
    expect(
      await f.create().get({ sessionId: f.request.sessionId, cursor: 0, limit: 100 }),
    ).toMatchObject({ status: "cancelled" });
    expect(f.accepted).toHaveBeenCalledOnce();
    expect(await f.operation()).toMatchObject({ state: "submission_unknown" });
  });
  it.each(["input_required", "completed", "failed"] as const)(
    "preserves actual %s ahead of queued projection",
    async (status) => {
      const f = await queuedFixture();
      await f.create().send(f.request);
      const original = f.observe.getMockImplementation();
      if (original === undefined) {
        throw new Error("Missing observer fixture");
      }
      const question = {
        allowFreeform: true,
        kind: "question" as const,
        requestId: "real-question",
        title: "Which account?",
      };
      f.observe.mockImplementationOnce(async (input) => {
        const observed = await original(input);
        if (observed.nativeObservationState === undefined) {
          throw new Error("Missing reducer checkpoint");
        }
        return {
          ...observed,
          status,
          pendingRequests: status === "input_required" ? [question] : [],
          nativeObservationState: {
            ...observed.nativeObservationState,
            boundary: status,
            pendingRequests: status === "input_required" ? [question] : [],
          },
        };
      });
      const result = await f
        .create()
        .get({ sessionId: f.request.sessionId, cursor: 0, limit: 100 });
      expect(result.status).toBe(status);
      if (status === "input_required") {
        expect(result.inputRequests).toEqual([question]);
      }
      expect(await f.operation()).toMatchObject({ state: "submission_unknown" });
      expect(f.accepted).toHaveBeenCalledOnce();
    },
  );
  it("keeps an incomplete post-ACK native read unknown without replay", async () => {
    const f = await queuedFixture();
    const original = f.observe.getMockImplementation();
    if (original === undefined) {
      throw new Error("Missing observer fixture");
    }
    f.observe.mockImplementationOnce(original).mockImplementationOnce(async (input) => ({
      ...(await original(input)),
      observationComplete: false,
    }));
    await expect(f.create().send(f.request)).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    expect(await f.operation()).toMatchObject({
      state: "submission_unknown",
      sendDelivery: { deliveryId: "ack" },
    });
    expect(f.accepted).toHaveBeenCalledOnce();
    expect(f.observe).toHaveBeenCalledTimes(2);
  });
  it("does not project a queued ACK after the adapter binding is replaced", async () => {
    const f = await queuedFixture();
    f.accepted.mockImplementationOnce(async (input) => {
      await input.onAccepted?.("ack");
      const stored = await f.store.getSession(principal, f.request.sessionId);
      if (stored === null) {
        throw new Error("Missing session fixture");
      }
      const current = toDurableHostedSessionRecord(stored);
      await f.store.replaceSessionAdapter({
        principal,
        sessionId: f.request.sessionId,
        adapterSessionId: "replacement",
        expectedAdapterGeneration: current.adapterGeneration,
        expectedCheckpointDigest: toDurableHostedSessionRecord(
          (await f.store.getSession(principal, f.request.sessionId)) ?? stored,
        ).checkpointDigest,
        checkpoint: { capturedAtEpochMs: Date.now(), events: [], status: "waiting", version: 1 },
        nowEpochMs: Date.now(),
        resumability: "live",
        stage: "planning",
      });
    });
    await expect(f.create().send(f.request)).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    expect(f.accepted).toHaveBeenCalledOnce();
    expect(await f.operation()).toMatchObject({ state: "submission_unknown" });
  });
  it("does not lose the earlier queued ACK when another valid SEND is accepted", async () => {
    const f = await queuedFixture();
    await f.create().send(f.request);
    await f
      .create()
      .send({ ...f.request, clientRequestId: "second-send", message: "Additional direction" });
    expect(f.accepted).toHaveBeenCalledTimes(2);
    f.setEvents([
      ...f.getEvents(),
      turnEvent("turn.started", "first-delivered", ["ack"]),
      turnEvent("turn.completed", "first-delivered", ["ack"]),
      waiting(["ack"]),
    ]);
    expect(
      await f.create().get({ sessionId: f.request.sessionId, cursor: 0, limit: 100 }),
    ).toMatchObject({ status: "working" });
    expect(await f.operation()).toMatchObject({ state: "succeeded" });
    expect(await f.store.getPrivateOperation(principal, operationId("second-send"))).toMatchObject({
      state: "submission_unknown",
      sendDelivery: { deliveryId: "ack-2" },
    });
    expect(f.accepted).toHaveBeenCalledTimes(2);
  });
  it("does not backfill an older ACK baseline or project it over native waiting", async () => {
    const f = await queuedFixture();
    const record = f.store.recordSendDelivery.bind(f.store);
    vi.spyOn(f.store, "recordSendDelivery").mockImplementation((input) => {
      const { cancellationRevisionAtDispatch, ...legacy } = input;
      void cancellationRevisionAtDispatch;
      return record(legacy);
    });
    await expect(f.create().send(f.request)).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    const operation = hostedOperationRecordSchema.parse(await f.operation());
    if (operation.sendDelivery === undefined) {
      throw new Error("Missing fixture ACK");
    }
    await record({
      principal,
      operationId: operation.operationId,
      delivery: operation.sendDelivery,
      cancellationRevisionAtDispatch: 0,
      nowEpochMs: Date.now(),
    });
    const page = await f.store.readUnsettledSendAcknowledgements?.({
      principal,
      sessionId: f.request.sessionId,
      limit: 1,
    });
    expect(page?.acknowledgements[0]?.cancellationRevisionAtDispatch).toBeNull();
    expect(
      await f.create().get({ sessionId: f.request.sessionId, cursor: 0, limit: 100 }),
    ).toMatchObject({ status: "waiting" });
    expect(f.accepted).toHaveBeenCalledOnce();
  });
  it("does not recover queued acceptance from an unreadable ACK view or revoked owner", async () => {
    const f = await queuedFixture();
    await f.create().send(f.request);
    const read = f.store.readUnsettledSendAcknowledgements;
    if (read === undefined) {
      throw new Error("Missing ACK reader");
    }
    f.store.readUnsettledSendAcknowledgements = () => Promise.reject(new Error("Unavailable"));
    await expect(f.create().send(f.request)).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    f.store.readUnsettledSendAcknowledgements = read;
    f.owner.mockRejectedValue(new Error("Owner revoked"));
    await expect(f.create().send(f.request)).rejects.toThrow();
    expect(f.accepted).toHaveBeenCalledOnce();
    expect(await f.operation()).toMatchObject({ state: "submission_unknown" });
  });
  it("rechecks Stop arriving during final queued ACK materialization", async () => {
    const f = await queuedFixture();
    await f.create().send(f.request);
    const read = f.store.readUnsettledSendAcknowledgements;
    if (read === undefined) {
      throw new Error("Missing ACK reader");
    }
    f.store.readUnsettledSendAcknowledgements = async (input) => {
      const page = await read(input);
      if (input.operationId !== undefined) {
        await f.store.recordCancellationIntent({
          principal,
          sessionId: f.request.sessionId,
          nowEpochMs: Date.now(),
        });
        await f.store.observeSession({
          principal,
          sessionId: f.request.sessionId,
          checkpoint: {
            capturedAtEpochMs: Date.now(),
            events: [],
            status: "cancelled",
            version: 1,
          },
          nowEpochMs: Date.now(),
          resumability: "terminal",
          stage: "needs_attention",
        });
      }
      return page;
    };
    expect(
      await f.create().get({ sessionId: f.request.sessionId, cursor: 0, limit: 100 }),
    ).toMatchObject({ status: "cancelled" });
    expect(f.accepted).toHaveBeenCalledOnce();
    expect(await f.operation()).toMatchObject({ state: "submission_unknown" });
  });
  it("paginates all tenant/session queued ACKs and retains baselines outside operation JSON", async () => {
    const f = await queuedFixture();
    await f.create().send(f.request);
    await f
      .create()
      .send({ ...f.request, clientRequestId: "another-send", message: "More direction" });
    const read = f.store.readUnsettledSendAcknowledgements;
    if (read === undefined) {
      throw new Error("Missing ACK reader");
    }
    const first = await read({ principal, sessionId: f.request.sessionId, limit: 1 });
    expect(first.acknowledgements).toHaveLength(1);
    expect(first.nextCursor).toBeDefined();
    const second = await read({
      principal,
      sessionId: f.request.sessionId,
      cursor: first.nextCursor,
      limit: 1,
    });
    expect(second.acknowledgements).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
    expect(second.acknowledgements[0]?.operation.operationId).not.toBe(
      first.acknowledgements[0]?.operation.operationId,
    );
    expect(
      [...first.acknowledgements, ...second.acknowledgements].map(
        (ack) => ack.cancellationRevisionAtDispatch,
      ),
    ).toEqual([0, 0]);
    expect(
      await read({
        principal: { ...principal, ownerUserId: "foreign" },
        sessionId: f.request.sessionId,
        limit: 1,
      }),
    ).toEqual({ acknowledgements: [] });
    expect(await read({ principal, sessionId: "foreign-session", limit: 1 })).toEqual({
      acknowledgements: [],
    });
    const exact = await read({
      principal,
      sessionId: f.request.sessionId,
      operationId: operationId(f.request.clientRequestId),
      limit: 1,
    });
    expect(exact.acknowledgements).toHaveLength(1);
    const operation = hostedOperationRecordSchema.parse(await f.operation());
    if (operation.sendDelivery === undefined) {
      throw new Error("Missing fixture ACK");
    }
    await expect(
      f.store.recordSendDelivery({
        principal,
        operationId: operation.operationId,
        delivery: operation.sendDelivery,
        cancellationRevisionAtDispatch: 1,
        nowEpochMs: Date.now(),
      }),
    ).rejects.toThrow();
    expect(JSON.stringify(operation)).not.toContain("cancellationRevisionAtDispatch");
  });
  it("rejects final ACK readback changing the canonical request binding", async () => {
    const f = await queuedFixture();
    await f.create().send(f.request);
    const read = f.store.readUnsettledSendAcknowledgements;
    if (read === undefined) {
      throw new Error("Missing ACK reader");
    }
    let exactReads = 0;
    f.store.readUnsettledSendAcknowledgements = async (input) => {
      const page = await read(input);
      if (input.operationId !== undefined) {
        exactReads += 1;
      }
      return exactReads < 2
        ? page
        : {
            ...page,
            acknowledgements: page.acknowledgements.map((ack) => ({
              ...ack,
              operation: { ...ack.operation, clientRequestId: "another-request" },
            })),
          };
    };
    await expect(f.create().send(f.request)).rejects.toThrow();
    expect(f.accepted).toHaveBeenCalledOnce();
    expect(await f.operation()).toMatchObject({ state: "submission_unknown" });
  });
  it.each([
    "missing-baseline",
    "cancel-revision",
    "observed-generation",
    "foreign-owner",
    "wrong-digest",
    "incomplete",
    "missing-tail",
    "not-at-tail",
  ] as const)(
    "denies queued projection for %s without changing exact native proof",
    async (fault) => {
      const f = await queuedFixture();
      const result = await f.create().send(f.request);
      const current = await f.store.getSession(principal, f.request.sessionId);
      const page = await f.store.readUnsettledSendAcknowledgements?.({
        principal,
        sessionId: f.request.sessionId,
        limit: 1,
      });
      const acknowledgement = page?.acknowledgements[0];
      if (current === null || acknowledgement === undefined) {
        throw new Error("Missing queued fixture");
      }
      const durable = toDurableHostedSessionRecord(current);
      const candidate: Parameters<typeof canProjectQueuedSendAcknowledgement>[0] = {
        acknowledgement,
        current,
        result,
        observation: {
          nativeStartIndex: 1,
          nativeNextIndex: 1,
          nativeTailIndex: 0,
          observationComplete: true,
          currentTurnPresent: false,
        },
        observedBinding: {
          adapterSessionId: durable.adapterSessionId,
          adapterGeneration: durable.adapterGeneration,
          cancellationRevision: 0,
        },
      };
      expect(canProjectQueuedSendAcknowledgement(candidate)).toBe(true);
      switch (fault) {
        case "missing-baseline": {
          candidate.acknowledgement = { ...acknowledgement, cancellationRevisionAtDispatch: null };
          break;
        }
        case "cancel-revision": {
          candidate.current = { ...durable, cancellationRevision: 1 };
          break;
        }
        case "observed-generation": {
          candidate.observedBinding.adapterGeneration += 1;
          break;
        }
        case "foreign-owner": {
          candidate.current = { ...durable, principal: { ...principal, ownerUserId: "foreign" } };
          break;
        }
        case "wrong-digest": {
          candidate.acknowledgement = {
            ...acknowledgement,
            operation: { ...acknowledgement.operation, requestDigest: `sha256:${"f".repeat(64)}` },
          };
          break;
        }
        case "incomplete": {
          candidate.observation.observationComplete = false;
          break;
        }
        case "missing-tail": {
          delete candidate.observation.nativeTailIndex;
          break;
        }
        case "not-at-tail": {
          candidate.observation.nativeNextIndex = 0;
          break;
        }
        default: {
          throw new Error("Unknown guard fixture");
        }
      }
      expect(canProjectQueuedSendAcknowledgement(candidate)).toBe(false);
      expect(f.accepted).toHaveBeenCalledOnce();
    },
  );
  it.each([true, false])(
    "reports the exact post-ACK paged read with stamped metadata %s and no additional native reads",
    async (stamped) => {
      const f = await fixture({ store: new PagedSendDiagnosticStore() });
      f.setEvents([
        turnEvent("turn.started", "unrelated-active-turn", stamped ? ["unrelated-delivery"] : []),
      ]);
      const { observe } = attachPagedTransport(f);
      await expect(f.create().send(f.request)).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
      expect(f.diagnostics).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "delivery_boundary_unobserved",
          phase: "send_delivery_boundary",
          sendDeliveryObservation: {
            ackObserved: true,
            sameAdapterSession: true,
            sameAdapterGeneration: true,
            nativeDeliveryStatePresent: stamped,
            nativeTurnCount: stamped ? 1 : 0,
            deliveryTurnMatchCount: 0,
            startedStampMatchCount: 0,
            boundaryStampMatchCount: 0,
            startedOrBoundaryMatch: false,
            currentTurnPresent: true,
            nativeReadObserved: true,
            nativeRead: {
              nativeStartIndex: 1,
              nativeNextIndex: 1,
              nativeTailIndex: 0,
              observationComplete: true,
              currentTurnPresent: true,
            },
          },
        }),
      );
      expect(observe).toHaveBeenCalledTimes(2);
      expect(f.adapter.sendAccepted).toHaveBeenCalledOnce();
      expect(f.send).not.toHaveBeenCalled();
      expect(await f.operation()).toMatchObject({
        state: "submission_unknown",
        sendDelivery: { deliveryId: "ack" },
      });
      expect(JSON.stringify(f.diagnostics.mock.calls)).not.toContain("unrelated-active-turn");
      expect(JSON.stringify(f.diagnostics.mock.calls)).not.toContain("unrelated-delivery");
    },
  );
  const cancelledFixture = async (failReadback = false) => {
    const f = await fixture({ failReadback });
    await f.store.observeSession({
      checkpoint: { capturedAtEpochMs: 10, events: [], status: "cancelled", version: 1 },
      nowEpochMs: Date.now(),
      principal,
      resumability: "terminal",
      sessionId: f.request.sessionId,
      stage: "needs_attention",
    });
    await f.store.recordCancellationIntent({
      nowEpochMs: Date.now(),
      principal,
      sessionId: f.request.sessionId,
    });
    return f;
  };
  it("keeps ordinary reads and ACK alone cancelled, then resumes the same session from its delayed exact SEND proof", async () => {
    const f = await cancelledFixture(true);
    const before = await f.store.getSession(principal, f.request.sessionId);
    await f.create().get({ cursor: 0, limit: 100, sessionId: f.request.sessionId });
    expect(await f.store.getSession(principal, f.request.sessionId)).toMatchObject({
      cancellationRevision: 1,
      status: "cancelled",
    });
    await expect(f.create().send(f.request)).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    expect(await f.operation()).toMatchObject({
      sendDelivery: { resumeCancellationRevision: 1 },
      state: "submission_unknown",
    });
    expect(await f.store.getSession(principal, f.request.sessionId)).toMatchObject({
      status: "cancelled",
    });
    f.setEvents([turnEvent("turn.started", "resumed", ["ack"])]);
    await f.create().get({ cursor: 0, limit: 100, sessionId: f.request.sessionId });
    expect(await f.store.getSession(principal, f.request.sessionId)).toMatchObject({
      cancellationRevision: 1,
      status: "cancelled",
    });
    await expect(f.create().send(f.request)).resolves.toMatchObject({
      sessionId: f.request.sessionId,
      status: "working",
    });
    expect(await f.store.getSession(principal, f.request.sessionId)).toMatchObject({
      adapterGeneration: 1,
      adapterSessionId: before?.adapterSessionId,
      cancellationRevision: 1,
      sessionId: f.request.sessionId,
      status: "working",
    });
    expect(f.send).toHaveBeenCalledOnce();
  });
  it.each(["before ACK", "after ACK"])(
    "lets a newer Stop win %s and on an exact SEND retry",
    async (when) => {
      const f = await cancelledFixture();
      f.setEvents([turnEvent("turn.started", "resumed", ["ack"])]);
      const stop = async () =>
        await f.store.recordCancellationIntent({
          nowEpochMs: Date.now(),
          principal,
          sessionId: f.request.sessionId,
        });
      f.send.mockImplementation(async (input) => {
        if (when === "before ACK") {
          await stop();
        }
        await input.onAccepted?.("ack");
        if (when === "after ACK") {
          await stop();
        }
        return snapshot([turnEvent("turn.started", "resumed", ["ack"])]);
      });
      try {
        await f.create().send(f.request);
      } catch (error) {
        expect(error).toBeInstanceOf(HostedSubmissionUnknownError);
      }
      try {
        await f.create().send(f.request);
      } catch (error) {
        expect(error).toBeInstanceOf(HostedSubmissionUnknownError);
      }
      expect(await f.store.getSession(principal, f.request.sessionId)).toMatchObject({
        cancellationRevision: 2,
        sessionId: f.request.sessionId,
        status: "cancelled",
      });
      expect(f.send).toHaveBeenCalledOnce();
    },
  );
  it("requires the same owner, adapter, cancellation revision and stamped delivery to revive", async () => {
    const f = await cancelledFixture(true);
    await expect(f.create().send(f.request)).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    const operation = hostedOperationRecordSchema.parse(await f.operation());
    const stored = await f.store.getSession(principal, f.request.sessionId);
    if (stored === null) {
      throw new Error("Missing cancelled fixture session");
    }
    const current = toDurableHostedSessionRecord(stored);
    const proof = nativeDeliveryForEvents([turnEvent("turn.started", "resumed", ["ack"])]);
    expect(mayReviveCancelledSession(operation, current, proof)).toBe(true);
    expect(mayReviveCancelledSession(null, current, proof)).toBe(false);
    expect(mayReviveCancelledSession(operation, current)).toBe(false);
    expect(
      mayReviveCancelledSession(operation, { ...current, cancellationRevision: 2 }, proof),
    ).toBe(false);
    expect(
      mayReviveCancelledSession(
        operation,
        { ...current, adapterGeneration: 2, adapterSessionId: "other" },
        proof,
      ),
    ).toBe(false);
    expect(
      mayReviveCancelledSession(
        operation,
        { ...current, principal: { ...principal, ownerUserId: "other" } },
        proof,
      ),
    ).toBe(false);
    expect(
      mayReviveCancelledSession(
        hostedOperationRecordSchema.parse({
          clientRequestId: operation.clientRequestId,
          createdAtEpochMs: operation.createdAtEpochMs,
          kind: "send",
          operationId: operation.operationId,
          principal,
          requestDigest: operation.requestDigest,
          sendDelivery: operation.sendDelivery,
          sessionId: current.sessionId,
          state: "succeeded",
          updatedAtEpochMs: operation.updatedAtEpochMs,
          version: 1,
          result: { cursor: 0, events: [], sessionId: current.sessionId, status: "waiting" },
        }),
        current,
        proof,
      ),
    ).toBe(false);
  });
  it("keeps an ACK durable before readback failure, then settles only its delayed coalesced turn without another POST", async () => {
    const f = await fixture({ failReadback: true });
    await expect(f.create().send(f.request)).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    expect(await f.operation()).toMatchObject({
      sendDelivery: {
        adapterGeneration: 1,
        adapterSessionId: "native",
        deliveryId: "ack",
        requestDigest: digest({ kind: "send", request: f.request, sessionId: f.request.sessionId }),
        sessionId: f.request.sessionId,
      },
      state: "submission_unknown",
    });
    f.setEvents([
      waiting(),
      turnEvent("turn.started", "other", ["other-ack"]),
      turnEvent("turn.completed", "other", ["other-ack"]),
      waiting(),
    ]);
    await expect(f.create().send(f.request)).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    expect(f.send).toHaveBeenCalledOnce();
    f.setEvents([
      waiting(),
      turnEvent("turn.started", "ours", ["other-ack", "ack"]),
      turnEvent("turn.completed", "ours", ["other-ack", "ack"]),
      waiting(),
    ]);
    const result = await f.create().send(f.request);
    expect(result.status).toBe("waiting");
    expect(JSON.stringify(result)).not.toContain('"deliveryId"');
    expect(await f.operation()).toMatchObject({ state: "succeeded" });
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.owner).toHaveBeenCalled();
  });
  it("does not settle from an unrelated changed WAITING checkpoint", async () => {
    const f = await fixture();
    f.setEvents([
      turnEvent("turn.started", "old", ["not-our-ack"]),
      turnEvent("turn.completed", "old", ["not-our-ack"]),
      waiting(),
    ]);
    await expect(f.create().send(f.request)).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    expect(await f.operation()).toMatchObject({ state: "submission_unknown" });
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "delivery_boundary_unobserved",
        operationKind: "send",
        phase: "send_delivery_boundary",
        sendDeliveryObservation: {
          ackObserved: true,
          sameAdapterSession: true,
          sameAdapterGeneration: true,
          nativeDeliveryStatePresent: true,
          nativeTurnCount: 1,
          deliveryTurnMatchCount: 0,
          startedStampMatchCount: 0,
          boundaryStampMatchCount: 0,
          startedOrBoundaryMatch: false,
          currentTurnPresent: false,
          nativeReadObserved: false,
        },
      }),
    );
  });
  it("acknowledges the exact native turn start while work is running and never posts the same CID again", async () => {
    const f = await fixture();
    f.setEvents([turnEvent("turn.started", "ours", ["ack", "neighbor"])]);
    const result = await f.create().send(f.request);
    expect(result.status).toBe("working");
    expect(await f.operation()).toMatchObject({
      state: "succeeded",
      result: { status: "working" },
    });
    expect(await f.create().send(f.request)).toEqual(result);
    expect(f.send).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('"deliveryId"');
    expect(f.diagnostics).not.toHaveBeenCalled();
  });
  it("reconciles a delayed native turn start after ACK readback failed without another POST", async () => {
    const f = await fixture({ failReadback: true });
    await expect(f.create().send(f.request)).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    f.setEvents([turnEvent("turn.started", "ours", ["ack"])]);
    await expect(f.create().send(f.request)).resolves.toMatchObject({ status: "working" });
    expect(await f.operation()).toMatchObject({ state: "succeeded" });
    expect(f.send).toHaveBeenCalledOnce();
  });
  it("observes from the supplied cursor after recovering an exact SEND without changing its settled receipt", async () => {
    const f = await fixture({ failReadback: true });
    await expect(f.create().send(f.request)).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    const observed = {
      ...snapshot([turnEvent("turn.started", "ours", ["ack"])]),
      events: Array.from({ length: 151 }, (_, index) => ({
        index,
        text: `Reply ${index}`,
        turnId: "ours",
        type: "assistant.message",
      })),
    };
    vi.mocked(f.adapter.get).mockResolvedValue(observed);
    const result = await f.create().send({ ...f.request, observationCursor: 150 });
    expect(result.cursor).toBe(151);
    expect(result.events.map((event) => event.index)).toEqual([150]);
    const settled = await f.operation();
    if (settled?.state !== "succeeded") {
      throw new Error("The recovered SEND did not settle in its canonical operation.");
    }
    expect(settled).toMatchObject({ state: "succeeded", result: { cursor: 100 } });
    expect(settled?.requestDigest).toBe(
      digest({ kind: "send", request: f.request, sessionId: f.request.sessionId }),
    );
    const later = {
      ...observed,
      events: [
        ...observed.events,
        { index: 151, text: "Later reply", turnId: "ours", type: "assistant.message" },
      ],
    };
    vi.mocked(f.adapter.get).mockResolvedValue(later);
    const fresh = await f.create().send({ ...f.request, observationCursor: result.cursor });
    expect(fresh.events.map((event) => event.index)).toEqual([151]);
    expect(fresh.cursor).toBe(152);
    expect(await f.operation()).toEqual(settled);
    expect(await f.create().send(f.request)).toEqual(settled.result);
    expect(f.send).toHaveBeenCalledOnce();
  });

  it("does not promote an unproved SEND when an observation cursor is supplied", async () => {
    const f = await fixture({ failReadback: true });
    await expect(f.create().send({ ...f.request, observationCursor: 0 })).rejects.toBeInstanceOf(
      HostedSubmissionUnknownError,
    );
    await expect(f.create().send({ ...f.request, observationCursor: 1 })).rejects.toBeInstanceOf(
      HostedSubmissionUnknownError,
    );
    expect(await f.operation()).toMatchObject({ state: "submission_unknown" });
    expect(f.send).toHaveBeenCalledOnce();
  });

  it("keeps a newer Stop authoritative when observing a settled SEND", async () => {
    const f = await fixture();
    f.setEvents([turnEvent("turn.started", "ours", ["ack"])]);
    await f.create().send(f.request);
    await f.store.observeSession({
      checkpoint: { capturedAtEpochMs: Date.now(), events: [], status: "cancelled", version: 1 },
      nowEpochMs: Date.now(),
      principal,
      resumability: "terminal",
      sessionId: f.request.sessionId,
      stage: "needs_attention",
    });
    await f.store.recordCancellationIntent({
      nowEpochMs: Date.now(),
      principal,
      sessionId: f.request.sessionId,
    });
    const result = await f.create().send({ ...f.request, observationCursor: 0 });
    expect(result.status).toBe("cancelled");
    expect(await f.store.getSession(principal, f.request.sessionId)).toMatchObject({
      status: "cancelled",
    });
    expect(f.send).toHaveBeenCalledOnce();
  });

  it("requires current owner and tenant access before observing a cached SEND", async () => {
    const f = await fixture();
    f.setEvents([turnEvent("turn.started", "ours", ["ack"])]);
    await f.create().send(f.request);
    f.owner.mockRejectedValue(new Error("Owner revoked"));
    await expect(f.create().send({ ...f.request, observationCursor: 0 })).rejects.toThrow(
      "Owner revoked",
    );
    const other = createHostedEveSessionService({
      assertSendDeliveryOwner: f.owner,
      principal: { ...principal, ownerUserId: "another-owner" },
      store: f.store,
      transport: f.adapter,
    });
    await expect(other.send({ ...f.request, observationCursor: 0 })).rejects.toThrow();
    expect(f.send).toHaveBeenCalledOnce();
  });
  it("does not infer native acceptance from generic running-turn membership", async () => {
    const f = await fixture();
    f.setEvents([
      turnEvent("turn.started", "ours", ["neighbor"]),
      {
        type: "message.received",
        data: { message: "Continue", sequence: 1, turnId: "ours" },
        meta: { at: "2026-10-14T00:00:00Z", deliveryIds: ["ack"], id: "message-received" },
      },
    ]);
    await expect(f.create().send(f.request)).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    expect(f.diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        sendDeliveryObservation: {
          ackObserved: true,
          sameAdapterSession: true,
          sameAdapterGeneration: true,
          nativeDeliveryStatePresent: true,
          nativeTurnCount: 1,
          deliveryTurnMatchCount: 1,
          startedStampMatchCount: 0,
          boundaryStampMatchCount: 0,
          startedOrBoundaryMatch: false,
          currentTurnPresent: true,
          nativeReadObserved: false,
        },
      }),
    );
    f.setEvents([
      turnEvent("turn.started", "ours", ["neighbor"]),
      turnEvent("turn.completed", "ours", ["ack", "neighbor"]),
      waiting(),
    ]);
    await expect(f.create().send(f.request)).resolves.toMatchObject({ status: "waiting" });
    expect(f.send).toHaveBeenCalledOnce();
  });
  it("keeps missing-ACK legacy outcomes unknown even when private turn metadata later mentions an ID", async () => {
    const f = await fixture({ acknowledge: false });
    f.setEvents([turnEvent("turn.completed", "ours", ["ack"])]);
    await expect(f.create().send(f.request)).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    await expect(f.create().send(f.request)).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    const operation = await f.operation();
    expect(operation?.sendDelivery).toBeUndefined();
    expect(f.send).toHaveBeenCalledOnce();
  });
  it("rejects a stale owner before dispatch and after ACK without replaying", async () => {
    const f = await fixture({ failReadback: true });
    await expect(f.create().send(f.request)).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    f.setEvents([turnEvent("turn.completed", "ours", ["ack"])]);
    f.owner.mockRejectedValue(new Error("Owner revoked"));
    await expect(f.create().send(f.request)).rejects.toThrow();
    expect(await f.operation()).toMatchObject({ state: "submission_unknown" });
    expect(f.send).toHaveBeenCalledOnce();
    const fresh = await fixture();
    fresh.owner.mockRejectedValue(new Error("Owner revoked"));
    await expect(fresh.create().send(fresh.request)).rejects.toMatchObject({
      code: "send_owner_unavailable",
    });
    expect(fresh.send).not.toHaveBeenCalled();
  });
  it("does not associate an old ACK with a replacement native adapter", async () => {
    const f = await fixture({ failReadback: true });
    await expect(f.create().send(f.request)).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    const stored = await f.store.getSession(principal, f.request.sessionId);
    if (stored === null) {
      throw new Error("Missing fixture session");
    }
    const current = toDurableHostedSessionRecord(stored);
    await f.store.replaceSessionAdapter({
      adapterSessionId: "replacement",
      checkpoint: { capturedAtEpochMs: 10, events: [], status: "waiting", version: 1 },
      expectedAdapterGeneration: current.adapterGeneration,
      expectedCheckpointDigest: current.checkpointDigest,
      nowEpochMs: current.updatedAtEpochMs + 1,
      principal,
      resumability: "live",
      sessionId: current.sessionId,
      stage: "planning",
    });
    f.setEvents([turnEvent("turn.completed", "replacement-turn", ["ack"])]);
    await expect(f.create().send(f.request)).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    expect(f.send).toHaveBeenCalledOnce();
  });
  it("binds ACK recording and settlement to the exact reserved digest, session and principal", async () => {
    const f = await fixture({ failReadback: true });
    await expect(f.create().send(f.request)).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    const operation = hostedOperationRecordSchema.parse(await f.operation());
    const current = await f.store.getSession(principal, f.request.sessionId);
    const marker = operation.sendDelivery;
    expect(marker).toBeDefined();
    if (marker === undefined) {
      throw new Error("Missing fixture ACK");
    }
    const proof = nativeDeliveryForEvents([
      turnEvent("turn.completed", "ours", ["ack", "neighbor"]),
    ]);
    expect(isProvedSendDelivery(operation, current, proof)).toBe(true);
    expect(
      isProvedSendDelivery(
        { ...operation, requestDigest: `sha256:${"f".repeat(64)}` },
        current,
        proof,
      ),
    ).toBe(false);
    expect(
      isProvedSendDelivery(
        operation,
        current === null
          ? null
          : { ...current, principal: { ...principal, ownerUserId: "foreign" } },
        proof,
      ),
    ).toBe(false);
    expect(() =>
      bindSendDelivery(operation, current, { ...marker, deliveryId: "different" }),
    ).toThrow();
    expect(() =>
      bindSendDelivery(operation, current, {
        ...marker,
        requestDigest: `sha256:${"e".repeat(64)}`,
      }),
    ).toThrow();
    await expect(
      f.store.recordSendDelivery({
        delivery: marker,
        nowEpochMs: 1,
        operationId: operation.operationId,
        principal: { ...principal, ownerUserId: "foreign" },
      }),
    ).rejects.toThrow();
  });
  it("retains native start acceptance and exact terminal metadata across incremental native cursor reads", async () => {
    let events = [turnEvent("turn.started", "ours", ["ack", "neighbor"])];
    // oxlint-disable-next-line eslint/require-await -- The local NDJSON response preserves the native fetch contract.
    const fetchImplementation = vi.fn<typeof fetch>(async (url) => {
      const startIndex = Number(
        new URL(url instanceof Request ? url.url : url).searchParams.get("startIndex") ?? 0,
      );
      return new Response(
        `${events
          .slice(startIndex)
          .map((event) => JSON.stringify(event))
          .join("\n")}\n`,
        {
          headers: {
            "content-type": "application/x-ndjson",
            "x-eve-session-id": "native",
            "x-eve-stream-format": "ndjson",
            "x-eve-stream-tail-index": String(events.length - 1),
            "x-eve-stream-version": "25",
          },
        },
      );
    });
    const common = {
      config: { baseUrl: "https://builder.example.test", timeoutMs: 1000 },
      fetchImplementation,
      onEvent: vi.fn(),
      sessionId: "native",
      // oxlint-disable-next-line eslint/require-await -- The synthetic workload identity has the asynchronous token contract.
      workloadIdentity: { token: async () => "synthetic-oidc" },
    };
    const first = await observeSameOriginEveStream(common);
    const marker = {
      adapterGeneration: 1,
      adapterSessionId: "native",
      deliveryId: "ack",
      requestDigest: `sha256:${"a".repeat(64)}`,
      sessionId: "public",
    };
    expect(provesNativeDelivery(marker, first.nativeObservationState.nativeDeliveryState)).toBe(
      true,
    );
    expect(first.status).toBe("working");
    expect(first.nativeObservationState.nativeDeliveryState?.turns[0].boundary).toBeUndefined();
    events = [...events, waiting(["neighbor", "ack"])];
    const second = await observeSameOriginEveStream({
      ...common,
      nativeObservationState: first.nativeObservationState,
    });
    expect(provesNativeDelivery(marker, second.nativeObservationState.nativeDeliveryState)).toBe(
      true,
    );
    expect(second.nativeObservationState.nextNativeIndex).toBe(2);
    events = [...events, turnEvent("turn.started", "next", ["next-ack"])];
    const third = await observeSameOriginEveStream({
      ...common,
      nativeObservationState: second.nativeObservationState,
    });
    expect(third.status).toBe("working");
    expect(third.activeTurnId).toBe("next");
  });
  it.each(["input_required", "cancelled", "completed", "failed"] as const)(
    "preserves real %s after turn.started resets an earlier waiting boundary",
    async (expected) => {
      const events: unknown[] = [waiting(), turnEvent("turn.started", "current", ["ack"])];
      if (expected === "input_required") {
        events.push(
          {
            type: "input.requested",
            data: {
              requests: [
                {
                  allowFreeform: true,
                  display: "text",
                  kind: "question",
                  prompt: "Choose",
                  requestId: "real-question",
                },
              ],
            },
          },
          turnEvent("turn.started", "current", ["ack"]),
        );
      } else {
        events.push({
          type: expected === "cancelled" ? "turn.cancelled" : `session.${expected}`,
          data:
            expected === "failed"
              ? { code: "synthetic_failure", message: "Synthetic failure", turnId: "current" }
              : { turnId: "current" },
        });
      }
      const result = await observeSameOriginEveStream({
        config: { baseUrl: "https://builder.example.test", timeoutMs: 1000 },
        workloadIdentity: { token: () => Promise.resolve("synthetic-oidc") },
        fetchImplementation: () =>
          Promise.resolve(
            new Response(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`, {
              headers: {
                "content-type": "application/x-ndjson",
                "x-eve-session-id": "native",
                "x-eve-stream-format": "ndjson",
                "x-eve-stream-tail-index": String(events.length - 1),
                "x-eve-stream-version": "25",
              },
            }),
          ),
        onEvent: () => {},
        sessionId: "native",
      });
      expect(result.status).toBe(expected);
    },
  );
  it("preserves old terminal-only proofs and refuses legacy membership without a boundary", () => {
    const marker = {
      adapterGeneration: 1,
      adapterSessionId: "native",
      deliveryId: "ack",
      requestDigest: `sha256:${"a".repeat(64)}`,
      sessionId: "public",
    };
    expect(
      provesNativeDelivery(marker, {
        version: 1,
        turns: [{ turnId: "ours", deliveryIds: ["ack"] }],
      }),
    ).toBe(false);
    expect(
      provesNativeDelivery(marker, {
        version: 1,
        turns: [
          {
            turnId: "ours",
            deliveryIds: ["ack"],
            boundary: "turn.completed",
            boundaryDeliveryIds: ["ack"],
          },
        ],
      }),
    ).toBe(true);
  });
  it.each(["send", "sendAccepted"] as const)(
    "passes the exact %s ACK to private storage before any readback",
    async (method) => {
      const order: string[] = [];
      // oxlint-disable-next-line eslint/require-await -- Preserve asynchronous fetch rejection without a network call.
      const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => {
        if (init?.method === "POST") {
          expect(JSON.parse(z.string().parse(init.body))).toMatchObject({
            message: "Continue",
            turnPolicy: "queue",
          });
          return Response.json(
            { deliveryId: "exact-ack", ok: true, sessionId: "native", status: "accepted" },
            { status: 202 },
          );
        }
        order.push("read");
        throw new Error("Read failed");
      });
      const diagnostics = vi.fn();
      const adapter = createSameOriginEveTransport({
        config: { baseUrl: "https://builder.example.test" },
        fetchImplementation,
        onSubmissionDiagnostic: diagnostics,
        // oxlint-disable-next-line eslint/require-await -- The synthetic workload identity has the asynchronous token contract.
        workloadIdentity: { token: async () => "synthetic-oidc" },
      });
      const input = {
        adapterSessionId: "native",
        message: "Continue",
        // oxlint-disable-next-line eslint/require-await -- This private ACK sink has the asynchronous storage contract.
        onAccepted: async (deliveryId: string) => {
          order.push(deliveryId);
        },
        operationId: "send",
        principal,
      };
      await (method === "send"
        ? expect(adapter.send(input)).rejects.toThrow()
        : adapter.sendAccepted?.(input));
      expect(order[0]).toBe("exact-ack");
      if (method === "send") {
        expect(diagnostics).toHaveBeenCalledWith(
          expect.objectContaining({
            category: "native_read_failed",
            operationKind: "send",
            phase: "send_accepted_readback",
          }),
        );
        expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("Read failed");
        expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("exact-ack");
      } else {
        expect(diagnostics).not.toHaveBeenCalled();
      }
      expect(
        fetchImplementation.mock.calls.filter(([, init]) => init?.method === "POST"),
      ).toHaveLength(1);
    },
  );
});
