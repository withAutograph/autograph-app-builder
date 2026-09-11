import { describe, expect, it, vi } from "vitest";

import {
  hostedEveOperationScopes,
  HostedAuthorizationError,
} from "./hosted-auth";
import type { HostedPrincipal } from "./hosted-auth";
import {
  createHostedEveSessionService,
  hostedEveProjectionForTesting,
  HostedAdapterSessionUnavailableError,
  HostedIdempotencyConflictError,
  HostedSessionBusyError,
  HostedSessionNotFoundError,
  HostedSubmissionUnknownError,
  HostedRejectedOperationError,
  SubmissionOutcomeUnknownError,
  SubmissionRejectedBeforeDispatchError,
} from "./hosted-service";
import type {
  HostedEngineSnapshot,
  HostedEveTransport,
} from "./hosted-service";
import {
  hostedOperationRecordSchema,
  InMemoryHostedEveStore,
} from "./hosted-store";
import type {
  HostedEveStore,
  HostedOperationRecord,
  ReserveOperationResult,
  HostedSessionTimeoutPolicy,
} from "./hosted-store";
import type { EveSessionService } from "./service";

const principal: HostedPrincipal = {
  audience: "autograph-app-builder",
  issuer: "https://identity.example.test",
  ownerUserId: "user_1",
  scopes: Object.values(hostedEveOperationScopes),
  workspaceId: "workspace_1",
};

describe("prepared handoff session continuity", () => {
  const sourceHandoffId = "123e4567-e89b-42d3-a456-426614174001";
  it("retains the internal reference across service recreation, follow-ups, and approval responses", async () => {
    const store = new InMemoryHostedEveStore();
    const adapter = transport({
      get: vi.fn(async () => approvalSnapshot(["build"])),
      start: vi.fn(async () => ({
        adapterSessionId: "eve_prepared",
        snapshot: approvalSnapshot(["build"]),
      })),
    });
    const createService = () =>
      createHostedEveSessionService({ principal, store, transport: adapter });
    const request = {
      clientRequestId: "prepared-start",
      prompt: "Prepared app",
      sourceHandoffId,
    };
    const result = await createService().start(request);
    expect(await createService().start(request)).toEqual(result);
    expect(adapter.start).toHaveBeenCalledOnce();
    expect(await store.getSession(principal, result.sessionId)).toMatchObject({
      sourceHandoffId,
    });
    expect(JSON.stringify(result)).not.toContain(sourceHandoffId);
    await createService().send({
      clientRequestId: "prepared-send",
      message: "Continue",
      sessionId: result.sessionId,
    });
    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({ sourceHandoffId })
    );
    await createService().respond({
      clientRequestId: "prepared-respond",
      responses: [{ requestId: "build", response: { kind: "approve" } }],
      sessionId: result.sessionId,
    });
    expect(adapter.respond).toHaveBeenCalledWith(
      expect.objectContaining({ sourceHandoffId })
    );
  });

  it("carries the reference into a recovered terminal session", async () => {
    const store = new InMemoryHostedEveStore();
    let starts = 0;
    const adapter = transport({
      start: vi.fn(async () => ({
        adapterSessionId: `eve_${++starts}`,
        snapshot: { events: [], status: "completed" as const },
      })),
    });
    const createService = () =>
      createHostedEveSessionService({ principal, store, transport: adapter });
    const first = await createService().start({
      clientRequestId: "prepared-start",
      prompt: "Prepared app",
      sourceHandoffId,
    });
    const recovered = await createService().start({
      clientRequestId: "prepared-resume",
      resumeSessionId: first.sessionId,
    });
    expect(adapter.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceHandoffId })
    );
    expect(
      await store.getSession(principal, recovered.sessionId)
    ).toMatchObject({ parentSessionId: first.sessionId, sourceHandoffId });
  });

  it("converges simultaneous prepared starts and a lost response on one session", async () => {
    const store = new InMemoryHostedEveStore();
    let accept!: (value: {
      adapterSessionId: string;
      snapshot: HostedEngineSnapshot;
    }) => void;
    let dispatched!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    const adapter = transport({
      start: vi.fn<HostedEveTransport["start"]>(
        () =>
          new Promise((resolve) => {
            accept = resolve;
            dispatched();
          })
      ),
    });
    const createService = () =>
      createHostedEveSessionService({ principal, store, transport: adapter });
    const request = {
      clientRequestId: "same-preparation",
      prompt: "Prepared app",
      sourceHandoffId,
    };
    const first = createService().start(request);
    await dispatchStarted;
    await expect(createService().start(request)).rejects.toBeInstanceOf(
      HostedSubmissionUnknownError
    );
    accept({ adapterSessionId: "eve_prepared", snapshot });
    const original = await first;
    expect(await createService().start(request)).toEqual(original);
    expect(adapter.start).toHaveBeenCalledOnce();
    expect(await store.getSession(principal, original.sessionId)).toMatchObject(
      { sourceHandoffId }
    );
  });

  it("retains prepared context when the engine disappears and during readback recovery", async () => {
    const store = new InMemoryHostedEveStore();
    let missing = false;
    let starts = 0;
    const adapter = transport({
      get: vi.fn(async () => {
        if (missing) throw new HostedAdapterSessionUnavailableError();
        return snapshot;
      }),
      start: vi.fn(async () => ({
        adapterSessionId: `eve_${++starts}`,
        snapshot,
      })),
    });
    const beforeRead = vi.fn(async () => {});
    const createService = () =>
      createHostedEveSessionService({
        beforeRead,
        principal,
        store,
        transport: adapter,
      });
    const first = await createService().start({
      clientRequestId: "prepared-start",
      prompt: "Prepared app",
      sourceHandoffId,
    });
    missing = true;
    const recovered = await createService().start({
      clientRequestId: "prepared-resume",
      resumeSessionId: first.sessionId,
    });
    expect(recovered.sessionId).toBe(first.sessionId);
    expect(adapter.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceHandoffId })
    );
    expect(await store.getSession(principal, first.sessionId)).toMatchObject({
      adapterGeneration: 2,
      sourceHandoffId,
    });
    missing = false;
    await createService().get({
      cursor: 0,
      limit: 100,
      sessionId: first.sessionId,
    });
    expect(beforeRead).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceHandoffId })
    );
  });
});

