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
  let before = durable.createDurableSessionState({ session });
  let after = durable.createDurableSessionState({
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
    (id, _reason) => {
      if (id === physicalOwner) {
        nativeStatus = "cancelled";
      } else {
        ancestorStatuses.set(id, "cancelled");
      }
      stopReceipts.add(id);
      return Promise.resolve();
    },
  );
  const dependencies: TerminalRecoveryDependencies = {
    collect,
    reconcile,
    start,
    stopSource,
    inspectSource: vi.fn<NonNullable<TerminalRecoveryDependencies["inspectSource"]>>((id) =>
      Promise.resolve({
        runId: id,
        status: id === physicalOwner ? nativeStatus : (ancestorStatuses.get(id) ?? "completed"),
        unsettledStepIds,
      }),
    ),
    readStopReceipt: vi.fn<NonNullable<TerminalRecoveryDependencies["readStopReceipt"]>>((id) =>
      Promise.resolve(stopReceipts.has(id)),
    ),
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
    handoffChain: lineageParents.map((id, index) => ({
      parentRunId: id,
      ownerRunId: lineageParents[index + 1] ?? physicalOwner,
      startStepId: `start-${id}`,
      activationEventId: `activation-${id}`,
      events: [],
    })),
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
  dependencies.reconcileLineagePreflight = () => reconcile(candidate);
  dependencies.readLogicalInboxOwner = () => {
    if (ready) {
      return Promise.resolve({ runId: ready.ownerRunId, logicalSessionId: "logical" });
    }
    if (nativeStatus === "cancelled") {
      const absent: undefined = ready;
      return Promise.resolve(absent);
    }
    return Promise.resolve({ runId: physicalOwner, logicalSessionId: "logical" });
  };
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
    getNativeStatus: () => nativeStatus,
    setCheckpointState: (state: typeof before) => {
      before = state;
      after = state;
    },
    setLineage: (parents: string[]) => {
      lineageParents = parents;
    },
    setAncestorStatus: (id: string, status: string) => {
      ancestorStatuses.set(id, status);
    },
    markStopReceipt: (id: string) => {
      stopReceipts.add(id);
    },
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
    expect(await f.run()).toMatchObject({ kind: "uncertain", reason: "source-not-terminal" });
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
    f.reconcile.mockImplementation((candidate) =>
      f.getNativeStatus() === "cancelled"
        ? Promise.resolve({ kind: "uncertain", reason: "uncommitted-action-dispatch" })
        : reconcile(candidate),
    );
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
      f.dependencies.inspectSource = (id) =>
        Promise.resolve({
          runId: id,
          status: "running",
          unsettledStepIds: id === "physical-child" ? [`${status}-effect`] : [],
          stepCounts: { [status]: 1 },
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
      .fn<NonNullable<TerminalRecoveryDependencies["readStopReceipt"]>>((id, reason) =>
        read(id, reason),
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
    f.dependencies.readLogicalInboxOwner = () =>
      Promise.resolve({ runId: "unverified-owner", logicalSessionId: "logical" });
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
    runs: { get: () => Promise.resolve({ runId: "old-native", status: "running" }) },
    steps: {
      list: (input: { pagination?: { cursor?: string; limit?: number } }) => {
        pages.push(input);
        expect(input.pagination).not.toHaveProperty("limit");
        return Promise.resolve(
          input.pagination?.cursor === undefined
            ? {
                data: [{ runId: "old-native", stepId: "one", status: "completed" }],
                hasMore: true,
                cursor: "page-two",
              }
            : { data: [{ runId: "old-native", stepId: "two", status: "failed" }], hasMore: false },
        );
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
    unsettledStepIds: ["two"],
    stepCounts: { completed: 1, failed: 1 },
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
  f.collect.mockImplementation((input) => {
    if (input.allowParked !== true && !injected) {
      injected = true;
      f.setLineage(["old-native", "physical-child"]);
      f.setAncestorStatus("physical-child", "cancelled");
      f.setPhysicalOwner("late-child");
      f.setNativeStatus("running");
    }
    return collect(input);
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
    issuer: "https://owner.example",
    audience: "builder",
    workspaceId: "workspace",
    ownerUserId: "owner",
    scopes: Object.values(hostedEveOperationScopes),
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
  f.dependencies.collectLineagePreflight = (input) =>
    afterRootStop
      ? Promise.resolve({ kind: "unavailable", reason: "paired-native-checkpoint-unavailable" })
      : preflight(input);
  const operationIds: string[] = [];
  const statuses: number[] = [];
  const nativeTransport = createSameOriginEveTransport({
    config: { baseUrl: "https://builder.example.test" },
    workloadIdentity: { token: () => Promise.resolve("synthetic-token") },
    fetchImplementation: async (_url, init) => {
      const payload = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(z.string().parse(init?.body)));
      operationIds.push(z.string().parse(payload.operationId));
      const response = await runtime.handleTerminalRecoveryRequest(
        { payload, auth: actor, forwarded: true, ports: f.ports },
        () => Promise.resolve(f.dependencies),
      );
      statuses.push(response.status);
      return response;
    },
  });
  const adapter: HostedEveTransport = {
    start: (input) =>
      input.recovery === undefined
        ? Promise.resolve({
            adapterSessionId: "logical",
            snapshot: { events: [], status: "input_required" },
          })
        : nativeTransport.start(input),
    get: () => Promise.resolve({ events: [], status: "input_required" }),
    send: vi.fn(),
    respond: vi.fn(),
    cancel: vi.fn(),
  };
  const service = createHostedEveSessionService({
    principal,
    store,
    transport: adapter,
    assertNativeRecoveryOwner: () => Promise.resolve(),
  });
  const first = await service.start({ clientRequestId: "initial", prompt: "Build isolated app" });
  const originalResponse = hostedOperationRecordSchema.parse({
    version: 1,
    kind: "respond",
    clientRequestId: "original-approval",
    operationId: "original-approval",
    sessionId: first.sessionId,
    principal,
    state: "reserved",
    requestDigest: `sha256:${"c".repeat(64)}`,
    createdAtEpochMs: 1,
    updatedAtEpochMs: 1,
  });
  await store.reserveOperation(principal, originalResponse);
  await store.settleUnsuccessful({
    principal,
    operationId: originalResponse.operationId,
    requestDigest: originalResponse.requestDigest,
    state: "submission_unknown",
    safeErrorCode: "submission_unknown",
    nowEpochMs: 2,
  });
  const request = {
    clientRequestId: "owned-recovery",
    resumeSessionId: first.sessionId,
    resumeMode: "recover" as const,
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
      operationId: "later-approval",
      clientRequestId: "later-approval",
    });
    expect(fenced).toMatchObject({ disposition: "rejected", reason: "session_busy" });
    await expect(service.start(request)).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    expect(statuses).toEqual([503, 409]);
    expect(operationIds[0]).toBe(operationIds[1]);
    const retained = await store.getStartOperation(principal, request.clientRequestId);
    expect(retained).toMatchObject({
      state: "submission_unknown",
      operationId: unknown?.operationId,
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
  f.dependencies.inspectSource = (id) =>
    Promise.resolve({
      runId: id,
      status: "running",
      unsettledStepIds: [],
      stepCounts: {
        completed: id === "old-native" ? 20 : 6,
        pending: 0,
        running: 0,
        failed: 0,
        cancelled: 0,
        unknown: 0,
      },
    });
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
        collectionKind: "preflight",
        reconciliation: { kind: "ready" },
        lineageRead: {
          outcome: "succeeded",
          provenRunCount: 2,
          unsettledStepCount: 0,
          stepCounts: {
            completed: 26,
            pending: 0,
            running: 0,
            failed: 0,
            cancelled: 0,
            unknown: 0,
          },
        },
      },
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
    .fn<TerminalRecoveryPorts["commitReceipt"]>((input) => commit(input))
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
  f.dependencies.getHook = () =>
    Promise.resolve({
      runId: "foreign-ready",
      metadata: Promise.resolve({
        recoveryBinding: {
          ...descriptor,
          operationId: "another-operation",
          ownerRunId: "foreign-ready",
          provenance: {
            kind: "committed-turn-output",
            sourceStepId: "step",
            sourceEventId: "event",
            sourceSlot: 1,
            checkpointVersion: 1,
          },
        },
      }),
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
  f.dependencies.readLogicalInboxOwner = () =>
    Promise.resolve({ runId: "forged-ready", logicalSessionId: "logical" });
  const forged: TerminalRecoveryBinding = {
    ...descriptor,
    ownerRunId: "forged-ready",
    provenance: {
      kind: "committed-turn-output",
      sourceStepId: "step",
      sourceEventId: "event",
      sourceSlot: 1,
      checkpointVersion: 1,
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
    sessionId: "logical",
    continuationToken: "continuation",
    history: [{ role: "assistant", content: "The prior response belongs to an earlier prompt." }],
    agent: { dynamicModel: true, system: "", tools: [] },
    compaction: { recentWindowSize: 1, threshold: 1000 },
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
    f.stopSource.mockImplementation(() => {
      f.setNativeStatus("cancelled");
      f.markStopReceipt("old-native");
      f.setCheckpointState(approvalState);
      return Promise.resolve();
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
                name: "provider",
                attemptId: "retained-attempt",
                challenge: { instructions: "Complete the existing authorization" },
                hookUrl: "https://builder.example/retained-callback",
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
