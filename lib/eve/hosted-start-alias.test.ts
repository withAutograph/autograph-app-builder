import { describe, expect, it, vi } from "vitest";

import { withHostedBuilderHandoffs } from "../mcp/request-handler";
import type { HostedBuilderHandoffRuntime } from "../mcp/request-handler";
import { hostedEveOperationScopes } from "./hosted-auth";
import type { HostedPrincipal } from "./hosted-auth";
import {
  createHostedEveSessionService,
  HostedAdapterSessionUnavailableError,
  HostedIdempotencyConflictError,
  HostedSubmissionUnknownError,
  SubmissionOutcomeUnknownError,
} from "./hosted-service";
import type { HostedEngineSnapshot, HostedEveTransport } from "./hosted-service";
import { InMemoryHostedEveStore } from "./hosted-store";

const handoffId = "123e4567-e89b-42d3-a456-426614174001";
const canonicalRequestId = `handoff:${"a".repeat(64)}`;
const principal: HostedPrincipal = {
  audience: "https://builder.example.test/mcp",
  issuer: "https://builder.example.test/api/auth",
  ownerUserId: "owner-one",
  scopes: Object.values(hostedEveOperationScopes),
  workspaceId: "workspace-one",
};
const snapshot: HostedEngineSnapshot = { events: [], status: "waiting" };

const adapter = (overrides: Partial<HostedEveTransport> = {}): HostedEveTransport => ({
  cancel: vi.fn().mockResolvedValue(snapshot),
  get: vi.fn().mockResolvedValue(snapshot),
  respond: vi.fn().mockResolvedValue(snapshot),
  send: vi.fn().mockResolvedValue(snapshot),
  start: vi.fn().mockResolvedValue({ adapterSessionId: "adapter-one", snapshot }),
  ...overrides,
});

const handoffs = (): HostedBuilderHandoffRuntime => {
  let sessionId: string | undefined;
  return {
    // oxlint-disable-next-line eslint/require-await -- Preserve the async handoff runtime test interface.
    bindSession: vi.fn(async (input: Parameters<HostedBuilderHandoffRuntime["bindSession"]>[0]) => {
      ({ sessionId } = input);
    }),
    recheckRepositoryAccess: vi.fn().mockResolvedValue({ status: "ready" }),
    // oxlint-disable-next-line eslint/require-await -- Preserve the async handoff runtime test interface.
    resolve: vi.fn(async () =>
      sessionId === undefined
        ? {
            deterministicClientRequestId: canonicalRequestId,
            prompt: "Build the prepared app.",
            record: {
              intent: { repository: { requestedName: "prepared-app" } },
              requestDigest: "a".repeat(64),
            },
            status: "unredeemed" as const,
          }
        : {
            deterministicClientRequestId: canonicalRequestId,
            sessionId,
            status: "redeemed" as const,
          },
    ),
  };
};

const wrap = (
  store: InMemoryHostedEveStore,
  transport: HostedEveTransport,
  runtime: HostedBuilderHandoffRuntime,
) =>
  withHostedBuilderHandoffs({
    handoffs: runtime,
    principal,
    service: createHostedEveSessionService({ principal, store, transport }),
  });
const read = (store: InMemoryHostedEveStore, transport: HostedEveTransport, caller = principal) =>
  createHostedEveSessionService({
    principal: { ...caller, scopes: [hostedEveOperationScopes.get] },
    store,
    transport,
  });