const snapshot: HostedEngineSnapshot = {
  events: [
    {
      type: "assistant.message",
      index: 0,
      turnId: "turn_1",
      text: "Ready.",
    },
    { type: "reasoning.delta", index: 1, text: "private reasoning" },
    { type: "tool.result", index: 2, message: "private tool output" },
    { type: "status", index: 3, status: "waiting" },
  ],
  status: "waiting",
};

function approvalSnapshot(requestIds: string[]): HostedEngineSnapshot {
  return {
    events: requestIds.map((requestId, index) => ({
      type: "input.requested",
      index,
      request: {
        requestId,
        kind: "approval",
        title: requestId,
        allowFreeform: false,
      },
    })),
    status: "input_required",
  };
}

function transport(overrides: Partial<HostedEveTransport> = {}) {
  const base: HostedEveTransport = {
    cancel: vi.fn(async () => snapshot),
    get: vi.fn(async () => snapshot),
    respond: vi.fn(async () => snapshot),
    send: vi.fn(async () => snapshot),
    start: vi.fn(async () => ({ adapterSessionId: "eve_1", snapshot })),
  };
  return { ...base, ...overrides };
}

function reservationStore(
  makeReservation: (candidate: HostedOperationRecord) => unknown
): HostedEveStore {
  return {
    async getSession() {
      return null;
    },
    async listSessions() {
      return { sessions: [], cursor: 0 };
    },
    async reserveOperation(_principal, candidate) {
      return makeReservation(candidate) as ReserveOperationResult;
    },
    async settleSucceeded() {
      throw new Error("settleSucceeded must not be reached");
    },
    async settleUnsuccessful() {
      throw new Error("settleUnsuccessful must not be reached");
    },
  };
}

async function invokeHostedOperation(
  service: EveSessionService,
  operation: keyof typeof hostedEveOperationScopes
) {
  switch (operation) {
    case "start": {
      return service.start({ prompt: "Build", clientRequestId: "scope_start" });
    }
    case "get": {
      return service.get({ sessionId: "session_1", cursor: 0, limit: 1 });
    }
    case "send": {
      return service.send({
        sessionId: "session_1",
        message: "Continue",
        clientRequestId: "scope_send",
      });
    }
    case "respond": {
      return service.respond({
        sessionId: "session_1",
        responses: [{ requestId: "request_1", response: { kind: "deny" } }],
        clientRequestId: "scope_respond",
      });
    }
    case "cancel": {
      return service.cancel({ sessionId: "session_1", turnId: "turn_1" });
    }
  }
}

async function started(input?: {
  store?: InMemoryHostedEveStore;
  principal?: HostedPrincipal;
  transport?: HostedEveTransport;
  now?: () => number;
  beforeRead?: Parameters<
    typeof createHostedEveSessionService
  >[0]["beforeRead"];
  sessionTimeoutPolicy?: HostedSessionTimeoutPolicy;
}) {
  const store = input?.store ?? new InMemoryHostedEveStore();
  const adapter = input?.transport ?? transport();
  const service = createHostedEveSessionService({
    now: input?.now ?? (() => 1_000),
    principal: input?.principal ?? principal,
    store,
    transport: adapter,
    ...(input?.beforeRead === undefined
      ? {}
      : { beforeRead: input.beforeRead }),
    ...(input?.sessionTimeoutPolicy === undefined
      ? {}
      : { sessionTimeoutPolicy: input.sessionTimeoutPolicy }),
  });
  const result = await service.start({
    clientRequestId: "request_1",
    prompt: "Build an app",
  });
  return { adapter, result, service, store };
}

