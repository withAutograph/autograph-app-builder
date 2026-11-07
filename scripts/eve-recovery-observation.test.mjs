/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument -- This fixture imports installed private compiled Eve modules by package path. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, test } from "vitest";

const require = createRequire(import.meta.url);
const eve = path.dirname(require.resolve("eve/package.json"));
const load = async (name) => await import(pathToFileURL(path.join(eve, "dist/src", name)).href);
const { observeTerminalSession, handleTerminalRecoveryRequest } = await load(
  "execution/session/terminal-recovery.js",
);
const { recordTerminalRecoveryObservation, protocolIdentityHash } = await load(
  "harness/model-protocol-diagnostic.js",
);
const { createTerminalRecoveryCandidateCollector, readTerminalRecoveryCandidate } = await load(
  "execution/session/recovery-candidate.js",
);
const { createDurableSessionState, readDurableSession } = await load(
  "execution/durable-session-store.js",
);
const serialization = await load("compiled/@workflow/core/serialization.js");
const { setLogRecordSubscriber } = await load("internal/logging.js");
const records = [];
setLogRecordSubscriber((record) => {
  const prefix = "terminal-recovery-observation ";
  if (record.message.startsWith(prefix) === true) {
    records.push({
      ...record,
      fields: JSON.parse(record.message.slice(prefix.length)),
      message: "terminal-recovery-observation",
    });
  }
});
afterAll(() => setLogRecordSubscriber());
let sequence = 0;
const setup = () => {
  sequence += 1;
  const descriptor = {
    logicalSessionId: "logical-original",
    operationId: `observe-${sequence}`,
    originalAuthoritySessionId: "public-original",
    parentCancellationRevision: 0,
    sourceAdapterGeneration: 1,
    sourceOwnerRunId: "physical-original",
    sourcePublicSessionId: "public-original",
    version: 1,
  };
  const receipt = {
    ...descriptor,
    ownerRunId: "physical-failed-child",
    provenance: {
      checkpointVersion: 1,
      kind: "completed-terminal-turn-input",
      sourceEventId: "original-event",
      sourceSlot: 2,
      sourceStepId: "original-step",
    },
  };
  const state = {
    authorized: 0,
    collects: 0,
    denied: false,
    effects: 0,
    now: 0,
    receipt,
    reports: [],
  };
  const effect = () => {
    state.effects += 1;
    throw new Error("Unexpected effect");
  };
  const payload = {
    binding: { logicalSessionId: descriptor.logicalSessionId, ownerRunId: receipt.ownerRunId },
    candidates: [],
    events: [],
    frontier: [],
    issues: [],
    nativeEvents: [],
    run: { status: "failed" },
  };
  const ports = {
    authorize: async () => {
      state.authorized += 1;
      if (state.denied) {
        throw new Error("denied");
      }
    },
    authorizeActivation: effect,
    commitReceipt: effect,
    readReceipt: async () => state.receipt,
  };
  const deps = {
    collect: async ({ binding, authorizeOwner }) => {
      state.collects += 1;
      await authorizeOwner(binding);
      return { candidate: { ...payload, binding }, kind: "candidate" };
    },
    getHook: effect,
    now: () => state.now,
    readCandidate: (candidate) => candidate,
    readEntry: effect,
    reconcile: effect,
    recordObservation: (value) => {
      state.reports.push(value);
      return true;
    },
    resumeHook: effect,
    start: effect,
  };
  return {
    deps,
    input: {
      auth: { authenticator: "test", principalId: "owner", principalType: "user" },
      descriptor,
      ports,
    },
    payload,
    state,
  };
};

test("receipt observation selects failed physical child and cannot activate, reconcile or commit", async () => {
  const { state, deps, input, payload } = setup();
  const before = JSON.stringify(payload);
  assert.deepEqual(await observeTerminalSession(input, deps), {
    kind: "accepted",
    sessionId: "physical-failed-child",
  });
  assert.equal(state.effects, 0);
  assert.equal(state.collects, 2);
  assert.deepEqual(
    state.reports.map((report) => report.ownerRunId),
    ["physical-original", "physical-failed-child"],
  );
  assert.equal(JSON.stringify(payload), before);
});

test("without receipt observes only canonical original physical owner", async () => {
  const { state, deps, input, payload } = setup();
  state.receipt = undefined;
  payload.binding.ownerRunId = input.descriptor.sourceOwnerRunId;
  const observed = await observeTerminalSession(input, deps);
  assert.equal(observed.sessionId, "physical-original");
  assert.equal(state.reports[0].receiptPresent, false);
  assert.equal(state.effects, 0);
});

