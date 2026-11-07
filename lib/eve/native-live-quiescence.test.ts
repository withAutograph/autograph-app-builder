/* oxlint-disable sonarjs/no-internal-api-use -- Exercise the actual patched recovery entrypoint with synthetic native World ports. */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createSameOriginEveTransport } from "./same-origin-http";
import { createHostedEveSessionService, HostedSubmissionUnknownError } from "./hosted-service";
import type { HostedEveTransport } from "./hosted-service";
import { InMemoryHostedEveStore, hostedOperationRecordSchema } from "./hosted-store";
import { hostedEveOperationScopes } from "./hosted-auth";
import type {
  TerminalRecoveryDependencies,
  TerminalRecoveryDescriptor,
  TerminalRecoveryPorts,
  TerminalRecoveryBinding,
  recoverTerminalSession as RuntimeRecover,
  observeTerminalSession as RuntimeObserve,
  handleTerminalRecoveryRequest as RuntimeHandle,
  inspectNativeRecoverySource as RuntimeInspect,
  createNativeTerminalRecoveryDependencies as RuntimeDependencies,
  quiesceLiveRecoverySource as RuntimeQuiesce,
  TerminalRecoveryObservationDependencies,
} from "../../node_modules/eve/dist/src/execution/session/terminal-recovery";
import type {
  PrivateNativeRecoveryCandidate,
  PrivateOwnedLineagePreflight,
} from "../../node_modules/eve/dist/src/execution/session/recovery-candidate";
import type { createDurableSessionState as RuntimeDurable } from "../../node_modules/eve/dist/src/execution/durable-session-store";
import type {
  appendPendingInputBatch as RuntimeAppend,
  queueDeferredStepInput as RuntimeDefer,
} from "../../node_modules/eve/dist/src/harness/pending-input-batches";
import type { setPendingAuthorization as RuntimeSetAuthorization } from "../../node_modules/eve/dist/src/harness/authorization";
import type { HarnessSession } from "../../node_modules/eve/dist/src/harness/types";