describe("hosted Eve service core", () => {
  it("runs the repository-access recovery seam before reading Eve", async () => {
    const calls: string[] = [];
    const adapter = transport({
      get: vi.fn(async () => {
        calls.push("transport");
        return snapshot;
      }),
    });
    const beforeRead = vi.fn(async ({ adapterSessionId }) => {
      calls.push(`recovery:${adapterSessionId}`);
    });
    const running = await started({ beforeRead, transport: adapter });

    await running.service.get({
      cursor: 0,
      limit: 100,
      sessionId: running.result.sessionId,
    });

    expect(calls).toEqual(["recovery:eve_1", "transport"]);
  });

  it("recovers a bound start with start scope and never substitutes get scope", async () => {
    const store = new InMemoryHostedEveStore();
    const adapter = transport();
    const startedService = createHostedEveSessionService({
      principal: {
        ...principal,
        scopes: ["autograph:session", "autograph:start"],
      },
      store,
      transport: adapter,
    });
    const result = await startedService.start({
      clientRequestId: "start-scope-only",
      prompt: "Build an app",
    });
    await expect(
      startedService.recoverStart?.({
        cursor: 0,
        limit: 100,
        sessionId: result.sessionId,
      })
    ).resolves.toMatchObject({ sessionId: result.sessionId });

    const getOnly = createHostedEveSessionService({
      principal: {
        ...principal,
        scopes: ["autograph:session", "autograph:get"],
      },
      store,
      transport: adapter,
    });
    await expect(
      getOnly.recoverStart?.({
        cursor: 0,
        limit: 100,
        sessionId: result.sessionId,
      })
    ).rejects.toMatchObject({
      code: "insufficient_scope",
      name: HostedAuthorizationError.name,
    });
  });

  it("keeps the verified implementation plan outside cursor pagination", () => {
    const implementationPlan = {
      appId: "vendor-onboarding",
      packageName: "@autograph/vendor-onboarding",
      projectName: "apps-vendor-onboarding",
      readOnly: true as const,
      routes: ["/vendor-onboarding", "/vendor-onboarding/:path*"],
      runtime: "nextjs" as const,
    };
    expect(
      hostedEveProjectionForTesting(
        "session_1",
        {
          events: [{ type: "status", index: 0, status: "completed" }],
          implementationPlan,
          status: "completed",
        },
        1,
        100
      )
    ).toEqual({
      cursor: 1,
      events: [],
      implementationPlan,
      sessionId: "session_1",
      status: "completed",
    });
  });

  it("keeps the latest prototype outside cursor pagination", () => {
    const prototype = {
      content: "<!doctype html><html><body>Vendor queue</body></html>",
      digest: "a".repeat(64),
      mediaType: "text/html" as const,
      path: "prototype/vendor-onboarding/index.html",
      revision: "b".repeat(64),
    };
    expect(
      hostedEveProjectionForTesting(
        "session_1",
        {
          events: [{ type: "status", index: 0, status: "completed" }],
          prototype,
          status: "completed",
        },
        1,
        100
      )
    ).toEqual({
      cursor: 1,
      events: [],
      prototype,
      sessionId: "session_1",
      status: "completed",
    });
  });

  it("rejects a non-closed principal before any store or transport access", () => {
    expect(() =>
      createHostedEveSessionService({
        principal: { ...principal, unverifiedRole: "admin" } as HostedPrincipal,
        store: new InMemoryHostedEveStore(),
        transport: transport(),
      })
    ).toThrow();
  });

  it.each(
    Object.keys(
      hostedEveOperationScopes
    ) as (keyof typeof hostedEveOperationScopes)[]
  )("requires the exact %s scope before store access", async (operation) => {
    const store = new InMemoryHostedEveStore();
    const reserve = vi.spyOn(store, "reserveOperation");
    const getSession = vi.spyOn(store, "getSession");
    const adapter = transport();
    const service = createHostedEveSessionService({
      principal: {
        ...principal,
        scopes: principal.scopes.filter(
          (scope) => scope !== hostedEveOperationScopes[operation]
        ),
      },
      store,
      transport: adapter,
    });

    await expect(
      invokeHostedOperation(service, operation)
    ).rejects.toMatchObject({
      code: "insufficient_scope",
      name: HostedAuthorizationError.name,
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
    for (const method of Object.values(adapter)) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it.each([
    [
      "wrong owner",
      (candidate: HostedOperationRecord) => ({
        disposition: "reserved",
        operation: {
          ...candidate,
          principal: { ...candidate.principal, ownerUserId: "user_other" },
        },
      }),
    ],
    [
      "wrong tenant",
      (candidate: HostedOperationRecord) => ({
        disposition: "reserved",
        operation: {
          ...candidate,
          principal: { ...candidate.principal, workspaceId: "workspace_other" },
        },
      }),
    ],
    [
      "wrong kind",
      (candidate: HostedOperationRecord) => ({
        disposition: "reserved",
        operation: { ...candidate, kind: "send", sessionId: "session_other" },
      }),
    ],
    [
      "wrong client request ID",
      (candidate: HostedOperationRecord) => ({
        disposition: "reserved",
        operation: { ...candidate, clientRequestId: "request_other" },
      }),
    ],
    [
      "wrong request digest",
      (candidate: HostedOperationRecord) => ({
        disposition: "reserved",
        operation: { ...candidate, requestDigest: `sha256:${"f".repeat(64)}` },
      }),
    ],
    [
      "wrong state",
      (candidate: HostedOperationRecord) => ({
        disposition: "reserved",
        operation: {
          ...candidate,
          safeErrorCode: "submission_unknown",
          state: "submission_unknown",
        },
      }),
    ],
    ["unknown disposition", () => ({ disposition: "future" })],
  ])("rejects a malicious store reservation with %s", async (_label, make) => {
    const adapter = transport();
    const service = createHostedEveSessionService({
      principal,
      store: reservationStore(make),
      transport: adapter,
    });
    await expect(
      service.start({ clientRequestId: "malicious_store", prompt: "Build" })
    ).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    expect(adapter.start).not.toHaveBeenCalled();
  });

  it("implements all five operations and projects only allowlisted events", async () => {
    const { service, adapter, result } = await started();
    vi.mocked(adapter.get)
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValue(approvalSnapshot(["approval_1"]));
    expect(result.events).toEqual([
      {
        index: 0,
        text: "Ready.",
        turnId: "turn_1",
        type: "assistant_message",
      },
      { index: 1, status: "waiting", type: "status" },
    ]);
    expect(result.cursor).toBe(2);

    await expect(
      service.get({ cursor: 1, limit: 2, sessionId: result.sessionId })
    ).resolves.toMatchObject({ cursor: 2, events: [{ index: 1 }] });
    await service.send({
      clientRequestId: "request_2",
      message: "Continue",
      sessionId: result.sessionId,
    });
    await service.respond({
      clientRequestId: "request_3",
      responses: [{ requestId: "approval_1", response: { kind: "approve" } }],
      sessionId: result.sessionId,
    });
    await service.cancel({ sessionId: result.sessionId, turnId: "turn_1" });

    expect(adapter.get).toHaveBeenCalledTimes(2);
    expect(adapter.send).toHaveBeenCalledTimes(1);
    expect(adapter.respond).toHaveBeenCalledTimes(1);
    expect(adapter.cancel).toHaveBeenCalledTimes(1);
  });

  it("returns an honest typed rejection when cancel has no matching active turn", async () => {
    const adapter = transport({
      cancel: vi.fn(async () => {
        throw new SubmissionRejectedBeforeDispatchError("turn_changed");
      }),
    });
    const { service, result } = await started({ transport: adapter });

    await expect(
      service.cancel({ sessionId: result.sessionId, turnId: "turn_0" })
    ).rejects.toMatchObject({
      code: "turn_changed",
      message: "The hosted Eve operation was rejected before a durable result.",
      name: HostedRejectedOperationError.name,
    });
    expect(adapter.cancel).toHaveBeenCalledTimes(1);
  });

  it("returns the durable result when a start response was lost to the caller", async () => {
    const adapter = transport();
    const { service, result } = await started({ transport: adapter });
    const retried = await service.start({
      clientRequestId: "request_1",
      prompt: "Build an app",
    });
    expect(retried).toEqual(result);
    expect(adapter.start).toHaveBeenCalledTimes(1);
  });

  it("keeps user-visible handles readable beyond the compute idle lease", async () => {
    let now = 1000;
    const adapter = transport();
    const first = await started({
      now: () => now,
      sessionTimeoutPolicy: {
        idleTimeoutMs: 60_000,
        maxLifetimeMs: 120_000,
      },
      transport: adapter,
    });
    now = 62_000;

    await expect(
      first.service.get({
        cursor: 0,
        limit: 1,
        sessionId: first.result.sessionId,
      })
    ).resolves.toMatchObject({ sessionId: first.result.sessionId });
    await expect(
      first.service.start({
        clientRequestId: "request_1",
        prompt: "Build an app",
      })
    ).resolves.toEqual(first.result);
    expect(adapter.start).toHaveBeenCalledTimes(1);
    expect(adapter.get).toHaveBeenCalledTimes(1);
  });

  it("keeps user-visible handles readable beyond the compute maximum lifetime", async () => {
    let now = 1000;
    const adapter = transport();
    const first = await started({
      now: () => now,
      sessionTimeoutPolicy: {
        idleTimeoutMs: 120_000,
        maxLifetimeMs: 120_000,
      },
      transport: adapter,
    });
    now = 61_000;
    await first.service.get({
      cursor: 0,
      limit: 1,
      sessionId: first.result.sessionId,
    });
    now = 122_000;
    await expect(
      first.service.get({
        cursor: 0,
        limit: 1,
        sessionId: first.result.sessionId,
      })
    ).resolves.toMatchObject({ sessionId: first.result.sessionId });
    expect(adapter.get).toHaveBeenCalledTimes(2);
  });

  it("lists recent sessions with tenant-scoped pagination", async () => {
    const store = new InMemoryHostedEveStore();
    const first = await started({ store });
    const second = await first.service.start({
      clientRequestId: "request_2",
      prompt: "Build a vendor workspace",
    });
    const other = await started({
      principal: {
        ...principal,
        ownerUserId: "user_other",
        workspaceId: "workspace_other",
      },
      store,
    });

    const pageOne = await first.service.list({ cursor: 0, limit: 1 });
    const pageTwo = await first.service.list({
      cursor: pageOne.cursor,
      limit: 10,
    });
    expect(
      [...pageOne.sessions, ...pageTwo.sessions]
        .map(({ sessionId }) => sessionId)
        .sort()
    ).toEqual([first.result.sessionId, second.sessionId].sort());
    expect(JSON.stringify([pageOne, pageTwo])).not.toContain(
      other.result.sessionId
    );
  });

  it("lists legacy rows and lazily backfills a checkpoint on first read", async () => {
    const store = new InMemoryHostedEveStore();
    const candidate = hostedOperationRecordSchema.parse({
      clientRequestId: "start_legacy",
      createdAtEpochMs: 1_000,
      kind: "start",
      operationId: "op_legacy",
      principal,
      requestDigest: `sha256:${"a".repeat(64)}`,
      state: "reserved",
      updatedAtEpochMs: 1_000,
      version: 1,
    });
    expect(await store.reserveOperation(principal, candidate)).toMatchObject({
      disposition: "reserved",
    });
    await store.settleSucceeded({
      nowEpochMs: 1_000,
      operationId: candidate.operationId,
      principal,
      requestDigest: candidate.requestDigest,
      result: {
        cursor: 0,
        events: [],
        sessionId: "session_legacy",
        status: "waiting",
      },
      session: {
        adapterSessionId: "eve_legacy",
        createdAtEpochMs: 1_000,
        principal,
        sessionId: "session_legacy",
        status: "waiting",
        updatedAtEpochMs: 1_000,
        version: 1,
      },
    });
    const service = createHostedEveSessionService({
      now: () => 2_000,
      principal,
      store,
      transport: transport(),
    });
    await expect(service.list({ cursor: 0, limit: 10 })).resolves.toMatchObject(
      {
        sessions: [
          {
            resumability: "restart_required",
            sessionId: "session_legacy",
            title: "Previous App Builder session",
          },
        ],
      }
    );
    await service.get({ cursor: 0, limit: 100, sessionId: "session_legacy" });
    const upgraded = await store.getSession(principal, "session_legacy");
    expect(upgraded).toMatchObject({
      adapterGeneration: 1,
      resumability: "live",
      version: 2,
    });
    if (upgraded?.version !== 2) {
      throw new Error("Expected lazy durable-session upgrade.");
    }
    expect(upgraded.checkpoint).toBeDefined();
  });

  it("backfills a healthy terminal legacy adapter before creating its resumed child", async () => {
    const store = new InMemoryHostedEveStore();
    const candidate = hostedOperationRecordSchema.parse({
      clientRequestId: "start_legacy_terminal",
      createdAtEpochMs: 1_000,
      kind: "start",
      operationId: "op_legacy_terminal",
      principal,
      requestDigest: `sha256:${"b".repeat(64)}`,
      state: "reserved",
      updatedAtEpochMs: 1_000,
      version: 1,
    });
    expect(await store.reserveOperation(principal, candidate)).toMatchObject({
      disposition: "reserved",
    });
    await store.settleSucceeded({
      nowEpochMs: 1_000,
      operationId: candidate.operationId,
      principal,
      requestDigest: candidate.requestDigest,
      result: {
        cursor: 0,
        events: [],
        sessionId: "session_legacy_terminal",
        status: "completed",
      },
      session: {
        adapterSessionId: "eve_legacy_terminal",
        createdAtEpochMs: 1_000,
        principal,
        sessionId: "session_legacy_terminal",
        status: "completed",
        updatedAtEpochMs: 1_000,
        version: 1,
      },
    });
    const terminalSnapshot: HostedEngineSnapshot = {
      events: [{ type: "status", index: 0, status: "completed" }],
      status: "completed",
    };
    const adapter = transport({
      get: vi.fn(async () => terminalSnapshot),
      start: vi.fn(async () => ({
        adapterSessionId: "eve_legacy_child",
        snapshot,
      })),
    });
    const service = createHostedEveSessionService({
      now: () => 2_000,
      principal,
      store,
      transport: adapter,
    });

    const resumed = await service.start({
      clientRequestId: "resume_legacy_terminal",
      resumeSessionId: "session_legacy_terminal",
    });

    expect(adapter.get).toHaveBeenCalledTimes(1);
    expect(adapter.start).toHaveBeenCalledTimes(1);
    expect(resumed.sessionId).not.toBe("session_legacy_terminal");
    await expect(
      store.getSession(principal, "session_legacy_terminal")
    ).resolves.toMatchObject({
      checkpoint: { status: "completed" },
      resumability: "terminal",
      version: 2,
    });
    await expect(
      store.getSession(principal, resumed.sessionId)
    ).resolves.toMatchObject({
      parentSessionId: "session_legacy_terminal",
      version: 2,
    });
  });

  it("preserves outstanding input at a checkpoint boundary", async () => {
    const adapter = transport({
      start: vi.fn(async () => ({
        adapterSessionId: "eve_input",
        snapshot: approvalSnapshot(["approve_one", "approve_two"]),
      })),
    });
    const first = await started({ transport: adapter });
    vi.mocked(adapter.get).mockRejectedValueOnce(
      new HostedAdapterSessionUnavailableError()
    );

    await expect(
      first.service.get({
        cursor: first.result.cursor,
        limit: 100,
        sessionId: first.result.sessionId,
      })
    ).resolves.toMatchObject({
      inputRequests: [
        { requestId: "approve_one" },
        { requestId: "approve_two" },
      ],
      status: "input_required",
    });
  });

  it("reissues exact outstanding input context when replacing a missing adapter", async () => {
    let recovery = "";
    const adapter = transport({
      get: vi.fn(async () => {
        throw new HostedAdapterSessionUnavailableError();
      }),
      start: vi
        .fn()
        .mockResolvedValueOnce({
          adapterSessionId: "eve_input_old",
          snapshot: approvalSnapshot(["approve_one", "approve_two"]),
        })
        .mockImplementationOnce(async ({ prompt }) => {
          recovery = prompt;
          return {
            adapterSessionId: "eve_input_new",
            snapshot: approvalSnapshot(["approve_one", "approve_two"]),
          };
        }),
    });
    const first = await started({ transport: adapter });

    const resumed = await first.service.start({
      clientRequestId: "resume_input_boundary",
      resumeSessionId: first.result.sessionId,
    });

    expect(resumed).toMatchObject({
      inputRequests: [
        { requestId: "approve_one", title: "approve_one" },
        { requestId: "approve_two", title: "approve_two" },
      ],
      sessionId: first.result.sessionId,
      status: "input_required",
    });
    expect(recovery).toContain("Outstanding unresolved product requests");
    expect(recovery).toContain('"requestId":"approve_one"');
    expect(recovery).toContain('"requestId":"approve_two"');
    expect(recovery).toContain("Reissue every unresolved product request");
    await expect(
      first.store.getSession(principal, first.result.sessionId)
    ).resolves.toMatchObject({
      adapterGeneration: 2,
      adapterSessionId: "eve_input_new",
      checkpoint: {
        inputRequests: [
          { requestId: "approve_one" },
          { requestId: "approve_two" },
        ],
      },
      version: 2,
    });
  });

  it("bounds durable checkpoints by event count and encoded bytes", async () => {
    const largeSnapshot: HostedEngineSnapshot = {
      events: Array.from({ length: 600 }, (_, index) => ({
        type: "assistant.message",
        index,
        turnId: `turn_${index}`,
        text: `${index}:`.padEnd(10_000, "x"),
      })),
      status: "waiting",
    };
    const store = new InMemoryHostedEveStore();
    const first = await started({
      store,
      transport: transport({
        start: vi.fn(async () => ({
          adapterSessionId: "eve_large",
          snapshot: largeSnapshot,
        })),
      }),
    });
    const record = await store.getSession(principal, first.result.sessionId);
    expect(record?.version).toBe(2);
    if (record?.version !== 2) {
      throw new Error("Expected durable session.");
    }
    expect(record.checkpoint?.events.length).toBeLessThanOrEqual(512);
    expect(
      new TextEncoder().encode(JSON.stringify(record.checkpoint)).byteLength
    ).toBeLessThanOrEqual(512 * 1024);
    expect(record.checkpoint?.truncatedBeforeIndex).toBeGreaterThan(0);
  });

  it("compacts max-shape user fields without losing outstanding request IDs", async () => {
    const requestIds = Array.from(
      { length: 32 },
      (_, index) => `request_${index.toString().padStart(2, "0")}`
    );
    const oversized = "A".repeat(65_536);
    const richSnapshot: HostedEngineSnapshot = {
      events: requestIds.map((requestId, index) => ({
        type: "input.requested",
        index,
        request: {
          requestId,
          kind: "question",
          title: oversized,
          description: oversized,
          options: Array.from({ length: 8 }, (_, optionIndex) => ({
            id: `${requestId}_option_${optionIndex}`,
            label: "L".repeat(4_096),
          })),
          allowFreeform: false,
        },
      })),
      implementationPlan: {
        appId: "stock-exceptions",
        packageName: "@autograph/stock-exceptions",
        projectName: "apps-stock-exceptions",
        readOnly: true,
        routes: Array.from(
          { length: 48 },
          (_, index) => `/${index}-${"r".repeat(1_024)}`
        ),
        runtime: "nextjs",
      },
      prototype: {
        content: "P".repeat(262_144),
        digest: "a".repeat(64),
        mediaType: "text/html",
        path: "prototype/stock-exceptions/index.html",
        revision: "b".repeat(64),
      },
      status: "input_required",
    };
    const store = new InMemoryHostedEveStore();

    const first = await started({
      store,
      transport: transport({
        start: vi.fn(async () => ({
          adapterSessionId: "eve_max_shape",
          snapshot: richSnapshot,
        })),
      }),
    });

    const record = await store.getSession(principal, first.result.sessionId);
    expect(record?.version).toBe(2);
    if (record?.version !== 2) {
      throw new Error("Expected durable session.");
    }
    expect(
      new TextEncoder().encode(JSON.stringify(record.checkpoint)).byteLength
    ).toBeLessThanOrEqual(512 * 1024);
    expect(record.checkpoint?.prototype).toBeDefined();
    expect(record.checkpoint?.implementationPlan).toBeDefined();
    expect(
      record.checkpoint?.inputRequests?.map(({ requestId }) => requestId)
    ).toEqual(requestIds);
    expect(record.checkpoint?.inputRequests?.[0]?.title.length).toBeLessThan(
      oversized.length
    );
    expect(
      record.checkpoint?.inputRequests?.[0]?.description?.length
    ).toBeLessThan(oversized.length);
  });

  it("stops refreshing an abandoned working lease and resumes as a child", async () => {
    let now = 1000;
    const working: HostedEngineSnapshot = {
      events: [{ type: "status", index: 0, status: "working" }],
      status: "working",
    };
    const adapter = transport({
      get: vi.fn(async () => working),
      start: vi
        .fn()
        .mockResolvedValueOnce({
          adapterSessionId: "eve_working",
          snapshot: working,
        })
        .mockResolvedValueOnce({
          adapterSessionId: "eve_child",
          snapshot,
        }),
    });
    const first = await started({
      now: () => now,
      sessionTimeoutPolicy: {
        idleTimeoutMs: 60_000,
        maxLifetimeMs: 120_000,
      },
      transport: adapter,
    });
    now = 61_001;
    await expect(
      first.service.get({
        cursor: 0,
        limit: 100,
        sessionId: first.result.sessionId,
      })
    ).resolves.toMatchObject({ status: "waiting" });

    const resumed = await first.service.start({
      clientRequestId: "resume_stuck",
      resumeSessionId: first.result.sessionId,
    });
    expect(resumed.sessionId).not.toBe(first.result.sessionId);
    const child = await first.store.getSession(principal, resumed.sessionId);
    expect(child).toMatchObject({
      parentSessionId: first.result.sessionId,
      version: 2,
    });
  });

  it("keeps a healthy handle and fences missing-adapter recovery", async () => {
    const store = new InMemoryHostedEveStore();
    const healthyAdapter = transport();
    const healthy = await started({ store, transport: healthyAdapter });
    const same = await healthy.service.start({
      clientRequestId: "resume_healthy",
      resumeSessionId: healthy.result.sessionId,
    });
    expect(same.sessionId).toBe(healthy.result.sessionId);
    expect(healthyAdapter.start).toHaveBeenCalledTimes(1);

    const missingAdapter = transport({
      get: vi.fn(async () => {
        throw new HostedAdapterSessionUnavailableError();
      }),
      start: vi
        .fn()
        .mockResolvedValueOnce({ adapterSessionId: "eve_old", snapshot })
        .mockResolvedValueOnce({ adapterSessionId: "eve_new", snapshot }),
    });
    const recovering = await started({ transport: missingAdapter });
    const recovered = await recovering.service.start({
      clientRequestId: "resume_missing",
      resumeSessionId: recovering.result.sessionId,
    });
    expect(recovered.sessionId).toBe(recovering.result.sessionId);
    const record = await recovering.store.getSession(
      principal,
      recovering.result.sessionId
    );
    expect(record).toMatchObject({
      adapterGeneration: 2,
      adapterSessionId: "eve_new",
      version: 2,
    });
  });

  it("allows only one mutating continuation for a session", async () => {
    let resolveSend!: (value: HostedEngineSnapshot) => void;
    const adapter = transport({
      send: vi.fn(
        () =>
          new Promise<HostedEngineSnapshot>((resolve) => {
            resolveSend = resolve;
          })
      ),
    });
    const first = await started({ transport: adapter });
    const active = first.service.send({
      clientRequestId: "send_active",
      message: "First",
      sessionId: first.result.sessionId,
    });
    await vi.waitFor(() => expect(adapter.send).toHaveBeenCalledTimes(1));
    await expect(
      first.service.send({
        clientRequestId: "send_competing",
        message: "Second",
        sessionId: first.result.sessionId,
      })
    ).rejects.toBeInstanceOf(HostedSessionBusyError);
    resolveSend(snapshot);
    await expect(active).resolves.toMatchObject({ status: "waiting" });
  });

  it("serializes competing child resumes from one terminal session", async () => {
    let resolveResume!: (value: {
      adapterSessionId: string;
      snapshot: HostedEngineSnapshot;
    }) => void;
    const terminalSnapshot: HostedEngineSnapshot = {
      events: [{ type: "status", index: 0, status: "completed" }],
      status: "completed",
    };
    const adapter = transport({
      start: vi
        .fn()
        .mockResolvedValueOnce({
          adapterSessionId: "eve_terminal",
          snapshot: terminalSnapshot,
        })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveResume = resolve;
            })
        ),
    });
    const first = await started({ transport: adapter });
    const active = first.service.start({
      clientRequestId: "resume_active",
      resumeSessionId: first.result.sessionId,
    });
    await vi.waitFor(() => expect(adapter.start).toHaveBeenCalledTimes(2));
    await expect(
      first.service.start({
        clientRequestId: "resume_competing",
        resumeSessionId: first.result.sessionId,
      })
    ).rejects.toBeInstanceOf(HostedSessionBusyError);
    resolveResume({ adapterSessionId: "eve_child", snapshot });
    await expect(active).resolves.toMatchObject({ status: "waiting" });
  });

  it.each(["missing", "mismatched"] as const)(
    "rejects a succeeded start retry when its stored session is %s",
    async (condition) => {
      const base = new InMemoryHostedEveStore();
      const first = await started({ store: base });
      const retryStore: HostedEveStore = {
        async getSession(requestPrincipal, sessionId) {
          const session = await base.getSession(requestPrincipal, sessionId);
          if (condition === "missing") return null;
          return session === null
            ? null
            : { ...session, adapterSessionId: "eve_mismatched" };
        },
        listSessions: (request) => base.listSessions(request),
        reserveOperation: (requestPrincipal, candidate) =>
          base.reserveOperation(requestPrincipal, candidate),
        settleSucceeded: (settlement) => base.settleSucceeded(settlement),
        settleUnsuccessful: (settlement) => base.settleUnsuccessful(settlement),
      };
      const retry = createHostedEveSessionService({
        now: () => 1_000,
        principal,
        store: retryStore,
        transport: first.adapter,
      });

      await expect(
        retry.start({
          clientRequestId: "request_1",
          prompt: "Build an app",
        })
      ).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
      expect(first.adapter.start).toHaveBeenCalledTimes(1);
    }
  );

  it("rejects reuse of a client request identifier for changed bytes", async () => {
    const { service, adapter } = await started();
    await expect(
      service.start({
        clientRequestId: "request_1",
        prompt: "Build a different app",
      })
    ).rejects.toBeInstanceOf(HostedIdempotencyConflictError);
    expect(adapter.start).toHaveBeenCalledTimes(1);
  });

  it("binds respond idempotency to the exact ordered full batch", async () => {
    const adapter = transport({
      get: vi.fn(async () => approvalSnapshot(["one", "two", "three"])),
    });
    const { service, result } = await started({ transport: adapter });
    const responses = [
      { requestId: "one", response: { kind: "approve" as const } },
      { requestId: "two", response: { kind: "deny" as const } },
      {
        requestId: "three",
        response: { kind: "answer" as const, value: "Choice" },
      },
    ];
    const request = {
      clientRequestId: "respond_batch",
      responses,
      sessionId: result.sessionId,
    };
    await service.respond(request);
    await service.respond(request);
    expect(adapter.respond).toHaveBeenCalledTimes(1);
    await expect(
      service.respond({ ...request, responses: [...responses].reverse() })
    ).rejects.toBeInstanceOf(HostedIdempotencyConflictError);
    expect(adapter.respond).toHaveBeenCalledTimes(1);
  });

  it("never redispatches an accepted response whose settlement is unknown", async () => {
    const requestId = "aitxt-0oQwVrjWKWZWGigsWFL0FUqy";
    const adapter = transport({
      get: vi.fn(async () => approvalSnapshot([requestId])),
      respond: vi.fn(async () => {
        throw new SubmissionOutcomeUnknownError();
      }),
    });
    const { service, result } = await started({ transport: adapter });
    const request = {
      clientRequestId: "respond_unsettled",
      responses: [{ requestId, response: { kind: "deny" as const } }],
      sessionId: result.sessionId,
    };

    await expect(service.respond(request)).rejects.toBeInstanceOf(
      HostedSubmissionUnknownError
    );
    await expect(service.respond(request)).rejects.toBeInstanceOf(
      HostedSubmissionUnknownError
    );
    expect(adapter.respond).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing member of the outstanding input batch", async () => {
    const adapter = transport({
      get: vi.fn(async () => approvalSnapshot(["one", "two", "three"])),
    });
    const { service, result } = await started({ transport: adapter });
    await expect(
      service.respond({
        clientRequestId: "incomplete_batch",
        responses: [
          { requestId: "one", response: { kind: "approve" } },
          { requestId: "two", response: { kind: "approve" } },
        ],
        sessionId: result.sessionId,
      })
    ).rejects.toMatchObject({
      code: "input_batch_changed",
      name: HostedRejectedOperationError.name,
    });
    expect(adapter.respond).not.toHaveBeenCalled();
  });

  it("never redispatches an operation whose submission outcome is unknown", async () => {
    const start = vi.fn(async () => {
      throw new SubmissionOutcomeUnknownError();
    });
    const service = createHostedEveSessionService({
      now: () => 2_000,
      principal,
      store: new InMemoryHostedEveStore(),
      transport: transport({ start }),
    });
    const request = {
      clientRequestId: "lost_response",
      prompt: "Build an app",
    };
    await expect(service.start(request)).rejects.toBeInstanceOf(
      HostedSubmissionUnknownError
    );
    await expect(service.start(request)).rejects.toBeInstanceOf(
      HostedSubmissionUnknownError
    );
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("treats an unclassified transport failure as unknown, not safe to retry", async () => {
    const start = vi.fn(async () => {
      throw new Error("socket closed");
    });
    const service = createHostedEveSessionService({
      principal,
      store: new InMemoryHostedEveStore(),
      transport: transport({ start }),
    });
    const request = { clientRequestId: "socket_closed", prompt: "Build" };
    await expect(service.start(request)).rejects.toBeInstanceOf(
      HostedSubmissionUnknownError
    );
    await expect(service.start(request)).rejects.toBeInstanceOf(
      HostedSubmissionUnknownError
    );
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("records a proven pre-dispatch rejection without exposing transport text", async () => {
    const start = vi.fn(async () => {
      throw new SubmissionRejectedBeforeDispatchError("credential_expired");
    });
    const service = createHostedEveSessionService({
      principal,
      store: new InMemoryHostedEveStore(),
      transport: transport({ start }),
    });
    const request = { clientRequestId: "rejected", prompt: "Build" };
    await expect(service.start(request)).rejects.toMatchObject({
      code: "credential_expired",
      message: "The hosted Eve operation was rejected before a durable result.",
      name: HostedRejectedOperationError.name,
    });
    await expect(service.start(request)).rejects.toBeInstanceOf(
      HostedRejectedOperationError
    );
    expect(start).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "state",
      (record: HostedOperationRecord) => ({
        ...record,
        safeErrorCode: "submission_unknown",
        state: "submission_unknown",
      }),
    ],
    [
      "tenant",
      (record: HostedOperationRecord) => ({
        ...record,
        principal: { ...record.principal, workspaceId: "workspace_other" },
      }),
    ],
    [
      "kind",
      (record: HostedOperationRecord) => ({
        ...record,
        kind: "send",
        sessionId: "session_other",
      }),
    ],
    [
      "digest",
      (record: HostedOperationRecord) => ({
        ...record,
        requestDigest: `sha256:${"e".repeat(64)}`,
      }),
    ],
    [
      "safe code",
      (record: HostedOperationRecord) => ({
        ...record,
        safeErrorCode: "different_code",
      }),
    ],
  ])(
    "fails closed on an unsuccessful settlement %s mismatch",
    async (_label, transform) => {
      const base = new InMemoryHostedEveStore();
      const maliciousStore: HostedEveStore = {
        getSession: (requestPrincipal, sessionId) =>
          base.getSession(requestPrincipal, sessionId),
        listSessions: (request) => base.listSessions(request),
        reserveOperation: (requestPrincipal, candidate) =>
          base.reserveOperation(requestPrincipal, candidate),
        settleSucceeded: (settlement) => base.settleSucceeded(settlement),
        async settleUnsuccessful(settlement) {
          const record = await base.settleUnsuccessful(settlement);
          return transform(record) as HostedOperationRecord;
        },
      };
      const start = vi.fn(async () => {
        throw new SubmissionRejectedBeforeDispatchError("credential_expired");
      });
      const service = createHostedEveSessionService({
        principal,
        store: maliciousStore,
        transport: transport({ start }),
      });
      await expect(
        service.start({
          clientRequestId: `bad_settlement_${_label}`,
          prompt: "Build",
        })
      ).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
      expect(start).toHaveBeenCalledTimes(1);
    }
  );

  it.each(["result", "events", "session ID", "stored session"] as const)(
    "fails closed when successful settlement substitutes the %s",
    async (substitution) => {
      const base = new InMemoryHostedEveStore();
      const maliciousStore: HostedEveStore = {
        async getSession(requestPrincipal, sessionId) {
          const session = await base.getSession(requestPrincipal, sessionId);
          return substitution === "stored session" && session !== null
            ? { ...session, adapterSessionId: "eve_substituted" }
            : session;
        },
        listSessions: (request) => base.listSessions(request),
        reserveOperation: (requestPrincipal, candidate) =>
          base.reserveOperation(requestPrincipal, candidate),
        async settleSucceeded(settlement) {
          const record = await base.settleSucceeded(settlement);
          if (record.state !== "succeeded") {
            throw new Error("Expected a succeeded record.");
          }
          if (substitution === "result") {
            return {
              ...record,
              result: { ...record.result, status: "completed", cursor: 99 },
            };
          }
          if (substitution === "events") {
            return {
              ...record,
              result: {
                ...record.result,
                events: [
                  {
                    type: "assistant_message",
                    index: 0,
                    turnId: "turn_substituted",
                    text: "Substituted output",
                  },
                ],
              },
            };
          }
          if (substitution === "session ID") {
            return {
              ...record,
              sessionId: "session_substituted",
              result: {
                ...record.result,
                sessionId: "session_substituted",
              },
            };
          }
          return record;
        },
        settleUnsuccessful: (settlement) => base.settleUnsuccessful(settlement),
      };
      const adapter = transport();
      const service = createHostedEveSessionService({
        now: () => 4_000,
        principal,
        store: maliciousStore,
        transport: adapter,
      });

      await expect(
        service.start({
          clientRequestId: `substituted_${substitution.replace(" ", "_")}`,
          prompt: "Build",
        })
      ).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
      expect(adapter.start).toHaveBeenCalledTimes(1);
    }
  );

  it("does not disclose or operate on another tenant's session", async () => {
    const sharedStore = new InMemoryHostedEveStore();
    const first = await started({ store: sharedStore });
    const otherPrincipal = {
      ...principal,
      ownerUserId: "user_2",
      workspaceId: "workspace_2",
    };
    const otherTransport = transport();
    const otherService = createHostedEveSessionService({
      principal: otherPrincipal,
      store: sharedStore,
      transport: otherTransport,
    });

    await expect(
      otherService.get({
        cursor: 0,
        limit: 100,
        sessionId: first.result.sessionId,
      })
    ).rejects.toBeInstanceOf(HostedSessionNotFoundError);
    await expect(
      otherService.send({
        clientRequestId: "cross_tenant",
        message: "Steal session",
        sessionId: first.result.sessionId,
      })
    ).rejects.toBeInstanceOf(HostedSessionNotFoundError);
    expect(otherTransport.get).not.toHaveBeenCalled();
    expect(otherTransport.send).not.toHaveBeenCalled();
  });

  it("does not share sessions across audiences", async () => {
    const sharedStore = new InMemoryHostedEveStore();
    const first = await started({ store: sharedStore });
    const otherTransport = transport();
    const otherService = createHostedEveSessionService({
      principal: { ...principal, audience: "another-client" },
      store: sharedStore,
      transport: otherTransport,
    });
    await expect(
      otherService.get({
        cursor: 0,
        limit: 100,
        sessionId: first.result.sessionId,
      })
    ).rejects.toBeInstanceOf(HostedSessionNotFoundError);
    expect(otherTransport.get).not.toHaveBeenCalled();
  });

  it("rejects unknown durable record fields", () => {
    expect(
      hostedOperationRecordSchema.safeParse({
        clientRequestId: "request_1",
        continuationToken: "must-not-be-stored-here",
        createdAtEpochMs: 1,
        kind: "start",
        operationId: "op_1",
        principal,
        requestDigest: `sha256:${"a".repeat(64)}`,
        state: "reserved",
        updatedAtEpochMs: 1,
        version: 1,
      }).success
    ).toBe(false);
  });

  it("rejects a terminal operation whose public result names another session", () => {
    expect(
      hostedOperationRecordSchema.safeParse({
        clientRequestId: "request_1",
        createdAtEpochMs: 1,
        kind: "send",
        operationId: "op_1",
        principal,
        requestDigest: `sha256:${"a".repeat(64)}`,
        result: {
          cursor: 0,
          events: [],
          sessionId: "session_2",
          status: "waiting",
        },
        sessionId: "session_1",
        state: "succeeded",
        updatedAtEpochMs: 2,
        version: 1,
      }).success
    ).toBe(false);
  });

  it("enforces state-specific closed operation fields", () => {
    const common = {
      clientRequestId: "request_1",
      createdAtEpochMs: 1,
      kind: "start",
      operationId: "op_1",
      principal,
      requestDigest: `sha256:${"a".repeat(64)}`,
      updatedAtEpochMs: 2,
      version: 1,
    };
    expect(
      hostedOperationRecordSchema.safeParse({
        ...common,
        safeErrorCode: "not_allowed",
        state: "reserved",
      }).success
    ).toBe(false);
    expect(
      hostedOperationRecordSchema.safeParse({
        ...common,
        result: {
          cursor: 0,
          events: [],
          sessionId: "session_1",
          status: "waiting",
        },
        sessionId: "session_1",
        state: "succeeded",
      }).success
    ).toBe(false);
    expect(
      hostedOperationRecordSchema.safeParse({
        ...common,
        safeErrorCode: "rejected",
        sessionId: "invented_session",
        state: "rejected",
      }).success
    ).toBe(false);
    expect(
      hostedOperationRecordSchema.safeParse({
        ...common,
        result: {
          cursor: 0,
          events: [],
          sessionId: "invented_session",
          status: "waiting",
        },
        safeErrorCode: "submission_unknown",
        state: "submission_unknown",
      }).success
    ).toBe(false);
  });
});