describe("durable original handoff start request recovery", () => {
  it("persists the caller's alias before dispatch and recovers it after service recreation without another start", async () => {
    const store = new InMemoryHostedEveStore();
    const start = vi.fn(async () => {
      expect(await store.getStartOperation(principal, "original-start")).toMatchObject({
        startAlias: { canonicalClientRequestId: canonicalRequestId, sourceHandoffId: handoffId },
        state: "reserved",
      });
      return { adapterSessionId: "adapter-one", snapshot };
    });
    const transport = adapter({ start });
    const runtime = handoffs();
    const result = await wrap(store, transport, runtime).start({
      clientRequestId: "original-start",
      handoffId,
    });
    expect(await store.getStartOperation(principal, "original-start")).toMatchObject({
      sessionId: result.sessionId,
      state: "succeeded",
    });
    await expect(
      read(store, transport).getStart?.({
        clientRequestId: "original-start",
        cursor: 0,
        limit: 100,
      }),
    ).resolves.toMatchObject({ sessionId: result.sessionId });
    expect(start).toHaveBeenCalledOnce();
    expect(runtime.bindSession).toHaveBeenCalledOnce();
  });

  it("lets simultaneous distinct original requests recover the single canonical session", async () => {
    const store = new InMemoryHostedEveStore();
    const pending = Promise.withResolvers<{
      adapterSessionId: string;
      snapshot: HostedEngineSnapshot;
    }>();
    const start = vi.fn(async () => await pending.promise);
    const transport = adapter({ start });
    const runtime = handoffs();
    const first = wrap(store, transport, runtime).start({ clientRequestId: "first", handoffId });
    await vi.waitFor(() => {
      expect(start).toHaveBeenCalledOnce();
    });
    await expect(
      wrap(store, transport, runtime).start({ clientRequestId: "second", handoffId }),
    ).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    pending.resolve({ adapterSessionId: "adapter-one", snapshot });
    const result = await first;
    const recovered = await read(store, transport).getStart?.({
      clientRequestId: "second",
      cursor: 0,
      limit: 100,
    });
    expect(recovered?.sessionId).toBe(result.sessionId);
    await expect(
      wrap(store, transport, runtime).start({ clientRequestId: "second", handoffId }),
    ).resolves.toMatchObject({ sessionId: result.sessionId });
    expect(await store.getStartOperation(principal, "second")).toMatchObject({
      state: "succeeded",
    });
    expect(start).toHaveBeenCalledOnce();
  });

  it("keeps an uncertain canonical submission read-only and reuses its operation ID on the original exact retry", async () => {
    const store = new InMemoryHostedEveStore();
    const start = vi
      .fn<HostedEveTransport["start"]>()
      .mockRejectedValueOnce(new SubmissionOutcomeUnknownError())
      .mockResolvedValue({ adapterSessionId: "adapter-one", snapshot });
    const transport = adapter({ start });
    const runtime = handoffs();
    const request = { clientRequestId: "lost-start", handoffId };
    await expect(wrap(store, transport, runtime).start(request)).rejects.toBeInstanceOf(
      HostedSubmissionUnknownError,
    );
    await expect(
      read(store, transport).getStart?.({
        clientRequestId: request.clientRequestId,
        cursor: 0,
        limit: 100,
      }),
    ).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    expect(start).toHaveBeenCalledOnce();
    const result = await wrap(store, transport, runtime).start(request);
    expect(start.mock.calls[0]?.[0].operationId).toBe(start.mock.calls[1]?.[0].operationId);
    await expect(
      read(store, transport).getStart?.({
        clientRequestId: request.clientRequestId,
        cursor: 0,
        limit: 100,
      }),
    ).resolves.toMatchObject({ sessionId: result.sessionId });
  });

  it.each([
    { ...principal, ownerUserId: "other-owner" },
    { ...principal, workspaceId: "other-workspace" },
    { ...principal, audience: "https://other.example/mcp" },
    { ...principal, issuer: "https://other.example/api/auth" },
  ])("does not expose an alias to another caller authority", async (caller) => {
    const store = new InMemoryHostedEveStore();
    const transport = adapter();
    await wrap(store, transport, handoffs()).start({ clientRequestId: "shared-id", handoffId });
    await expect(
      read(store, transport, caller).getStart?.({
        clientRequestId: "shared-id",
        cursor: 0,
        limit: 100,
      }),
    ).resolves.toMatchObject({ error: { code: "start_request_not_found" }, sessionId: "" });
    expect(transport.get).not.toHaveBeenCalled();
  });

  it("rejects reuse of a prompt-start ID for a handoff without dispatching its canonical start", async () => {
    const store = new InMemoryHostedEveStore();
    const transport = adapter();
    await createHostedEveSessionService({ principal, store, transport }).start({
      clientRequestId: "occupied",
      prompt: "Existing brief",
    });
    await expect(
      wrap(store, transport, handoffs()).start({ clientRequestId: "occupied", handoffId }),
    ).rejects.toBeInstanceOf(HostedIdempotencyConflictError);
    expect(transport.start).toHaveBeenCalledOnce();
  });

  it("rejects reuse of an alias ID for a different handoff", async () => {
    const store = new InMemoryHostedEveStore();
    const transport = adapter();
    const runtime = handoffs();
    await wrap(store, transport, runtime).start({ clientRequestId: "occupied", handoffId });
    await expect(
      wrap(store, transport, runtime).start({
        clientRequestId: "occupied",
        handoffId: "123e4567-e89b-42d3-a456-426614174002",
      }),
    ).rejects.toBeInstanceOf(HostedIdempotencyConflictError);
    expect(transport.start).toHaveBeenCalledOnce();
  });
});

