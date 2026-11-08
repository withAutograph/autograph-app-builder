import { describe, expect, it, vi } from "vitest";
import { createHostedEveSessionService } from "./hosted-service";
import type { HostedEngineSnapshot, HostedEveTransport } from "./hosted-service";
import { hostedEveOperationScopes } from "./hosted-auth";
import type { HostedPrincipal } from "./hosted-auth";
import { InMemoryHostedEveStore } from "./hosted-store";
import { createSameOriginEveTransport, observeSameOriginEveStream } from "./same-origin-http";
import type { InternalEveEvent } from "./public-events";
import type { NativeRecoveryBinding } from "./native-recovery-contract";

const principal: HostedPrincipal = {
  issuer: "https://identity.example",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace",
  ownerUserId: "owner",
  scopes: Object.values(hostedEveOperationScopes),
};
const config = { baseUrl: "https://builder.example", timeoutMs: 10_000 };
const workloadIdentity = { token: () => Promise.resolve("fixture-workload") };
interface BootStreamHeaders {
  [name: string]: string;
  "content-type": string;
}

const stream = (
  input: {
    events?: unknown[];
    status?: string;
    sessionId?: string;
    tailIndex?: number;
  } = {},
) => {
  const events = input.events ?? [];
  const ResponseConstructor = Response;
  const body = events.map((event) => JSON.stringify(event)).join("\n");
  const headers: BootStreamHeaders = {
    "content-type": "application/x-ndjson",
    "x-eve-session-id": input.sessionId ?? "run_boot",
    "x-eve-stream-format": "ndjson",
    "x-eve-stream-version": "25",
    "x-eve-stream-tail-index": String(input.tailIndex ?? events.length - 1),
  };
  if (input.status !== undefined) {
    headers["x-eve-native-recovery-boot-status"] = input.status;
  }
  return new ResponseConstructor(body, { headers });
};
const observe = (response: () => Response, onEvent: (event: InternalEveEvent) => void = () => {}) =>
  observeSameOriginEveStream({
    config,
    workloadIdentity,
    fetchImplementation: () => Promise.resolve(response()),
    sessionId: "run_boot",
    onEvent,
  });

