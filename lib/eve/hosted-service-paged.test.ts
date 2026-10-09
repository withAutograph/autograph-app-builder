import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { stableId } from "./hosted-operation-identifiers";
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
import { nativeObservationStateSchema } from "./native-observation-state";
import {
  privateHostedApprovalCaptureStateSchema,
  privateHostedApprovalReceiptSchema,
} from "./private-hosted-approval";
import {
  hostedOperatorPlanSchema,
  operatorPlanDigest,
} from "../provisioning/hosted-operator-contract";

const nativeState = (input: {
  adapterSessionId: string;
  nextNativeIndex: number;
  publicEventCount: number;
  legacy?: boolean;
}) =>
  nativeObservationStateSchema.parse({
    adapterSessionId: input.adapterSessionId,
    artifactReadback: {
      incompleteArtifacts: [],
      incompleteUiPreviews: [],
      legacy: input.legacy ?? false,
      markdownCalls: [],
      pending: [],
      references: { requested: [], requestedUiPreview: [] },
    },
    boundary: "waiting",
    invalidInput: false,
    nextNativeIndex: input.nextNativeIndex,
    pendingRequests: [],
    prototypeProjector: {
      artifactReadRequests: [],
      readChunks: [],
      requested: [],
      transfers: [],
    },
    prototypeReference: { requested: [], requestedUiPreview: [] },
    publicEventCount: input.publicEventCount,
    version: 1,
  });

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
  let checkpointEvents: PublicEveEvent[] = [];
  let checkpointRevision = 0;
  const observeSessionPaged = vi.fn<NonNullable<HostedEveStore["observeSessionPaged"]>>(
    async (input) => {
      const previous = paged ?? (await base.getSession(principal, started.sessionId));
      if (previous?.version !== 2 || previous.checkpointDigest !== input.expectedCheckpointDigest) {
        throw new Error("Checkpoint observation raced.");
      }
      const stagedEvents: PublicEveEvent[] = [];
      for await (const event of input.events) {
        stagedEvents.push(event);
      }
      checkpointEvents = stagedEvents;
      eventCount = stagedEvents.length;
      ({ metadata } = input);
      const { checkpoint: previousInlineCheckpoint, ...withoutInline } = previous;
      void previousInlineCheckpoint;
      const digest = `sha256:${checkpointRevision.toString(16).padStart(64, "0")}`;
      checkpointRevision += 1;
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
      const events = checkpointEvents.slice(input.cursor, input.cursor + input.limit);
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
    const stagedEvents: PublicEveEvent[] = [];
    for await (const event of input.events) {
      stagedEvents.push(event);
    }
    checkpointEvents = stagedEvents;
    eventCount = stagedEvents.length;
    ({ metadata } = input);
    const { checkpoint: previousInlineCheckpoint, ...withoutInline } = previous;
    void previousInlineCheckpoint;
    const digest = `sha256:${checkpointRevision.toString(16).padStart(64, "0")}`;
    checkpointRevision += 1;
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
    recordPrivateApprovalReceipts: base.recordPrivateApprovalReceipts.bind(base),
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
    getPagedEventCount: () => eventCount,
    getSession,
    observeSessionPaged,
    readCheckpointPage,
    replaceSessionAdapterPaged,
    service,
    sessionId: started.sessionId,
    store,
  };
};

const seedColdCheckpoint = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const initial = await f.getSession(principal, f.sessionId);
  if (initial?.version !== 2) {
    throw new Error("Expected durable session");
  }
  const priorEvents: PublicEveEvent[] = [0, 1, 2].map((index) => ({
    index,
    text: `event ${index}`,
    turnId: "turn_1",
    type: "assistant_message",
  }));
  const eventStream = async function* eventStream() {
    yield* priorEvents;
  };
  await f.observeSessionPaged({
    events: eventStream(),
    expectedCheckpointDigest: initial.checkpointDigest,
    metadata: { capturedAtEpochMs: 1000, status: "waiting", version: 1 },
    nowEpochMs: 1000,
    principal,
    resumability: "live",
    sessionId: f.sessionId,
    stage: "planning",
  });
  return priorEvents;
};

