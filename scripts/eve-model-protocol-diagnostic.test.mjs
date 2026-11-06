import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, test } from "vitest";

const require = createRequire(import.meta.url);
const eve = path.dirname(require.resolve("eve/package.json"));
const load = async (name) => await import(pathToFileURL(path.join(eve, "dist/src", name)).href);
const { createTerminalRecoveryCandidateCollector, readTerminalRecoveryCandidate } = await load(
  "execution/session/recovery-candidate.js",
);
const { reconcileTerminalRecoveryCandidate } = await load(
  "execution/session/recovery-reconciliation.js",
);
const { createDurableSessionState, readDurableSession } = await load(
  "execution/durable-session-store.js",
);
const { setPendingCoordinationBatch, getPendingCoordinationBatch, resolvePendingCoordination } =
  await load("harness/coordination.js");
const serialization = await load("compiled/@workflow/core/serialization.js");
const { ContextContainer, contextStorage } = await load("context/container.js");
const { SessionKey } = await load("context/keys.js");
const { createToolLoopHarness } = await load("harness/tool-loop.js");
const { MockLanguageModelV4 } = await import("ai/test");
const { z } = await import("zod");
const { summarizeModelProtocol, protocolIdentityHash, recordModelProtocolDiagnostic } = await load(
  "harness/model-protocol-diagnostic.js",
);
const { setLogRecordSubscriber } = await load("internal/logging.js");
const diagnosticRecords = [];
const TURN_STEP_NAME = "step//eve//turnStep";
const TOOL_RESULT_TYPE = "tool-result";
const ORIGINAL_DEFERRED_CALL_ID = "original-deferred";
const ORIGINAL_NATIVE_CALL_ID = "original-native";
const TURN_ID = "turn-original";
const ORIGINAL_OWNER_ID = "original-owner";
const DEFERRED_WORKFLOW_ID = "workflow:deferred";
const OPAQUE_CALL_ID = "opaque-call";
const OPAQUE_APPROVAL_ID = "opaque-approval";
const MIXED_NATIVE_CALL_ID = "mixed-native";
const TOOL_CALL_TYPE = "tool-call";
const TOOL_APPROVAL_RESPONSE_TYPE = "tool-approval-response";
const TOOL_APPROVAL_REQUEST_TYPE = "tool-approval-request";
const NATIVE_TOOL_NAME = "native";
const ORIGINAL_REQUEST_ID = "original-request";
const PRIVATE_CONTENT = "NEVER-LOG-PRIVATE-CONTENT";
afterAll(() => setLogRecordSubscriber());
setLogRecordSubscriber((record) => {
  if (record.namespace === "harness.model-protocol") {
    const separator = record.message.indexOf(" ");
    assert.ok(separator > 0);
    diagnosticRecords.push({
      ...record,
      fields: JSON.parse(record.message.slice(separator + 1)),
      message: record.message.slice(0, separator),
    });
  }
});
const ownerRunId = "wrun_physical_original";
const logicalSessionId = "wrun_logical_original";
const eventId = (slot) => `evnt_${String(slot).padStart(26, "0")}`;
const batchEvent = { sequence: 1, stepIndex: 1, turnId: TURN_ID };
const emission = { sequence: 1, sessionStarted: true, stepIndex: 2, turnId: TURN_ID };
const actualRuntimeResult = {
  callId: ORIGINAL_DEFERRED_CALL_ID,
  kind: TOOL_RESULT_TYPE,
  output: { value: "actual-native-outcome" },
  toolName: "deferred",
};

