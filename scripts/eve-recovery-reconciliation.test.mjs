/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument -- This fixture imports installed compiled Eve internals by package path; their private module declarations are not public exports. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";

const require = createRequire(import.meta.url);
const eve = path.dirname(require.resolve("eve/package.json"));
const load = (name) => import(pathToFileURL(path.join(eve, "dist/src", name)).href);
const { createTerminalRecoveryCandidateCollector, readTerminalRecoveryCandidate } = await load(
  "execution/session/recovery-candidate.js",
);
const { reconcileTerminalRecoveryCandidate } = await load(
  "execution/session/recovery-reconciliation.js",
);
const { createDurableSessionState, readDurableSession } = await load(
  "execution/durable-session-store.js",
);
const { setPendingCoordinationBatch, resolvePendingCoordination } =
  await load("harness/coordination.js");
const serialization = await load("compiled/@workflow/core/serialization.js");
const { ContextContainer, contextStorage } = await load("context/container.js");
const { SessionKey } = await load("context/keys.js");
const { createToolLoopHarness } = await load("harness/tool-loop.js");
const { MockLanguageModelV4 } = await import("ai/test");
const { z } = await import("zod");
const ownerRunId = "wrun_physical_original";
const logicalSessionId = "wrun_logical_original";
const eventId = (slot) => `evnt_${String(slot).padStart(26, "0")}`;
const batchEvent = { sequence: 1, stepIndex: 1, turnId: "turn-original" };
const emission = { sessionStarted: true, sequence: 1, stepIndex: 2, turnId: "turn-original" };
const actualRuntimeResult = {
  kind: "tool-result",
  callId: "original-deferred",
  toolName: "deferred",
  output: { value: "actual-native-outcome" },
};

const fixture = async (options = {}) => {
  const originalGrant = {
    sessionId: logicalSessionId,
    workspaceId: "original-private-workspace",
    appSpecDigest: "original-spec",
    proposalDigest: "original-proposal",
  };
  let source = {
    sessionId: logicalSessionId,
    continuationToken: "original-continuation",
    rootSessionId: logicalSessionId,
    agent: {
      system: "original prompt",
      tools: [],
      modelReference: { id: "synthetic", provider: "test" },
    },
    compaction: { threshold: 1e6, recentWindowSize: 10 },
    state: {
      "eve.harness.emission": emission,
      "eve.runtime.hitl.approvedTools": options.denied === true ? [] : ["native"],
      "fixture.authority": {
        grant: options.denied === true ? null : originalGrant,
        pending: [{ callId: "original-native", scope: originalGrant }],
      },
      "fixture.program": { phase: "source-planned", arbitraryNestedState: { keep: true } },
    },
    sandboxState: {
      session: {
        providerName: "vercel",
        stateProtocolVersion: 1,
        state: { name: "original-sandbox", workspaceDrive: { id: "original-drive" } },
      },
    },
    history: [
      { role: "user", kind: "user", content: "Original product brief" },
      {
        role: "tool",
        content: [
          {
            type: "tool-approval-response",
            approvalId: "original-request",
            approved: options.denied !== true,
          },
          ...(options.denied === true
            ? [
                {
                  type: "tool-result",
                  toolCallId: "original-native",
                  toolName: "native",
                  output: { type: "execution-denied", reason: "original denial" },
                },
              ]
            : []),
        ],
      },
    ],
  };
  source = setPendingCoordinationBatch({
    session: source,
    event: batchEvent,
    runtimeActions: [],
    tasks: [
      {
        kind: "workflow-task",
        callId: "original-deferred",
        toolName: "deferred",
        input: {},
        workflowId: "workflow:deferred",
      },
    ],
    responseMessages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "original-native",
            toolName: "native",
            input: { value: "exact-original-input" },
          },
          { type: "tool-call", toolCallId: "original-deferred", toolName: "deferred", input: {} },
          {
            type: "tool-approval-request",
            approvalId: "original-request",
            toolCallId: "original-native",
          },
        ],
      },
    ],
  });
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
      "fixture.program": { phase: "latest-committed", arbitraryNestedState: { keep: true } },
    },
  };
  const sourcePair = {
    serializedContext: {
      "eve.sessionId": logicalSessionId,
      "eve.auth": { principalId: "original-owner" },
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
    ...(options.delivery === true
      ? {
          delivery: {
            kind: "deliver",
            auth: { principalId: "original-owner" },
            payloads: [{ message: "already admitted" }],
          },
        }
      : {}),
  };
  const args = (value) =>
    serialization.dehydrateStepArguments({ args: [value], closureVars: [] }, ownerRunId);
  const output = (value) => serialization.dehydrateStepReturnValue(value, ownerRunId);
  const steps = new Map([
    [
      "prior",
      {
        runId: ownerRunId,
        stepId: "prior",
        stepName: "step//eve//turnStep",
        status: "completed",
        input: await args(sourcePair),
        output: await output({ action: "park", ...sourcePair }),
      },
    ],
    [
      "terminal",
      {
        runId: ownerRunId,
        stepId: "terminal",
        stepName: "step//eve//turnStep",
        status: options.failedTurn === true ? "failed" : "completed",
        input: await args({ ...sourcePair, input: incoming }),
        ...(options.failedTurn === true
          ? { error: { name: "failure" } }
          : { output: await output({ action: "done", ...latestPair }) }),
      },
    ],
    [
      "finalizer",
      {
        runId: ownerRunId,
        stepId: "finalizer",
        stepName: "step//eve//terminateChildSessionsStep",
        status: "completed",
        input: await args(latestPair),
      },
    ],
  ]);
  if (options.historicalFailure === true) {
    steps.set("historical", {
      runId: ownerRunId,
      stepId: "historical",
      stepName: "step//eve//turnStep",
      status: "failed",
      input: await args(sourcePair),
      error: { name: "older failure" },
    });
  }
  if (options.unreadableLater === true) {
    steps.set("unreadable", {
      runId: ownerRunId,
      stepId: "unreadable",
      stepName: "step//eve//turnStep",
      status: "completed",
      output: new Uint8Array([99, 1, 2, 3]),
    });
  }
  const event = (slot, eventType, stepId, eventData = {}) => ({
    runId: ownerRunId,
    eventId: eventId(slot),
    eventType,
    ...(stepId === undefined ? {} : { correlationId: stepId }),
    eventData: {
      ...(steps.has(stepId) ? { stepName: steps.get(stepId).stepName } : {}),
      ...eventData,
    },
  });
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
    event(11, "hook_received", "ordinary-hook", {
      ...(options.inboxAfterSource === true
        ? { token: `eve:session:${logicalSessionId}:inbox` }
        : {}),
      payload: { untouchedNativeFact: true },
    }),
    event(12, "run_completed"),
  ];
  const nativeEvents = [
    { type: "action.result", data: { ...batchEvent, result: actualRuntimeResult } },
    ...(options.uncommittedWrite === true
      ? [
          {
            type: "action.result",
            data: {
              ...emission,
              result: {
                kind: "tool-result",
                callId: "original-native",
                toolName: "native",
                output: "may-have-written",
              },
            },
          },
        ]
      : []),
    ...(options.uncommittedDispatch === true
      ? [
          {
            type: "actions.requested",
            data: {
              ...emission,
              actions: [
                {
                  callId: "new-uncommitted-write",
                  kind: "tool-call",
                  toolName: "native",
                  input: {},
                },
              ],
            },
          },
        ]
      : []),
    ...(options.cancelled === true
      ? [{ type: "turn.cancelled", data: { sequence: 1, turnId: "turn-original" } }]
      : []),
  ];
  const world = {
    runs: {
      get: async () =>
        await Promise.resolve({
          runId: ownerRunId,
          status: options.failedTurn === true ? "failed" : "completed",
          input: "original-entry-retained",
        }),
    },
    events: { list: async () => await Promise.resolve({ data: events, hasMore: false }) },
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
    resolveRunEncryptionKey: async () => {
      await Promise.resolve();
    },
    hydrateStepArguments: (...values) => serialization.hydrateStepArguments(...values),
    hydrateStepReturnValue: (...values) => serialization.hydrateStepReturnValue(...values),
    readDurableSession,
    requireEventSlot: (id) => Number(id.slice(5)),
    now: () => 0,
    async *readNativeEvents() {
      yield* nativeEvents;
    },
  });
  const collected = await collect({
    binding: { ownerRunId, logicalSessionId },
    authorizeOwner: async (currentBinding) => {
      assert.deepEqual(currentBinding, { ownerRunId, logicalSessionId });
      assert.ok(Object.isFrozen(currentBinding));
      authorized = true;
      await Promise.resolve();
    },
  });
  assert.equal(collected.kind, "candidate");
  assert.equal(authorized, true);
  return {
    collected,
    source,
    latest,
    sourcePair,
    latestPair,
    originalGrant,
    incoming,
    events,
    nativeEvents,
  };
};