describe("paged hosted session observation", () => {
  it.each(["generation", "new-request"] as const)(
    "rejects stale authorization cleanup after concurrent %s checkpoint replacement",
    async (race) => {
      const newRequest = {
        allowFreeform: true,
        kind: "question" as const,
        requestId: "new-request",
        title: "Keep this question",
      };
      const observe = vi.fn<NonNullable<HostedEveTransport["observe"]>>();
      const f = await fixture(observe);
      observe.mockImplementation(async (input) => {
        const current = await f.getSession(principal, f.sessionId);
        if (current?.version !== 2) {
          throw new Error("Expected current durable session");
        }
        const replacementState = nativeState({
          adapterSessionId: race === "generation" ? "replacement_adapter" : "adapter_1",
          nextNativeIndex: 3,
          publicEventCount: 1,
        });
        replacementState.pendingRequests = [newRequest];
        const replacement = {
          events: (async function* replacementEvents() {
            yield { index: 0, request: newRequest, type: "input_required" as const };
          })(),
          expectedCheckpointDigest: current.checkpointDigest,
          metadata: {
            capturedAtEpochMs: 2000,
            inputRequests: [newRequest],
            nativeObservationState: replacementState,
            status: "input_required" as const,
            version: 1 as const,
          },
          nowEpochMs: 2000,
          principal,
          resumability: "live" as const,
          sessionId: f.sessionId,
          stage: "planning" as const,
        };
        await (race === "generation"
          ? f.replaceSessionAdapterPaged({
              ...replacement,
              adapterSessionId: "replacement_adapter",
              expectedAdapterGeneration: current.adapterGeneration,
            })
          : f.observeSessionPaged(replacement));
        const observed = nativeObservationStateSchema.parse({
          ...input.nativeObservationState,
          pendingRequests: [],
        });
        return {
          artifactProjectionRequiresLegacyReadback: false,
          installedEventCount: 3,
          nativeObservationState: observed,
          nextNativeIndex: 3,
          pendingRequests: [],
          publicEventCount: 1,
          status: "waiting",
        };
      });
      const initial = await f.getSession(principal, f.sessionId);
      if (initial?.version !== 2) {
        throw new Error("Expected initial durable session");
      }
      const authorization = {
        allowFreeform: false,
        kind: "authorization" as const,
        requestId: "old-auth",
        title: "Connect",
      };
      const originalState = nativeState({
        adapterSessionId: "adapter_1",
        nextNativeIndex: 3,
        publicEventCount: 1,
      });
      originalState.pendingRequests = [authorization];
      await f.observeSessionPaged({
        events: (async function* originalEvents() {
          yield { index: 0, request: authorization, type: "input_required" as const };
        })(),
        expectedCheckpointDigest: initial.checkpointDigest,
        metadata: {
          capturedAtEpochMs: 1000,
          inputRequests: [authorization],
          nativeObservationState: originalState,
          status: "input_required",
          version: 1,
        },
        nowEpochMs: 1000,
        principal,
        resumability: "live",
        sessionId: f.sessionId,
        stage: "planning",
      });
      await expect(f.service.get({ cursor: 1, limit: 10, sessionId: f.sessionId })).rejects.toThrow(
        "Checkpoint observation raced",
      );
      const current = await f.getSession(principal, f.sessionId);
      expect(current).toMatchObject({
        adapterGeneration: race === "generation" ? 2 : 1,
        adapterSessionId: race === "generation" ? "replacement_adapter" : "adapter_1",
        status: "input_required",
      });
      if (current?.version !== 2 || current.checkpointRef === undefined) {
        throw new Error("Expected replacement checkpoint");
      }
      const saved = await f.readCheckpointPage({
        checkpointRef: current.checkpointRef,
        cursor: 0,
        limit: 10,
        principal,
        sessionId: f.sessionId,
      });
      expect(saved.metadata?.inputRequests).toEqual([newRequest]);
      expect(saved.metadata?.nativeObservationState).not.toHaveProperty(
        "authorizationCompletionsReconciled",
      );
    },
  );
  it("retains the old public checkpoint while privately catching up and promotes only a complete tail", async () => {
    const observe = vi.fn<NonNullable<HostedEveTransport["observe"]>>(async (input) => {
      const start = input.nativeObservationState?.publicEventCount ?? 0;
      expect(input.allowPartialObservation).toBe(true);
      const end = start + 1;
      for (let index = start; index < end; index += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Preserve ordered callback backpressure.
        await input.onEvent({
          index,
          text: `event ${index}`,
          turnId: "turn_1",
          type: "assistant.message",
        });
      }
      const state = nativeState({
        adapterSessionId: input.adapterSessionId,
        nextNativeIndex: end * 10,
        publicEventCount: end,
      });
      return {
        artifactProjectionRequiresLegacyReadback: false,
        installedEventCount: state.nextNativeIndex,
        nativeObservationState: state,
        nextNativeIndex: state.nextNativeIndex,
        observationComplete: start === 2,
        pendingRequests: [],
        publicEventCount: end,
        status: "waiting",
      };
    });
    const f = await fixture(observe);
    const priorEvents = await seedColdCheckpoint(f);
    const partial = await f.service.get({ cursor: 3, limit: 10, sessionId: f.sessionId });
    expect(partial).toMatchObject({
      cursor: 3,
      error: { code: "session_read_delayed" },
      events: [],
      inputRequests: [],
    });
    expect(f.getPagedEventCount()).toBe(3);
    const privateProgress = f.observeSessionPaged.mock.calls[1]?.[0].metadata.coldReadProgress;
    expect(privateProgress?.events).toEqual(priorEvents.slice(0, 1));
    expect(privateProgress?.nativeObservationState.nextNativeIndex).toBe(10);
    const secondPartial = await f.service.get({ cursor: 3, limit: 10, sessionId: f.sessionId });
    expect(secondPartial.error?.code).toBe("session_read_delayed");
    expect(f.observeSessionPaged.mock.calls[2]?.[0].metadata.coldReadProgress?.events).toEqual(
      priorEvents.slice(0, 2),
    );
    expect(f.getPagedEventCount()).toBe(3);
    const complete = await f.service.get({ cursor: 3, limit: 10, sessionId: f.sessionId });
    expect(complete.error).toBeUndefined();
    expect(complete.cursor).toBe(3);
    expect(complete.events).toEqual([]);
    expect(f.getPagedEventCount()).toBe(3);
    expect(observe.mock.calls[1]?.[0].nativeObservationState?.nextNativeIndex).toBe(10);
    expect(f.observeSessionPaged.mock.calls[3]?.[0].metadata.coldReadProgress).toBeUndefined();
  });

  it.each(["CAS race", "provider failure", "invalid frontier"])(
    "does not publish private catch-up after %s",
    async (failure) => {
      const observe = vi.fn<NonNullable<HostedEveTransport["observe"]>>(async (input) => {
        if (failure === "provider failure") {
          throw new Error("provider failure");
        }
        await input.onEvent({
          index: 0,
          text: "event 0",
          turnId: "turn_1",
          type: "assistant.message",
        });
        const state = nativeState({
          adapterSessionId: input.adapterSessionId,
          nextNativeIndex: 10,
          publicEventCount: failure === "invalid frontier" ? 2 : 1,
        });
        return {
          artifactProjectionRequiresLegacyReadback: false,
          installedEventCount: 10,
          nativeObservationState: state,
          nextNativeIndex: 10,
          observationComplete: false,
          pendingRequests: [],
          publicEventCount: state.publicEventCount,
          status: "waiting",
        };
      });
      const f = await fixture(observe);
      await seedColdCheckpoint(f);
      const before = await f.getSession(principal, f.sessionId);
      if (failure === "CAS race") {
        f.observeSessionPaged.mockRejectedValueOnce(new Error("CAS race"));
      }
      await expect(
        f.service.get({ cursor: 3, limit: 10, sessionId: f.sessionId }),
      ).rejects.toThrow();
      expect(await f.getSession(principal, f.sessionId)).toEqual(before);
      expect(f.getPagedEventCount()).toBe(3);
      expect(f.observeSessionPaged.mock.calls[0]?.[0].metadata.coldReadProgress).toBeUndefined();
    },
  );

  it("passes the complete owner-checked native preflight to response settlement", async () => {
    const question = {
      allowFreeform: true,
      kind: "question" as const,
      requestId: "choose-target",
      title: "Choose a Preview target",
    };
    let settled = false;
    const observe = vi.fn<NonNullable<HostedEveTransport["observe"]>>(async (input) => {
      const previous = input.nativeObservationState;
      if (previous === undefined) {
        await input.onEvent({ index: 0, request: question, type: "input.requested" });
      }
      const publicEventCount = 1;
      const nextNativeIndex = settled ? 11 : 10;
      const state = nativeObservationStateSchema.parse({
        ...nativeState({
          adapterSessionId: input.adapterSessionId,
          nextNativeIndex,
          publicEventCount,
        }),
        pendingRequests: settled ? [] : [question],
      });
      return {
        artifactProjectionRequiresLegacyReadback: false,
        installedEventCount: nextNativeIndex,
        nativeObservationState: state,
        nextNativeIndex,
        pendingRequests: state.pendingRequests,
        publicEventCount,
        status: settled ? "waiting" : "input_required",
      };
    });
    const f = await fixture(observe);
    const accepted = vi.fn<NonNullable<HostedEveTransport["respondAccepted"]>>(async (input) => {
      expect(input.nativeObservationState).toMatchObject({
        adapterSessionId: "adapter_1",
        nextNativeIndex: 10,
        publicEventCount: 1,
      });
      expect(input.nativeObservationState?.pendingRequests).toEqual([question]);
      await Promise.resolve();
      settled = true;
    });
    f.adapter.respondAccepted = accepted;
    await f.service.get({ cursor: 0, limit: 10, sessionId: f.sessionId });
    const result = await f.service.respond({
      clientRequestId: randomUUID(),
      responses: [
        { requestId: question.requestId, response: { kind: "answer", value: "isolated Preview" } },
      ],
      sessionId: f.sessionId,
    });
    expect(result.error).toBeUndefined();
    expect(accepted).toHaveBeenCalledOnce();
    expect(f.adapter.respond).not.toHaveBeenCalled();
  });

  it("hydrates native reducer state and atomically appends absolute public event deltas", async () => {
    const observe = vi.fn<NonNullable<HostedEveTransport["observe"]>>(async (input) => {
      const previous = input.nativeObservationState;
      const eventIndex = previous?.publicEventCount ?? 0;
      await input.onEvent({
        index: eventIndex,
        text: `event ${eventIndex}`,
        turnId: "turn_1",
        type: "assistant.message",
      });
      const nextNativeIndex = previous === undefined ? 2 : 3;
      const publicEventCount = eventIndex + 1;
      const state = nativeState({
        adapterSessionId: input.adapterSessionId,
        legacy: true,
        nextNativeIndex,
        publicEventCount,
      });
      return {
        artifactProjectionRequiresLegacyReadback: true,
        installedEventCount: nextNativeIndex,
        nativeObservationState: state,
        nextNativeIndex,
        pendingRequests: [],
        publicEventCount,
        status: "waiting",
      };
    });
    const { getPagedEventCount, observeSessionPaged, service, sessionId } = await fixture(observe);

    const first = await service.get({ cursor: 0, limit: 10, sessionId });
    const second = await service.get({ cursor: 0, limit: 10, sessionId });

    expect(first.events.map((event) => event.index)).toEqual([0]);
    expect(second.events.map((event) => event.index)).toEqual([0, 1]);
    expect(getPagedEventCount()).toBe(2);
    expect(observe.mock.calls[1]?.[0].nativeObservationState).toMatchObject({
      adapterSessionId: "adapter_1",
      nextNativeIndex: 2,
      publicEventCount: 1,
    });
    const metadata = observeSessionPaged.mock.calls[1]?.[0].metadata;
    expect(metadata?.nativeObservationState).toMatchObject({
      nextNativeIndex: 3,
      publicEventCount: 2,
    });
    expect(metadata?.privateApprovalCaptureState).toMatchObject({
      sessionId,
      version: 1,
    });
    expect(second).not.toHaveProperty("nativeObservationState");
    expect(second).not.toHaveProperty("privateApprovalCaptureState");
  });

  it("does not advance native or approval checkpoints after a checkpoint CAS failure", async () => {
    const observe = vi.fn<NonNullable<HostedEveTransport["observe"]>>(async (input) => {
      const previous = input.nativeObservationState;
      const eventIndex = previous?.publicEventCount ?? 0;
      await input.onEvent({
        index: eventIndex,
        text: `event ${eventIndex}`,
        turnId: "turn_1",
        type: "assistant.message",
      });
      const nextNativeIndex = previous === undefined ? 2 : 3;
      const publicEventCount = eventIndex + 1;
      const state = nativeState({
        adapterSessionId: input.adapterSessionId,
        nextNativeIndex,
        publicEventCount,
      });
      return {
        artifactProjectionRequiresLegacyReadback: false,
        installedEventCount: nextNativeIndex,
        nativeObservationState: state,
        nextNativeIndex,
        pendingRequests: [],
        publicEventCount,
        status: "waiting",
      };
    });
    const { getPagedEventCount, getSession, observeSessionPaged, service, sessionId } =
      await fixture(observe);
    await service.get({ cursor: 0, limit: 10, sessionId });
    const before = await getSession(principal, sessionId);
    const savedMetadata = observeSessionPaged.mock.calls[0]?.[0].metadata;
    observeSessionPaged.mockRejectedValueOnce(new Error("checkpoint CAS lost"));

    await expect(service.get({ cursor: 0, limit: 10, sessionId })).rejects.toThrow(
      "checkpoint CAS lost",
    );

    const after = await getSession(principal, sessionId);
    expect(before?.version).toBe(2);
    expect(after?.version).toBe(2);
    if (before?.version !== 2 || after?.version !== 2) {
      throw new Error("Expected a saved paged checkpoint before and after the failed CAS.");
    }
    expect(after.checkpointRef?.digest).toBe(before.checkpointRef?.digest);
    expect(observeSessionPaged.mock.calls[0]?.[0].metadata).toBe(savedMetadata);
    expect(getPagedEventCount()).toBe(1);
  });

  it("drops pending approval correlation when the durable adapter generation is replaced", async () => {
    const requestId = "request_reused_after_replacement";
    const selection = {
      appId: "spend-review",
      branch: "preview",
      environment: "preview" as const,
      projectId: "prj_fixture",
      sessionId: "replace-me",
    };
    const plan = hostedOperatorPlanSchema.parse({
      access: [{ actorId: "reviewer", organizationId: "org", roles: ["reviewer"] }],
      action: "prepare",
      appDatabase: {
        database: "spend",
        migratorRole: "spend_owner",
        resourceId: "app-resource",
        runtimeRole: "spend_runtime",
      },
      authDatabase: {
        database: "shared_auth",
        migratorRole: "auth_owner",
        resourceId: "auth-resource",
        runtimeRole: "auth_runtime",
      },
      contextId: "context",
      cost: { class: "shared-recovery-group", description: "fixture", owner: "owner" },
      effects: [
        { description: "verify resources", id: "resources", kind: "resources" },
        { description: "install release", id: "install", kind: "install" },
        { description: "grant access", id: "access", kind: "access" },
        { description: "bind runtime", id: "bindings", kind: "bindings" },
      ],
      installer: { reference: "installer", sha256: "a".repeat(64) },
      neon: {
        branchId: "br_synthetic",
        connectionRef: "owner-connection",
        endpoint: "ep-fixture.us-east-1.aws.neon.tech",
        projectId: "neon-project",
        source: "synthetic-only",
      },
      publicGateway: {
        branch: selection.branch,
        origin: "https://apps-preview.example.test",
        projectId: selection.projectId,
      },
      release: { artifactRef: "artifact", id: "release", sha256: "b".repeat(64) },
      retention: { expiresAt: "2027-01-01T00:00:00.000Z", policy: "retain" },
      selection,
      version: 1,
    });
    const observe = vi.fn<NonNullable<HostedEveTransport["observe"]>>(async (input) => {
      if (input.adapterSessionId === "adapter_1") {
        const approvalPlan = hostedOperatorPlanSchema.parse({
          ...plan,
          selection: { ...selection, sessionId: input.sessionId },
        });
        const requested = {
          data: {
            requests: [
              {
                action: {
                  callId: "call_fixture",
                  input: {
                    appId: selection.appId,
                    branch: selection.branch,
                    environment: selection.environment,
                    operationRef: "a3f06690-718f-41c7-a67f-c6c1c0ecdbf3",
                    plan: approvalPlan,
                    planDigest: operatorPlanDigest(approvalPlan),
                    projectId: selection.projectId,
                  },
                  kind: "tool-call",
                  toolName: "prepare-app-hosted-runtime",
                },
                kind: "tool-approval",
                prompt: "Approve hosted runtime preparation",
                requestId,
              },
            ],
            sequence: 4,
            stepIndex: 2,
            turnId: "turn_fixture",
          },
          meta: { at: "2026-10-06T00:00:00.000Z", id: "evt_pending" },
          type: "input.requested",
        } as const;
        await input.onPrivateEvent?.(requested);
        return {
          artifactProjectionRequiresLegacyReadback: false,
          installedEventCount: 1,
          nativeObservationState: nativeState({
            adapterSessionId: input.adapterSessionId,
            nextNativeIndex: 1,
            publicEventCount: 0,
          }),
          nextNativeIndex: 1,
          pendingRequests: [],
          publicEventCount: 0,
          status: "waiting",
        };
      }
      await input.onPrivateEvent?.({
        data: {
          outcome: "approved",
          requestId,
          responderPrincipalId: "owner_1",
          sequence: 5,
          stepIndex: 2,
          turnId: "turn_fixture",
        },
        meta: { at: "2026-10-06T00:00:01.000Z", id: "evt_settled_collision" },
        type: "approval.settled",
      });
      return {
        artifactProjectionRequiresLegacyReadback: false,
        installedEventCount: 1,
        nativeObservationState: nativeState({
          adapterSessionId: input.adapterSessionId,
          nextNativeIndex: 1,
          publicEventCount: 0,
        }),
        nextNativeIndex: 1,
        pendingRequests: [],
        publicEventCount: 0,
        status: "waiting",
      };
    });
    const { getSession, observeSessionPaged, service, sessionId, store } = await fixture(observe);
    await service.get({ cursor: 0, limit: 10, sessionId });
    const recordReceipts = vi.spyOn(store, "recordPrivateApprovalReceipts");
    const saved = await getSession(principal, sessionId);
    if (saved?.version !== 2) {
      throw new Error("Expected the initial adapter checkpoint.");
    }
    const priorApprovedPlan = hostedOperatorPlanSchema.parse({
      ...plan,
      selection: { ...selection, sessionId },
    });
    const priorReceipt = privateHostedApprovalReceiptSchema.parse({
      callId: "call_fixture",
      format: "autograph-hosted-approval-v1",
      outcome: "approved",
      requestId: "request_from_original_adapter",
      responderPrincipalId: "owner_1",
      sequence: 3,
      toolInput: {
        appId: selection.appId,
        branch: selection.branch,
        environment: selection.environment,
        operationRef: "a3f06690-718f-41c7-a67f-c6c1c0ecdbf3",
        plan: priorApprovedPlan,
        planDigest: operatorPlanDigest(priorApprovedPlan),
        projectId: selection.projectId,
      },
      toolName: "prepare-app-hosted-runtime",
      turnId: "turn_fixture",
    });
    const savedMetadata = observeSessionPaged.mock.calls[0]?.[0].metadata;
    if (savedMetadata?.privateApprovalCaptureState === undefined) {
      throw new Error("Expected a saved private approval capture checkpoint.");
    }
    savedMetadata.privateApprovalCaptureState = privateHostedApprovalCaptureStateSchema.parse({
      ...savedMetadata.privateApprovalCaptureState,
      receipts: [priorReceipt],
    });
    // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous store contract.
    getSession.mockImplementationOnce(async () => ({
      ...saved,
      adapterGeneration: saved.adapterGeneration + 1,
      adapterSessionId: "replacement_adapter",
    }));

    await expect(service.get({ cursor: 0, limit: 10, sessionId })).resolves.toMatchObject({
      sessionId,
      status: "waiting",
    });

    expect(
      observeSessionPaged.mock.calls[0]?.[0].metadata.privateApprovalCaptureState,
    ).toMatchObject({ pendingRequests: [{ requestId }] });
    const replacementApprovalState =
      observeSessionPaged.mock.calls[1]?.[0].metadata.privateApprovalCaptureState;
    if (replacementApprovalState === undefined) {
      throw new Error("Expected a replacement private approval checkpoint.");
    }
    expect(replacementApprovalState).toMatchObject({ pendingRequests: [] });
    expect(replacementApprovalState.receipts).toEqual([priorReceipt]);
    expect(observe.mock.calls[1]?.[0].nativeObservationState).toBeUndefined();
    expect(recordReceipts).toHaveBeenCalledOnce();
    expect(recordReceipts.mock.calls[0]?.[0].receipts.map((receipt) => receipt.requestId)).toEqual([
      priorReceipt.requestId,
    ]);
  });

  it("atomically settles a new session with more than 512 paged checkpoint events", async () => {
    const base = new InMemoryHostedEveStore();
    const events = Array.from({ length: 520 }, (_, index) => ({
      index,
      text: `event ${index}`,
      turnId: "turn_start",
      type: "assistant_message" as const,
    }));
    const adapter = transport(
      // oxlint-disable-next-line eslint/require-await -- Transport mocks preserve the asynchronous adapter contract.
      vi.fn(async () => ({
        artifactProjectionRequiresLegacyReadback: false,
        installedEventCount: 0,
        pendingRequests: [],
        publicEventCount: 0,
        status: "waiting" as const,
      })),
    );
    // oxlint-disable-next-line eslint/require-await -- Start mocks preserve the asynchronous adapter contract.
    adapter.start = vi.fn(async () => ({
      adapterSessionId: "adapter_large_start",
      snapshot: {
        events: events.map(({ index, text, turnId }) => ({
          index,
          text,
          turnId,
          type: "assistant.message",
        })),
        status: "waiting" as const,
      },
    }));
    const settleSucceededPaged = vi.fn<NonNullable<HostedEveStore["settleSucceededPaged"]>>(
      async (input) => {
        const stagedEvents: PublicEveEvent[] = [];
        for await (const event of input.events) {
          stagedEvents.push(event);
        }
        expect(stagedEvents).toHaveLength(520);
        const checkpointDigest = `sha256:${"e".repeat(64)}`;
        return await base.settleSucceeded({
          ...input,
          session: durableHostedSessionRecordSchema.parse({
            ...input.session,
            checkpointDigest,
            checkpointProgressDigest: `sha256:${"f".repeat(64)}`,
            checkpointRef: {
              digest: checkpointDigest,
              eventCount: stagedEvents.length,
              id: randomUUID(),
            },
          }),
        });
      },
    );
    const store: HostedEveStore = {
      getSession: base.getSession.bind(base),
      listSessions: base.listSessions.bind(base),
      readCheckpointPage: vi.fn(() => {
        throw new Error("New-session verification must use its saved session record.");
      }),
      reserveOperation: base.reserveOperation.bind(base),
      settleSucceeded: base.settleSucceeded.bind(base),
      settleSucceededPaged,
      settleUnsuccessful: base.settleUnsuccessful.bind(base),
    };
    const service = createHostedEveSessionService({
      now: () => 10_000,
      principal,
      store,
      transport: adapter,
    });

    const result = await service.start({
      clientRequestId: randomUUID(),
      prompt: "Build a large app",
    });
    const saved = await base.getSession(principal, result.sessionId);

    expect(result.sessionId).toBeTruthy();
    expect(saved?.version === 2 && saved.checkpointRef?.eventCount).toBe(520);
    expect(settleSucceededPaged).toHaveBeenCalledOnce();
  });

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

  it("pages the complete compatibility snapshot when a legacy artifact needs readback", async () => {
    // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous observation contract.
    const observe = vi.fn<NonNullable<HostedEveTransport["observe"]>>(async () => ({
      artifactProjectionRequiresLegacyReadback: true,
      installedEventCount: 1,
      pendingRequests: [],
      publicEventCount: 0,
      status: "waiting",
    }));
    const { adapter, getPagedEventCount, observeSessionPaged, service, sessionId } =
      await fixture(observe);
    const events = [
      ...Array.from({ length: 520 }, (_, index) => ({
        index,
        text: `event ${index}`,
        turnId: "turn_legacy",
        type: "assistant.message",
      })),
      ...Array.from({ length: 40 }, (_, index) => ({
        index: index + 520,
        request: {
          allowFreeform: true,
          description: `Question ${index}: ${"x".repeat(16_000)}`,
          kind: "question",
          requestId: `legacy_request_${index}`,
          title: `Question ${index}`,
        },
        type: "input.requested",
      })),
    ];
    adapter.get = vi.fn(async () => {
      await Promise.resolve();
      return { events, status: "input_required" as const };
    });
    const result = await service.get({ cursor: 0, limit: 1, sessionId });
    expect(result.status).toBe("input_required");
    expect(adapter.get).toHaveBeenCalledOnce();
    expect(observeSessionPaged).toHaveBeenCalledOnce();
    expect(getPagedEventCount()).toBe(560);
    expect(observeSessionPaged.mock.calls[0]?.[0].metadata.inputRequests).toHaveLength(40);
    expect(
      new TextEncoder().encode(JSON.stringify(observeSessionPaged.mock.calls[0]?.[0].metadata))
        .byteLength,
    ).toBeGreaterThan(512 * 1024);
  });
});

