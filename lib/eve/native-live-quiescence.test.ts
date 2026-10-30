/* oxlint-disable sonarjs/no-internal-api-use -- Exercise the actual patched recovery entrypoint with synthetic native World ports. */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createSameOriginEveTransport } from "./same-origin-http";
import type {
  TerminalRecoveryDependencies,
  TerminalRecoveryDescriptor,
  TerminalRecoveryPorts,
  TerminalRecoveryBinding,
  recoverTerminalSession as RuntimeRecover,
  observeTerminalSession as RuntimeObserve,
  handleTerminalRecoveryRequest as RuntimeHandle,
  inspectNativeRecoverySource as RuntimeInspect,
  TerminalRecoveryObservationDependencies,
} from "../../node_modules/eve/dist/src/execution/session/terminal-recovery";
import type { PrivateNativeRecoveryCandidate } from "../../node_modules/eve/dist/src/execution/session/recovery-candidate";
import type { createDurableSessionState as RuntimeDurable } from "../../node_modules/eve/dist/src/execution/durable-session-store";
import type { appendPendingInputBatch as RuntimeAppend } from "../../node_modules/eve/dist/src/harness/pending-input-batches";
import type { HarnessSession } from "../../node_modules/eve/dist/src/harness/types";

const runtime = await vi.importActual<{
  recoverTerminalSession: typeof RuntimeRecover;
  observeTerminalSession: typeof RuntimeObserve;
  handleTerminalRecoveryRequest: typeof RuntimeHandle;
  inspectNativeRecoverySource: typeof RuntimeInspect;
}>(
  new URL("../../node_modules/eve/dist/src/execution/session/terminal-recovery.js", import.meta.url)
    .href,
);
const durable = await vi.importActual<{ createDurableSessionState: typeof RuntimeDurable }>(
  new URL("../../node_modules/eve/dist/src/execution/durable-session-store.js", import.meta.url)
    .href,
);
const batches = await vi.importActual<{ appendPendingInputBatch: typeof RuntimeAppend }>(
  new URL("../../node_modules/eve/dist/src/harness/pending-input-batches.js", import.meta.url).href,
);
const nativeDiagnosticLogSchema = z.looseObject({ event: z.string() });
type NativeDiagnosticLog = z.infer<typeof nativeDiagnosticLogSchema>;
const loggedEvent = (
  calls: readonly (readonly unknown[])[],
  event: string,
): NativeDiagnosticLog | undefined => {
  const values = calls.map(([value]) => nativeDiagnosticLogSchema.parse(JSON.parse(String(value))));
  return values.find((value) => value.event === event);
};
const descriptor: TerminalRecoveryDescriptor = {
  version: 1,
  operationId: "transfer",
  sourcePublicSessionId: "source",
  sourceOwnerRunId: "old-native",
  sourceAdapterGeneration: 1,
  logicalSessionId: "logical",
  originalAuthoritySessionId: "source",
  parentCancellationRevision: 0,
  executionTransfer: {
    kind: "pending-approval",
    sourceCheckpointDigest: `sha256:${"a".repeat(64)}`,
  },
};
const actor = {
  authenticator: "fixture",
  principalType: "user",
  principalId: "owner",
  attributes: {},
};
const fixture = () => {
  let nativeStatus = "running";
  let physicalOwner = "old-native";
  let currentOwner = true;
  let unsettledStepIds: string[] = [];
  let receipt: TerminalRecoveryBinding | undefined;
  let ready: TerminalRecoveryBinding | undefined;
  // SAFETY: The opaque handle is passed only to the injected synthetic reconciler; production collection is not bypassed.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Synthetic opaque capability is consumed exclusively by the injected test reconciler.
  const candidate = {
    kind: "private-native-recovery-candidate",
    version: 1,
  } as PrivateNativeRecoveryCandidate;
  const session: HarnessSession = batches.appendPendingInputBatch({
    session: {
      sessionId: "logical",
      continuationToken: "continuation",
      history: [],
      agent: { dynamicModel: true, system: "", tools: [] },
      compaction: { recentWindowSize: 1, threshold: 1000 },
    },
    requests: [
      {
        kind: "tool-approval",
        requestId: "pending",
        prompt: "Approve target",
        action: {
          kind: "tool-call",
          toolName: "prepare-app-native-target",
          callId: "pending-call",
          input: {},
        },
      },
    ],
    responseAuthRequiredRequestIds: ["pending"],
    responseMessages: [],
  });
  const before = durable.createDurableSessionState({ session });
  const after = durable.createDurableSessionState({
    session: { ...session, history: [{ role: "assistant", content: "retained late result" }] },
  });
  const provenance = {
    version: 1 as const,
    sourceOwnerRunId: "old-native",
    checkpointOwnerRunId: "old-native",
    logicalSessionId: "logical",
    selectedOrigin: {
      kind: "committed-turn-output" as const,
      stepId: "step",
      eventId: "event",
      slot: 1,
    },
    coveredNativeEventIds: [],
    frontierEventIds: [],
    nativeProtocolFactCount: 0,
    reconstructedCoordination: false,
  };
  const ports: TerminalRecoveryPorts = {
    authorize: vi.fn(() =>
      currentOwner ? Promise.resolve() : Promise.reject(new Error("owner revoked")),
    ),
    authorizeActivation: vi.fn(() => Promise.resolve()),
    readReceipt: vi.fn(() => Promise.resolve(receipt)),
    commitReceipt: vi.fn<TerminalRecoveryPorts["commitReceipt"]>((input) => {
      receipt = input.recoveryBinding;
      return Promise.resolve(input.recoveryBinding);
    }),
  };
  const collect = vi.fn<TerminalRecoveryDependencies["collect"]>(() =>
    Promise.resolve({
      kind: "candidate",
      candidate,
      inspection: {
        version: 1,
        candidates: [],
        nativeEventCount: 0,
        uncertaintyReasons: [],
        requiresTrustedReconciliation: true,
      },
    }),
  );
  const reconcile = vi.fn<TerminalRecoveryDependencies["reconcile"]>(() =>
    Promise.resolve({
      kind: "ready",
      checkpointCore: {
        sessionState: nativeStatus === "running" ? before : after,
        serializedContext: { "eve.sessionId": "logical" },
      },
      provenance,
    }),
  );
  const start = vi.fn<TerminalRecoveryDependencies["start"]>((input) => {
    ready = { ...descriptor, ownerRunId: "new-native", provenance: input.provenance };
    return Promise.resolve();
  });
  const stopSource = vi.fn<NonNullable<TerminalRecoveryDependencies["stopSource"]>>(
    (_id, _reason) => {
      nativeStatus = "cancelled";
      return Promise.resolve();
    },
  );
  const dependencies: TerminalRecoveryDependencies = {
    collect,
    reconcile,
    start,
    stopSource,
    inspectSource: vi.fn(() =>
      Promise.resolve({ runId: physicalOwner, status: nativeStatus, unsettledStepIds }),
    ),
    readStopReceipt: vi.fn(() => Promise.resolve(nativeStatus === "cancelled")),
    readCandidate: vi.fn(() => {
      throw new Error("unused synthetic native payload");
    }),
    readEntry: vi.fn(() =>
      Promise.resolve({ kind: "initial", sessionTimeoutMs: false, serializedContext: {} }),
    ),
    getHook: vi.fn(() =>
      ready === undefined
        ? Promise.reject(new Error("not found"))
        : Promise.resolve({
            runId: ready.ownerRunId,
            metadata: Promise.resolve({ recoveryBinding: ready }),
          }),
    ),
    resumeHook: vi.fn(() => Promise.resolve()),
    isHookNotFound: (error) => error instanceof Error && error.message === "not found",
    now: () => 1,
    wait: () => Promise.resolve(),
  };
  // readCandidate's payload is inspected only after terminal reconciliation; retain its exact origin contract.
  dependencies.readCandidate = vi.fn<TerminalRecoveryDependencies["readCandidate"]>(() => ({
    version: 1,
    binding: { ownerRunId: "old-native", logicalSessionId: "logical" },
    checkpointOwnerRunId: physicalOwner,
    handoffChain: [],
    run: {
      runId: physicalOwner,
      status: "cancelled",
      deploymentId: "deployment",
      workflowName: "workflow",
      attributes: {},
      createdAt: new Date(0),
      updatedAt: new Date(0),
      completedAt: new Date(0),
    },
    nativeRunKey: undefined,
    candidates: [
      {
        kind: "committed-turn-output",
        origin: { stepId: "step", eventId: "event", slot: 1 },
        sessionState: after,
        serializedContext: { "eve.sessionId": "logical" },
      },
    ],
    events: [],
    frontier: [],
    steps: [],
    nativeEvents: [],
    carriedInbox: [],
    issues: [],
  }));
  return {
    ports,
    dependencies,
    collect,
    reconcile,
    start,
    stopSource,
    before,
    after,
    run: () => runtime.recoverTerminalSession({ auth: actor, descriptor, ports }, dependencies),
    setPhysicalOwner: (id: string) => {
      physicalOwner = id;
    },
    setUnsettled: (ids: string[]) => {
      unsettledStepIds = ids;
    },
    revoke: () => {
      currentOwner = false;
    },
    setNativeStatus: (status: string) => {
      nativeStatus = status;
    },
  };
};

