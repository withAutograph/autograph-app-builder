import { observeNativeSource } from "./native-recovery-observation";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { hostedEveOperationScopes } from "./hosted-auth";
import type { HostedPrincipal } from "./hosted-auth";
import {
  createHostedEveSessionService,
  HostedSubmissionUnknownError,
  SubmissionOutcomeUnknownError,
} from "./hosted-service";
import type { HostedEveTransport } from "./hosted-service";
import { durableHostedSessionRecordSchema, InMemoryHostedEveStore } from "./hosted-store";
import { createSameOriginEveTransport } from "./same-origin-http";

const principal: HostedPrincipal = {
  audience: "builder-observation",
  issuer: "https://identity.example.test",
  ownerUserId: "owner",
  workspaceId: "workspace",
  scopes: Object.values(hostedEveOperationScopes),
};

const fixture = async (id: string) => {
  const store = new InMemoryHostedEveStore();
  const observeRecovery = vi.fn<NonNullable<HostedEveTransport["observeRecovery"]>>(() =>
    Promise.resolve(),
  );
  const activateRecovery = vi.fn<NonNullable<HostedEveTransport["activateRecovery"]>>();
  const start = vi
    .fn<HostedEveTransport["start"]>()
    .mockResolvedValueOnce({
      adapterSessionId: "original-physical-owner",
      snapshot: { events: [], status: "failed" },
    })
    .mockRejectedValueOnce(new SubmissionOutcomeUnknownError());
  const adapter: HostedEveTransport = {
    start,
    observeRecovery,
    activateRecovery,
    get: vi.fn(() => Promise.resolve({ events: [], status: "failed" as const })),
    send: vi.fn(),
    respond: vi.fn(),
    cancel: vi.fn(),
  };
  const assertOwner = vi.fn(() => Promise.resolve());
  const service = createHostedEveSessionService({
    principal,
    store,
    transport: adapter,
    assertNativeRecoveryOwner: assertOwner,
  });
  const first = await service.start({ clientRequestId: `${id}-initial`, prompt: "Build" });
  const readSession = store.getSession.bind(store);
  vi.spyOn(store, "getSession").mockImplementation(async (owner, sessionId) => {
    const record = await readSession(owner, sessionId);
    return record?.version !== 2 || record.sessionId !== first.sessionId
      ? record
      : durableHostedSessionRecordSchema.parse({
          ...record,
          checkpoint: undefined,
          checkpointDigest: undefined,
          checkpointProgressDigest: undefined,
        });
  });
  const clientRequestId = `${id}-recovery`;
  await expect(
    service.start({ clientRequestId, resumeSessionId: first.sessionId }),
  ).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
  const getStart = service.getStart;
  if (getStart === undefined) {
    throw new Error("Expected public start lookup.");
  }
  const lookup = () => getStart({ clientRequestId, cursor: 0, limit: 20 });
  return { store, service, adapter, assertOwner, lookup, clientRequestId, observeRecovery };
};

describe("normal public recovery observation", () => {
  it("keeps the unknown result and reservation unchanged while coalescing repeated reads", async () => {
    const f = await fixture("coalesced");
    const before = await f.store.getStartOperation(principal, f.clientRequestId);
    await Promise.all(
      [f.lookup(), f.lookup()].map((read) =>
        expect(read).rejects.toBeInstanceOf(HostedSubmissionUnknownError),
      ),
    );
    await expect(f.lookup()).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    expect(f.adapter.observeRecovery).toHaveBeenCalledOnce();
    expect(f.adapter.observeRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ expectedOwnerRunId: "original-physical-owner" }),
    );
    expect(f.adapter.start).toHaveBeenCalledTimes(2);
    expect(f.adapter.activateRecovery).not.toHaveBeenCalled();
    expect(f.adapter.send).not.toHaveBeenCalled();
    expect(await f.store.getStartOperation(principal, f.clientRequestId)).toEqual(before);
  });

  it("selects a newly committed exact receipt owner instead of reusing the source diagnostic", async () => {
    const f = await fixture("receipt");
    await expect(f.lookup()).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    const operation = await f.store.getStartOperation(principal, f.clientRequestId);
    if (operation?.nativeRecovery === undefined) {
      throw new Error("Missing canonical recovery.");
    }
    await f.store.commitNativeRecoveryReceipt({
      principal,
      descriptor: operation.nativeRecovery,
      recoveryBinding: {
        ...operation.nativeRecovery,
        ownerRunId: "already-failed-recovered-owner",
        provenance: {
          kind: "failed-turn-input",
          sourceStepId: "step",
          sourceEventId: "event",
          sourceSlot: 0,
          checkpointVersion: 1,
        },
      },
      nowEpochMs: Date.now(),
    });
    await expect(f.lookup()).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    expect(f.adapter.observeRecovery).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedOwnerRunId: "already-failed-recovered-owner" }),
    );
    expect(f.adapter.activateRecovery).not.toHaveBeenCalled();
    expect(f.adapter.start).toHaveBeenCalledTimes(2);
  });

  it("rechecks current owner even on a cached diagnostic and preserves failure semantics", async () => {
    const f = await fixture("revoked");
    await expect(f.lookup()).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    f.assertOwner.mockRejectedValue(new Error("Current owner revoked"));
    await expect(f.lookup()).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    expect(f.adapter.observeRecovery).toHaveBeenCalledOnce();
    expect(f.adapter.activateRecovery).not.toHaveBeenCalled();
  });

  it("does not cache a failed inspection or expose its private error", async () => {
    const f = await fixture("read-failure");
    const observe = f.observeRecovery;
    observe.mockRejectedValueOnce(new Error("private diagnostic detail"));
    await expect(f.lookup()).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    await expect(f.lookup()).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    expect(observe).toHaveBeenCalledTimes(2);
    expect(f.adapter.activateRecovery).not.toHaveBeenCalled();
  });
});