describe("send preflight dispatch classification", () => {
  it("records a failed read-only preflight as rejected and never dispatches or replays the same request", async () => {
    const observe = vi.fn<NonNullable<HostedEveTransport["observe"]>>(async () => {
      await Promise.reject(new HostedSessionReadTimeoutError());
      throw new Error("unreachable");
    });
    const { adapter, base, service, sessionId } = await fixture(observe);
    adapter.sendAccepted = vi.fn(async () => {
      await Promise.resolve();
    });
    const request = { clientRequestId: randomUUID(), message: "continue", sessionId };
    await expect(service.send(request)).rejects.toMatchObject({
      code: "send_preflight_unavailable",
    });
    const operationId = stableId("op", {
      clientRequestId: request.clientRequestId,
      kind: "send",
      tenant: [principal.issuer, principal.audience, principal.workspaceId, principal.ownerUserId],
    });
    expect(await base.getPrivateOperation(principal, operationId)).toMatchObject({
      safeErrorCode: "send_preflight_unavailable",
      state: "rejected",
    });
    await expect(service.send(request)).rejects.toMatchObject({
      code: "send_preflight_unavailable",
    });
    expect(observe).toHaveBeenCalledTimes(1);
    expect(adapter.sendAccepted).not.toHaveBeenCalled();
    expect(adapter.send).not.toHaveBeenCalled();
  });
  it.each(["post", "accepted-readback"] as const)(
    "preserves uncertainty after %s and blocks exact replay",
    async (failure) => {
      let reads = 0;
      const observe = vi.fn<NonNullable<HostedEveTransport["observe"]>>(async () => {
        reads += 1;
        if (reads > 1 && failure === "accepted-readback") {
          throw new HostedSessionReadTimeoutError();
        }
        return await Promise.resolve({
          artifactProjectionRequiresLegacyReadback: false,
          installedEventCount: 0,
          pendingRequests: [],
          publicEventCount: 0,
          status: "waiting" as const,
        });
      });
      const { adapter, base, service, sessionId } = await fixture(observe);
      adapter.sendAccepted = vi.fn(async () => {
        if (failure === "post") {
          throw new Error("mutation response unknown");
        }
        await Promise.resolve();
      });
      const request = { clientRequestId: randomUUID(), message: "continue", sessionId };
      await expect(service.send(request)).rejects.toMatchObject({
        name: "HostedSubmissionUnknownError",
      });
      const operationId = stableId("op", {
        clientRequestId: request.clientRequestId,
        kind: "send",
        tenant: [
          principal.issuer,
          principal.audience,
          principal.workspaceId,
          principal.ownerUserId,
        ],
      });
      expect(await base.getPrivateOperation(principal, operationId)).toMatchObject({
        safeErrorCode: "submission_unknown",
        state: "submission_unknown",
      });
      await expect(service.send(request)).rejects.toMatchObject({
        name: "HostedSubmissionUnknownError",
      });
      expect(adapter.sendAccepted).toHaveBeenCalledTimes(1);
      expect(adapter.send).not.toHaveBeenCalled();
    },
  );
});