describe("live native execution transfer", () => {
  it("stops the verified physical inbox owner while preserving the authority anchor", async () => {
    const f = fixture();
    f.setPhysicalOwner("physical-child");
    expect(await f.run()).toMatchObject({ kind: "accepted" });
    expect(f.stopSource).toHaveBeenCalledWith(
      "physical-child",
      "Builder native execution transfer transfer",
    );
    expect(f.collect.mock.calls[0]?.[0].binding.ownerRunId).toBe("old-native");
  });
  it("refuses a physical owner change before stop", async () => {
    const f = fixture();
    f.dependencies.inspectSource = vi.fn(() => {
      f.setPhysicalOwner("newer-physical-owner");
      return Promise.resolve({ runId: "old-native", status: "running", unsettledStepIds: [] });
    });
    expect(await f.run()).toMatchObject({
      kind: "unavailable",
      reason: "source-physical-owner-changed",
    });
    expect(f.stopSource).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });
  it("observes a parked physical owner without stopping or adopting it", async () => {
    const f = fixture();
    f.setPhysicalOwner("observed-physical-owner");
    const recordObservation = vi.fn<TerminalRecoveryObservationDependencies["recordObservation"]>(
      () => true,
    );
    await runtime.observeTerminalSession(
      { auth: actor, descriptor, ports: f.ports },
      {
        collect: (input) => f.dependencies.collect(input),
        readCandidate: (candidate) => f.dependencies.readCandidate(candidate),
        now: () => 1,
        recordObservation,
      },
    );
    expect(f.collect.mock.calls[0]?.[0].allowParked).toBe(true);
    expect(recordObservation.mock.calls[0]?.[0].payload?.checkpointOwnerRunId).toBe(
      "observed-physical-owner",
    );
    expect(f.stopSource).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });
  it("refuses a live handoff discovered by terminal recollection after stop", async () => {
    const f = fixture();
    const collect = f.collect.getMockImplementation();
    if (collect === undefined) {
      throw new Error("Missing collector fixture");
    }
    f.collect.mockImplementation(async (input) =>
      input.allowParked === true
        ? await collect(input)
        : { kind: "unavailable", reason: "source-not-terminal" },
    );
    expect(await f.run()).toMatchObject({ kind: "unavailable", reason: "source-not-terminal" });
    expect(f.stopSource).toHaveBeenCalledTimes(1);
    expect(f.collect.mock.calls.at(-1)?.[0].allowParked).toBeUndefined();
    expect(f.start).not.toHaveBeenCalled();
  });
  it("rejects source inspection mixed with recovery dispatch fields before native reads", async () => {
    const f = fixture();
    const authorizeSourceObservation = vi.fn(() =>
      Promise.resolve({ ownerRunId: "old-native", logicalSessionId: "logical" }),
    );
    for (const forbidden of [
      { recovery: descriptor },
      { operationId: "transfer" },
      { recoveryPhase: "activate", sourceObservation: {} },
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each forbidden payload is independently asserted before the next case.
      const response = await runtime.handleTerminalRecoveryRequest({
        payload: { recoveryPhase: "inspect-source", sourceObservation: {}, ...forbidden },
        auth: actor,
        forwarded: true,
        ports: { ...f.ports, authorizeSourceObservation },
      });
      expect(response.status).toBe(400);
    }
    expect(authorizeSourceObservation).not.toHaveBeenCalled();
    expect(f.stopSource).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });
  it("refuses an unresolved failed effect on a terminal handoff ancestor", async () => {
    const f = fixture();
    const read = f.dependencies.readCandidate.bind(f.dependencies);
    f.dependencies.readCandidate = (candidate) => ({
      ...read(candidate),
      handoffChain: [
        {
          parentRunId: "ancestor",
          ownerRunId: "old-native",
          startStepId: "handoff",
          activationEventId: "activation",
          events: [],
        },
      ],
    });
    f.dependencies.inspectSource = vi.fn<
      NonNullable<TerminalRecoveryDependencies["inspectSource"]>
    >((runId) =>
      Promise.resolve({
        runId,
        status: runId === "ancestor" ? "failed" : "running",
        unsettledStepIds: runId === "ancestor" ? ["failed-effect"] : [],
      }),
    );
    expect(await f.run()).toMatchObject({
      kind: "unavailable",
      reason: "source-lineage-effects-unsettled",
    });
    expect(f.stopSource).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });
  it.each(["pending", "running"])("accepts a fully closed %s World run", async (status) => {
    const f = fixture();
    f.setNativeStatus(status);
    expect(await f.run()).toMatchObject({ kind: "accepted" });
  });
  it("refuses active or unproven failed effect steps before stop", async () => {
    const f = fixture();
    f.setUnsettled(["provider-effect"]);
    expect(await f.run()).toMatchObject({
      kind: "unavailable",
      reason: "source-lineage-effects-unsettled",
    });
    expect(f.stopSource).not.toHaveBeenCalled();
  });
  it("refuses effects remaining after cancellation", async () => {
    const f = fixture();
    f.stopSource.mockImplementationOnce(() => {
      f.setNativeStatus("cancelled");
      f.setUnsettled(["provider-effect"]);
      return Promise.resolve();
    });
    expect(await f.run()).toMatchObject({ kind: "uncertain", reason: "source-stop-unconfirmed" });
    expect(f.start).not.toHaveBeenCalled();
  });
  it("refuses an unprovable waiting checkpoint before stopping its execution", async () => {
    const f = fixture();
    f.collect.mockResolvedValueOnce({
      kind: "unavailable",
      reason: "paired-native-checkpoint-unavailable",
    });
    expect(await f.run()).toMatchObject({ kind: "unavailable" });
    expect(f.stopSource).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });
  it("stops the exact execution, re-collects terminal history and preserves pending work", async () => {
    const f = fixture();
    expect(await f.run()).toMatchObject({
      kind: "accepted",
      recoveryBinding: { ownerRunId: "new-native" },
    });
    expect(f.stopSource).toHaveBeenCalledWith(
      "old-native",
      "Builder native execution transfer transfer",
    );
    expect(f.collect.mock.calls.map(([input]) => input.allowParked)).toEqual([
      true,
      true,
      undefined,
    ]);
    expect(f.start.mock.calls[0]?.[0].checkpoint.sessionState).toEqual(f.after);
    expect(f.start.mock.calls[0]?.[0].checkpoint.sessionState).not.toEqual(f.before);
    expect(await f.run()).toMatchObject({ kind: "accepted" });
    expect(f.stopSource).toHaveBeenCalledTimes(1);
    expect(f.start).toHaveBeenCalledTimes(1);
  });
  it("refuses unresolved effects discovered after execution stop", async () => {
    const f = fixture();
    f.reconcile.mockResolvedValueOnce({
      kind: "ready",
      checkpointCore: { sessionState: f.before, serializedContext: { "eve.sessionId": "logical" } },
      provenance: {
        version: 1,
        sourceOwnerRunId: "old-native",
        checkpointOwnerRunId: "old-native",
        logicalSessionId: "logical",
        selectedOrigin: {
          kind: "committed-turn-output",
          stepId: "step",
          eventId: "event",
          slot: 1,
        },
        coveredNativeEventIds: [],
        frontierEventIds: [],
        nativeProtocolFactCount: 0,
        reconstructedCoordination: false,
      },
    });
    f.reconcile.mockResolvedValueOnce({ kind: "uncertain", reason: "uncommitted-action-dispatch" });
    expect(await f.run()).toMatchObject({ kind: "uncertain" });
    expect(f.stopSource).toHaveBeenCalledTimes(1);
    expect(f.start).not.toHaveBeenCalled();
  });
  it("honors owner revocation after stopping and before child execution", async () => {
    const f = fixture();
    f.stopSource.mockImplementationOnce(() => {
      f.setNativeStatus("cancelled");
      f.revoke();
      return Promise.resolve();
    });
    await expect(f.run()).rejects.toThrow("owner revoked");
    expect(f.start).not.toHaveBeenCalled();
  });
  it("does not adopt an execution stopped by a different operation", async () => {
    const f = fixture();
    f.setNativeStatus("cancelled");
    f.dependencies.readStopReceipt = vi.fn(() => Promise.resolve(false));
    expect(await f.run()).toMatchObject({ kind: "unavailable", reason: "source-stop-not-owned" });
    expect(f.start).not.toHaveBeenCalled();
  });
});

describe("native recovery refusal diagnostics", () => {
  it.each([
    { reason: "handoff-owner-ambiguous", expected: "handoff-owner-ambiguous" },
    { reason: "source-not-terminal", expected: "source-not-terminal" },
    {
      reason: "paired-native-checkpoint-unavailable",
      expected: "paired-native-checkpoint-unavailable",
    },
    { reason: "private-canary-native-reason-secret", expected: "other" },
  ])(
    "reports only fixed inspect-source collection labels: $expected",
    async ({ reason, expected }) => {
      const f = fixture();
      // @ts-expect-error Deliberately exercise an unknown runtime native reason at the diagnostic boundary.
      f.collect.mockResolvedValueOnce({ kind: "unavailable", reason });
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      try {
        const response = await runtime.handleTerminalRecoveryRequest(
          {
            payload: {
              recoveryPhase: "inspect-source",
              sourceObservation: {
                sourcePublicSessionId: "private-canary-source",
                sourceAdapterSessionId: "old-native",
                sourceAdapterGeneration: 1,
                cancellationRevision: 0,
              },
            },
            auth: actor,
            forwarded: true,
            ports: {
              ...f.ports,
              authorizeSourceObservation: () =>
                Promise.resolve({ ownerRunId: "old-native", logicalSessionId: "logical" }),
            },
          },
          () => Promise.resolve(f.dependencies),
        );
        expect(response.status).toBe(202);
        const diagnostic: unknown = loggedEvent(
          info.mock.calls,
          "builder.native_source_observation",
        );
        expect(diagnostic).toMatchObject({
          event: "builder.native_source_observation",
          collectionKind: "unavailable",
          collectionReason: expected,
          collectionStage: "candidate_collect",
          candidate: false,
          lineageResolved: false,
        });
        expect(JSON.stringify(info.mock.calls)).not.toContain("private-canary");
        expect(JSON.stringify(info.mock.calls)).not.toContain("old-native");
        expect(f.stopSource).not.toHaveBeenCalled();
        expect(f.start).not.toHaveBeenCalled();
      } finally {
        info.mockRestore();
      }
    },
  );
  it.each([
    {
      reason: "paired-native-checkpoint-unavailable",
      expected: "paired-native-checkpoint-unavailable",
    },
    { reason: "private-canary-native-reason-secret", expected: "other" },
  ])("reports only fixed prepare refusal labels: $expected", async ({ reason, expected }) => {
    const f = fixture();
    // @ts-expect-error Deliberately exercise an unknown runtime native reason at the diagnostic boundary.
    f.collect.mockResolvedValueOnce({ kind: "unavailable", reason });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const response = await runtime.handleTerminalRecoveryRequest(
        {
          payload: { operationId: descriptor.operationId, recovery: descriptor },
          auth: actor,
          forwarded: true,
          ports: f.ports,
        },
        () => Promise.resolve(f.dependencies),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ ok: false, code: "terminal_recovery_unavailable" });
      const diagnostic: unknown = loggedEvent(info.mock.calls, "builder.native_recovery_refusal");
      expect(diagnostic).toEqual({
        event: "builder.native_recovery_refusal",
        outcome: "unavailable",
        reason: expected,
        stage: "live_transfer_preflight",
        boundary: null,
      });
      expect(JSON.stringify(info.mock.calls)).not.toContain("private-canary");
      expect(JSON.stringify(info.mock.calls)).not.toContain("old-native");
      expect(JSON.stringify(info.mock.calls)).not.toContain("sha256:");
      expect(f.stopSource).not.toHaveBeenCalled();
      expect(f.start).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
    }
  });
});