const fixture = async (options = {}) => {
  const originalGrant = {
    appSpecDigest: "original-spec",
    proposalDigest: "original-proposal",
    sessionId: logicalSessionId,
    workspaceId: "original-private-workspace",
  };
  let source = {
    agent: {
      modelReference: { id: "synthetic", provider: "test" },
      system: "original prompt",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 1e6 },
    continuationToken: "original-continuation",
    history: [
      { content: "Original product brief", kind: "user", role: "user" },
      {
        content: [
          {
            approvalId: ORIGINAL_REQUEST_ID,
            approved: options.denied !== true,
            type: TOOL_APPROVAL_RESPONSE_TYPE,
          },
          ...(options.denied === true
            ? [
                {
                  output: { reason: "original denial", type: "execution-denied" },
                  toolCallId: ORIGINAL_NATIVE_CALL_ID,
                  toolName: NATIVE_TOOL_NAME,
                  type: TOOL_RESULT_TYPE,
                },
              ]
            : []),
        ],
        role: "tool",
      },
    ],
    rootSessionId: logicalSessionId,
    sandboxState: {
      session: {
        providerName: "vercel",
        state: { name: "original-sandbox", workspaceDrive: { id: "original-drive" } },
        stateProtocolVersion: 1,
      },
    },
    sessionId: logicalSessionId,
    state: {
      "eve.harness.emission": emission,
      "eve.runtime.hitl.approvedTools": options.denied === true ? [] : ["native"],
      "fixture.authority": {
        grant: options.denied === true ? null : originalGrant,
        pending: [{ callId: ORIGINAL_NATIVE_CALL_ID, scope: originalGrant }],
      },
      "fixture.program": { arbitraryNestedState: { keep: true }, phase: "source-planned" },
    },
  };
  source = setPendingCoordinationBatch({
    event: batchEvent,
    responseMessages: [
      {
        content: [
          {
            input: { value: "exact-original-input" },
            toolCallId: ORIGINAL_NATIVE_CALL_ID,
            toolName: NATIVE_TOOL_NAME,
            type: TOOL_CALL_TYPE,
          },
          {
            input: {},
            toolCallId: ORIGINAL_DEFERRED_CALL_ID,
            toolName: "deferred",
            type: TOOL_CALL_TYPE,
          },
          {
            approvalId: ORIGINAL_REQUEST_ID,
            toolCallId: ORIGINAL_NATIVE_CALL_ID,
            type: TOOL_APPROVAL_REQUEST_TYPE,
          },
        ],
        role: "assistant",
      },
    ],
    runtimeActions: [],
    session: source,
    tasks: [
      {
        callId: ORIGINAL_DEFERRED_CALL_ID,
        input: {},
        kind: "workflow-task",
        toolName: "deferred",
        workflowId: DEFERRED_WORKFLOW_ID,
      },
    ],
  });
  if (options.mixedStorage === true) {
    const batch = getPendingCoordinationBatch(source.state);
    // Post-PR950 pending input settlement has already appended its assistant calls
    // and actual approval response. The coordination transcript itself is empty.
    source = setPendingCoordinationBatch({
      ...batch,
      responseMessages: [],
      session: {
        ...source,
        history: [source.history[0], ...batch.responseMessages, ...source.history.slice(1)],
      },
    });
  }
  // Real native reducer returns a state with coordination cleared but its input
  // history unchanged. This is the pre-repair completed MODEL400 failure shape.
  const old = await resolvePendingCoordination({
    session: source,
    stepInput: { runtimeActionResults: [actualRuntimeResult] },
  });
  const latest = {
    ...old.session,
    state: {
      ...old.session.state,
      "fixture.program": { arbitraryNestedState: { keep: true }, phase: "latest-committed" },
    },
  };
  if (options.mixedStorage === true) {
    latest.history = old.messages;
  }
  const sourcePair = {
    serializedContext: {
      "eve.auth": { principalId: ORIGINAL_OWNER_ID },
      "eve.sessionId": logicalSessionId,
      "fixture.privateContext": { original: true },
    },
    sessionState: createDurableSessionState({ session: source }),
  };
  const latestPair = {
    serializedContext: {
      ...sourcePair.serializedContext,
      "fixture.latestContext": { committed: true },
    },
    sessionState: createDurableSessionState({ session: latest }),
  };
  const incoming = {
    runtimeResults: { results: options.missingResult === true ? [] : [actualRuntimeResult] },
  };
  if (options.delivery === true) {
    incoming.delivery = {
      auth: { principalId: ORIGINAL_OWNER_ID },
      kind: "deliver",
      payloads: [{ message: "already admitted" }],
    };
  }
  const args = (value) =>
    serialization.dehydrateStepArguments({ args: [value], closureVars: [] }, ownerRunId);
  const output = (value) => serialization.dehydrateStepReturnValue(value, ownerRunId);
  const steps = new Map([
    [
      "prior",
      {
        input: await args(sourcePair),
        output: await output({ action: "park", ...sourcePair }),
        runId: ownerRunId,
        status: "completed",
        stepId: "prior",
        stepName: TURN_STEP_NAME,
      },
    ],
    [
      "terminal",
      {
        input: await args({ ...sourcePair, input: incoming }),
        runId: ownerRunId,
        status: options.failedTurn === true ? "failed" : "completed",
        stepId: "terminal",
        stepName: TURN_STEP_NAME,
        ...(options.failedTurn === true
          ? { error: { name: "failure" } }
          : { output: await output({ action: "done", ...latestPair }) }),
      },
    ],
    [
      "finalizer",
      {
        input: await args(latestPair),
        runId: ownerRunId,
        status: "completed",
        stepId: "finalizer",
        stepName: "step//eve//terminateChildSessionsStep",
      },
    ],
  ]);
  if (options.historicalFailure === true) {
    steps.set("historical", {
      error: { name: "older failure" },
      input: await args(sourcePair),
      runId: ownerRunId,
      status: "failed",
      stepId: "historical",
      stepName: TURN_STEP_NAME,
    });
  }
  if (options.unreadableLater === true) {
    steps.set("unreadable", {
      output: new Uint8Array([99, 1, 2, 3]),
      runId: ownerRunId,
      status: "completed",
      stepId: "unreadable",
      stepName: TURN_STEP_NAME,
    });
  }
  const event = (slot, eventType, stepId, eventData = {}) => {
    const result = {
      eventData: { ...eventData },
      eventId: eventId(slot),
      eventType,
      runId: ownerRunId,
    };
    if (stepId !== undefined) {
      result.correlationId = stepId;
    }
    if (steps.has(stepId)) {
      result.eventData.stepName = steps.get(stepId).stepName;
    }
    return result;
  };
  const events = [
    ...(options.historicalFailure === true
      ? [event(1, "step_started", "historical"), event(2, "step_failed", "historical")]
      : []),
    event(3, "step_started", "prior"),
    event(4, "step_completed", "prior"),
    event(5, "step_started", "terminal"),
    event(6, options.failedTurn === true ? "step_failed" : "step_completed", "terminal"),
    event(7, "step_started", "finalizer"),
    event(8, "step_completed", "finalizer"),
    ...(options.unreadableLater === true
      ? [event(9, "step_started", "unreadable"), event(10, "step_completed", "unreadable")]
      : []),
    (() => {
      const hook = event(11, "hook_received", "ordinary-hook", {
        payload: { untouchedNativeFact: true },
      });
      if (options.inboxAfterSource === true) {
        hook.eventData.token = `eve:session:${logicalSessionId}:inbox`;
      }
      return hook;
    })(),
    event(12, "run_completed"),
  ];
  const nativeEvents = [
    { data: { ...batchEvent, result: actualRuntimeResult }, type: "action.result" },
    ...(options.uncommittedWrite === true
      ? [
          {
            data: {
              ...emission,
              result: {
                callId: ORIGINAL_NATIVE_CALL_ID,
                kind: TOOL_RESULT_TYPE,
                output: "may-have-written",
                toolName: "native",
              },
            },
            type: "action.result",
          },
        ]
      : []),
    ...(options.uncommittedDispatch === true
      ? [
          {
            data: {
              ...emission,
              actions: [
                {
                  callId: "new-uncommitted-write",
                  input: {},
                  kind: "tool-call",
                  toolName: "native",
                },
              ],
            },
            type: "actions.requested",
          },
        ]
      : []),
    ...(options.cancelled === true
      ? [{ data: { sequence: 1, turnId: TURN_ID }, type: "turn.cancelled" }]
      : []),
  ];
  const world = {
    events: { list: async () => await Promise.resolve({ data: events, hasMore: false }) },
    runs: {
      get: async () =>
        await Promise.resolve({
          input: "original-entry-retained",
          runId: ownerRunId,
          status: options.failedTurn === true ? "failed" : "completed",
        }),
    },
    steps: {
      get: async (runId, id) => {
        assert.equal(runId, ownerRunId);
        return await Promise.resolve(steps.get(id));
      },
    },
  };
  let authorized = false;
  const collect = createTerminalRecoveryCandidateCollector({
    getWorld: async () => await Promise.resolve(world),
    hydrateStepArguments: (...values) => serialization.hydrateStepArguments(...values),
    hydrateStepReturnValue: (...values) => serialization.hydrateStepReturnValue(...values),
    now: () => 0,
    readDurableSession,
    async *readNativeEvents() {
      yield* nativeEvents;
    },
    requireEventSlot: (id) => Number(id.slice(5)),
    resolveRunEncryptionKey: async () => {
      await Promise.resolve();
    },
  });
  const collected = await collect({
    authorizeOwner: async (currentBinding) => {
      assert.deepEqual(currentBinding, { logicalSessionId, ownerRunId });
      assert.ok(Object.isFrozen(currentBinding));
      authorized = true;
      await Promise.resolve();
    },
    binding: { logicalSessionId, ownerRunId },
  });
  assert.equal(collected.kind, "candidate");
  assert.equal(authorized, true);
  return {
    collected,
    events,
    incoming,
    latest,
    latestPair,
    nativeEvents,
    originalGrant,
    source,
    sourcePair,
  };
};

