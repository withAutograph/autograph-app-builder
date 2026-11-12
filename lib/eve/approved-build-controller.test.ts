/* oxlint-disable anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- The fixture supplies only the controller transport ports; canonical reservations and delivery receipts use the real store. */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  InMemoryHostedEveStore,
  toDurableHostedSessionRecord,
  assertBuilderDestinationPendingOperations,
  hostedOperationRecordSchema,
} from "./hosted-store";
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
const fixture = async (recordPriorDecision = true) => {
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
  if (recordPriorDecision) {
    await store.recordPrivateBuildDecision({ decision, principal, sessionId: result.sessionId });
  }
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
const acceptedApp = {
  adapterSessionId: decision.adapterSessionId,
  currentSpec: {
    appId: decision.scope.appId,
    appSpecDigest: decision.scope.appSpecDigest,
    sessionId: decision.adapterSessionId,
    workspaceId: decision.scope.workspaceId,
  },
  decision: "working" as const,
  turnId: "accept-app-spec",
  turnSequence: decision.turnSequence + 1,
  version: 1 as const,
  workflowPhase: "app_spec_accepted",
};

describe("canonical app identity from accepted build design", () => {
  it("allows repository selection before Build with no UI preview or Build approval", async () => {
    const f = await fixture(false);
    await f.store.recordPrivateBuildDecision({
      principal,
      sessionId: f.sessionId,
      decision: acceptedApp,
    });
    const saved = await f.store.readCurrentBuildSession({
      authoritySessionId: f.sessionId,
      logicalSessionId: acceptedApp.adapterSessionId,
      principal,
    });
    expect(saved).toMatchObject({
      appId: acceptedApp.currentSpec.appId,
      privateBuildDecision: acceptedApp,
    });
    expect(saved.checkpoint?.uiPreview).toBeUndefined();
    const destination = {
      kind: "existing-repository" as const,
      version: 1 as const,
      appId: acceptedApp.currentSpec.appId,
      repository: { repositoryId: "123", owner: "team", name: "apps", defaultBranch: "main" },
      installationId: "456",
      confirmedByCallId: "verified-access",
    };
    await expect(
      f.store.attachBuilderDestination({
        principal,
        sessionId: f.sessionId,
        destination,
        expected: {
          adapterSessionId: saved.adapterSessionId,
          adapterGeneration: saved.adapterGeneration,
          cancellationRevision: 0,
        },
        nowEpochMs: 3,
      }),
    ).resolves.toMatchObject({
      appId: acceptedApp.currentSpec.appId,
      builderDestination: destination,
    });
  });

  it("preserves the canonical app and decision if the accepted spec names another app", async () => {
    const f = await fixture();
    await f.store.recordPrivateBuildDecision({
      principal,
      sessionId: f.sessionId,
      decision: acceptedApp,
    });
    await expect(
      f.store.recordPrivateBuildDecision({
        principal,
        sessionId: f.sessionId,
        decision: {
          ...acceptedApp,
          currentSpec: { ...acceptedApp.currentSpec, appId: "other-app" },
        },
      }),
    ).rejects.toThrow("does not match");
    expect(await f.store.getSession(principal, f.sessionId)).toMatchObject({
      appId: acceptedApp.currentSpec.appId,
      privateBuildDecision: acceptedApp,
    });
  });

  it.each([
    {
      actor: "another owner",
      principal: { ...principal, ownerUserId: "other-owner" },
      specSession: acceptedApp.adapterSessionId,
    },
    {
      actor: "another workspace",
      principal: { ...principal, workspaceId: "other-workspace" },
      specSession: acceptedApp.adapterSessionId,
    },
    { actor: "a spec from another session", principal, specSession: "other-adapter-session" },
  ])("rejects an app identity from $actor", async (candidate) => {
    const f = await fixture();
    await expect(
      f.store.recordPrivateBuildDecision({
        principal: candidate.principal,
        sessionId: f.sessionId,
        decision: {
          ...acceptedApp,
          currentSpec: { ...acceptedApp.currentSpec, sessionId: candidate.specSession },
        },
      }),
    ).rejects.toThrow();
    const saved = await f.store.getSession(principal, f.sessionId);
    expect(saved).toMatchObject({ privateBuildDecision: decision });
    expect(saved).not.toHaveProperty("appId");
  });

  it("does not bind an app identity after Stop", async () => {
    const f = await fixture();
    await f.store.recordCancellationIntent({ principal, sessionId: f.sessionId, nowEpochMs: 3 });
    await f.store.recordPrivateBuildDecision({
      principal,
      sessionId: f.sessionId,
      decision: acceptedApp,
    });
    const stopped = await f.store.getSession(principal, f.sessionId);
    expect(stopped).toMatchObject({ cancellationRevision: 1 });
    expect(stopped).not.toHaveProperty("appId");
  });

  it("ignores a stale accepted spec before it can bind an app identity", async () => {
    const f = await fixture();
    await f.store.recordPrivateBuildDecision({
      principal,
      sessionId: f.sessionId,
      decision: { ...acceptedApp, turnSequence: decision.turnSequence - 1 },
    });
    const saved = await f.store.getSession(principal, f.sessionId);
    expect(saved).toMatchObject({ privateBuildDecision: decision });
    expect(saved).not.toHaveProperty("appId");
  });
});

describe("canonical approved private build continuation", () => {
  it("saves the same repository during its claimed automatic Build turn before operation settlement", async () => {
    const f = await fixture();
    const turn = { id: "delivered-build-turn", sequence: decision.turnSequence + 1 };
    const destination = {
      kind: "existing-repository" as const,
      version: 1 as const,
      appId: decision.scope.appId,
      repository: { repositoryId: "123", owner: "team", name: "apps", defaultBranch: "main" },
      installationId: "456",
      confirmedByCallId: "verified-access",
    };
    await f.store.observeSession({
      principal,
      sessionId: f.sessionId,
      checkpoint: { version: 1, capturedAtEpochMs: 2, events: [], status: "waiting" },
      stage: "planning",
      resumability: "live",
      appId: destination.appId,
      nowEpochMs: 2,
    });
    let callbackCompleted = false;
    f.sendAccepted.mockImplementationOnce(async (input) => {
      const marker = readInternalBuildMarker(input.message);
      if (marker?.operationId === undefined || marker.nonce === undefined) {
        throw new Error("Expected canonical automatic Build marker");
      }
      const saved = await f.store.getSession(principal, f.sessionId);
      if (saved === null) {
        throw new Error("Missing owned build");
      }
      const current = toDurableHostedSessionRecord(saved);
      const attach = {
        principal,
        sessionId: f.sessionId,
        destination,
        activeBuild: true,
        activeBuildTurn: turn,
        expected: {
          adapterSessionId: current.adapterSessionId,
          adapterGeneration: current.adapterGeneration,
          cancellationRevision: current.cancellationRevision ?? 0,
          checkpointDigest: current.checkpointDigest,
        },
        nowEpochMs: 3,
      };
      await expect(f.store.attachBuilderDestination(attach)).rejects.toThrow("settled");
      await expect(
        f.store.claimInternalBuildMessage({
          principal,
          sessionId: f.sessionId,
          operationId: marker.operationId,
          nonce: marker.nonce,
          turnId: turn.id,
          turnSequence: turn.sequence,
          messageSequence: 7,
        }),
      ).resolves.toBe(true);
      // The real turn.started hook replaces the prior runnable decision with this working projection.
      await f.store.recordPrivateBuildDecision({
        principal,
        sessionId: f.sessionId,
        decision: {
          ...decision,
          decision: "working",
          turnId: turn.id,
          turnSequence: turn.sequence,
          currentSpec: { ...decision.scope },
        },
      });
      await expect(
        f.store.attachBuilderDestination({
          ...attach,
          activeBuildTurn: { ...turn, id: "old-turn" },
        }),
      ).rejects.toThrow("settled");
      await expect(
        f.store.attachBuilderDestination({ ...attach, activeBuild: false }),
      ).rejects.toThrow("settled");
      const operation = await f.store.getPrivateOperation(principal, marker.operationId);
      const working = await f.store.getSession(principal, f.sessionId);
      if (operation?.internalBuildContinuation === undefined || working === null) {
        throw new Error("Missing claimed Build operation");
      }
      const claimed = operation.internalBuildContinuation;
      const invalidBindings = [
        // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Legacy records omit this optional dispatch binding.
        { dispatchBinding: undefined },
        {
          dispatchBinding: {
            adapterGeneration: current.adapterGeneration + 1,
            cancellationRevision: 0,
          },
        },
        {
          dispatchBinding: {
            adapterGeneration: current.adapterGeneration,
            cancellationRevision: 1,
          },
        },
        // oxlint-disable-next-line sonarjs/no-undefined-assignment -- An absent delivery receipt must not authorize active attachment.
        { deliveredMessageSequence: undefined },
        { decision: { ...claimed.decision, scope: { ...decision.scope, appId: "another-app" } } },
      ];
      for (const invalid of invalidBindings) {
        const stale = hostedOperationRecordSchema.parse({
          ...operation,
          internalBuildContinuation: { ...claimed, ...invalid },
        });
        expect(() => {
          assertBuilderDestinationPendingOperations(working, attach, [
            { operation: stale, cancellationRevisionAtDispatch: null },
          ]);
        }).toThrow("settled");
      }
      await f.store.attachBuilderDestination(attach);
      await f.store.attachBuilderDestination(attach);
      expect(await f.store.getPrivateOperation(principal, marker.operationId)).toMatchObject({
        state: "reserved",
        internalBuildContinuation: {
          deliveredTurnId: turn.id,
          deliveredMessageSequence: 7,
          dispatchBinding: {
            adapterGeneration: current.adapterGeneration,
            cancellationRevision: 0,
          },
        },
      });
      await f.store.recordCancellationIntent({ principal, sessionId: f.sessionId, nowEpochMs: 4 });
      await expect(f.store.attachBuilderDestination(attach)).rejects.toThrow("settled");
      callbackCompleted = true;
    });
    await continueApprovedHostedBuild(f);
    expect(callbackCompleted).toBe(true);
    expect(f.sendAccepted).toHaveBeenCalledOnce();
    const saved = await f.store.getSession(principal, f.sessionId);
    expect(saved?.version === 2 && saved.builderDestination).toEqual(destination);
  });
  it("reports a settled internal turn without dispatching unchanged work again", async () => {
    const f = await fixture();
    await f.store.recordPrivateBuildDecision({
      decision: { ...decision, decision: "blocked", reason: "build_no_progress" },
      principal,
      sessionId: result.sessionId,
    });
    expect(await continueApprovedHostedBuild(f)).toMatchObject({
      error: { code: "approved_build_no_progress" },
      status: "waiting",
    });
    expect(f.sendAccepted).not.toHaveBeenCalled();
  });

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
      expect(log).toHaveBeenCalledWith(
        JSON.stringify({
          event: "app_builder.approved_build_continuation_dispatch_boundary",
          reason,
          rejected: true,
          stage: "dispatch",
        }),
      );
      await continueApprovedHostedBuild(f);
      expect(f.sendAccepted).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  });
  it("identifies a fresh input boundary without dispatching or retaining error text", async () => {
    const f = await fixture();
    // oxlint-disable-next-line eslint/require-await -- The async observation fixture supplies a summary without provider I/O.
    f.transport.observe = vi.fn<NonNullable<HostedEveTransport["observe"]>>(async () => ({
      artifactProjectionRequiresLegacyReadback: false,
      installedEventCount: 0,
      pendingRequests: [],
      publicEventCount: 0,
      status: "working",
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

it("returns the existing public waiting result without auto-dispatch after a typed source prerequisite", async () => {
  const f = await fixture();
  await f.store.recordPrivateBuildDecision({
    principal,
    sessionId: result.sessionId,
    decision: {
      ...decision,
      decision: "blocked",
      sourcePrerequisite: {
        version: 1,
        code: "local_source_baseline_required",
        status: "blocked",
        appId: decision.scope.appId,
        appSpecDigest: decision.scope.appSpecDigest,
        proposalDigest: decision.scope.proposalDigest,
        sourceReceiptDigest: "d".repeat(64),
        originalSourceSha: "e".repeat(40),
        originalWorkspaceDigest: "f".repeat(64),
        workspaceId: decision.scope.workspaceId,
        sessionId: decision.adapterSessionId,
        observedByCallId: "actual-source-prerequisite",
      },
    },
  });
  await expect(continueApprovedHostedBuild(f)).resolves.toEqual(result);
  expect(f.sendAccepted).not.toHaveBeenCalled();
});