it("preserves a native recovery refusal when its advisory sink fails", async () => {
  const f = fixture();
  f.collect.mockResolvedValueOnce({ kind: "unavailable", reason: "source-not-terminal" });
  const info = vi.spyOn(console, "info").mockImplementation(() => {
    throw new Error("private-canary-sink-error");
  });
  try {
    const response = await runtime.handleTerminalRecoveryRequest(
      {
        payload: { operationId: descriptor.operationId, recovery: descriptor },
        auth: actor,
        forwarded: true,
        ports: f.ports,
      },
      () => Promise.resolve(f.dependencies),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, code: "terminal_recovery_unavailable" });
    expect(f.stopSource).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  } finally {
    info.mockRestore();
  }
});

describe("native refusal boundary observation", () => {
  it.each([
    {
      stage: "handoff_parent",
      status: "running",
      anchorStatus: "queued",
      expectedStage: "handoff_parent",
      expectedStatus: "running",
      expectedAnchor: "queued",
    },
    {
      stage: "private-canary-boundary",
      status: "private-canary-status",
      anchorStatus: "private-canary-anchor",
      expectedStage: "other",
      expectedStatus: "other",
      expectedAnchor: "other",
    },
  ])(
    "observes canonical anchor even without a candidate and sanitizes $expectedStage",
    async ({ stage, status, anchorStatus, expectedStage, expectedStatus, expectedAnchor }) => {
      const f = fixture();
      const nativeResult = {
        kind: "unavailable" as const,
        reason: "source-not-terminal" as const,
        boundary: {
          stage,
          status,
          parentStatus: "private-canary-parent",
          allowParked: true,
          privateContent: "private-canary-content",
        },
      };
      // @ts-expect-error Unknown native runtime labels deliberately test the diagnostic boundary.
      f.collect.mockResolvedValueOnce(nativeResult);
      const inspectSource = vi.fn<NonNullable<TerminalRecoveryDependencies["inspectSource"]>>(() =>
        Promise.resolve({
          runId: "old-native",
          status: anchorStatus,
          unsettledStepIds: ["private-canary-step"],
          stepCounts: { completed: 4, pending: 1, running: 2, failed: 3, cancelled: 0, unknown: 0 },
        }),
      );
      f.dependencies.inspectSource = inspectSource;
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      try {
        const response = await runtime.handleTerminalRecoveryRequest(
          {
            payload: {
              recoveryPhase: "inspect-source",
              sourceObservation: {
                sourcePublicSessionId: "source",
                sourceAdapterSessionId: "old-native",
                sourceAdapterGeneration: 1,
                cancellationRevision: 0,
              },
            },
            auth: actor,
            forwarded: true,
            ports: {
              ...f.ports,
              authorizeSourceObservation: () =>
                Promise.resolve({ ownerRunId: "old-native", logicalSessionId: "logical" }),
            },
          },
          () => Promise.resolve(f.dependencies),
        );
        expect(response.status).toBe(202);
        expect(inspectSource).toHaveBeenCalledWith("old-native");
        const diagnostic: unknown = loggedEvent(
          info.mock.calls,
          "builder.native_source_observation",
        );
        expect(diagnostic).toMatchObject({
          collectionKind: "unavailable",
          collectionReason: "source-not-terminal",
          collectionBoundary: {
            stage: expectedStage,
            status: expectedStatus,
            parentStatus: "other",
            allowParked: true,
          },
          anchorStatus: expectedAnchor,
          anchorUnsettledStepCount: 1,
          anchorStepCounts: {
            completed: 4,
            pending: 1,
            running: 2,
            failed: 3,
            cancelled: 0,
            unknown: 0,
          },
          lineageResolved: false,
        });
        expect(JSON.stringify(info.mock.calls)).not.toContain("private-canary");
        expect(JSON.stringify(info.mock.calls)).not.toContain("old-native");
        expect(f.stopSource).not.toHaveBeenCalled();
        expect(f.start).not.toHaveBeenCalled();
      } finally {
        info.mockRestore();
      }
    },
  );
});

