import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { hostedEveOperationScopes, tenantKeyFor } from "./hosted-auth";
import type { HostedPrincipal } from "./hosted-auth";
import { createHostedEveSessionService, HostedSessionNotFoundError } from "./hosted-service";
import { HostedSessionReadTimeoutError } from "./hosted-session-read-timeout-error";
import type { HostedEveTransport } from "./hosted-service";
import { durableHostedSessionRecordSchema, InMemoryHostedEveStore } from "./hosted-store";
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

const fixture = async (observe: NonNullable<HostedEveTransport["observe"]>) => {
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
    reserveOperation: base.reserveOperation.bind(base),
    settleSucceeded: base.settleSucceeded.bind(base),
    settleUnsuccessful: base.settleUnsuccessful.bind(base),
  };
  const service = createHostedEveSessionService({
    now: () => 2000,
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
    service,
    sessionId: started.sessionId,
  };
};

describe("paged hosted session observation", () => {
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