const resumeSynthetic = async (ready, denied) => {
  let executions = 0;
  let requests = 0;
  const durable = readDurableSession(ready.checkpointCore.sessionState);
  const session = {
    ...durable,
    agent: {
      modelReference: { id: "synthetic", provider: "test" },
      system: durable.agent.system,
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 1e6 },
  };
  const tools = new Map([
    [
      "native",
      {
        approval: () => "user-approval",
        execute: (input) => {
          executions += 1;
          assert.equal(input.value, "exact-original-input");
          return "actual-resumed-result";
        },
        inputSchema: z.object({ value: z.string() }),
        name: "native",
      },
    ],
    ["deferred", { inputSchema: z.object({}), name: "deferred", workflowId: DEFERRED_WORKFLOW_ID }],
  ]);
  const model = new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      requests += 1;
      const content = prompt.flatMap((message) =>
        Array.isArray(message.content) ? message.content : [],
      );
      for (const name of ["native", "deferred"]) {
        assert.equal(
          content.filter(
            (part) => part.type === TOOL_RESULT_TYPE && part.toolCallId === `original-${name}`,
          ).length,
          1,
        );
      }
      return await Promise.resolve({
        content: [{ text: "same app continued", type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
        warnings: [],
      });
    },
  });
  const ctx = new ContextContainer();
  const auth = { authenticator: "test", principalId: ORIGINAL_OWNER_ID, principalType: "user" };
  ctx.set(SessionKey, {
    auth: { current: auth, initiator: auth },
    sessionId: logicalSessionId,
    turn: { id: TURN_ID },
  });
  assert.equal(executions, 0);
  const result = await contextStorage.run(ctx, () =>
    createToolLoopHarness({ resolveModel: async () => await Promise.resolve(model), tools })(
      session,
      {
        runtimeActionResults: ready.replayInput.runtimeResults.results,
      },
    ),
  );
  assert.equal(executions, denied === true ? 0 : 1);
  assert.equal(requests, 1);
  const diagnostic = diagnosticRecords.findLast(
    (record) => record.message === "before-model-protocol",
  );
  assert.ok(diagnostic !== undefined);
  assert.equal(diagnostic.fields.sdkBeforeProvider.missingResultCount, 0);
  assert.equal(diagnostic.fields.sdkBeforeProvider.resultParts, 2);
  assert.match(diagnostic.fields.sdkCallHash, /^[a-f0-9]{64}$/u);
  assert.equal(result.session.sessionId, logicalSessionId);
  assert.deepEqual(result.session.sandboxState, session.sandboxState);
};