it("continues exact-source collection after step inspection fails, retaining authoritative run status", async () => {
  const f = fixture();
  const reads: string[] = [];
  const world = {
    runs: {
      get: () => {
        reads.push("run");
        return Promise.resolve({ runId: "old-native", status: "running" });
      },
    },
    steps: {
      list: () => {
        reads.push("steps");
        throw new TypeError("private-canary-provider-secret");
      },
    },
  };
  // @ts-expect-error The synthetic native World intentionally exposes only the methods exercised by this reader.
  f.dependencies.inspectSource = (owner) => runtime.inspectNativeRecoverySource(world, owner);
  f.collect.mockResolvedValueOnce({
    kind: "unavailable",
    reason: "source-not-terminal",
    boundary: { stage: "handoff_parent", status: "running", allowParked: true },
  });
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const response = await runtime.handleTerminalRecoveryRequest(
      {
        payload: { recoveryPhase: "inspect-source", sourceObservation: {} },
        auth: actor,
        forwarded: true,
        ports: {
          ...f.ports,
          authorizeSourceObservation: () =>
            Promise.resolve({ ownerRunId: "old-native", logicalSessionId: "logical" }),
        },
      },
      () => Promise.resolve(f.dependencies),
    );
    expect(response.status).toBe(202);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      sourceDiagnostic: {
        collectionKind: "unavailable",
        collectionReason: "source-not-terminal",
        collectionBoundary: { stage: "handoff_parent", status: "running", allowParked: true },
        anchorRead: {
          outcome: "failed",
          stage: "steps_list",
          errorCategory: "type",
          status: "running",
          unsettledStepCount: null,
          stepCounts: null,
        },
      },
    });
    expect(reads).toEqual(["run", "steps"]);
    expect(f.collect).toHaveBeenCalledOnce();
    expect(JSON.stringify(info.mock.calls)).not.toContain("private-canary");
    expect(f.stopSource).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  } finally {
    info.mockRestore();
  }
});
it("returns a safe private summary for collector errors after successful owner authorization", async () => {
  const f = fixture();
  f.collect.mockRejectedValueOnce(new ReferenceError("private-canary-history"));
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const response = await runtime.handleTerminalRecoveryRequest(
      {
        payload: { recoveryPhase: "inspect-source", sourceObservation: {} },
        auth: actor,
        forwarded: true,
        ports: {
          ...f.ports,
          authorizeSourceObservation: () =>
            Promise.resolve({ ownerRunId: "old-native", logicalSessionId: "logical" }),
        },
      },
      () => Promise.resolve(f.dependencies),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      sourceDiagnostic: {
        collectionKind: "failed",
        collectionErrorCategory: "reference",
        anchorRead: { outcome: "succeeded" },
      },
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain("private-canary");
    expect(f.stopSource).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  } finally {
    info.mockRestore();
  }
});
it("fails closed without a summary or private reads when owner authorization is revoked", async () => {
  const f = fixture();
  const authorizeSourceObservation = vi
    .fn()
    .mockResolvedValueOnce({ ownerRunId: "old-native", logicalSessionId: "logical" })
    .mockRejectedValue(new Error("private-canary-owner"));
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const response = await runtime.handleTerminalRecoveryRequest(
      {
        payload: { recoveryPhase: "inspect-source", sourceObservation: {} },
        auth: actor,
        forwarded: true,
        ports: { ...f.ports, authorizeSourceObservation },
      },
      () => Promise.resolve(f.dependencies),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).not.toHaveProperty("sourceDiagnostic");
    // oxlint-disable-next-line typescript/unbound-method -- The injected native reader is a standalone mock with no this binding.
    expect(f.dependencies.inspectSource).not.toHaveBeenCalled();
    expect(f.collect).not.toHaveBeenCalled();
    expect(JSON.stringify(info.mock.calls)).not.toContain("private-canary");
    expect(loggedEvent(info.mock.calls, "builder.native_recovery_route")).toMatchObject({
      stage: "handler_entered",
    });
  } finally {
    info.mockRestore();
  }
});