const resumeSynthetic = async (ready, denied) => {
  let executions = 0;
  let requests = 0;
  const durable = readDurableSession(ready.checkpointCore.sessionState);
  const session = {
    ...durable,
    agent: {
      system: durable.agent.system,
      tools: [],
      modelReference: { id: "synthetic", provider: "test" },
    },
    compaction: { threshold: 1e6, recentWindowSize: 10 },
  };
  const tools = new Map([
    [
      "native",
      {
        name: "native",
        inputSchema: z.object({ value: z.string() }),
        approval: () => "user-approval",
        execute: (input) => {
          executions += 1;
          assert.equal(input.value, "exact-original-input");
          return "actual-resumed-result";
        },
      },
    ],
    ["deferred", { name: "deferred", inputSchema: z.object({}), workflowId: "workflow:deferred" }],
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
            (part) => part.type === "tool-result" && part.toolCallId === `original-${name}`,
          ).length,
          1,
        );
      }
      return await Promise.resolve({
        content: [{ type: "text", text: "same app continued" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
        warnings: [],
      });
    },
  });
  const ctx = new ContextContainer();
  const auth = { authenticator: "test", principalId: "original-owner", principalType: "user" };
  ctx.set(SessionKey, {
    sessionId: logicalSessionId,
    auth: { current: auth, initiator: auth },
    turn: { id: "turn-original" },
  });
  assert.equal(executions, 0);
  const result = await contextStorage.run(ctx, () =>
    createToolLoopHarness({ tools, resolveModel: async () => await Promise.resolve(model) })(
      session,
      {
        runtimeActionResults: ready.replayInput.runtimeResults.results,
      },
    ),
  );
  assert.equal(executions, denied === true ? 0 : 1);
  assert.equal(requests, 1);
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
