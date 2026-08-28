import { describe, expect, it, vi } from "vitest";

import {
  hostedEveOperationScopes,
  HostedAuthorizationError,
  type HostedPrincipal,
} from "./hosted-auth";
import {
  createHostedEveSessionService,
  hostedEveProjectionForTesting,
  HostedIdempotencyConflictError,
  HostedSessionNotFoundError,
  HostedSubmissionUnknownError,
  HostedRejectedOperationError,
  SubmissionOutcomeUnknownError,
  SubmissionRejectedBeforeDispatchError,
  type HostedEngineSnapshot,
  type HostedEveTransport,
} from "./hosted-service";
import {
  hostedOperationRecordSchema,
  InMemoryHostedEveStore,
  type HostedEveStore,
  type HostedOperationRecord,
  type ReserveOperationResult,
  type HostedSessionTimeoutPolicy,
} from "./hosted-store";
import type { EveSessionService } from "./service";

const principal: HostedPrincipal = {
  issuer: "https://identity.example.test",
  audience: "autograph-app-builder",
  workspaceId: "workspace_1",
  ownerUserId: "user_1",
  scopes: Object.values(hostedEveOperationScopes),
};

const snapshot: HostedEngineSnapshot = {
  status: "waiting",
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
};

function approvalSnapshot(requestIds: string[]): HostedEngineSnapshot {
  return {
    status: "input_required",
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
  };
}

function transport(overrides: Partial<HostedEveTransport> = {}) {
  const base: HostedEveTransport = {
    start: vi.fn(async () => ({ adapterSessionId: "eve_1", snapshot })),
    get: vi.fn(async () => snapshot),
    send: vi.fn(async () => snapshot),
    respond: vi.fn(async () => snapshot),
    cancel: vi.fn(async () => snapshot),
  };
  return { ...base, ...overrides };
}

function reservationStore(
  makeReservation: (candidate: HostedOperationRecord) => unknown,
): HostedEveStore {
  return {
    async reserveOperation(_principal, candidate) {
      return makeReservation(candidate) as ReserveOperationResult;
    },
    async settleSucceeded() {
      throw new Error("settleSucceeded must not be reached");
    },
    async settleUnsuccessful() {
      throw new Error("settleUnsuccessful must not be reached");
    },
    async getSession() {
      return null;
    },
  };
}

async function invokeHostedOperation(
  service: EveSessionService,
  operation: keyof typeof hostedEveOperationScopes,
) {
  switch (operation) {
    case "start":
      return service.start({ prompt: "Build", clientRequestId: "scope_start" });
    case "get":
      return service.get({ sessionId: "session_1", cursor: 0, limit: 1 });
    case "send":
      return service.send({
        sessionId: "session_1",
        message: "Continue",
        clientRequestId: "scope_send",
      });
    case "respond":
      return service.respond({
        sessionId: "session_1",
        responses: [{ requestId: "request_1", response: { kind: "deny" } }],
        clientRequestId: "scope_respond",
      });
    case "cancel":
      return service.cancel({ sessionId: "session_1", turnId: "turn_1" });
  }
}

async function started(input?: {
  store?: InMemoryHostedEveStore;
  principal?: HostedPrincipal;
  transport?: HostedEveTransport;
  now?: () => number;
  sessionTimeoutPolicy?: HostedSessionTimeoutPolicy;
}) {
  const store = input?.store ?? new InMemoryHostedEveStore();
  const adapter = input?.transport ?? transport();
  const service = createHostedEveSessionService({
    principal: input?.principal ?? principal,
    store,
    transport: adapter,
    now: input?.now ?? (() => 1_000),
    ...(input?.sessionTimeoutPolicy === undefined
      ? {}
      : { sessionTimeoutPolicy: input.sessionTimeoutPolicy }),
  });
  const result = await service.start({
    prompt: "Build an app",
    clientRequestId: "request_1",
  });
  return { store, adapter, service, result };
}