describe("verified native recovery boot failure", () => {
  it("reports a failed empty recovery without inventing events or changing native cursors", async () => {
    const events: InternalEveEvent[] = [];
    const observed = await observe(
      () => stream({ status: "failed" }),
      (event) => {
        events.push(event);
      },
    );
    expect(observed).toMatchObject({
      installedEventCount: 0,
      nativeObservationState: { boundary: "failed", nextNativeIndex: 0, publicEventCount: 0 },
      nativeTailIndex: -1,
      nextNativeIndex: 0,
      observationComplete: true,
      pendingRequests: [],
      publicEventCount: 0,
      status: "failed",
    });
    expect(events).toEqual([]);
    const transport = createSameOriginEveTransport({
      config,
      workloadIdentity,
      fetchImplementation: () => Promise.resolve(stream({ status: "failed" })),
    });
    await expect(transport.get({ adapterSessionId: "run_boot", principal })).resolves.toMatchObject(
      { events: [], status: "failed" },
    );
  });

  it.each([undefined, "working", "completed", "unknown", "FAILED"])(
    "does not infer terminal failure from missing or unrecognized metadata %s",
    async (status) => {
      await expect(observe(() => stream({ status }))).resolves.toMatchObject({ status: "working" });
    },
  );

  it("does not apply a boot-only failure signal to nonempty history", async () => {
    const events: InternalEveEvent[] = [];
    const observed = await observe(
      () =>
        stream({
          status: "failed",
          events: [
            { type: "step.started", data: { turnId: "turn" } },
            { type: "session.waiting", data: {} },
          ],
        }),
      (event) => {
        events.push(event);
      },
    );
    expect(observed.status).toBe("waiting");
    expect(observed.nextNativeIndex).toBe(2);
    expect(events).toContainEqual({ index: 1, status: "waiting", type: "status" });
  });

  it("rejects wrong-session, unavailable and incomplete reads rather than proving failure", async () => {
    await expect(
      observe(() => stream({ sessionId: "other-run", status: "failed" })),
    ).rejects.toThrow("incompatible stream contract");
    await expect(observe(() => new Response(null, { status: 503 }))).rejects.toThrow("unavailable");
    await expect(observe(() => stream({ status: "failed", tailIndex: 1 }))).rejects.toThrow(
      "before its durable tail",
    );
  });

  it("keeps retained history when an empty tail contradicts its native cursor", async () => {
    const previous = await observe(() =>
      stream({ events: [{ type: "session.waiting", data: {} }] }),
    );
    const retained = structuredClone(previous.nativeObservationState);
    await expect(
      observeSameOriginEveStream({
        config,
        workloadIdentity,
        fetchImplementation: () => Promise.resolve(stream({ status: "failed" })),
        sessionId: "run_boot",
        nativeObservationState: retained,
        onEvent() {},
      }),
    ).rejects.toThrow("precedes the saved native cursor");
    expect(retained).toEqual(previous.nativeObservationState);
  });

  it("uses ordinary terminal recovery while preserving the original authority and completed history", async () => {
    const store = new InMemoryHostedEveStore();
    const originalSnapshot: HostedEngineSnapshot = {
      status: "failed",
      events: [{ index: 0, label: "Published reviewed app", state: "completed", type: "progress" }],
      nativeDeliveryState: {
        version: 1,
        turns: [
          {
            turnId: "published-turn",
            deliveryIds: ["approved-publication"],
            boundary: "turn.completed",
            boundaryDeliveryIds: ["approved-publication"],
          },
        ],
      },
    };
    let starts = 0;
    const start = vi.fn<HostedEveTransport["start"]>(async ({ recovery }) => {
      starts += 1;
      if (starts === 1) {
        return { adapterSessionId: "run_original", snapshot: originalSnapshot };
      }
      if (recovery === undefined) {
        throw new Error("Expected native recovery");
      }
      const ownerRunId = starts === 2 ? "run_boot" : "run_recovered";
      const binding = { ...recovery, ownerRunId };
      const provenance: NativeRecoveryBinding["provenance"] = {
        kind: starts === 2 ? "failed-turn-input" : "validated-recovery-input",
        sourceStepId: "validated-step",
        sourceEventId: "validated-event",
        sourceSlot: 0,
        checkpointVersion: 1,
      };
      if (starts !== 2) {
        provenance.resumePhase = "await-input";
      }
      const recoveryBinding = { ...binding, provenance };
      await store.commitNativeRecoveryReceipt({
        principal,
        descriptor: recovery,
        recoveryBinding,
        nowEpochMs: Date.now(),
      });
      return {
        adapterSessionId: ownerRunId,
        recoveryBinding,
        snapshot: { events: [], status: "working" },
      };
    });
    let failureReported = false;
    const transport: HostedEveTransport = {
      ...createSameOriginEveTransport({
        config,
        workloadIdentity,
        fetchImplementation: () =>
          Promise.resolve(stream({ status: failureReported ? "failed" : undefined })),
      }),
      start,
      async activateRecovery({ operationId }) {
        const operation = await store.getPrivateOperation(principal, operationId);
        if (operation?.nativeRecoveryReceipt === undefined) {
          throw new Error("Expected committed recovery receipt");
        }
        return operation.nativeRecoveryReceipt;
      },
    };
    const service = createHostedEveSessionService({
      principal,
      store,
      transport,
      assertNativeRecoveryOwner: () => Promise.resolve(),
    });
    const original = await service.start({ clientRequestId: "original", prompt: "Build this app" });
    const originalRecord = await store.getSession(principal, original.sessionId);
    const child = await service.start({
      clientRequestId: "first-resume",
      resumeSessionId: original.sessionId,
    });
    await expect(
      service.get({ sessionId: child.sessionId, cursor: 0, limit: 100 }),
    ).resolves.toMatchObject({ status: "working" });
    await expect(
      service.start({
        clientRequestId: "metadata-unavailable-resume",
        resumeSessionId: child.sessionId,
      }),
    ).resolves.toMatchObject({ sessionId: child.sessionId });
    expect(start).toHaveBeenCalledTimes(2);
    failureReported = true;
    const observed = await service.get({ sessionId: child.sessionId, cursor: 0, limit: 100 });
    expect(observed).toMatchObject({ cursor: 0, events: [], status: "failed" });
    expect(await store.getSession(principal, child.sessionId)).toMatchObject({
      resumability: "terminal",
      status: "failed",
    });
    const resume = { clientRequestId: "boot-resume", resumeSessionId: child.sessionId };
    const recovered = await service.start(resume);
    expect(recovered.sessionId).not.toBe(child.sessionId);
    expect(await store.getSession(principal, recovered.sessionId)).toMatchObject({
      nativeRecoveryBinding: {
        logicalSessionId: "run_original",
        originalAuthoritySessionId: original.sessionId,
        provenance: { kind: "validated-recovery-input", resumePhase: "await-input" },
        sourceOwnerRunId: "run_boot",
      },
      parentSessionId: child.sessionId,
    });
    expect(await store.getSession(principal, original.sessionId)).toEqual(originalRecord);
    await expect(service.start(resume)).resolves.toMatchObject({ sessionId: recovered.sessionId });
    expect(start).toHaveBeenCalledTimes(3);
  });
});