describe("original resume start request recovery", () => {
  it("recovers a healthy resume and retains its exact handle after the session later becomes terminal", async () => {
    const store = new InMemoryHostedEveStore();
    const transport = adapter();
    const service = createHostedEveSessionService({ principal, store, transport });
    const first = await service.start({ clientRequestId: "first", prompt: "Build an app." });
    const request = { clientRequestId: "healthy-resume", resumeSessionId: first.sessionId };
    const resumed = await service.start(request);
    expect(resumed.sessionId).toBe(first.sessionId);
    expect(await store.getStartOperation(principal, request.clientRequestId)).toMatchObject({
      sessionId: first.sessionId,
      state: "succeeded",
    });
    vi.mocked(transport.get).mockResolvedValue({ events: [], status: "completed" });
    await expect(
      read(store, transport).getStart?.({
        clientRequestId: request.clientRequestId,
        cursor: 0,
        limit: 100,
      }),
    ).resolves.toMatchObject({ sessionId: first.sessionId, status: "completed" });
    await expect(
      createHostedEveSessionService({ principal, store, transport }).start(request),
    ).resolves.toEqual(resumed);
    expect(transport.start).toHaveBeenCalledOnce();
    await expect(
      service.start({ ...request, resumeSessionId: "different-session" }),
    ).rejects.toBeInstanceOf(HostedIdempotencyConflictError);
  });

  it("recovers the original ID of an adapter replacement without dispatching another replacement", async () => {
    const store = new InMemoryHostedEveStore();
    const transport = adapter({
      get: vi
        .fn()
        .mockRejectedValueOnce(new HostedAdapterSessionUnavailableError())
        .mockResolvedValue(snapshot),
      start: vi
        .fn()
        .mockResolvedValueOnce({ adapterSessionId: "adapter-one", snapshot })
        .mockResolvedValue({ adapterSessionId: "adapter-two", snapshot }),
    });
    const service = createHostedEveSessionService({ principal, store, transport });
    const first = await service.start({ clientRequestId: "first", prompt: "Build an app." });
    const request = { clientRequestId: "replace-adapter", resumeSessionId: first.sessionId };
    const resumed = await service.start(request);
    expect(await store.getStartOperation(principal, request.clientRequestId)).toMatchObject({
      kind: "resume",
      state: "succeeded",
    });
    await expect(
      read(store, transport).getStart?.({
        clientRequestId: request.clientRequestId,
        cursor: 0,
        limit: 100,
      }),
    ).resolves.toMatchObject({ sessionId: resumed.sessionId });
    await expect(
      createHostedEveSessionService({ principal, store, transport }).start(request),
    ).resolves.toEqual(resumed);
    expect(transport.start).toHaveBeenCalledTimes(2);
  });

  it("recovers the child selected by a terminal-session resume", async () => {
    const store = new InMemoryHostedEveStore();
    const terminal = { events: [], status: "completed" as const };
    const transport = adapter({
      start: vi
        .fn()
        .mockResolvedValueOnce({ adapterSessionId: "adapter-one", snapshot: terminal })
        .mockResolvedValue({ adapterSessionId: "adapter-two", snapshot }),
    });
    const service = createHostedEveSessionService({ principal, store, transport });
    const first = await service.start({ clientRequestId: "first", prompt: "Build an app." });
    const request = { clientRequestId: "terminal-resume", resumeSessionId: first.sessionId };
    const resumed = await service.start(request);
    expect(resumed.sessionId).not.toBe(first.sessionId);
    await expect(
      read(store, transport).getStart?.({
        clientRequestId: request.clientRequestId,
        cursor: 0,
        limit: 100,
      }),
    ).resolves.toMatchObject({ sessionId: resumed.sessionId });
    await expect(
      createHostedEveSessionService({ principal, store, transport }).start(request),
    ).resolves.toEqual(resumed);
    expect(transport.start).toHaveBeenCalledTimes(2);
  });
});
