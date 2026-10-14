import { z } from "zod";
import type { MessageStreamEvent } from "eve/client";
import { describe, expect, it, vi } from "vitest";
import { createHostedEveSessionService, HostedSubmissionUnknownError } from "./hosted-service";
import type { HostedEngineSnapshot, HostedEveTransport } from "./hosted-service";
import { hostedEveOperationScopes } from "./hosted-auth";
import {
  bindSendDelivery,
  hostedOperationRecordSchema,
  InMemoryHostedEveStore,
  isProvedSendDelivery,
  toDurableHostedSessionRecord,
} from "./hosted-store";
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
const fixture = async (options: { acknowledge?: boolean; failReadback?: boolean } = {}) => {
  const store = new InMemoryHostedEveStore();
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
      principal,
      store,
      transport: adapter,
    });
  const started = await create().start({ clientRequestId: "start", prompt: "App" });
  const request = { clientRequestId: "send", message: "Continue", sessionId: started.sessionId };
  return {
    adapter,
    create,
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

describe("canonical SEND delivery acknowledgement", () => {
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
  });
  it("requires a matching boundary, not just ACK membership in a running turn", async () => {
    const f = await fixture();
    f.setEvents([turnEvent("turn.started", "ours", ["ack", "neighbor"])]);
    await expect(f.create().send(f.request)).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    f.setEvents([
      turnEvent("turn.started", "ours", ["ack", "neighbor"]),
      waiting(["ack", "neighbor"]),
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
  it("retains ACK membership and exact boundary across actual incremental native cursor reads", async () => {
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
      false,
    );
    events = [...events, waiting(["neighbor", "ack"])];
    const second = await observeSameOriginEveStream({
      ...common,
      nativeObservationState: first.nativeObservationState,
    });
    expect(provesNativeDelivery(marker, second.nativeObservationState.nativeDeliveryState)).toBe(
      true,
    );
    expect(second.nativeObservationState.nextNativeIndex).toBe(2);
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
      const adapter = createSameOriginEveTransport({
        config: { baseUrl: "https://builder.example.test" },
        fetchImplementation,
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
      expect(
        fetchImplementation.mock.calls.filter(([, init]) => init?.method === "POST"),
      ).toHaveLength(1);
    },
  );
});