test("completed handled400 uses exact terminal input, latest typed state, original grant and original logical identity", async () => {
  const f = await fixture();
  const privateBefore = readTerminalRecoveryCandidate(f.collected.candidate);
  const snapshots = structuredClone(privateBefore.candidates);
  const ready = await reconcileTerminalRecoveryCandidate(f.collected.candidate);
  assert.equal(ready.kind, "ready");
  assert.equal(
    ready.replayInput,
    privateBefore.candidates.find((candidate) => candidate.kind === "completed-terminal-turn-input")
      .incoming,
  );
  const recovered = readDurableSession(ready.checkpointCore.sessionState);
  assert.deepEqual(recovered.state["fixture.program"], f.latest.state["fixture.program"]);
  assert.deepEqual(recovered.state["fixture.authority"], f.latest.state["fixture.authority"]);
  assert.deepEqual(recovered.sandboxState, f.latest.sandboxState);
  assert.deepEqual(ready.checkpointCore.serializedContext, f.latestPair.serializedContext);
  assert.equal(ready.provenance.logicalSessionId, logicalSessionId);
  assert.equal(ready.provenance.sourceOwnerRunId, ownerRunId);
  assert.equal(ready.provenance.historySourceOrigin.kind, "completed-terminal-turn-input");
  assert.equal(ready.provenance.frontierEventIds.includes(eventId(11)), true);
  assert.deepEqual(privateBefore.candidates, snapshots);
  await resumeSynthetic(ready, false);
});