const runtime = await vi.importActual<{
  recoverTerminalSession: typeof RuntimeRecover;
  observeTerminalSession: typeof RuntimeObserve;
  handleTerminalRecoveryRequest: typeof RuntimeHandle;
  inspectNativeRecoverySource: typeof RuntimeInspect;
  createNativeTerminalRecoveryDependencies: typeof RuntimeDependencies;
  quiesceLiveRecoverySource: typeof RuntimeQuiesce;
}>(
  new URL("../../node_modules/eve/dist/src/execution/session/terminal-recovery.js", import.meta.url)
    .href,
);
const durable = await vi.importActual<{ createDurableSessionState: typeof RuntimeDurable }>(
  new URL("../../node_modules/eve/dist/src/execution/durable-session-store.js", import.meta.url)
    .href,
);
const batches = await vi.importActual<{
  appendPendingInputBatch: typeof RuntimeAppend;
  queueDeferredStepInput: typeof RuntimeDefer;
}>(
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
  executionTransfer: {
    kind: "pending-approval",
    sourceCheckpointDigest: `sha256:${"a".repeat(64)}`,
  },
  logicalSessionId: "logical",
  operationId: "transfer",
  originalAuthoritySessionId: "source",
  parentCancellationRevision: 0,
  sourceAdapterGeneration: 1,
  sourceOwnerRunId: "old-native",
  sourcePublicSessionId: "source",
  version: 1,
};
const actor = {
  attributes: {},
  authenticator: "fixture",
  principalId: "owner",
  principalType: "user",
};
const fixture = (transferKind: "pending-approval" | "idle-checkpoint" = "pending-approval") => {
  const selectedDescriptor: TerminalRecoveryDescriptor = {
    ...descriptor,
    executionTransfer: { kind: transferKind, sourceCheckpointDigest: `sha256:${"a".repeat(64)}` },
  };
  let nativeStatus = "running";
  let physicalOwner = "old-native";
  let lineageParents: string[] = [];
  const ancestorStatuses = new Map<string, string>();
  const stopReceipts = new Set<string>();
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
    requests: [
      {
        action: {
          callId: "pending-call",
          input: {},
          kind: "tool-call",
          toolName: "prepare-app-native-target",
        },
        kind: "tool-approval",
        prompt: "Approve target",
        requestId: "pending",
      },
    ],
    responseAuthRequiredRequestIds: ["pending"],
    responseMessages: [],
    session: {
      agent: { dynamicModel: true, system: "", tools: [] },
      compaction: { recentWindowSize: 1, threshold: 1000 },
      continuationToken: "continuation",
      history: [],
      sessionId: "logical",
    },
  });
  let before = durable.createDurableSessionState({ session });
  let after = durable.createDurableSessionState({
    session: { ...session, history: [{ content: "retained late result", role: "assistant" }] },
  });
  const provenance = {
    checkpointOwnerRunId: "old-native",
    coveredNativeEventIds: [],
    frontierEventIds: [],
    logicalSessionId: "logical",
    nativeProtocolFactCount: 0,
    reconstructedCoordination: false,
    selectedOrigin: {
      eventId: "event",
      kind: "committed-turn-output" as const,
      slot: 1,
      stepId: "step",
    },
    sourceOwnerRunId: "old-native",
    version: 1 as const,
  };
  const ports: TerminalRecoveryPorts = {
    authorize: vi.fn(async () => {
      currentOwner ? await Promise.resolve() : await Promise.reject(new Error("owner revoked"));
    }),
    authorizeActivation: vi.fn(async () => {}),
    commitReceipt: vi.fn<TerminalRecoveryPorts["commitReceipt"]>(async (input) => {
      receipt = input.recoveryBinding;
      return input.recoveryBinding;
    }),
    readReceipt: vi.fn(async () => receipt),
  };
  const collect = vi.fn<TerminalRecoveryDependencies["collect"]>(async () => ({
    candidate,
    inspection: {
      candidates: [],
      nativeEventCount: 0,
      requiresTrustedReconciliation: true,
      uncertaintyReasons: [],
      version: 1,
    },
    kind: "candidate",
  }));
  const reconcile = vi.fn<TerminalRecoveryDependencies["reconcile"]>(async () => ({
    checkpointCore: {
      serializedContext: { "eve.sessionId": "logical" },
      sessionState: nativeStatus === "running" ? before : after,
    },
    kind: "ready",
    provenance,
  }));
  const start = vi.fn<TerminalRecoveryDependencies["start"]>(async (input) => {
    ready = { ...input.descriptor, ownerRunId: "new-native", provenance: input.provenance };
    return;
  });
  const stopSource = vi.fn<NonNullable<TerminalRecoveryDependencies["stopSource"]>>(
    async (id, _reason) => {
      if (id === physicalOwner) {
        nativeStatus = "cancelled";
      } else {
        ancestorStatuses.set(id, "cancelled");
      }
      stopReceipts.add(id);
      return;
    },
  );
  const dependencies: TerminalRecoveryDependencies = {
    collect,
    getHook: vi.fn(async () =>
      ready === undefined
        ? await Promise.reject(new Error("not found"))
        : await Promise.resolve({
            metadata: Promise.resolve({ recoveryBinding: ready }),
            runId: ready.ownerRunId,
          }),
    ),
    inspectSource: vi.fn<NonNullable<TerminalRecoveryDependencies["inspectSource"]>>(
      async (id) => ({
        runId: id,
        status: id === physicalOwner ? nativeStatus : (ancestorStatuses.get(id) ?? "completed"),
        unsettledStepIds,
      }),
    ),
    isHookNotFound: (error) => error instanceof Error && error.message === "not found",
    now: () => 1,
    readCandidate: vi.fn(() => {
      throw new Error("unused synthetic native payload");
    }),
    readEntry: vi.fn(async () => ({
      kind: "initial",
      serializedContext: {},
      sessionTimeoutMs: false,
    })),
    readStopReceipt: vi.fn<NonNullable<TerminalRecoveryDependencies["readStopReceipt"]>>(
      async (id) => stopReceipts.has(id),
    ),
    reconcile,
    resumeHook: vi.fn(async () => {}),
    start,
    stopSource,
    wait: async () => {},
  };
  // readCandidate's payload is inspected only after terminal reconciliation; retain its exact origin contract.
  dependencies.readCandidate = vi.fn<TerminalRecoveryDependencies["readCandidate"]>(() => ({
    binding: { logicalSessionId: "logical", ownerRunId: "old-native" },
    candidates: [
      {
        kind: "committed-turn-output",
        origin: {
          eventId: provenance.selectedOrigin.eventId,
          slot: provenance.selectedOrigin.slot,
          stepId: provenance.selectedOrigin.stepId,
        },
        serializedContext: { "eve.sessionId": "logical" },
        sessionState: after,
      },
    ],
    carriedInbox: [],
    checkpointOwnerRunId: physicalOwner,
    events: [],
    frontier: [],
    handoffChain: lineageParents.map((id, index) => ({
      activationEventId: `activation-${id}`,
      events: [],
      ownerRunId: lineageParents[index + 1] ?? physicalOwner,
      parentRunId: id,
      startStepId: `start-${id}`,
    })),
    issues: [],
    nativeEvents: [],
    nativeRunKey: undefined,
    run: {
      attributes: {},
      completedAt: new Date(0),
      createdAt: new Date(0),
      deploymentId: "deployment",
      runId: physicalOwner,
      status: "cancelled",
      updatedAt: new Date(0),
      workflowName: "workflow",
    },
    steps: [],
    version: 1,
  }));
  const opaquePreflight = { kind: "private-native-lineage-preflight", version: 1 };
  // SAFETY: Only these injected native ports consume this synthetic capability.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The real collector's separate WeakMap brand is behaviorally tested.
  const lineagePreflight = opaquePreflight as PrivateOwnedLineagePreflight;
  dependencies.collectLineagePreflight = async (input) => {
    const result = await collect({ ...input, allowParked: true });
    return result.kind === "candidate"
      ? { kind: "preflight", preflight: lineagePreflight }
      : result;
  };
  dependencies.readLineagePreflight = () => dependencies.readCandidate(candidate);
  dependencies.reconcileLineagePreflight = async () => await reconcile(candidate);
  dependencies.readLogicalInboxOwner = async () => {
    if (ready) {
      return { logicalSessionId: "logical", runId: ready.ownerRunId };
    }
    if (nativeStatus === "cancelled") {
      const absent: undefined = ready;
      return absent;
    }
    return { logicalSessionId: "logical", runId: physicalOwner };
  };
  return {
    after,
    before,
    collect,
    dependencies,
    getNativeStatus: () => nativeStatus,
    markStopReceipt: (id: string) => {
      stopReceipts.add(id);
    },
    ports,
    reconcile,
    revoke: () => {
      currentOwner = false;
    },
    run: async () =>
      await runtime.recoverTerminalSession(
        { auth: actor, descriptor: selectedDescriptor, ports },
        dependencies,
      ),
    setAncestorStatus: (id: string, status: string) => {
      ancestorStatuses.set(id, status);
    },
    setCheckpointOrigin: (slot: number) => {
      provenance.selectedOrigin = {
        ...provenance.selectedOrigin,
        eventId: `event-${slot}`,
        slot,
        stepId: `step-${slot}`,
      };
    },
    setCheckpointState: (state: typeof before) => {
      before = state;
      after = state;
    },
    setLineage: (parents: string[]) => {
      lineageParents = parents;
    },
    setNativeStatus: (status: string) => {
      nativeStatus = status;
    },
    setPhysicalOwner: (id: string) => {
      physicalOwner = id;
    },
    setTurnState: (turnId: string) => {
      const state = durable.createDurableSessionState({
        session: {
          ...session,
          history: [{ content: "Completed ordinary turn", role: "assistant" }],
          state: {
            "eve.harness.emission": { sequence: 1, sessionStarted: true, stepIndex: 0, turnId },
          },
        },
      });
      before = state;
      after = state;
    },
    setUnsettled: (ids: string[]) => {
      unsettledStepIds = ids;
    },
    start,
    stopSource,
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
    f.dependencies.inspectSource = vi.fn(async () => {
      f.setPhysicalOwner("newer-physical-owner");
      return { runId: "old-native", status: "running", unsettledStepIds: [] };
    });
    expect(await f.run()).toMatchObject({
      kind: "uncertain",
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
        collect: async (input) => await f.dependencies.collect(input),
        now: () => 1,
        readCandidate: (candidate) => f.dependencies.readCandidate(candidate),
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
    expect(await f.run()).toMatchObject({ kind: "uncertain", reason: "source-not-terminal" });
    expect(f.stopSource).toHaveBeenCalledTimes(1);
    expect(f.collect.mock.calls.at(-1)?.[0].allowParked).toBeUndefined();
    expect(f.start).not.toHaveBeenCalled();
  });
  it("rejects source inspection mixed with recovery dispatch fields before native reads", async () => {
    const f = fixture();
    const authorizeSourceObservation = vi.fn(async () => ({
      logicalSessionId: "logical",
      ownerRunId: "old-native",
    }));
    for (const forbidden of [
      { recovery: descriptor },
      { operationId: "transfer" },
      { recoveryPhase: "activate", sourceObservation: {} },
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each forbidden payload is independently asserted before the next case.
      const response = await runtime.handleTerminalRecoveryRequest({
        auth: actor,
        forwarded: true,
        payload: { recoveryPhase: "inspect-source", sourceObservation: {}, ...forbidden },
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
          activationEventId: "activation",
          events: [],
          ownerRunId: "old-native",
          parentRunId: "ancestor",
          startStepId: "handoff",
        },
      ],
    });
    f.dependencies.inspectSource = vi.fn<
      NonNullable<TerminalRecoveryDependencies["inspectSource"]>
    >(async (runId) => ({
      runId,
      status: runId === "ancestor" ? "failed" : "running",
      unsettledStepIds: runId === "ancestor" ? ["failed-effect"] : [],
    }));
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
    f.stopSource.mockImplementationOnce(async () => {
      f.setNativeStatus("cancelled");
      f.setUnsettled(["provider-effect"]);
      return;
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
    expect(f.collect.mock.calls.filter(([input]) => input.allowParked !== true)).toHaveLength(1);
    expect(f.start.mock.calls[0]?.[0].checkpoint.sessionState).toEqual(f.after);
    expect(f.start.mock.calls[0]?.[0].checkpoint.sessionState).not.toEqual(f.before);
    expect(await f.run()).toMatchObject({ kind: "accepted" });
    expect(f.stopSource).toHaveBeenCalledTimes(1);
    expect(f.start).toHaveBeenCalledTimes(1);
  });
  it("refuses unresolved effects discovered after execution stop", async () => {
    const f = fixture();
    const reconcile = f.reconcile.getMockImplementation();
    if (reconcile === undefined) {
      throw new Error("Missing reconciliation fixture");
    }
    f.reconcile.mockImplementation(async (candidate) =>
      f.getNativeStatus() === "cancelled"
        ? await Promise.resolve({ kind: "uncertain", reason: "uncommitted-action-dispatch" })
        : await reconcile(candidate),
    );
    expect(await f.run()).toMatchObject({ kind: "uncertain" });
    expect(f.stopSource).toHaveBeenCalledTimes(1);
    expect(f.start).not.toHaveBeenCalled();
  });
  it("honors owner revocation after stopping and before child execution", async () => {
    const f = fixture();
    f.stopSource.mockImplementationOnce(async () => {
      f.setNativeStatus("cancelled");
      f.revoke();
      return;
    });
    await expect(f.run()).rejects.toThrow("owner revoked");
    expect(f.start).not.toHaveBeenCalled();
  });
  it("does not adopt an execution stopped by a different operation", async () => {
    const f = fixture();
    f.setNativeStatus("cancelled");
    f.dependencies.readStopReceipt = vi.fn(async () => false);
    expect(await f.run()).toMatchObject({ kind: "unavailable", reason: "source-stop-not-owned" });
    expect(f.start).not.toHaveBeenCalled();
  });
});

describe("native recovery refusal diagnostics", () => {
  it.each([
    { expected: "handoff-owner-ambiguous", reason: "handoff-owner-ambiguous" },
    { expected: "source-not-terminal", reason: "source-not-terminal" },
    {
      expected: "paired-native-checkpoint-unavailable",
      reason: "paired-native-checkpoint-unavailable",
    },
    { expected: "other", reason: "private-canary-native-reason-secret" },
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
            auth: actor,
            forwarded: true,
            payload: {
              recoveryPhase: "inspect-source",
              sourceObservation: {
                cancellationRevision: 0,
                sourceAdapterGeneration: 1,
                sourceAdapterSessionId: "old-native",
                sourcePublicSessionId: "private-canary-source",
              },
            },
            ports: {
              ...f.ports,
              authorizeSourceObservation: async () => ({
                logicalSessionId: "logical",
                ownerRunId: "old-native",
              }),
            },
          },
          async () => f.dependencies,
        );
        expect(response.status).toBe(202);
        const diagnostic: unknown = loggedEvent(
          info.mock.calls,
          "builder.native_source_observation",
        );
        expect(diagnostic).toMatchObject({
          candidate: false,
          collectionKind: "unavailable",
          collectionReason: expected,
          collectionStage: "candidate_collect",
          event: "builder.native_source_observation",
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
      expected: "paired-native-checkpoint-unavailable",
      reason: "paired-native-checkpoint-unavailable",
    },
    { expected: "other", reason: "private-canary-native-reason-secret" },
  ])("reports only fixed prepare refusal labels: $expected", async ({ reason, expected }) => {
    const f = fixture();
    // @ts-expect-error Deliberately exercise an unknown runtime native reason at the diagnostic boundary.
    f.collect.mockResolvedValueOnce({ kind: "unavailable", reason });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const response = await runtime.handleTerminalRecoveryRequest(
        {
          auth: actor,
          forwarded: true,
          payload: { operationId: descriptor.operationId, recovery: descriptor },
          ports: f.ports,
        },
        async () => f.dependencies,
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ code: "terminal_recovery_unavailable", ok: false });
      const diagnostic: unknown = loggedEvent(info.mock.calls, "builder.native_recovery_refusal");
      expect(diagnostic).toEqual({
        boundary: null,
        event: "builder.native_recovery_refusal",
        outcome: "unavailable",
        reason: expected,
        stage: "live_transfer_preflight",
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
        auth: actor,
        forwarded: true,
        payload: { operationId: descriptor.operationId, recovery: descriptor },
        ports: f.ports,
      },
      async () => f.dependencies,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "terminal_recovery_unavailable", ok: false });
    expect(f.stopSource).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  } finally {
    info.mockRestore();
  }
});