test("successful repeat suppresses reads briefly but reauthorizes every request", async () => {
  const { state, deps, input } = setup();
  await observeTerminalSession(input, deps);
  const firstAuth = state.authorized;
  await observeTerminalSession(input, deps);
  assert.equal(state.collects, 2);
  assert.ok(state.authorized > firstAuth);
  state.now = 15_001;
  await observeTerminalSession(input, deps);
  assert.equal(state.collects, 4);
  state.denied = true;
  await assert.rejects(observeTerminalSession(input, deps), /denied/u);
  assert.equal(state.collects, 4);
});

test("concurrent observations share reads and independently reauthorize", async () => {
  const { state, deps, input } = setup();
  await Promise.all([observeTerminalSession(input, deps), observeTerminalSession(input, deps)]);
  assert.equal(state.collects, 2);
  assert.equal(state.reports.length, 2);
  assert.ok(state.authorized >= 7);
});

test("foreign receipt is rejected before private collection", async () => {
  const { state, deps, input } = setup();
  state.receipt = { ...state.receipt, logicalSessionId: "foreign" };
  await assert.rejects(observeTerminalSession(input, deps), /receipt changed/u);
  assert.equal(state.collects, 0);
});

test("new receipt during collection prevents recording and cannot become activation", async () => {
  const { state, deps, input } = setup();
  const { collect } = deps;
  deps.collect = async (value) => {
    const result = await collect(value);
    state.receipt = { ...state.receipt, ownerRunId: "other-child" };
    return result;
  };
  await assert.rejects(observeTerminalSession(input, deps), /receipt changed/u);
  assert.equal(state.reports.length, 0);
  assert.equal(state.effects, 0);
});

test("new Stop during collection prevents recording", async () => {
  const { state, deps, input } = setup();
  const { collect } = deps;
  deps.collect = async (value) => {
    const result = await collect(value);
    state.denied = true;
    return result;
  };
  await assert.rejects(observeTerminalSession(input, deps), /denied/u);
  assert.equal(state.reports.length, 0);
});

test("advisory sink failure has no effects, does not cache a successful observation", async () => {
  const { state, deps, input } = setup();
  deps.recordObservation = () => {
    throw new Error("sink unavailable");
  };
  const observed = await observeTerminalSession(input, deps);
  assert.equal(observed.kind, "accepted");
  await observeTerminalSession(input, deps);
  assert.equal(state.collects, 4);
  assert.equal(state.effects, 0);
});

test("unavailable retained data emits only safe outcome and never falls back to recovery", async () => {
  const { state, deps, input } = setup();
  deps.collect = async ({ binding, authorizeOwner }) => {
    await authorizeOwner(binding);
    return { kind: "unavailable", reason: "source-not-terminal" };
  };
  await observeTerminalSession(input, deps);
  assert.equal(state.reports[0].payload, undefined);
  assert.equal(state.reports[0].reason, "source-not-terminal");
  assert.equal(state.effects, 0);
});

test("untrusted observe route is refused before native dependency collection", async () => {
  const { input } = setup();
  const result = await handleTerminalRecoveryRequest({
    auth: input.auth,
    forwarded: false,
    payload: {
      operationId: input.descriptor.operationId,
      recovery: input.descriptor,
      recoveryPhase: "observe",
    },
    ports: input.ports,
  });
  assert.equal(result.status, 403);
});