describe("hosted Eve service core", () => {
  it("keeps the verified implementation plan outside cursor pagination", () => {
    const implementationPlan = {
      appId: "vendor-onboarding",
      runtime: "nextjs" as const,
      workspacePath: "apps/vendor-onboarding",
      packageName: "@autograph/vendor-onboarding",
      projectName: "apps-vendor-onboarding",
      routes: ["/vendor-onboarding", "/vendor-onboarding/:path*"],
      sourceSha: "a".repeat(40),
      sourceTree: "b".repeat(40),
      proposalDigest: "c".repeat(64),
      readOnly: true as const,
    };
    expect(
      hostedEveProjectionForTesting(
        "session_1",
        {
          status: "completed",
          events: [{ type: "status", index: 0, status: "completed" }],
          implementationPlan,
        },
        1,
        100,
      ),
    ).toEqual({
      sessionId: "session_1",
      status: "completed",
      cursor: 1,
      events: [],
      implementationPlan,
    });
  });

  it("keeps the latest prototype outside cursor pagination", () => {
    const prototype = {
      path: "prototype/vendor-onboarding/index.html",
      mediaType: "text/html" as const,
      content: "<!doctype html><html><body>Vendor queue</body></html>",
      digest: "a".repeat(64),
      revision: "b".repeat(64),
    };
    expect(
      hostedEveProjectionForTesting(
        "session_1",
        {
          status: "completed",
          events: [{ type: "status", index: 0, status: "completed" }],
          prototype,
        },
        1,
        100,
      ),
    ).toEqual({
      sessionId: "session_1",
      status: "completed",
      cursor: 1,
      events: [],
      prototype,
    });
  });

  it("rejects a non-closed principal before any store or transport access", () => {
    expect(() =>
      createHostedEveSessionService({
        principal: { ...principal, unverifiedRole: "admin" } as HostedPrincipal,
        store: new InMemoryHostedEveStore(),
        transport: transport(),
      }),
    ).toThrow();
  });

  it.each(
    Object.keys(hostedEveOperationScopes) as Array<
      keyof typeof hostedEveOperationScopes
    >,
  )("requires the exact %s scope before store access", async (operation) => {
    const store = new InMemoryHostedEveStore();
    const reserve = vi.spyOn(store, "reserveOperation");
    const getSession = vi.spyOn(store, "getSession");
    const adapter = transport();
    const service = createHostedEveSessionService({
      principal: {
        ...principal,
        scopes: principal.scopes.filter(
          (scope) => scope !== hostedEveOperationScopes[operation],
        ),
      },
      store,
      transport: adapter,
    });

    await expect(
      invokeHostedOperation(service, operation),
    ).rejects.toMatchObject({
      name: HostedAuthorizationError.name,
      code: "insufficient_scope",
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
          state: "submission_unknown",
          safeErrorCode: "submission_unknown",
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
      service.start({ prompt: "Build", clientRequestId: "malicious_store" }),
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
        type: "assistant_message",
        index: 0,
        turnId: "turn_1",
        text: "Ready.",
      },
      { type: "status", index: 1, status: "waiting" },
    ]);
    expect(result.cursor).toBe(2);

    await expect(
      service.get({ sessionId: result.sessionId, cursor: 1, limit: 2 }),
    ).resolves.toMatchObject({ cursor: 2, events: [{ index: 1 }] });
    await service.send({
      sessionId: result.sessionId,
      message: "Continue",
      clientRequestId: "request_2",
    });
    await service.respond({
      sessionId: result.sessionId,
      responses: [{ requestId: "approval_1", response: { kind: "approve" } }],
      clientRequestId: "request_3",
    });
    await service.cancel({ sessionId: result.sessionId, turnId: "turn_1" });

    expect(adapter.get).toHaveBeenCalledTimes(2);
    expect(adapter.send).toHaveBeenCalledTimes(1);
    expect(adapter.respond).toHaveBeenCalledTimes(1);
    expect(adapter.cancel).toHaveBeenCalledTimes(1);
  });

  it("returns the durable result when a start response was lost to the caller", async () => {
    const adapter = transport();
    const { service, result } = await started({ transport: adapter });
    const retried = await service.start({
      prompt: "Build an app",
      clientRequestId: "request_1",
    });
    expect(retried).toEqual(result);
    expect(adapter.start).toHaveBeenCalledTimes(1);
  });

  it("fails an idle-expired session closed before transport access", async () => {
    let now = 1_000;
    const adapter = transport();
    const first = await started({
      transport: adapter,
      now: () => now,
      sessionTimeoutPolicy: {
        idleTimeoutMs: 60_000,
        maxLifetimeMs: 120_000,
      },
    });
    now = 62_000;

    await expect(
      first.service.get({
        sessionId: first.result.sessionId,
        cursor: 0,
        limit: 1,
      }),
    ).rejects.toBeInstanceOf(HostedSessionNotFoundError);
    await expect(
      first.service.start({
        prompt: "Build an app",
        clientRequestId: "request_1",
      }),
    ).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    expect(adapter.start).toHaveBeenCalledTimes(1);
    expect(adapter.get).not.toHaveBeenCalled();
  });

  it("enforces maximum lifetime even when reads refresh idle activity", async () => {
    let now = 1_000;
    const adapter = transport();
    const first = await started({
      transport: adapter,
      now: () => now,
      sessionTimeoutPolicy: {
        idleTimeoutMs: 120_000,
        maxLifetimeMs: 120_000,
      },
    });
    now = 61_000;
    await first.service.get({
      sessionId: first.result.sessionId,
      cursor: 0,
      limit: 1,
    });
    now = 122_000;
    await expect(
      first.service.get({
        sessionId: first.result.sessionId,
        cursor: 0,
        limit: 1,
      }),
    ).rejects.toBeInstanceOf(HostedSessionNotFoundError);
    expect(adapter.get).toHaveBeenCalledTimes(1);
  });

  it.each(["missing", "mismatched"] as const)(
    "rejects a succeeded start retry when its stored session is %s",
    async (condition) => {
      const base = new InMemoryHostedEveStore();
      const first = await started({ store: base });
      const retryStore: HostedEveStore = {
        reserveOperation: (requestPrincipal, candidate) =>
          base.reserveOperation(requestPrincipal, candidate),
        settleSucceeded: (settlement) => base.settleSucceeded(settlement),
        settleUnsuccessful: (settlement) => base.settleUnsuccessful(settlement),
        async getSession(requestPrincipal, sessionId) {
          const session = await base.getSession(requestPrincipal, sessionId);
          if (condition === "missing") return null;
          return session === null
            ? null
            : { ...session, adapterSessionId: "eve_mismatched" };
        },
      };
      const retry = createHostedEveSessionService({
        principal,
        store: retryStore,
        transport: first.adapter,
        now: () => 1_000,
      });

      await expect(
        retry.start({
          prompt: "Build an app",
          clientRequestId: "request_1",
        }),
      ).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
      expect(first.adapter.start).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects reuse of a client request identifier for changed bytes", async () => {
    const { service, adapter } = await started();
    await expect(
      service.start({
        prompt: "Build a different app",
        clientRequestId: "request_1",
      }),
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
      sessionId: result.sessionId,
      responses,
      clientRequestId: "respond_batch",
    };
    await service.respond(request);
    await service.respond(request);
    expect(adapter.respond).toHaveBeenCalledTimes(1);
    await expect(
      service.respond({ ...request, responses: [...responses].reverse() }),
    ).rejects.toBeInstanceOf(HostedIdempotencyConflictError);
    expect(adapter.respond).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing member of the outstanding input batch", async () => {
    const adapter = transport({
      get: vi.fn(async () => approvalSnapshot(["one", "two", "three"])),
    });
    const { service, result } = await started({ transport: adapter });
    await expect(
      service.respond({
        sessionId: result.sessionId,
        clientRequestId: "incomplete_batch",
        responses: [
          { requestId: "one", response: { kind: "approve" } },
          { requestId: "two", response: { kind: "approve" } },
        ],
      }),
    ).rejects.toMatchObject({
      name: HostedRejectedOperationError.name,
      code: "input_batch_changed",
    });
    expect(adapter.respond).not.toHaveBeenCalled();
  });

  it("never redispatches an operation whose submission outcome is unknown", async () => {
    const start = vi.fn(async () => {
      throw new SubmissionOutcomeUnknownError();
    });
    const service = createHostedEveSessionService({
      principal,
      store: new InMemoryHostedEveStore(),
      transport: transport({ start }),
      now: () => 2_000,
    });
    const request = {
      prompt: "Build an app",
      clientRequestId: "lost_response",
    };
    await expect(service.start(request)).rejects.toBeInstanceOf(
      HostedSubmissionUnknownError,
    );
    await expect(service.start(request)).rejects.toBeInstanceOf(
      HostedSubmissionUnknownError,
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
    const request = { prompt: "Build", clientRequestId: "socket_closed" };
    await expect(service.start(request)).rejects.toBeInstanceOf(
      HostedSubmissionUnknownError,
    );
    await expect(service.start(request)).rejects.toBeInstanceOf(
      HostedSubmissionUnknownError,
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
    const request = { prompt: "Build", clientRequestId: "rejected" };
    await expect(service.start(request)).rejects.toMatchObject({
      name: HostedRejectedOperationError.name,
      code: "credential_expired",
      message: "The hosted Eve operation was rejected before a durable result.",
    });
    await expect(service.start(request)).rejects.toBeInstanceOf(
      HostedRejectedOperationError,
    );
    expect(start).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "state",
      (record: HostedOperationRecord) => ({
        ...record,
        state: "submission_unknown",
        safeErrorCode: "submission_unknown",
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
        reserveOperation: (requestPrincipal, candidate) =>
          base.reserveOperation(requestPrincipal, candidate),
        settleSucceeded: (settlement) => base.settleSucceeded(settlement),
        async settleUnsuccessful(settlement) {
          const record = await base.settleUnsuccessful(settlement);
          return transform(record) as HostedOperationRecord;
        },
        getSession: (requestPrincipal, sessionId) =>
          base.getSession(requestPrincipal, sessionId),
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
          prompt: "Build",
          clientRequestId: `bad_settlement_${_label}`,
        }),
      ).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
      expect(start).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["result", "events", "session ID", "stored session"] as const)(
    "fails closed when successful settlement substitutes the %s",
    async (substitution) => {
      const base = new InMemoryHostedEveStore();
      const maliciousStore: HostedEveStore = {
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
        async getSession(requestPrincipal, sessionId) {
          const session = await base.getSession(requestPrincipal, sessionId);
          return substitution === "stored session" && session !== null
            ? { ...session, adapterSessionId: "eve_substituted" }
            : session;
        },
      };
      const adapter = transport();
      const service = createHostedEveSessionService({
        principal,
        store: maliciousStore,
        transport: adapter,
        now: () => 4_000,
      });

      await expect(
        service.start({
          prompt: "Build",
          clientRequestId: `substituted_${substitution.replace(" ", "_")}`,
        }),
      ).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
      expect(adapter.start).toHaveBeenCalledTimes(1);
    },
  );

  it("does not disclose or operate on another tenant's session", async () => {
    const sharedStore = new InMemoryHostedEveStore();
    const first = await started({ store: sharedStore });
    const otherPrincipal = {
      ...principal,
      workspaceId: "workspace_2",
      ownerUserId: "user_2",
    };
    const otherTransport = transport();
    const otherService = createHostedEveSessionService({
      principal: otherPrincipal,
      store: sharedStore,
      transport: otherTransport,
    });

    await expect(
      otherService.get({
        sessionId: first.result.sessionId,
        cursor: 0,
        limit: 100,
      }),
    ).rejects.toBeInstanceOf(HostedSessionNotFoundError);
    await expect(
      otherService.send({
        sessionId: first.result.sessionId,
        message: "Steal session",
        clientRequestId: "cross_tenant",
      }),
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
        sessionId: first.result.sessionId,
        cursor: 0,
        limit: 100,
      }),
    ).rejects.toBeInstanceOf(HostedSessionNotFoundError);
    expect(otherTransport.get).not.toHaveBeenCalled();
  });

  it("rejects unknown durable record fields", () => {
    expect(
      hostedOperationRecordSchema.safeParse({
        version: 1,
        operationId: "op_1",
        principal,
        kind: "start",
        clientRequestId: "request_1",
        requestDigest: `sha256:${"a".repeat(64)}`,
        state: "reserved",
        createdAtEpochMs: 1,
        updatedAtEpochMs: 1,
        continuationToken: "must-not-be-stored-here",
      }).success,
    ).toBe(false);
  });

  it("rejects a terminal operation whose public result names another session", () => {
    expect(
      hostedOperationRecordSchema.safeParse({
        version: 1,
        operationId: "op_1",
        principal,
        kind: "send",
        clientRequestId: "request_1",
        requestDigest: `sha256:${"a".repeat(64)}`,
        state: "succeeded",
        sessionId: "session_1",
        result: {
          sessionId: "session_2",
          status: "waiting",
          cursor: 0,
          events: [],
        },
        createdAtEpochMs: 1,
        updatedAtEpochMs: 2,
      }).success,
    ).toBe(false);
  });

  it("enforces state-specific closed operation fields", () => {
    const common = {
      version: 1,
      operationId: "op_1",
      principal,
      kind: "start",
      clientRequestId: "request_1",
      requestDigest: `sha256:${"a".repeat(64)}`,
      createdAtEpochMs: 1,
      updatedAtEpochMs: 2,
    };
    expect(
      hostedOperationRecordSchema.safeParse({
        ...common,
        state: "reserved",
        safeErrorCode: "not_allowed",
      }).success,
    ).toBe(false);
    expect(
      hostedOperationRecordSchema.safeParse({
        ...common,
        state: "succeeded",
        sessionId: "session_1",
        result: {
          sessionId: "session_1",
          status: "waiting",
          cursor: 0,
          events: [],
        },
      }).success,
    ).toBe(false);
    expect(
      hostedOperationRecordSchema.safeParse({
        ...common,
        state: "rejected",
        sessionId: "invented_session",
        safeErrorCode: "rejected",
      }).success,
    ).toBe(false);
    expect(
      hostedOperationRecordSchema.safeParse({
        ...common,
        state: "submission_unknown",
        safeErrorCode: "submission_unknown",
        result: {
          sessionId: "invented_session",
          status: "waiting",
          cursor: 0,
          events: [],
        },
      }).success,
    ).toBe(false);
  });
});