test("denial is retained and never executes the denied native call", async () => {
  const f = await fixture({ denied: true });
  const ready = await reconcileTerminalRecoveryCandidate(f.collected.candidate);
  assert.equal(ready.kind, "ready");
  assert.equal(
    readDurableSession(ready.checkpointCore.sessionState).state["fixture.authority"].grant,
    null,
  );
  await resumeSynthetic(ready, true);
});

for (const { options, reason } of [
  { options: { uncommittedWrite: true }, reason: "uncommitted-action-result" },
  { options: { uncommittedDispatch: true }, reason: "uncommitted-action-dispatch" },
  { options: { failedTurn: true }, reason: "failed-turn-effects-unreconciled" },
  { options: { delivery: true }, reason: "delivery-consumption-unreconciled" },
  { options: { missingResult: true }, reason: "coordination-results-incomplete" },
  { options: { cancelled: true }, reason: "cancelled-turn-replay" },
  { options: { unreadableLater: true }, reason: "unreadable-native-effect-frontier" },
  { options: { inboxAfterSource: true }, reason: "unconsumed-native-inbox-input" },
]) {
  test(`uncertain ${reason} never becomes replay permission`, async () => {
    const f = await fixture(options);
    const result = await reconcileTerminalRecoveryCandidate(f.collected.candidate);
    assert.equal(result.kind, "uncertain");
    assert.equal(result.reason, reason);
  });
}

test("historical failed step covered by a later committed turn does not block known latest state", async () => {
  const f = await fixture({ historicalFailure: true });
  const result = await reconcileTerminalRecoveryCandidate(f.collected.candidate);
  assert.equal(result.kind, "ready");
  assert.equal(result.provenance.coveredNativeEventIds.includes(eventId(2)), true);
});