it("relays the actual native diagnostic response through postMutation on the stable caller side", async () => {
  const f = fixture();
  f.collect.mockResolvedValueOnce({
    kind: "unavailable",
    reason: "source-not-terminal",
    boundary: { stage: "handoff_parent", status: "running", allowParked: true },
  });
  f.dependencies.inspectSource = () => Promise.reject(new TypeError("private-canary-step-error"));
  const adapter = createSameOriginEveTransport({
    config: { baseUrl: "https://builder.example.test" },
    workloadIdentity: { token: () => Promise.resolve("synthetic-token") },
    fetchImplementation: () =>
      runtime.handleTerminalRecoveryRequest(
        {
          payload: { recoveryPhase: "inspect-source", sourceObservation: {} },
          auth: actor,
          forwarded: true,
          ports: {
            ...f.ports,
            authorizeSourceObservation: () =>
              Promise.resolve({ ownerRunId: "old-native", logicalSessionId: "logical" }),
          },
        },
        () => Promise.resolve(f.dependencies),
      ),
  });
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    await adapter.observeSource?.({
      principal: {
        issuer: "https://owner.example",
        audience: "builder",
        workspaceId: "workspace",
        ownerUserId: "owner",
        scopes: ["autograph:get"],
      },
      source: {
        sourcePublicSessionId: "source",
        sourceAdapterSessionId: "old-native",
        sourceAdapterGeneration: 1,
        cancellationRevision: 0,
      },
    });
    expect(loggedEvent(info.mock.calls, "builder.native_source_observation_relay")).toMatchObject({
      outcome: "available",
      diagnostic: {
        collectionReason: "source-not-terminal",
        collectionBoundary: { stage: "handoff_parent", status: "running" },
        anchorRead: { outcome: "failed", errorCategory: "type" },
      },
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain("private-canary");
    expect(f.stopSource).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  } finally {
    info.mockRestore();
  }
});

it("relays dependency-load failure only after successful exact source authorization", async () => {
  const f = fixture();
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const response = await runtime.handleTerminalRecoveryRequest(
      {
        payload: { recoveryPhase: "inspect-source", sourceObservation: {} },
        auth: actor,
        forwarded: true,
        ports: {
          ...f.ports,
          authorizeSourceObservation: () =>
            Promise.resolve({ ownerRunId: "old-native", logicalSessionId: "logical" }),
        },
      },
      () => Promise.reject(new ReferenceError("private-canary-module")),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      sourceDiagnostic: {
        collectionKind: "failed",
        collectionStage: "dependencies",
        collectionErrorCategory: "reference",
        anchorRead: {
          outcome: "failed",
          stage: "dependencies",
          errorCategory: "reference",
          status: null,
        },
      },
    });
    expect(f.collect).not.toHaveBeenCalled();
    expect(f.stopSource).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
    expect(JSON.stringify(info.mock.calls)).not.toContain("private-canary");
  } finally {
    info.mockRestore();
  }
});