it("uses the authenticated existing observation route once without session start or stream read", async () => {
  const recovery = {
    version: 1 as const,
    operationId: "observation-operation",
    sourcePublicSessionId: "public-parent",
    sourceOwnerRunId: "physical-parent",
    sourceAdapterGeneration: 1,
    logicalSessionId: "logical-parent",
    originalAuthoritySessionId: "public-parent",
    parentCancellationRevision: 0,
  };
  const request = vi.fn<typeof fetch>(() =>
    Promise.resolve(
      Response.json(
        { ok: true, status: "accepted", sessionId: "failed-receipt-owner" },
        { status: 202 },
      ),
    ),
  );
  const adapter = createSameOriginEveTransport({
    config: { baseUrl: "https://builder.example.test" },
    workloadIdentity: { token: () => Promise.resolve("synthetic-project-token") },
    fetchImplementation: request,
  });
  await adapter.observeRecovery?.({
    principal,
    operationId: recovery.operationId,
    recovery,
    expectedOwnerRunId: "failed-receipt-owner",
  });
  expect(request).toHaveBeenCalledOnce();
  const [url, init] = request.mock.calls[0];
  expect(url).toBe("https://builder.example.test/eve/v1/session");
  expect(JSON.parse(z.string().parse(init?.body))).toMatchObject({
    recoveryPhase: "observe",
    recovery,
    forwardedPrincipal: { current: { principalId: principal.ownerUserId } },
  });
  expect(init?.redirect).toBe("manual");
});

it("observes exact source coordinates through the protected route without recovery authority", async () => {
  const source = {
    sourcePublicSessionId: "source",
    sourceAdapterSessionId: "anchor",
    sourceAdapterGeneration: 1,
    cancellationRevision: 0,
  };
  const request = vi.fn<typeof fetch>(() =>
    Promise.resolve(
      Response.json({ ok: true, status: "accepted", sessionId: "anchor" }, { status: 202 }),
    ),
  );
  const adapter = createSameOriginEveTransport({
    config: { baseUrl: "https://builder.example.test" },
    workloadIdentity: { token: () => Promise.resolve("synthetic-project-token") },
    fetchImplementation: request,
  });
  await adapter.observeSource?.({ principal, source });
  expect(request).toHaveBeenCalledOnce();
  const call = request.mock.calls[0];
  const body: unknown = JSON.parse(z.string().parse(call?.[1]?.body));
  expect(body).toMatchObject({ recoveryPhase: "inspect-source", sourceObservation: source });
  expect(body).not.toHaveProperty("operationId");
  expect(body).not.toHaveProperty("recovery");
});
it("coalesces identical source observations and re-inspects changed cancellation", async () => {
  const observeSource = vi.fn<NonNullable<HostedEveTransport["observeSource"]>>(() =>
    Promise.resolve(),
  );
  const source = {
    sourcePublicSessionId: "coalesced-source",
    sourceAdapterSessionId: "anchor",
    sourceAdapterGeneration: 1,
    cancellationRevision: 0,
  };
  await Promise.all([
    observeNativeSource({ principal, source, transport: { observeSource } }),
    observeNativeSource({ principal, source, transport: { observeSource } }),
  ]);
  expect(observeSource).toHaveBeenCalledOnce();
  await observeNativeSource({
    principal,
    source: { ...source, cancellationRevision: 1 },
    transport: { observeSource },
  });
  expect(observeSource).toHaveBeenCalledTimes(2);
});