describe("native refusal boundary observation", () => {
  it.each([
    {
      anchorStatus: "queued",
      expectedAnchor: "queued",
      expectedStage: "handoff_parent",
      expectedStatus: "running",
      stage: "handoff_parent",
      status: "running",
    },
    {
      anchorStatus: "private-canary-anchor",
      expectedAnchor: "other",
      expectedStage: "other",
      expectedStatus: "other",
      stage: "private-canary-boundary",
      status: "private-canary-status",
    },
  ])(
    "observes canonical anchor even without a candidate and sanitizes $expectedStage",
    async ({ stage, status, anchorStatus, expectedStage, expectedStatus, expectedAnchor }) => {
      const f = fixture();
      const nativeResult = {
        boundary: {
          allowParked: true,
          parentStatus: "private-canary-parent",
          privateContent: "private-canary-content",
          stage,
          status,
        },
        kind: "unavailable" as const,
        reason: "source-not-terminal" as const,
      };
      // @ts-expect-error Unknown native runtime labels deliberately test the diagnostic boundary.
      f.collect.mockResolvedValueOnce(nativeResult);
      const inspectSource = vi.fn<NonNullable<TerminalRecoveryDependencies["inspectSource"]>>(
        async () => ({
          runId: "old-native",
          status: anchorStatus,
          stepCounts: {
            cancelled: 0,
            completed: 4,
            failed: 3,
            pending: 1,
            running: 2,
            unknown: 0,
          },
          unsettledStepIds: ["private-canary-step"],
        }),
      );
      f.dependencies.inspectSource = inspectSource;
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      try {
        const response = await runtime.handleTerminalRecoveryRequest(
          {
            auth: actor,
            forwarded: true,
            payload: {
              recoveryPhase: "inspect-source",
              sourceObservation: {
                cancellationRevision: 0,
                sourceAdapterGeneration: 1,
                sourceAdapterSessionId: "old-native",
                sourcePublicSessionId: "source",
              },
            },
            ports: {
              ...f.ports,
              authorizeSourceObservation: async () => ({
                logicalSessionId: "logical",
                ownerRunId: "old-native",
              }),
            },
          },
          async () => f.dependencies,
        );
        expect(response.status).toBe(202);
        expect(inspectSource).toHaveBeenCalledWith("old-native");
        const diagnostic: unknown = loggedEvent(
          info.mock.calls,
          "builder.native_source_observation",
        );
        expect(diagnostic).toMatchObject({
          anchorStatus: expectedAnchor,
          anchorStepCounts: {
            cancelled: 0,
            completed: 4,
            failed: 3,
            pending: 1,
            running: 2,
            unknown: 0,
          },
          anchorUnsettledStepCount: 1,
          collectionBoundary: {
            allowParked: true,
            parentStatus: "other",
            stage: expectedStage,
            status: expectedStatus,
          },
          collectionKind: "unavailable",
          collectionReason: "source-not-terminal",
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
      get: async () => {
        reads.push("run");
        return { runId: "old-native", status: "running" };
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
  f.dependencies.inspectSource = async (owner) =>
    await runtime.inspectNativeRecoverySource(world, owner);
  f.collect.mockResolvedValueOnce({
    boundary: { allowParked: true, stage: "handoff_parent", status: "running" },
    kind: "unavailable",
    reason: "source-not-terminal",
  });
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const response = await runtime.handleTerminalRecoveryRequest(
      {
        auth: actor,
        forwarded: true,
        payload: { recoveryPhase: "inspect-source", sourceObservation: {} },
        ports: {
          ...f.ports,
          authorizeSourceObservation: async () => ({
            logicalSessionId: "logical",
            ownerRunId: "old-native",
          }),
        },
      },
      async () => f.dependencies,
    );
    expect(response.status).toBe(202);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      sourceDiagnostic: {
        anchorRead: {
          errorCategory: "type",
          outcome: "failed",
          stage: "steps_list",
          status: "running",
          stepCounts: null,
          unsettledStepCount: null,
        },
        collectionBoundary: { allowParked: true, stage: "handoff_parent", status: "running" },
        collectionKind: "unavailable",
        collectionReason: "source-not-terminal",
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
        auth: actor,
        forwarded: true,
        payload: { recoveryPhase: "inspect-source", sourceObservation: {} },
        ports: {
          ...f.ports,
          authorizeSourceObservation: async () => ({
            logicalSessionId: "logical",
            ownerRunId: "old-native",
          }),
        },
      },
      async () => f.dependencies,
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      sourceDiagnostic: {
        anchorRead: { outcome: "succeeded" },
        collectionErrorCategory: "reference",
        collectionKind: "failed",
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
    .mockResolvedValueOnce({ logicalSessionId: "logical", ownerRunId: "old-native" })
    .mockRejectedValue(new Error("private-canary-owner"));
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const response = await runtime.handleTerminalRecoveryRequest(
      {
        auth: actor,
        forwarded: true,
        payload: { recoveryPhase: "inspect-source", sourceObservation: {} },
        ports: { ...f.ports, authorizeSourceObservation },
      },
      async () => f.dependencies,
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
    boundary: { allowParked: true, stage: "handoff_parent", status: "running" },
    kind: "unavailable",
    reason: "source-not-terminal",
  });
  f.dependencies.inspectSource = async () => {
    throw new TypeError("private-canary-step-error");
  };
  const adapter = createSameOriginEveTransport({
    config: { baseUrl: "https://builder.example.test" },
    fetchImplementation: async () =>
      await runtime.handleTerminalRecoveryRequest(
        {
          auth: actor,
          forwarded: true,
          payload: { recoveryPhase: "inspect-source", sourceObservation: {} },
          ports: {
            ...f.ports,
            authorizeSourceObservation: async () => ({
              logicalSessionId: "logical",
              ownerRunId: "old-native",
            }),
          },
        },
        async () => f.dependencies,
      ),
    workloadIdentity: { token: async () => "synthetic-token" },
  });
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    await adapter.observeSource?.({
      principal: {
        audience: "builder",
        issuer: "https://owner.example",
        ownerUserId: "owner",
        scopes: ["autograph:get"],
        workspaceId: "workspace",
      },
      source: {
        cancellationRevision: 0,
        sourceAdapterGeneration: 1,
        sourceAdapterSessionId: "old-native",
        sourcePublicSessionId: "source",
      },
    });
    expect(loggedEvent(info.mock.calls, "builder.native_source_observation_relay")).toMatchObject({
      diagnostic: {
        anchorRead: { errorCategory: "type", outcome: "failed" },
        collectionBoundary: { stage: "handoff_parent", status: "running" },
        collectionReason: "source-not-terminal",
      },
      outcome: "available",
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
        auth: actor,
        forwarded: true,
        payload: { recoveryPhase: "inspect-source", sourceObservation: {} },
        ports: {
          ...f.ports,
          authorizeSourceObservation: async () => ({
            logicalSessionId: "logical",
            ownerRunId: "old-native",
          }),
        },
      },
      async () => {
        throw new ReferenceError("private-canary-module");
      },
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      sourceDiagnostic: {
        anchorRead: {
          errorCategory: "reference",
          outcome: "failed",
          stage: "dependencies",
          status: null,
        },
        collectionErrorCategory: "reference",
        collectionKind: "failed",
        collectionStage: "dependencies",
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

it("composes real native lineage ports and reaches canonical validation before any World read", async () => {
  const f = fixture();
  const dependencies = await runtime.createNativeTerminalRecoveryDependencies();
  await expect(
    runtime.quiesceLiveRecoverySource(
      { auth: actor, descriptor: { ...descriptor, logicalSessionId: "" }, ports: f.ports },
      dependencies,
    ),
  ).rejects.toThrow("Canonical server ownership authorization is required.");
  expect(f.stopSource).not.toHaveBeenCalled();
  expect(f.start).not.toHaveBeenCalled();
});

describe("owned running-lineage execution transfer", () => {
  const twoOwners = () => {
    const f = fixture();
    f.setLineage(["old-native"]);
    f.setAncestorStatus("old-native", "running");
    f.setPhysicalOwner("physical-child");
    return f;
  };
  it("stops every active verified owner root first, verifies all receipts and adopts one terminal checkpoint", async () => {
    const f = twoOwners();
    expect(await f.run()).toMatchObject({ kind: "accepted" });
    expect(f.stopSource.mock.calls.map(([id]) => id)).toEqual(["old-native", "physical-child"]);
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.start.mock.calls[0]?.[0].checkpoint.sessionState).toEqual(f.after);
    expect(await f.run()).toMatchObject({ kind: "accepted" });
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.stopSource).toHaveBeenCalledTimes(2);
  });
  it("observes a naturally completed ancestor without cancelling it", async () => {
    const f = twoOwners();
    f.setAncestorStatus("old-native", "completed");
    expect(await f.run()).toMatchObject({ kind: "accepted" });
    expect(f.stopSource.mock.calls.map(([id]) => id)).toEqual(["physical-child"]);
  });
  it.each(["running", "failed", "cancelled"])(
    "refuses an unresolved %s effect anywhere before any stop",
    async (status) => {
      const f = twoOwners();
      f.dependencies.inspectSource = async (id) => ({
        runId: id,
        status: "running",
        stepCounts: { [status]: 1 },
        unsettledStepIds: id === "physical-child" ? [`${status}-effect`] : [],
      });
      expect(await f.run()).toMatchObject({
        kind: "unavailable",
        reason: "source-lineage-effects-unsettled",
      });
      expect(f.stopSource).not.toHaveBeenCalled();
      expect(f.start).not.toHaveBeenCalled();
    },
  );
  it("reconstructs a partial stop from exact native receipts without stopping the ancestor twice", async () => {
    const f = twoOwners();
    const read = f.dependencies.readStopReceipt?.bind(f.dependencies);
    if (read === undefined) {
      throw new Error("Missing receipt fixture");
    }
    f.dependencies.readStopReceipt = vi
      .fn<NonNullable<TerminalRecoveryDependencies["readStopReceipt"]>>(
        async (id, reason) => await read(id, reason),
      )
      .mockResolvedValueOnce(false);
    expect(await f.run()).toMatchObject({ kind: "uncertain", reason: "source-stop-unconfirmed" });
    expect(f.stopSource.mock.calls.map(([id]) => id)).toEqual(["old-native"]);
    expect(f.start).not.toHaveBeenCalled();
    expect(await f.run()).toMatchObject({ kind: "accepted" });
    expect(f.stopSource.mock.calls.map(([id]) => id)).toEqual(["old-native", "physical-child"]);
    expect(f.start).toHaveBeenCalledOnce();
  });
  it("refuses a late handoff before boot and rediscovers it on the same operation retry", async () => {
    const f = twoOwners();
    const stop = f.stopSource.getMockImplementation();
    if (stop === undefined) {
      throw new Error("Missing stop fixture");
    }
    f.stopSource.mockImplementationOnce(async (id, reason) => {
      await stop(id, reason);
      f.setLineage(["old-native", "physical-child"]);
      f.setAncestorStatus("physical-child", "running");
      f.setPhysicalOwner("late-child");
    });
    expect(await f.run()).toMatchObject({
      kind: "uncertain",
      reason: "source-physical-owner-changed",
    });
    expect(f.start).not.toHaveBeenCalled();
    expect(f.stopSource).toHaveBeenCalledOnce();
    expect(await f.run()).toMatchObject({ kind: "accepted" });
    expect(f.stopSource.mock.calls.map(([id]) => id)).toEqual([
      "old-native",
      "physical-child",
      "late-child",
    ]);
    expect(f.start).toHaveBeenCalledOnce();
  });
  it("honors owner revocation between ancestor and final-owner stops", async () => {
    const f = twoOwners();
    const stop = f.stopSource.getMockImplementation();
    if (stop === undefined) {
      throw new Error("Missing stop fixture");
    }
    f.stopSource.mockImplementationOnce(async (id, reason) => {
      await stop(id, reason);
      f.revoke();
    });
    await expect(f.run()).rejects.toThrow("owner revoked");
    expect(f.stopSource.mock.calls.map(([id]) => id)).toEqual(["old-native"]);
    expect(f.start).not.toHaveBeenCalled();
  });
  it("refuses an inbox owned outside the reconstructed verified lineage", async () => {
    const f = twoOwners();
    f.dependencies.readLogicalInboxOwner = async () => ({
      logicalSessionId: "logical",
      runId: "unverified-owner",
    });
    expect(await f.run()).toMatchObject({
      kind: "uncertain",
      reason: "source-physical-owner-changed",
    });
    expect(f.stopSource).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });
});

it("uses server-default bulk pagination and exhausts all step pages", async () => {
  const pages: unknown[] = [];
  const world = {
    runs: { get: async () => ({ runId: "old-native", status: "running" }) },
    steps: {
      list: async (input: { pagination?: { cursor?: string; limit?: number } }) => {
        pages.push(input);
        expect(input.pagination).not.toHaveProperty("limit");
        return input.pagination?.cursor === undefined
          ? {
              cursor: "page-two",
              data: [{ runId: "old-native", status: "completed", stepId: "one" }],
              hasMore: true,
            }
          : { data: [{ runId: "old-native", status: "failed", stepId: "two" }], hasMore: false };
      },
    },
  };
  const inspect = runtime.inspectNativeRecoverySource;
  // @ts-expect-error Synthetic World intentionally implements only the native read methods exercised here.
  const result = await inspect(world, "old-native");
  expect(pages).toHaveLength(2);
  expect(result).toMatchObject({
    runId: "old-native",
    status: "running",
    stepCounts: { completed: 1, failed: 1 },
    unsettledStepIds: ["two"],
  });
});

it("terminal-only recollection refuses a newly visible handoff before any successor", async () => {
  const f = fixture();
  f.setLineage(["old-native"]);
  f.setAncestorStatus("old-native", "running");
  f.setPhysicalOwner("physical-child");
  const collect = f.collect.getMockImplementation();
  if (collect === undefined) {
    throw new Error("Missing collector fixture");
  }
  let injected = false;
  f.collect.mockImplementation(async (input) => {
    if (input.allowParked !== true && !injected) {
      injected = true;
      f.setLineage(["old-native", "physical-child"]);
      f.setAncestorStatus("physical-child", "cancelled");
      f.setPhysicalOwner("late-child");
      f.setNativeStatus("running");
    }
    return await collect(input);
  });
  expect(await f.run()).toMatchObject({
    kind: "uncertain",
    reason: "source-physical-owner-changed",
  });
  expect(f.start).not.toHaveBeenCalled();
  expect(f.stopSource.mock.calls.map(([id]) => id)).toEqual(["old-native", "physical-child"]);
  expect(await f.run()).toMatchObject({ kind: "accepted" });
  expect(f.stopSource.mock.calls.map(([id]) => id)).toEqual([
    "old-native",
    "physical-child",
    "late-child",
  ]);
  expect(f.start).toHaveBeenCalledOnce();
});

it("retains the canonical unknown operation and source fence after a partial native stop through HTTP", async () => {
  const f = fixture();
  f.setLineage(["logical"]);
  f.setAncestorStatus("logical", "running");
  const principal = {
    audience: "builder",
    issuer: "https://owner.example",
    ownerUserId: "owner",
    scopes: Object.values(hostedEveOperationScopes),
    workspaceId: "workspace",
  };
  const store = new InMemoryHostedEveStore();
  let afterRootStop = false;
  const stop = f.stopSource.getMockImplementation();
  if (stop === undefined) {
    throw new Error("Missing stop fixture");
  }
  f.stopSource.mockImplementationOnce(async (id, reason) => {
    await stop(id, reason);
    afterRootStop = true;
  });
  const preflight = f.dependencies.collectLineagePreflight?.bind(f.dependencies);
  if (preflight === undefined) {
    throw new Error("Missing preflight fixture");
  }
  f.dependencies.collectLineagePreflight = async (input) =>
    afterRootStop
      ? await Promise.resolve({
          kind: "unavailable",
          reason: "paired-native-checkpoint-unavailable",
        })
      : await preflight(input);
  const operationIds: string[] = [];
  const statuses: number[] = [];
  const nativeTransport = createSameOriginEveTransport({
    config: { baseUrl: "https://builder.example.test" },
    fetchImplementation: async (_url, init) => {
      const payload = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(z.string().parse(init?.body)));
      operationIds.push(z.string().parse(payload.operationId));
      const response = await runtime.handleTerminalRecoveryRequest(
        { auth: actor, forwarded: true, payload, ports: f.ports },
        async () => f.dependencies,
      );
      statuses.push(response.status);
      return response;
    },
    workloadIdentity: { token: async () => "synthetic-token" },
  });
  const adapter: HostedEveTransport = {
    cancel: vi.fn(),
    get: async () => ({ events: [], status: "input_required" }),
    respond: vi.fn(),
    send: vi.fn(),
    start: async (input) =>
      input.recovery === undefined
        ? await Promise.resolve({
            adapterSessionId: "logical",
            snapshot: { events: [], status: "input_required" },
          })
        : await nativeTransport.start(input),
  };
  const service = createHostedEveSessionService({
    assertNativeRecoveryOwner: async () => {},
    principal,
    store,
    transport: adapter,
  });
  const first = await service.start({ clientRequestId: "initial", prompt: "Build isolated app" });
  const originalResponse = hostedOperationRecordSchema.parse({
    clientRequestId: "original-approval",
    createdAtEpochMs: 1,
    kind: "respond",
    operationId: "original-approval",
    principal,
    requestDigest: `sha256:${"c".repeat(64)}`,
    sessionId: first.sessionId,
    state: "reserved",
    updatedAtEpochMs: 1,
    version: 1,
  });
  await store.reserveOperation(principal, originalResponse);
  await store.settleUnsuccessful({
    nowEpochMs: 2,
    operationId: originalResponse.operationId,
    principal,
    requestDigest: originalResponse.requestDigest,
    safeErrorCode: "submission_unknown",
    state: "submission_unknown",
  });
  const request = {
    clientRequestId: "owned-recovery",
    resumeMode: "recover" as const,
    resumeSessionId: first.sessionId,
  };
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    await expect(service.start(request)).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    const unknown = await store.getStartOperation(principal, request.clientRequestId);
    expect(unknown).toMatchObject({ state: "submission_unknown" });
    expect(statuses).toEqual([503]);
    expect(f.stopSource.mock.calls.map(([id]) => id)).toEqual(["logical"]);
    const fenced = await store.reserveOperation(principal, {
      ...originalResponse,
      clientRequestId: "later-approval",
      operationId: "later-approval",
    });
    expect(fenced).toMatchObject({ disposition: "rejected", reason: "session_busy" });
    await expect(service.start(request)).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    expect(statuses).toEqual([503, 409]);
    expect(operationIds[0]).toBe(operationIds[1]);
    const retained = await store.getStartOperation(principal, request.clientRequestId);
    expect(retained).toMatchObject({
      operationId: unknown?.operationId,
      state: "submission_unknown",
    });
    const approval = await store.getPrivateOperation(principal, originalResponse.operationId);
    expect(approval).toMatchObject({ state: "submission_unknown" });
    expect(f.stopSource).toHaveBeenCalledOnce();
    expect(f.start).not.toHaveBeenCalled();
  } finally {
    info.mockRestore();
  }
});

it("GET-only opaque preflight relays complete owned-lineage facts without stopping any owner", async () => {
  const f = fixture();
  f.setLineage(["old-native"]);
  f.setAncestorStatus("old-native", "running");
  f.setPhysicalOwner("physical-child");
  f.dependencies.inspectSource = async (id) => ({
    runId: id,
    status: "running",
    stepCounts: {
      cancelled: 0,
      completed: id === "old-native" ? 20 : 6,
      failed: 0,
      pending: 0,
      running: 0,
      unknown: 0,
    },
    unsettledStepIds: [],
  });
  const adapter = createSameOriginEveTransport({
    config: { baseUrl: "https://builder.example.test" },
    fetchImplementation: async () =>
      await runtime.handleTerminalRecoveryRequest(
        {
          auth: actor,
          forwarded: true,
          payload: { recoveryPhase: "inspect-source", sourceObservation: {} },
          ports: {
            ...f.ports,
            authorizeSourceObservation: async () => ({
              logicalSessionId: "logical",
              ownerRunId: "old-native",
            }),
          },
        },
        async () => f.dependencies,
      ),
    workloadIdentity: { token: async () => "synthetic-token" },
  });
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    await adapter.observeSource?.({
      principal: {
        audience: "builder",
        issuer: "https://owner.example",
        ownerUserId: "owner",
        scopes: ["autograph:get"],
        workspaceId: "workspace",
      },
      source: {
        cancellationRevision: 0,
        sourceAdapterGeneration: 1,
        sourceAdapterSessionId: "old-native",
        sourcePublicSessionId: "source",
      },
    });
    expect(loggedEvent(info.mock.calls, "builder.native_source_observation_relay")).toMatchObject({
      diagnostic: {
        collectionKind: "preflight",
        lineageRead: {
          outcome: "succeeded",
          provenRunCount: 2,
          stepCounts: {
            cancelled: 0,
            completed: 26,
            failed: 0,
            pending: 0,
            running: 0,
            unknown: 0,
          },
          unsettledStepCount: 0,
        },
        reconciliation: { kind: "ready" },
      },
      outcome: "available",
    });
    expect(f.stopSource).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
    expect(JSON.stringify(info.mock.calls)).not.toContain("physical-child");
    expect(JSON.stringify(info.mock.calls)).not.toContain("old-native");
  } finally {
    info.mockRestore();
  }
});

it("adopts the same parked ready child after receipt failure without a second start or stopping that child", async () => {
  const f = fixture();
  f.setLineage(["old-native"]);
  f.setAncestorStatus("old-native", "running");
  f.setPhysicalOwner("physical-child");
  const commit = f.ports.commitReceipt.bind(f.ports);
  f.ports.commitReceipt = vi
    .fn<TerminalRecoveryPorts["commitReceipt"]>(async (input) => await commit(input))
    .mockRejectedValueOnce(new Error("private-ready-receipt-failure"));
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    await expect(f.run()).rejects.toThrow("private-ready-receipt-failure");
    expect(f.start).toHaveBeenCalledOnce();
    expect(await f.run()).toMatchObject({
      kind: "accepted",
      recoveryBinding: { ownerRunId: "new-native" },
    });
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.stopSource.mock.calls.map(([id]) => id)).toEqual(["old-native", "physical-child"]);
    expect(f.collect.mock.calls.filter(([input]) => input.allowParked !== true)).toHaveLength(2);
  } finally {
    info.mockRestore();
  }
});
it("refuses another operation's ready hook before stopping any owner", async () => {
  const f = fixture();
  f.dependencies.getHook = async () => ({
    metadata: Promise.resolve({
      recoveryBinding: {
        ...descriptor,
        operationId: "another-operation",
        ownerRunId: "foreign-ready",
        provenance: {
          checkpointVersion: 1,
          kind: "committed-turn-output",
          sourceEventId: "event",
          sourceSlot: 1,
          sourceStepId: "step",
        },
      },
    }),
    runId: "foreign-ready",
  });
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    await expect(f.run()).rejects.toThrow("Recovery activation owner changed");
    expect(f.stopSource).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  } finally {
    info.mockRestore();
  }
});
it("does not accept a caller-supplied parked owner without its exact native ready hook", async () => {
  const f = fixture();
  f.dependencies.readLogicalInboxOwner = async () => ({
    logicalSessionId: "logical",
    runId: "forged-ready",
  });
  const forged: TerminalRecoveryBinding = {
    ...descriptor,
    ownerRunId: "forged-ready",
    provenance: {
      checkpointVersion: 1,
      kind: "committed-turn-output",
      sourceEventId: "event",
      sourceSlot: 1,
      sourceStepId: "step",
    },
  };
  expect(
    await runtime.quiesceLiveRecoverySource(
      { auth: actor, descriptor, ports: f.ports },
      f.dependencies,
      undefined,
      forged,
    ),
  ).toMatchObject({ kind: "uncertain", reason: "source-physical-owner-changed" });
  expect(f.stopSource).not.toHaveBeenCalled();
  expect(f.start).not.toHaveBeenCalled();
});

describe("idle source execution transfer", () => {
  const idleSession = (): HarnessSession => ({
    agent: { dynamicModel: true, system: "", tools: [] },
    compaction: { recentWindowSize: 1, threshold: 1000 },
    continuationToken: "continuation",
    history: [{ content: "The prior response belongs to an earlier prompt.", role: "assistant" }],
    sessionId: "logical",
  });
  const idleState = () => durable.createDurableSessionState({ session: idleSession() });

  it("transfers a proven idle lineage without replaying a response or starting a model turn", async () => {
    const f = fixture();
    f.setCheckpointState(idleState());
    f.setLineage(["anchor", "middle"]);
    f.setAncestorStatus("anchor", "running");
    f.setAncestorStatus("middle", "running");
    const result = await f.run();
    expect(result.kind).toBe("accepted");
    expect(f.stopSource.mock.calls.map(([id]) => id)).toEqual(["anchor", "middle", "old-native"]);
    expect(f.start).toHaveBeenCalledTimes(1);
    const started = f.start.mock.calls.at(0)?.[0];
    if (started === undefined) {
      throw new Error("Recovery did not start its owner.");
    }
    expect(started.provenance.resumePhase).toBe("await-input");
    expect(started.replayInput).toBeUndefined();
    expect(started.checkpoint.sessionState).toEqual(idleState());
  });

  it("does not stop an idle source with an unsettled native effect", async () => {
    const f = fixture();
    f.setCheckpointState(idleState());
    f.setUnsettled(["running-provider-effect"]);
    const result = await f.run();
    expect(result.kind).toBe("unavailable");
    expect(f.stopSource).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });

  it("refuses a changed idle-to-approval phase after a source stop", async () => {
    const f = fixture();
    const approvalState = f.before;
    f.setCheckpointState(idleState());
    f.stopSource.mockImplementation(async () => {
      f.setNativeStatus("cancelled");
      f.markStopReceipt("old-native");
      f.setCheckpointState(approvalState);
      return;
    });
    const result = await f.run();
    expect(result.kind).toBe("uncertain");
    expect(f.start).not.toHaveBeenCalled();
  });
  it("does not stop a source whose accepted input is deferred outside pending approvals", async () => {
    const f = fixture();
    f.setCheckpointState(
      durable.createDurableSessionState({
        session: batches.queueDeferredStepInput(idleSession(), {
          message: "Already accepted work",
        }),
      }),
    );
    const result = await f.run();
    expect(result.kind).toBe("unavailable");
    expect(f.stopSource).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });
  it("does not stop a source waiting for an authorization callback", async () => {
    const authorization = await vi.importActual<{
      setPendingAuthorization: typeof RuntimeSetAuthorization;
    }>(new URL("../../node_modules/eve/dist/src/harness/authorization.js", import.meta.url).href);
    const session = idleSession();
    const f = fixture();
    f.setCheckpointState(
      durable.createDurableSessionState({
        session: {
          ...session,
          state: authorization.setPendingAuthorization(session.state, {
            challenges: [
              {
                attemptId: "retained-attempt",
                challenge: { instructions: "Complete the existing authorization" },
                hookUrl: "https://builder.example/retained-callback",
                name: "provider",
              },
            ],
          }),
        },
      }),
    );
    const result = await f.run();
    expect(result.kind).toBe("unavailable");
    expect(f.stopSource).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });
});

describe("explicit idle-checkpoint execution transfer", () => {
  it("recovers a completed idle checkpoint through the same owned stop and native receipt path", async () => {
    const f = fixture("idle-checkpoint");
    f.setTurnState("");
    const result = await f.run();
    expect(result).toMatchObject({
      kind: "accepted",
      recoveryBinding: {
        executionTransfer: { kind: "idle-checkpoint" },
        provenance: { resumePhase: "await-input" },
      },
    });
    expect(f.stopSource).toHaveBeenCalledWith(
      "old-native",
      "Builder native execution transfer transfer",
    );
    expect(f.start).toHaveBeenCalledTimes(1);
  });
  it("does not treat a pending tool approval as an idle checkpoint", async () => {
    const f = fixture("idle-checkpoint");
    expect(await f.run()).toMatchObject({ kind: "unavailable", reason: "source-idle-not-parked" });
    expect(f.stopSource).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });
  it("rejects an active ordinary turn even when no tool or approval is pending", async () => {
    const f = fixture("idle-checkpoint");
    f.setTurnState("active-ordinary-turn");
    expect(await f.run()).toMatchObject({ kind: "unavailable", reason: "source-idle-not-parked" });
    expect(f.stopSource).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });
  it("refuses a different completed checkpoint before stopping the same physical owner", async () => {
    const f = fixture("idle-checkpoint");
    f.setTurnState("");
    const reconcile = f.dependencies.reconcileLineagePreflight;
    if (reconcile === undefined) {
      throw new Error("Missing native preflight fixture");
    }
    let observed = false;
    f.dependencies.reconcileLineagePreflight = async (input) => {
      if (observed) {
        f.setCheckpointOrigin(2);
      }
      observed = true;
      return await reconcile(input);
    };
    expect(await f.run()).toMatchObject({ kind: "uncertain", reason: "source-checkpoint-changed" });
    expect(f.stopSource).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });
  it("retains uncertainty when checkpoint identity changes after the owned stop", async () => {
    const f = fixture("idle-checkpoint");
    f.setTurnState("");
    const stop = f.stopSource.getMockImplementation();
    if (stop === undefined) {
      throw new Error("Missing owned stop fixture");
    }
    f.stopSource.mockImplementation(async (...input) => {
      await stop(...input);
      f.setCheckpointOrigin(2);
    });
    expect(await f.run()).toMatchObject({ kind: "uncertain", reason: "source-checkpoint-changed" });
    expect(f.stopSource).toHaveBeenCalledTimes(1);
    expect(f.start).not.toHaveBeenCalled();
  });
  it("pins the final terminal recollection to the exact idle checkpoint proved before stop", async () => {
    const f = fixture("idle-checkpoint");
    f.setTurnState("");
    const collect = f.collect.getMockImplementation();
    if (collect === undefined) {
      throw new Error("Missing collector fixture");
    }
    f.collect.mockImplementation(async (input) => {
      if (input.allowParked !== true) {
        f.setCheckpointOrigin(2);
      }
      return await collect(input);
    });
    expect(await f.run()).toMatchObject({ kind: "uncertain", reason: "source-checkpoint-changed" });
    expect(f.stopSource).toHaveBeenCalledTimes(1);
    expect(f.start).not.toHaveBeenCalled();
  });
});
