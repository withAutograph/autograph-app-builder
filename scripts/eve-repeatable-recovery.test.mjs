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
const { setPendingCoordinationBatch } = await load("harness/coordination.js");
const { appendPendingInputBatch } = await load("harness/pending-input-batches.js");
const serialization = await load("compiled/@workflow/core/serialization.js");
const { summarizeModelProtocol } = await load("harness/model-protocol-diagnostic.js");
const logical = "logical-session";
const owner = "physical-owner";
const callId = "native-call";
const result = {
  output: { type: "text", value: "actual-deferred-result" },
  toolCallId: "deferred-call",
  toolName: "deferred",
  type: "tool-result",
};
const approval = (approved = true) => ({
  approvalId: "native-approval",
  approved,
  type: "tool-approval-response",
});
const history = (tail = "mixed", approved = true) => [
  {
    content: [
      {
        input: { value: "original-input" },
        toolCallId: callId,
        toolName: "native",
        type: "tool-call",
      },
      { approvalId: "native-approval", toolCallId: callId, type: "tool-approval-request" },
      { input: {}, toolCallId: "deferred-call", toolName: "deferred", type: "tool-call" },
    ],
    role: "assistant",
  },
  ...(tail === "mixed"
    ? [
        { content: [approval(approved)], role: "tool" },
        { content: [result], role: "tool" },
      ]
    : [{ content: [approval(approved), result], role: "tool" }]),
];
const fixture = async (options = {}) => {
  let session = {
    agent: {
      modelReference: { id: "synthetic", provider: "test" },
      system: "Original brief",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 1e6 },
    continuationToken: "original-continuation",
    history: options.history ?? history(),
    rootSessionId: logical,
    sessionId: logical,
    state: {
      "eve.harness.emission": {
        sequence: 5,
        sessionStarted: true,
        stepIndex: 4,
        turnId: "original-turn",
      },
      "fixture.app": { exact: "latest-app" },
      "fixture.grant": { cancelled: false, original: true },
    },
  };
  if (options.pending === "coordination") {
    session = setPendingCoordinationBatch({
      event: { sequence: 5, stepIndex: 4, turnId: "original-turn" },
      responseMessages: [],
      runtimeActions: [],
      session,
      tasks: [
        {
          callId,
          input: { value: "original-input" },
          kind: "workflow-task",
          toolName: "native",
          workflowId: "workflow:native",
        },
      ],
    });
  }
  if (options.pending === "human") {
    session = appendPendingInputBatch({
      event: { sequence: 5, stepIndex: 4, turnId: "original-turn" },
      requests: [
        {
          action: {
            callId,
            input: { value: "original-input" },
            kind: "tool-call",
            toolName: "native",
          },
          requestId: "request",
        },
      ],
      responseMessages: [],
      session,
    });
  }
  const pair = {
    serializedContext: {
      "eve.sessionId": logical,
      "fixture.authority": { exact: "original-owner" },
      ...options.context,
    },
    sessionState: createDurableSessionState({ session }),
  };
  const step = {
    input: await serialization.dehydrateStepArguments({ args: [pair], closureVars: [] }, owner),
    runId: owner,
    status: "completed",
    stepId: "finalizer",
    stepName: "step//eve//terminateChildSessionsStep",
  };
  const world = {
    events: {
      list: async () => ({
        data: [
          {
            correlationId: step.stepId,
            eventData: { stepName: step.stepName },
            eventId: "evnt_00000000000000000000000002",
            eventType: "step_completed",
            runId: owner,
          },
        ],
        hasMore: false,
      }),
    },
    runs: { get: async () => ({ runId: owner, status: "completed" }) },
    steps: { get: async () => step },
  };
  const collect = createTerminalRecoveryCandidateCollector({
    getWorld: async () => world,
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
    resolveRunEncryptionKey: async () => {},
  });
  const collected = await collect({
    authorizeOwner: async () => {},
    binding: { logicalSessionId: logical, ownerRunId: owner },
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
    doGenerate: async ({ prompt }) => {
      requests += 1;
      const summary = summarizeModelProtocol(prompt);
      assert.equal(summary.missingResultCount, 0);
      return {
        content: [{ text: "continued", type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
        warnings: [],
      };
    },
  });
  const nativeTool = tool({
    execute: (value) => {
      executions += 1;
      assert.equal(value.value, "original-input");
      return "actual-native-output";
    },
    inputSchema: z.object({ value: z.string() }),
  });
  const agent = new ToolLoopAgent({
    model,
    tools: {
      apply_app_creation: nativeTool,
      deferred: tool({ inputSchema: z.object({}) }),
      native: tool({
        execute: (value) => {
          executions += 1;
          assert.equal(value.value, "original-input");
          return "actual-native-output";
        },
        inputSchema: z.object({ value: z.string() }),
      }),
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
    output: { type: "text", value: "real-retained-native-output" },
    providerOptions: { openai: { itemId: "retained-provider-metadata" } },
    toolCallId: callId,
    toolName: "native",
    type: "tool-result",
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
        data: {
          result: {
            callId,
            kind: "tool-result",
            output: "actual-but-uncommitted-output",
            toolName: "native",
          },
          sequence: 1,
          stepIndex: 1,
        },
        type: "action.result",
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
    { content: [{ text: "terminal framework context", type: "text" }], role: "assistant" },
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
                data: { result: { callId, output: "genuine outcome" }, sequence: 1, stepIndex: 1 },
                type: "action.result",
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
    sessionId: logical,
    workspaceId: "workspace",
  };
  const messages = [...history(), { content: "terminal context", role: "assistant" }];
  messages[0].content[0].toolName = "apply_app_creation";
  const f = await fixture({
    context: {
      "autograph-app-builder.private-apply-authority.v1": {
        grant: null,
        pending: [{ callId, scope }],
      },
      "autograph-app-builder.workflow.v17": {
        appSpec: { digest: "spec" },
        phase: "planned",
        proposal: { digest: "proposal", target: { contract: { appId: "app" } } },
        workspace: { workspaceId: "workspace" },
      },
    },
    history: messages,
  });
  const { recoverTerminalSession } = await load("execution/session/terminal-recovery.js");
  const descriptor = {
    logicalSessionId: logical,
    operationId: "new-operation",
    originalAuthoritySessionId: "original-public",
    parentCancellationRevision: 0,
    sourceAdapterGeneration: 1,
    sourceOwnerRunId: owner,
    sourcePublicSessionId: "failed-public-child",
    version: 1,
  };
  const selected = f.payload.candidates[0];
  const binding = {
    ...descriptor,
    ownerRunId: "new-physical-child",
    provenance: {
      checkpointVersion: 1,
      kind: selected.kind,
      sourceEventId: selected.origin.eventId,
      sourceSlot: selected.origin.slot,
      sourceStepId: selected.origin.stepId,
    },
  };
  let receipt;
  let hook;
  let checkpoint;
  let starts = 0;
  let contractReads = 0;
  const accepted = await recoverTerminalSession(
    {
      auth: { authenticator: "fixture", principalId: "owner", principalType: "user" },
      descriptor,
      ports: {
        authorize: async () => {},
        authorizeRepeatableRecoveryCalls: async (input) => {
          contractReads += 1;
          return authorizeRepeatablePrivateApplyCalls(input);
        },
        commitReceipt: async ({ recoveryBinding }) => {
          receipt = recoveryBinding;
          return receipt;
        },
        readReceipt: async () => receipt,
      },
    },
    {
      collect: async ({ binding: source, authorizeOwner }) => {
        await authorizeOwner(source);
        return { candidate: f.handle, kind: "candidate" };
      },
      getHook: async () =>
        hook === undefined
          ? await Promise.reject(new Error("missing hook"))
          : await Promise.resolve(hook),
      isHookNotFound: (error) => error.message === "missing hook",
      now: () => 0,
      readCandidate: readTerminalRecoveryCandidate,
      readEntry: async () => ({ checkpoint: { sessionTimeoutMs: false }, kind: "handoff" }),
      reconcile: reconcileTerminalRecoveryCandidate,
      start: async (input) => {
        starts += 1;
        checkpoint = input.checkpoint;
        hook = {
          metadata: Promise.resolve({ recoveryBinding: binding }),
          runId: binding.ownerRunId,
        };
      },
      wait: async () => {
        throw new Error("unexpected wait");
      },
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
