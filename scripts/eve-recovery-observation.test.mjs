/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument -- This fixture imports installed private compiled Eve modules by package path. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, test } from "vitest";

const require = createRequire(import.meta.url);
const eve = path.dirname(require.resolve("eve/package.json"));
const load = (name) => import(pathToFileURL(path.join(eve, "dist/src", name)).href);
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
      message: "terminal-recovery-observation",
      fields: JSON.parse(record.message.slice(prefix.length)),
    });
  }
});
afterAll(() => setLogRecordSubscriber());
let sequence = 0;
const setup = () => {
  sequence += 1;
  const descriptor = {
    version: 1,
    operationId: `observe-${sequence}`,
    sourcePublicSessionId: "public-original",
    sourceOwnerRunId: "physical-original",
    sourceAdapterGeneration: 1,
    logicalSessionId: "logical-original",
    originalAuthoritySessionId: "public-original",
    parentCancellationRevision: 0,
  };
  const receipt = {
    ...descriptor,
    ownerRunId: "physical-failed-child",
    provenance: {
      kind: "completed-terminal-turn-input",
      sourceStepId: "original-step",
      sourceEventId: "original-event",
      sourceSlot: 2,
      checkpointVersion: 1,
    },
  };
  const state = {
    receipt,
    authorized: 0,
    denied: false,
    collects: 0,
    effects: 0,
    now: 0,
    reports: [],
  };
  const effect = () => {
    state.effects += 1;
    throw new Error("Unexpected effect");
  };
  const payload = {
    binding: { ownerRunId: receipt.ownerRunId, logicalSessionId: descriptor.logicalSessionId },
    run: { status: "failed" },
    candidates: [],
    events: [],
    nativeEvents: [],
    issues: [],
    frontier: [],
  };
  const ports = {
    authorize: () => {
      state.authorized += 1;
      if (state.denied) {
        throw new Error("denied");
      }
      return Promise.resolve();
    },
    readReceipt: () => Promise.resolve(state.receipt),
    commitReceipt: effect,
    authorizeActivation: effect,
  };
  const deps = {
    now: () => state.now,
    collect: async ({ binding, authorizeOwner }) => {
      state.collects += 1;
      await authorizeOwner(binding);
      return { kind: "candidate", candidate: { ...payload, binding } };
    },
    readCandidate: (candidate) => candidate,
    recordObservation: (value) => {
      state.reports.push(value);
      return true;
    },
    start: effect,
    resumeHook: effect,
    reconcile: effect,
    readEntry: effect,
    getHook: effect,
  };
  return {
    state,
    payload,
    deps,
    input: {
      auth: { authenticator: "test", principalType: "user", principalId: "owner" },
      descriptor,
      ports,
    },
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
  const collect = deps.collect;
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
  const collect = deps.collect;
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
    payload: {
      operationId: input.descriptor.operationId,
      recovery: input.descriptor,
      recoveryPhase: "observe",
    },
    auth: input.auth,
    ports: input.ports,
    forwarded: false,
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
    sessionId: logical,
    continuationToken: "private-continuation",
    compaction: { threshold: 1e6, recentWindowSize: 10 },
    agent: {
      system: "secret-prompt",
      tools: [],
      modelReference: { id: "synthetic", provider: "test" },
    },
    state: {},
    history: [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: nativeCall,
            toolName: "private-tool",
            input: { privateArgument: "hidden" },
          },
          { type: "tool-call", toolCallId: deferredCall, toolName: "private-deferred", input: {} },
          { type: "tool-approval-request", approvalId: "private-approval", toolCallId: nativeCall },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-approval-response", approvalId: "private-approval", approved: true },
          {
            type: "tool-result",
            toolCallId: deferredCall,
            toolName: "private-deferred",
            output: { type: "text", value: "private-result" },
          },
        ],
      },
    ],
  };
  const pair = {
    serializedContext: { "eve.sessionId": logical },
    sessionState: createDurableSessionState({ session }),
  };
  const stepId = "step-private-finalizer";
  const eventId = "evnt_00000000000000000000000002";
  const step = {
    runId: owner,
    stepId,
    stepName: "step//eve//terminateChildSessionsStep",
    status: "completed",
    input: await serialization.dehydrateStepArguments({ args: [pair], closureVars: [] }, owner),
  };
  const event = {
    runId: owner,
    eventId,
    eventType: "step_completed",
    correlationId: stepId,
    eventData: { stepName: step.stepName },
  };
  const sourceOwner = input.descriptor.sourceOwnerRunId;
  const sourceStep = {
    ...step,
    runId: sourceOwner,
    input: await serialization.dehydrateStepArguments(
      { args: [pair], closureVars: [] },
      sourceOwner,
    ),
  };
  const readOwners = [];
  const world = {
    runs: {
      get: (id) => {
        assert.ok([owner, sourceOwner].includes(id));
        readOwners.push(id);
        return Promise.resolve({ runId: id, status: "failed" });
      },
    },
    events: {
      list: ({ runId }) => Promise.resolve({ data: [{ ...event, runId }], hasMore: false }),
    },
    steps: { get: (runId) => Promise.resolve(runId === sourceOwner ? sourceStep : step) },
  };
  const realResult = {
    type: "action.result",
    data: {
      result: {
        kind: "tool-result",
        callId: deferredCall,
        toolName: "private-deferred",
        output: "private-result",
      },
    },
  };
  deps.collect = createTerminalRecoveryCandidateCollector({
    getWorld: () => Promise.resolve(world),
    resolveRunEncryptionKey: () => Promise.resolve(),
    hydrateStepArguments: (value, runId, key) =>
      serialization.hydrateStepArguments(value, runId, key, []),
    hydrateStepReturnValue: (value, runId, key) =>
      serialization.hydrateStepReturnValue(value, runId, key),
    readDurableSession,
    requireEventSlot: (id) => Number(id.slice(5)),
    async *readNativeEvents(runId) {
      yield realResult;
      if (runId === sourceOwner) {
        yield {
          ...realResult,
          data: { result: { ...realResult.data.result, callId: nativeCall } },
        };
      }
    },
    now: () => 0,
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
