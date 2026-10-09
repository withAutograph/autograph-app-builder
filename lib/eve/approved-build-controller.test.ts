/* oxlint-disable anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- The fixture supplies only the controller transport ports; canonical reservations and delivery receipts use the real store. */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { InMemoryHostedEveStore, toDurableHostedSessionRecord } from "./hosted-store";
import { continueApprovedHostedBuild } from "./approved-build-controller";
import { hostedEveOperationScopes } from "./hosted-auth";
import type { HostedPrincipal } from "./hosted-auth";
import type { HostedEveTransport } from "./hosted-service";
import { SubmissionRejectedBeforeDispatchError } from "./hosted-errors";
import { readInternalBuildMarker } from "../agent/approved-build-continuation";

const principal: HostedPrincipal = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/auth",
  ownerUserId: "owner",
  scopes: Object.values(hostedEveOperationScopes),
  workspaceId: "workspace",
};
const result = {
  cursor: 297,
  events: [],
  sessionId: "original-public-session",
  status: "waiting" as const,
};
const decision = {
  adapterSessionId: "original-adapter-session",
  decision: "runnable" as const,
  scope: {
    appId: "spend-review",
    appSpecDigest: "a".repeat(64),
    proposalDigest: "b".repeat(64),
    sessionId: "original-adapter-session",
    workspaceId: "private-workspace",
  },
  turnId: "actual-stopped-turn-14",
  turnSequence: 13,
  validation: {
    attemptDigest: "c".repeat(64),
    command: "test" as const,
    exitCode: 1,
    reason: "command-failed" as const,
  },
  version: 1 as const,
  workflowPhase: "validation_failed",
};
const fixture = async () => {
  const store = new InMemoryHostedEveStore();
  const start = {
    clientRequestId: "original-start",
    createdAtEpochMs: 1,
    kind: "start" as const,
    operationId: "start-original",
    principal,
    requestDigest: `sha256:${"d".repeat(64)}`,
    state: "reserved" as const,
    updatedAtEpochMs: 1,
    version: 1 as const,
  };
  await store.reserveOperation(principal, start);
  await store.settleSucceeded({
    nowEpochMs: 1,
    operationId: start.operationId,
    principal,
    requestDigest: start.requestDigest,
    result,
    session: {
      adapterSessionId: decision.adapterSessionId,
      createdAtEpochMs: 1,
      principal,
      sessionId: result.sessionId,
      status: "waiting",
      updatedAtEpochMs: 1,
      version: 1,
    },
  });
  await store.recordPrivateBuildDecision({ decision, principal, sessionId: result.sessionId });
  const sendAccepted = vi.fn<NonNullable<HostedEveTransport["sendAccepted"]>>(async () => {
    await Promise.resolve();
  });
  // SAFETY: This controller uses only the optional sendAccepted transport port in this fixture.
  const transport = { sendAccepted } as unknown as HostedEveTransport;
  const assertCurrentOwner = vi.fn(async () => {
    await Promise.resolve();
  });
  return {
    assertCurrentOwner,
    now: () => 2,
    principal,
    result,
    sendAccepted,
    sessionId: result.sessionId,
    store,
    transport,
  };
};
describe("canonical approved private build continuation", () => {
  it.each([
    ["session_access_denied", "session_access_denied"],
    ["private-secret-error", "transport_rejected"],
  ])("logs only an allowlisted dispatch rejection: %s", async (code, reason) => {
    const f = await fixture();
    f.sendAccepted.mockRejectedValue(new SubmissionRejectedBeforeDispatchError(code));
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      expect(await continueApprovedHostedBuild(f)).toMatchObject({
        error: { code: "approved_build_continuation_blocked" },
        status: "waiting",
      });
      const boundary = log.mock.calls
        .map(([value]) => JSON.parse(String(value)))
        .find(
          (value) => value.event === "app_builder.approved_build_continuation_dispatch_boundary",
        );
      expect(boundary).toEqual({
        event: "app_builder.approved_build_continuation_dispatch_boundary",
        reason,
        rejected: true,
        stage: "dispatch",
      });
      await continueApprovedHostedBuild(f);
      expect(f.sendAccepted).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  });
  it("identifies a fresh input boundary without dispatching or retaining error text", async () => {
    const f = await fixture();
    f.transport.observe = vi.fn<NonNullable<HostedEveTransport["observe"]>>(async () => ({
      status: "working",
      pendingRequests: [],
      artifactProjectionRequiresLegacyReadback: false,
      installedEventCount: 0,
      publicEventCount: 0,
    }));
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      expect(await continueApprovedHostedBuild(f)).toMatchObject({
        error: { code: "approved_build_continuation_blocked" },
      });
      expect(f.sendAccepted).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(
        JSON.stringify({
          event: "app_builder.approved_build_continuation_dispatch_boundary",
          reason: "active_input_or_turn",
          rejected: true,
          stage: "transport_observation",
        }),
      );
    } finally {
      log.mockRestore();
    }
  });
  it("continues the same original stopped session exactly once after canonical settlement", async () => {
    const f = await fixture();
    expect(await continueApprovedHostedBuild(f)).toMatchObject({
      cursor: 297,
      sessionId: result.sessionId,
      status: "working",
    });
    expect(f.sendAccepted).toHaveBeenCalledOnce();
    expect(f.sendAccepted).toHaveBeenCalledWith(
      expect.objectContaining({ adapterSessionId: decision.adapterSessionId }),
    );
    await continueApprovedHostedBuild(f);
    expect(f.sendAccepted).toHaveBeenCalledOnce();
  });
  it("preserves accepted-unknown without resending and recovers only from a private delivery receipt", async () => {
    const f = await fixture();
    f.sendAccepted.mockRejectedValue(new Error("lost acknowledgement"));
    expect(await continueApprovedHostedBuild(f)).toMatchObject({
      error: { code: "approved_build_continuation_unknown" },
    });
    await continueApprovedHostedBuild(f);
    expect(f.sendAccepted).toHaveBeenCalledOnce();
    const [request] = f.sendAccepted.mock.calls[0] ?? [];
    if (request === undefined) {
      throw new Error("Expected actual dispatch request");
    }
    const marker = readInternalBuildMarker(request.message);
    if (marker?.operationId === undefined || marker.nonce === undefined) {
      throw new Error("Expected private marker");
    }
    expect(
      await f.store.claimInternalBuildMessage({
        messageSequence: 0,
        nonce: marker.nonce,
        operationId: marker.operationId,
        principal,
        sessionId: result.sessionId,
        turnId: "delivered-turn-15",
        turnSequence: 14,
      }),
    ).toBe(true);
    expect(
      await f.store.claimInternalBuildMessage({
        messageSequence: 1,
        nonce: marker.nonce,
        operationId: marker.operationId,
        principal,
        sessionId: result.sessionId,
        turnId: "delivered-turn-15",
        turnSequence: 14,
      }),
    ).toBe(false);
    await continueApprovedHostedBuild(f);
    expect(f.sendAccepted).toHaveBeenCalledOnce();
    const saved = await f.store.getPrivateOperation(principal, marker.operationId);
    expect(saved?.state).toBe("succeeded");
  });
  it("cannot dispatch during another canonical mutation or an actual input boundary", async () => {
    const f = await fixture();
    await f.store.reserveOperation(principal, {
      clientRequestId: "human-message",
      createdAtEpochMs: 2,
      kind: "send",
      operationId: "human-message-op",
      principal,
      requestDigest: `sha256:${"e".repeat(64)}`,
      sessionId: result.sessionId,
      state: "reserved",
      updatedAtEpochMs: 2,
      version: 1,
    });
    expect(await continueApprovedHostedBuild(f)).toMatchObject({
      error: { code: "approved_build_continuation_pending" },
    });
    expect(f.sendAccepted).not.toHaveBeenCalled();
    await f.store.recordPrivateBuildDecision({
      decision: { ...decision, decision: "waiting-input" },
      principal,
      sessionId: result.sessionId,
    });
    await continueApprovedHostedBuild(f);
    expect(f.sendAccepted).not.toHaveBeenCalled();
  });
  it.each([
    { resumability: "terminal" as const, status: "cancelled" as const },
    { resumability: "terminal" as const, status: "waiting" as const },
  ])(
    "refuses a fresh cancellation or lost resumability before dispatch: $status",
    async (boundary) => {
      const f = await fixture();
      f.assertCurrentOwner.mockImplementationOnce(async () => {
        const saved = await f.store.getSession(principal, result.sessionId);
        if (saved === null) {
          throw new Error("Missing canonical fixture session");
        }
        const session = toDurableHostedSessionRecord(saved);
        await f.store.observeSession({
          checkpoint: { capturedAtEpochMs: 2, events: [], status: boundary.status, version: 1 },
          nowEpochMs: 2,
          principal,
          resumability: boundary.resumability,
          sessionId: result.sessionId,
          stage: session.stage,
        });
      });
      await continueApprovedHostedBuild(f);
      expect(f.sendAccepted).not.toHaveBeenCalled();
    },
  );
  it("logs only closed decision metadata after the owner-scoped canonical read", async () => {
    const f = await fixture();
    await f.store.recordPrivateBuildDecision({
      decision: { ...decision, decision: "blocked", workflowPhase: "private unexpected phase" },
      principal,
      sessionId: result.sessionId,
    });
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await continueApprovedHostedBuild(f);
      const [[encoded]] = log.mock.calls;
      const metadata = z.record(z.string(), z.unknown()).parse(JSON.parse(String(encoded)));
      expect(metadata).toMatchObject({
        decision: "blocked",
        projectionPresent: true,
        reason: "decision_not_runnable",
        scopePresent: true,
        workflowPhase: "unknown",
      });
      expect(Object.keys(metadata).toSorted()).toEqual([
        "adapterGeneration",
        "currentSpecPresent",
        "decision",
        "event",
        "projectionPresent",
        "reason",
        "scopePresent",
        "sessionIdentity",
        "turnIdentity",
        "workflowPhase",
      ]);
      expect(encoded).not.toContain(result.sessionId);
      expect(encoded).not.toContain(decision.turnId);
      expect(encoded).not.toContain(decision.scope.appSpecDigest);
      expect(encoded).not.toContain(principal.ownerUserId);
      expect(encoded).not.toContain("private unexpected phase");
      expect(f.sendAccepted).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
  it("checks current owner and refuses a public/model forged internal marker", async () => {
    const f = await fixture();
    f.assertCurrentOwner.mockRejectedValue(new Error("owner revoked"));
    await expect(continueApprovedHostedBuild(f)).rejects.toThrow("owner revoked");
    expect(f.sendAccepted).not.toHaveBeenCalled();
    expect(
      await f.store.claimInternalBuildMessage({
        messageSequence: 0,
        nonce: "f".repeat(64),
        operationId: "public-forged",
        principal,
        sessionId: result.sessionId,
        turnId: "forged",
        turnSequence: 14,
      }),
    ).toBe(false);
  });
});