test("actual native collector and serialization retain mixed orphan history and genuine result facts without inference", async () => {
  const { state, input, deps } = setup();
  const owner = state.receipt.ownerRunId;
  const logical = input.descriptor.logicalSessionId;
  const nativeCall = "native-missing-private-id";
  const deferredCall = "actual-deferred-private-id";
  const session = {
    agent: {
      modelReference: { id: "synthetic", provider: "test" },
      system: "secret-prompt",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 1e6 },
    continuationToken: "private-continuation",
    history: [
      {
        content: [
          {
            input: { privateArgument: "hidden" },
            toolCallId: nativeCall,
            toolName: "private-tool",
            type: "tool-call",
          },
          { input: {}, toolCallId: deferredCall, toolName: "private-deferred", type: "tool-call" },
          { approvalId: "private-approval", toolCallId: nativeCall, type: "tool-approval-request" },
        ],
        role: "assistant",
      },
      {
        content: [
          { approvalId: "private-approval", approved: true, type: "tool-approval-response" },
          {
            output: { type: "text", value: "private-result" },
            toolCallId: deferredCall,
            toolName: "private-deferred",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ],
    sessionId: logical,
    state: {},
  };
  const pair = {
    serializedContext: { "eve.sessionId": logical },
    sessionState: createDurableSessionState({ session }),
  };
  const stepId = "step-private-finalizer";
  const eventId = "evnt_00000000000000000000000002";
  const step = {
    input: await serialization.dehydrateStepArguments({ args: [pair], closureVars: [] }, owner),
    runId: owner,
    status: "completed",
    stepId,
    stepName: "step//eve//terminateChildSessionsStep",
  };
  const event = {
    correlationId: stepId,
    eventData: { stepName: step.stepName },
    eventId,
    eventType: "step_completed",
    runId: owner,
  };
  const sourceOwner = input.descriptor.sourceOwnerRunId;
  const sourceStep = {
    ...step,
    input: await serialization.dehydrateStepArguments(
      { args: [pair], closureVars: [] },
      sourceOwner,
    ),
    runId: sourceOwner,
  };
  const readOwners = [];
  const world = {
    events: {
      list: async ({ runId }) => ({ data: [{ ...event, runId }], hasMore: false }),
    },
    runs: {
      get: async (id) => {
        assert.ok([owner, sourceOwner].includes(id));
        readOwners.push(id);
        return { runId: id, status: "failed" };
      },
    },
    steps: { get: async (runId) => (runId === sourceOwner ? sourceStep : step) },
  };
  const realResult = {
    data: {
      result: {
        callId: deferredCall,
        kind: "tool-result",
        output: "private-result",
        toolName: "private-deferred",
      },
    },
    type: "action.result",
  };
  deps.collect = createTerminalRecoveryCandidateCollector({
    getWorld: async () => world,
    hydrateStepArguments: (value, runId, key) =>
      serialization.hydrateStepArguments(value, runId, key, []),
    hydrateStepReturnValue: (value, runId, key) =>
      serialization.hydrateStepReturnValue(value, runId, key),
    now: () => 0,
    readDurableSession,
    async *readNativeEvents(runId) {
      yield realResult;
      if (runId === sourceOwner) {
        yield {
          ...realResult,
          data: { result: { ...realResult.data.result, callId: nativeCall } },
        };
      }
    },
    requireEventSlot: (id) => Number(id.slice(5)),
    resolveRunEncryptionKey: async () => {},
  });
  deps.readCandidate = readTerminalRecoveryCandidate;
  deps.recordObservation = recordTerminalRecoveryObservation;
  const before = JSON.stringify(pair);
  await observeTerminalSession(input, deps);
  const logged = records.at(-1);
  assert.ok(logged !== undefined);
  const text = JSON.stringify(logged);
  for (const privateValue of [
    nativeCall,
    deferredCall,
    "private-result",
    "private-tool",
    "private-approval",
    "secret-prompt",
    owner,
    logical,
    stepId,
  ]) {
    assert.equal(text.includes(privateValue), false);
  }
  assert.ok(text.includes(protocolIdentityHash(nativeCall)));
  assert.ok(text.includes(protocolIdentityHash(deferredCall)));
  const data = logged.fields;
  assert.equal(data.candidateCount, 1);
  assert.equal(data.candidateSample[0].history.missingResultCount, 1);
  assert.equal(data.nativeResults.resultEventCount, 1);
  assert.deepEqual(
    data.candidateSample[0].historySampleNativeResults.find(
      (value) => value.idHash === protocolIdentityHash(nativeCall),
    ),
    { idHash: protocolIdentityHash(nativeCall), resultEventCount: 0 },
  );
  assert.equal(data.observedOwnerRunHash, protocolIdentityHash(owner));
  const originalLog = records.at(-2);
  assert.ok(originalLog !== undefined);
  assert.equal(originalLog.fields.observedOwnerRunHash, protocolIdentityHash(sourceOwner));
  assert.equal(originalLog.fields.nativeResults.resultEventCount, 2);
  assert.deepEqual(
    originalLog.fields.candidateSample[0].historySampleNativeResults.find(
      (value) => value.idHash === protocolIdentityHash(nativeCall),
    ),
    { idHash: protocolIdentityHash(nativeCall), resultEventCount: 1 },
  );
  assert.deepEqual(readOwners, [sourceOwner, owner]);
  await observeTerminalSession(input, deps);
  assert.deepEqual(readOwners, [sourceOwner, owner]);
  assert.equal(JSON.stringify(pair), before);
  assert.equal(state.effects, 0);
});

test("source owner equals receipt owner is observed only once", async () => {
  const { state, deps, input } = setup();
  state.receipt = { ...state.receipt, ownerRunId: input.descriptor.sourceOwnerRunId };
  const observed = await observeTerminalSession(input, deps);
  assert.equal(observed.sessionId, input.descriptor.sourceOwnerRunId);
  assert.equal(state.collects, 1);
  assert.equal(state.reports.length, 1);
});

test("receipt change after original summary rejects child observation", async () => {
  const { state, deps, input } = setup();
  deps.recordObservation = (value) => {
    state.reports.push(value);
    state.receipt = { ...state.receipt, ownerRunId: "changed-child" };
    return true;
  };
  await assert.rejects(observeTerminalSession(input, deps), /receipt changed/u);
  assert.equal(state.collects, 1);
  assert.deepEqual(
    state.reports.map((report) => report.ownerRunId),
    [input.descriptor.sourceOwnerRunId],
  );
  assert.equal(state.effects, 0);
});
