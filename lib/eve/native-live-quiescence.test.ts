/* oxlint-disable sonarjs/no-internal-api-use -- Exercise the actual patched recovery entrypoint with synthetic native World ports. */
import { describe, expect, it, vi } from "vitest";
import type {
  TerminalRecoveryDependencies,
  TerminalRecoveryDescriptor,
  TerminalRecoveryPorts,
  TerminalRecoveryBinding,
  recoverTerminalSession as RuntimeRecover,
  observeTerminalSession as RuntimeObserve,
  handleTerminalRecoveryRequest as RuntimeHandle,
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
