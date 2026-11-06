import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, test } from "vitest";

const require = createRequire(import.meta.url);
const eve = path.dirname(require.resolve("eve/package.json"));
const FAILED_STATUS = "failed";
const TERMINAL_OBSERVATION_PREFIX = "terminal-recovery-observation";
const DENIED_ERROR = "denied";
const PRIVATE_DEFERRED = "private-deferred";
const PRIVATE_APPROVAL = "private-approval";
const PRIVATE_RESULT = "private-result";
const PHYSICAL_ORIGINAL = "physical-original";
const PHYSICAL_FAILED_CHILD = "physical-failed-child";
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
  const prefix = `${TERMINAL_OBSERVATION_PREFIX} `;
  if (record.message.startsWith(prefix) === true) {
    records.push({
      ...record,
      fields: JSON.parse(record.message.slice(prefix.length)),
      message: TERMINAL_OBSERVATION_PREFIX,
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
    sourceOwnerRunId: PHYSICAL_ORIGINAL,
    sourcePublicSessionId: "public-original",
    version: 1,
  };
  const receipt = {
    ...descriptor,
    ownerRunId: PHYSICAL_FAILED_CHILD,
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
    run: { status: FAILED_STATUS },
  };
  const ports = {
    authorize: () => {
      state.authorized += 1;
      if (state.denied) {
        throw new Error(DENIED_ERROR);
      }
    },
    authorizeActivation: effect,
    commitReceipt: effect,
    readReceipt: () => state.receipt,
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
    sessionId: PHYSICAL_FAILED_CHILD,
  });
  assert.equal(state.effects, 0);
  assert.equal(state.collects, 2);
  assert.deepEqual(
    state.reports.map((report) => report.ownerRunId),
    [PHYSICAL_ORIGINAL, PHYSICAL_FAILED_CHILD],
  );
  assert.equal(JSON.stringify(payload), before);
});

test("without receipt observes only canonical original physical owner", async () => {
  const { state, deps, input, payload } = setup();
  state.receipt = null;
  payload.binding.ownerRunId = input.descriptor.sourceOwnerRunId;
  const observed = await observeTerminalSession(input, deps);
  assert.equal(observed.sessionId, PHYSICAL_ORIGINAL);
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
  await assert.rejects(observeTerminalSession(input, deps), new RegExp(DENIED_ERROR, "u"));
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
          { input: {}, toolCallId: deferredCall, toolName: PRIVATE_DEFERRED, type: "tool-call" },
          { approvalId: PRIVATE_APPROVAL, toolCallId: nativeCall, type: "tool-approval-request" },
        ],
        role: "assistant",
      },
      {
        content: [
          { approvalId: PRIVATE_APPROVAL, approved: true, type: "tool-approval-response" },
          {
            output: { type: "text", value: PRIVATE_RESULT },
            toolCallId: deferredCall,
            toolName: PRIVATE_DEFERRED,
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
      list: ({ runId }) => ({ data: [{ ...event, runId }], hasMore: false }),
    },
    runs: {
      get: (id) => {
        assert.ok([owner, sourceOwner].includes(id));
        readOwners.push(id);
        return { runId: id, status: FAILED_STATUS };
      },
    },
    steps: { get: (runId) => (runId === sourceOwner ? sourceStep : step) },
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
    getWorld: () => world,
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
    resolveRunEncryptionKey: () => null,
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
    PRIVATE_RESULT,
    "private-tool",
    PRIVATE_APPROVAL,
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