test("diagnostic never serializes prompts, tool names, arguments, outputs or provider metadata", () => {
  const secret = PRIVATE_CONTENT;
  const messages = [
    { content: secret, role: "user" },
    {
      content: [
        {
          input: { secret },
          providerOptions: { openai: { secret } },
          toolCallId: OPAQUE_CALL_ID,
          toolName: secret,
          type: TOOL_CALL_TYPE,
        },
        {
          approvalId: OPAQUE_APPROVAL_ID,
          toolCallId: OPAQUE_CALL_ID,
          type: TOOL_APPROVAL_REQUEST_TYPE,
        },
      ],
      role: "assistant",
    },
    {
      content: [
        { approvalId: OPAQUE_APPROVAL_ID, approved: true, type: TOOL_APPROVAL_RESPONSE_TYPE },
      ],
      role: "tool",
    },
    {
      content: [
        {
          output: { type: "text", value: secret },
          toolCallId: "another-call",
          toolName: secret,
          type: TOOL_RESULT_TYPE,
        },
      ],
      role: "tool",
    },
  ];
  const before = structuredClone(messages);
  const summary = summarizeModelProtocol(messages);
  assert.equal(summary.missingResultCount, 1);
  assert.equal(summary.orphanResultCount, 1);
  assert.equal(summary.terminalApprovedResponseCount, 1);
  assert.equal(
    summary.sample.find((value) => value.idHash === protocolIdentityHash(OPAQUE_CALL_ID))
      .resultCount,
    0,
  );
  const serialized = JSON.stringify(summary);
  for (const forbidden of [secret, OPAQUE_CALL_ID, OPAQUE_APPROVAL_ID, "another-call"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.deepEqual(messages, before);
  const many = Array.from({ length: 40 }, (_, index) => ({
    content: [
      { input: { secret }, toolCallId: `private-${index}`, toolName: secret, type: TOOL_CALL_TYPE },
    ],
    role: "assistant",
  }));
  const bounded = summarizeModelProtocol(many);
  assert.equal(bounded.missingResultCount, 40);
  assert.equal(bounded.sample.length, 12);
  assert.equal(bounded.omittedIdentityCount, 28);
});

test("diagnostic exception is advisory and does not escape", () => {
  assert.doesNotThrow(() =>
    recordModelProtocolDiagnostic({
      get logicalSessionId() {
        throw new Error("private exception");
      },
    }),
  );
});

test("actual SDK exposes retained mixed orphan without inventing or replaying its uncertain native output", async () => {
  const history = [
    { content: "private brief", kind: "user", role: "user" },
    {
      content: [
        {
          input: { value: "private-input" },
          toolCallId: MIXED_NATIVE_CALL_ID,
          toolName: NATIVE_TOOL_NAME,
          type: TOOL_CALL_TYPE,
        },
        { input: {}, toolCallId: "mixed-deferred", toolName: "deferred", type: "tool-call" },
        {
          approvalId: "mixed-approval",
          toolCallId: MIXED_NATIVE_CALL_ID,
          type: TOOL_APPROVAL_REQUEST_TYPE,
        },
      ],
      role: "assistant",
    },
    {
      content: [
        { approvalId: "mixed-approval", approved: true, type: TOOL_APPROVAL_RESPONSE_TYPE },
      ],
      role: "tool",
    },
    {
      content: [
        {
          output: { type: "text", value: "actual saved deferred outcome" },
          toolCallId: "mixed-deferred",
          toolName: "deferred",
          type: TOOL_RESULT_TYPE,
        },
      ],
      role: "tool",
    },
  ];
  const before = structuredClone(history);
  let executions = 0;
  let requests = 0;
  const tools = new Map([
    [
      "native",
      {
        approval: () => "user-approval",
        execute: () => {
          executions += 1;
          return "must not invent output";
        },
        inputSchema: z.object({ value: z.string() }),
        name: "native",
      },
    ],
    ["deferred", { inputSchema: z.object({}), name: "deferred", workflowId: DEFERRED_WORKFLOW_ID }],
  ]);
  const model = new MockLanguageModelV4({
    doGenerate: ({ prompt }) => {
      requests += 1;
      const summary = summarizeModelProtocol(prompt);
      assert.equal(summary.missingResultCount, 1);
      return {
        content: [{ text: "synthetic only", type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
        warnings: [],
      };
    },
  });
  const session = {
    agent: {
      modelReference: { id: "synthetic", provider: "test" },
      system: "private-system",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 1e6 },
    continuationToken: "private-token",
    history,
    rootSessionId: logicalSessionId,
    sessionId: logicalSessionId,
    state: { "eve.harness.emission": emission },
  };
  const ctx = new ContextContainer();
  const auth = { authenticator: "test", principalId: "owner", principalType: "user" };
  ctx.set(SessionKey, {
    auth: { current: auth, initiator: auth },
    sessionId: logicalSessionId,
    turn: { id: TURN_ID },
  });
  await contextStorage.run(ctx, () =>
    createToolLoopHarness({ resolveModel: () => model, tools })(session),
  );
  assert.equal(requests, 1);
  assert.equal(executions, 0);
  const diagnostic = diagnosticRecords.findLast(
    (record) => record.message === "before-model-protocol",
  );
  assert.equal(diagnostic.fields.canonical.missingResultCount, 1);
  assert.equal(diagnostic.fields.sdkInput.missingResultCount, 1);
  assert.equal(diagnostic.fields.sdkBeforeProvider.missingResultCount, 1);
  const missing = diagnostic.fields.sdkBeforeProvider.sample.find(
    (value) => value.idHash === protocolIdentityHash(MIXED_NATIVE_CALL_ID),
  );
  assert.equal(missing.callCount, 1);
  assert.equal(missing.resultCount, 0);
  assert.deepEqual(history, before);
});

test("a mixed orphan without trusted repeatability remains uncertain and retains diagnostic evidence", async () => {
  const f = await fixture({ mixedStorage: true });
  const result = await reconcileTerminalRecoveryCandidate(f.collected.candidate);
  assert.equal(result.kind, "uncertain");
  assert.equal(result.reason, "uncommitted-action-dispatch");
  const summary = summarizeModelProtocol(f.latest.history);
  assert.equal(summary.missingResultCount, 1);
  assert.equal(
    summary.sample.find((value) => value.idHash === protocolIdentityHash(ORIGINAL_NATIVE_CALL_ID))
      .resultCount,
    0,
  );
  const diagnostic = diagnosticRecords.findLast((record) => record.message === "recovery-protocol");
  assert.equal(diagnostic.fields.outcomeHash, protocolIdentityHash("uncertain"));
  assert.equal(diagnostic.fields.latest.missingResultCount, 1);
  assert.equal(diagnostic.fields.reconciled.callParts, 0);
  assert.equal(diagnostic.fields.latestCoordination.callParts, 0);
  assert.equal(
    diagnostic.fields.nativeResults.sample.some(
      (value) => value.idHash === protocolIdentityHash(ORIGINAL_NATIVE_CALL_ID),
    ),
    false,
  );
});
