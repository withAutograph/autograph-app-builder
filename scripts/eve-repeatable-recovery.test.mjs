/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument -- This fixture imports installed compiled Eve internals by private package path. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { ToolLoopAgent, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { authorizeRepeatablePrivateApplyCalls } from "../lib/eve/native-recovery-repeatable-apply.ts";

const TOOL_RESULT_TYPE = "tool-result";
const ORIGINAL_INPUT_VALUE = "original-input";
const ORIGINAL_TURN_ID = "original-turn";

const require = createRequire(import.meta.url);
const eve = path.dirname(require.resolve("eve/package.json"));
// oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
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
const { setPendingCoordinationBatch } = await load("harness/coordination.js");
const { appendPendingInputBatch } = await load("harness/pending-input-batches.js");
const serialization = await load("compiled/@workflow/core/serialization.js");
const { summarizeModelProtocol } = await load("harness/model-protocol-diagnostic.js");
const logical = "logical-session";
const owner = "physical-owner";
const callId = "native-call";
const result = {
  type: TOOL_RESULT_TYPE,
  toolCallId: "deferred-call",
  toolName: "deferred",
  output: { type: "text", value: "actual-deferred-result" },
};
const approval = (approved = true) => ({
  type: "tool-approval-response",
  approvalId: "native-approval",
  approved,
});
const history = (tail = "mixed", approved = true) => [
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: callId,
        toolName: "native",
        input: { value: ORIGINAL_INPUT_VALUE },
      },
      { type: "tool-approval-request", approvalId: "native-approval", toolCallId: callId },
      { type: "tool-call", toolCallId: "deferred-call", toolName: "deferred", input: {} },
    ],
  },
  ...(tail === "mixed"
    ? [
        { role: "tool", content: [approval(approved)] },
        { role: "tool", content: [result] },
      ]
    : [{ role: "tool", content: [approval(approved), result] }]),
];
const fixture = async (options = {}) => {
  let session = {
    sessionId: logical,
    continuationToken: "original-continuation",
    rootSessionId: logical,
    agent: {
      system: "Original brief",
      tools: [],
      modelReference: { id: "synthetic", provider: "test" },
    },
    compaction: { threshold: 1e6, recentWindowSize: 10 },
    state: {
      "fixture.grant": { original: true, cancelled: false },
      "fixture.app": { exact: "latest-app" },
      "eve.harness.emission": {
        sessionStarted: true,
        sequence: 5,
        stepIndex: 4,
        turnId: ORIGINAL_TURN_ID,
      },
    },
    history: options.history ?? history(),
  };
  if (options.pending === "coordination") {
    session = setPendingCoordinationBatch({
      session,
      runtimeActions: [],
      tasks: [
        {
          kind: "workflow-task",
          callId,
          toolName: "native",
          input: { value: ORIGINAL_INPUT_VALUE },
          workflowId: "workflow:native",
        },
      ],
      responseMessages: [],
      event: { sequence: 5, stepIndex: 4, turnId: ORIGINAL_TURN_ID },
    });
  }
  if (options.pending === "human") {
    session = appendPendingInputBatch({
      session,
      responseMessages: [],
      requests: [
        {
          requestId: "request",
          action: {
            kind: "tool-call",
            callId,
            toolName: "native",
            input: { value: ORIGINAL_INPUT_VALUE },
          },
        },
      ],
      event: { sequence: 5, stepIndex: 4, turnId: ORIGINAL_TURN_ID },
    });
  }
  const pair = {
    sessionState: createDurableSessionState({ session }),
    serializedContext: {
      "eve.sessionId": logical,
      "fixture.authority": { exact: "original-owner" },
      ...options.context,
    },
  };
  const step = {
    runId: owner,
    stepId: "finalizer",
    stepName: "step//eve//terminateChildSessionsStep",
    status: "completed",
    input: await serialization.dehydrateStepArguments({ args: [pair], closureVars: [] }, owner),
  };
  const world = {
    events: {
      // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
      list: () =>
        Promise.resolve({
          data: [
            {
              runId: owner,
              eventId: "evnt_00000000000000000000000002",
              correlationId: step.stepId,
              eventType: "step_completed",
              eventData: { stepName: step.stepName },
            },
          ],
          hasMore: false,
        }),
    },
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    runs: { get: () => Promise.resolve({ runId: owner, status: "completed" }) },
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    steps: { get: () => Promise.resolve(step) },
  };
  const collect = createTerminalRecoveryCandidateCollector({
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    getWorld: () => Promise.resolve(world),
    hydrateStepArguments: (value, runId, key) =>
      serialization.hydrateStepArguments(value, runId, key, []),
    hydrateStepReturnValue: (value, runId, key) =>
      serialization.hydrateStepReturnValue(value, runId, key),
    now: () => 0,
    readDurableSession,
    async *readNativeEvents() {
      yield* options.nativeEvents ?? [];
    },
    requireEventSlot: (id) => Number(id.slice(5)),
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    resolveRunEncryptionKey: () => Promise.resolve(),
  });
  const collected = await collect({
    binding: { ownerRunId: owner, logicalSessionId: logical },
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    authorizeOwner: () => Promise.resolve(),
  });
  assert.equal(collected.kind, "candidate");
  const payload = readTerminalRecoveryCandidate(collected.candidate);
  return { handle: collected.candidate, pair, payload };
};
const runNextModel = async (ready) => {
  const session = readDurableSession(ready.checkpointCore.sessionState);
  let executions = 0;
  let requests = 0;
  const model = new MockLanguageModelV4({
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    doGenerate: ({ prompt }) => {
      requests += 1;
      const summary = summarizeModelProtocol(prompt);
      assert.equal(summary.missingResultCount, 0);
      return Promise.resolve({
        content: [{ type: "text", text: "continued" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
        warnings: [],
      });
    },
  });
  const nativeTool = tool({
    inputSchema: z.object({ value: z.string() }),
    execute: (value) => {
      executions += 1;
      assert.equal(value.value, ORIGINAL_INPUT_VALUE);
      return "actual-native-output";
    },
  });
  const agent = new ToolLoopAgent({
    model,
    tools: {
      apply_app_creation: nativeTool,
      native: tool({
        inputSchema: z.object({ value: z.string() }),
        execute: (value) => {
          executions += 1;
          assert.equal(value.value, ORIGINAL_INPUT_VALUE);
          return "actual-native-output";
        },
      }),
      deferred: tool({ inputSchema: z.object({}) }),
    },
  });
  await agent.generate({ messages: session.history });
  return { executions, requests };
};

test("mixed retained call/approval/deferred result is uncertain before any invalid model dispatch", async () => {
  const f = await fixture();
  const before = JSON.stringify(f.payload);
  const reconciled = await reconcileTerminalRecoveryCandidate(f.handle);
  assert.deepEqual(reconciled, {
    callId,
    kind: "uncertain",
    reason: "uncommitted-action-dispatch",
  });
  assert.equal(JSON.stringify(f.payload), before);
});

test("a genuine result already retained pairs the call and is not executed again", async () => {
  const messages = history();
  messages.at(-1).content.push({
    type: TOOL_RESULT_TYPE,
    toolCallId: callId,
    toolName: "native",
    output: { type: "text", value: "real-retained-native-output" },
    providerOptions: { openai: { itemId: "retained-provider-metadata" } },
  });
  const f = await fixture({ history: messages });
  const ready = await reconcileTerminalRecoveryCandidate(f.handle);
  assert.equal(ready.kind, "ready");
  assert.deepEqual(ready.checkpointCore, f.pair);
  assert.deepEqual(await runNextModel(ready), { executions: 0, requests: 1 });
});

test("legitimate final-tool-message native approval still executes exactly once before next model", async () => {
  const f = await fixture({ history: history("final") });
  const ready = await reconcileTerminalRecoveryCandidate(f.handle);
  assert.equal(ready.kind, "ready");
  assert.deepEqual(ready.checkpointCore, f.pair);
  assert.deepEqual(await runNextModel(ready), { executions: 1, requests: 1 });
});

test("legitimate final-tool-message denial stays denied and paired without executing", async () => {
  const f = await fixture({ history: history("final", false) });
  const ready = await reconcileTerminalRecoveryCandidate(f.handle);
  assert.equal(ready.kind, "ready");
  assert.deepEqual(await runNextModel(ready), { executions: 0, requests: 1 });
});

test("provider-executed calls are not mistaken for unresolved local execution", async () => {
  const messages = history();
  messages[0].content[0].providerExecuted = true;
  const f = await fixture({ history: messages });
  const ready = await reconcileTerminalRecoveryCandidate(f.handle);
  assert.equal(ready.kind, "ready");
  assert.deepEqual(ready.checkpointCore, f.pair);
});

for (const pending of ["human", "coordination"]) {
  test(`actual pending ${pending} settlement remains owned by normal native continuation`, async () => {
    const f = await fixture({ pending });
    const ready = await reconcileTerminalRecoveryCandidate(f.handle);
    assert.equal(ready.kind, "ready");
    assert.deepEqual(ready.checkpointCore, f.pair);
  });
}

test("emitted native result alone never becomes a committed result or permission to replay", async () => {
  const f = await fixture({
    history: history("final"),
    nativeEvents: [
      {
        type: "action.result",
        data: {
          sequence: 1,
          stepIndex: 1,
          result: {
            kind: TOOL_RESULT_TYPE,
            callId,
            toolName: "native",
            output: "actual-but-uncommitted-output",
          },
        },
      },
    ],
  });
  const before = JSON.stringify(f.payload);
  assert.deepEqual(await reconcileTerminalRecoveryCandidate(f.handle), {
    callId,
    kind: "uncertain",
    reason: "uncommitted-action-result",
  });
  assert.equal(JSON.stringify(f.payload), before);
});

test("only the trusted exact repeatable call restores its genuine approval tail and actual SDK output", async () => {
  const messages = [
    ...history(),
    { role: "assistant", content: [{ type: "text", text: "terminal framework context" }] },
  ];
  messages[1].providerOptions = { fixture: { original: "metadata" } };
  messages[1].content[0].providerOptions = { fixture: { signature: "retained" } };
  const f = await fixture({ history: messages });
  const before = structuredClone(f.pair);
  const ready = await reconcileTerminalRecoveryCandidate(f.handle, { repeatableCallIds: [callId] });
  assert.equal(ready.kind, "ready");
  assert.deepEqual(ready.checkpointCore.serializedContext, before.serializedContext);
  const session = readDurableSession(ready.checkpointCore.sessionState);
  assert.deepEqual(session.state, readDurableSession(before.sessionState).state);
  assert.deepEqual(session.history.at(-1).content, messages[1].content);
  assert.deepEqual(session.history.at(-1).providerOptions, messages[1].providerOptions);
  assert.deepEqual(session.history.slice(0, -1), [messages[0], messages[2], messages[3]]);
  assert.deepEqual(f.pair, before);
  assert.deepEqual(await runNextModel(ready), { executions: 1, requests: 1 });
});

for (const mode of [
  "wrong-id",
  "denied",
  "duplicate-response",
  "duplicate-call",
  "native-result",
]) {
  test(`repeatable recovery does not grant replay for ${mode}`, async () => {
    const messages = history("mixed", mode !== "denied");
    if (mode === "duplicate-response") {
      messages[1].content.push(approval());
    }
    if (mode === "duplicate-call") {
      messages[0].content.push({ ...messages[0].content[0] });
    }
    const f = await fixture({
      history: messages,
      nativeEvents:
        mode === "native-result"
          ? [
              {
                type: "action.result",
                data: { sequence: 1, stepIndex: 1, result: { callId, output: "genuine outcome" } },
              },
            ]
          : [],
    });
    const ready = await reconcileTerminalRecoveryCandidate(f.handle, {
      repeatableCallIds: [mode === "wrong-id" ? "other" : callId],
    });
    assert.equal(ready.kind, "uncertain");
  });
}

test("trusted Builder call contract flows through actual native prepare and reconciler to the actual SDK result", async () => {
  const scope = {
    appId: "app",
    appSpecDigest: "spec",
    proposalDigest: "proposal",
    workspaceId: "workspace",
    sessionId: logical,
  };
  const messages = [...history(), { role: "assistant", content: "terminal context" }];
  messages[0].content[0].toolName = "apply_app_creation";
  const f = await fixture({
    history: messages,
    context: {
      "autograph-app-builder.private-apply-authority.v1": {
        grant: null,
        pending: [{ callId, scope }],
      },
      "autograph-app-builder.workflow.v17": {
        phase: "planned",
        appSpec: { digest: "spec" },
        proposal: { digest: "proposal", target: { contract: { appId: "app" } } },
        workspace: { workspaceId: "workspace" },
      },
    },
  });
  const { recoverTerminalSession } = await load("execution/session/terminal-recovery.js");
  const descriptor = {
    version: 1,
    operationId: "new-operation",
    sourcePublicSessionId: "failed-public-child",
    sourceOwnerRunId: owner,
    sourceAdapterGeneration: 1,
    logicalSessionId: logical,
    originalAuthoritySessionId: "original-public",
    parentCancellationRevision: 0,
  };
  const [selected] = f.payload.candidates;
  const binding = {
    ...descriptor,
    ownerRunId: "new-physical-child",
    provenance: {
      kind: selected.kind,
      sourceStepId: selected.origin.stepId,
      sourceEventId: selected.origin.eventId,
      sourceSlot: selected.origin.slot,
      checkpointVersion: 1,
    },
  };
  let receipt;
  let hook;
  let checkpoint;
  let starts = 0;
  let contractReads = 0;
  const accepted = await recoverTerminalSession(
    {
      descriptor,
      auth: { authenticator: "fixture", principalType: "user", principalId: "owner" },
      ports: {
        // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
        authorize: () => Promise.resolve(),
        // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
        readReceipt: () => Promise.resolve(receipt),
        // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
        commitReceipt: ({ recoveryBinding }) => {
          receipt = recoveryBinding;
          return Promise.resolve(receipt);
        },
        // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
        authorizeRepeatableRecoveryCalls: (input) => {
          contractReads += 1;
          return Promise.resolve(authorizeRepeatablePrivateApplyCalls(input));
        },
      },
    },
    {
      collect: async ({ binding: source, authorizeOwner }) => {
        await authorizeOwner(source);
        return { candidate: f.handle, kind: "candidate" };
      },
      readCandidate: readTerminalRecoveryCandidate,
      reconcile: reconcileTerminalRecoveryCandidate,
      // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
      readEntry: () =>
        Promise.resolve({ checkpoint: { sessionTimeoutMs: false }, kind: "handoff" }),
      // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
      start: (input) => {
        starts += 1;
        ({ checkpoint } = input);
        hook = {
          runId: binding.ownerRunId,
          metadata: Promise.resolve({ recoveryBinding: binding }),
        };
        return Promise.resolve();
      },
      // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
      getHook: () =>
        hook === undefined ? Promise.reject(new Error("missing hook")) : Promise.resolve(hook),
      isHookNotFound: (error) => error.message === "missing hook",
      now: () => 0,
      // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
      wait: () => Promise.reject(new Error("unexpected wait")),
    },
  );
  assert.equal(accepted.kind, "accepted");
  assert.equal(starts, 1);
  assert.equal(contractReads, 1);
  assert.deepEqual(checkpoint.serializedContext, f.pair.serializedContext);
  assert.deepEqual(await runNextModel({ checkpointCore: checkpoint }), {
    executions: 1,
    requests: 1,
  });
});
