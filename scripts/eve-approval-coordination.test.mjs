/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument -- This regression loads the installed compiled Eve internals by package path; their private module declarations are not public exports. */
/* oxlint-disable sonarjs/no-duplicate-string -- Protocol fixture names deliberately match stored request, call, and event identities. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { it } from "vitest";

const require = createRequire(import.meta.url);
const sdk = pathToFileURL(`${path.dirname(require.resolve("eve/package.json"))}/dist/src/`).href;
it("settles native approval before dispatch, preserves results and authorizers, and never dispatches denied calls", async () => {
  const { createToolLoopHarness } = await import(`${sdk}harness/tool-loop.js`);
  const { appendPendingInputBatch, getPendingInputBatches } = await import(
    `${sdk}harness/pending-input-batches.js`
  );
  const { setPendingCoordinationBatch, getPendingCoordinationBatch, resolvePendingCoordination } =
    await import(`${sdk}harness/coordination.js`);
  const { derivePendingState } = await import(`${sdk}execution/session/pending-turn-state.js`);
  const event = { sequence: 1, stepIndex: 1, turnId: "turn-one" };
  const tools = new Map(
    ["one", "two", "free"].map((name) => [
      name,
      {
        approval: () => true,
        inputSchema: { type: "object" },
        name,
        workflowId: `workflow:${name}`,
      },
    ]),
  );
  const auth = { authenticator: "test", principalId: "owner", principalType: "user" };
  const fixture = (names = ["one"], batches = [["one"]]) => {
    const calls = names.map((name) => ({
      input: {},
      toolCallId: `call-${name}`,
      toolName: name,
      type: "tool-call",
    }));
    const approvals = batches.flat().map((name) => ({
      approvalId: `request-${name}`,
      toolCallId: `call-${name}`,
      type: "tool-approval-request",
    }));
    let session = {
      agent: { modelReference: { id: "model", provider: "test" }, system: "", tools: [] },
      compaction: { recentWindowSize: 10, threshold: 1e6 },
      continuationToken: "token",
      history: [{ content: [...calls, ...approvals], role: "assistant" }],
      sessionId: "session",
    };
    session = setPendingCoordinationBatch({
      event,
      responseMessages: [],
      runtimeActions: [],
      session,
      tasks: names.map((name) => ({
        callId: `call-${name}`,
        input: {},
        kind: "workflow-task",
        toolName: name,
        workflowId: `workflow:${name}`,
      })),
    });
    for (const batch of batches) {
      session = appendPendingInputBatch({
        event,
        requests: batch.map((name) => ({
          action: { callId: `call-${name}`, input: {}, kind: "tool-call", toolName: name },
          allowFreeform: false,
          display: "confirmation",
          kind: "tool-approval",
          options: [
            { id: "approve", label: "Approve" },
            { id: "cancel", label: "Cancel" },
          ],
          prompt: "approve",
          requestId: `request-${name}`,
        })),
        responseMessages: [],
        session,
      });
    }
    return session;
  };
  const answer = async (session, decisions) => {
    const events = [];
    const run = createToolLoopHarness({
      handleEvent: async (streamEvent) => {
        await Promise.resolve(events.push(streamEvent));
      },
      resolveModel: async () => await Promise.reject(new Error("unexpected model call")),
      tools,
    });
    let result = await run(session, {
      attributedInputResponses: Object.entries(decisions).map(([name, optionId]) => ({
        auth,
        response: { optionId, requestId: `request-${name}` },
      })),
    });
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- StepNext intentionally distinguishes a continuation function from a terminal record.
    for (let n = 0; typeof result.next === "function" && n < 5; n += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each SDK step consumes the preceding durable state.
      result = await result.next(result.session);
    }
    return { events, result };
  };
  const session = fixture();
  assert.equal(derivePendingState(session).pendingCoordinationCallIds, undefined);
  let { result, events } = await answer(session, { one: "approve" });
  assert.deepEqual(derivePendingState(result.session).pendingCoordinationCallIds, ["call-one"]);
  assert.equal(getPendingInputBatches(result.session.state).length, 0);
  assert.ok(events.some((e) => e.type === "approval.settled"));
  assert.ok(events.some((e) => e.type === "input.resolved"));
  assert.equal(result.next, null);
  console.log("approved: settlement emitted before original call becomes dispatchable");
  // Keep one non-gated task so normal continuation parks before any model call.
  ({ result, events } = await answer(fixture(["one", "free"]), { one: "cancel" }));
  assert.deepEqual(derivePendingState(result.session).pendingCoordinationCallIds, ["call-free"]);
  assert.ok(
    events.some(
      (e) => e.type === "action.result" && JSON.stringify(e).includes("TOOL_EXECUTION_DENIED"),
    ),
  );
  assert.equal(JSON.stringify(result.session.history).includes("execution-denied"), true);
  console.log("denied: denied call removed, non-gated task preserved, not-run transcript retained");
  ({ result } = await answer(fixture(["one", "two", "free"], [["one"], ["two"]]), {
    one: "approve",
  }));
  assert.equal(derivePendingState(result.session).pendingCoordinationCallIds, undefined);
  assert.equal(getPendingInputBatches(result.session.state).length, 1);
  ({ result } = await answer(result.session, { two: "cancel" }));
  assert.deepEqual(derivePendingState(result.session).pendingCoordinationCallIds, [
    "call-one",
    "call-free",
  ]);
  console.log(
    "multiple batches: partial approval parks, final denial opens only approved and independent calls",
  );
  const settled = await resolvePendingCoordination({
    session: result.session,
    stepInput: {
      runtimeActionResults: [
        { callId: "call-one", kind: "tool-result", output: "one-result", toolName: "one" },
        { callId: "call-free", kind: "tool-result", output: "free-result", toolName: "free" },
      ],
    },
    tools,
  });
  assert.equal(settled.outcome, "resolved");
  assert.equal(getPendingCoordinationBatch(settled.session.state), undefined);
  assert.ok(JSON.stringify(settled.messages).includes("one-result"));
  assert.ok(JSON.stringify(settled.messages).includes("free-result"));
  assert.ok(JSON.stringify(settled.messages).includes("execution-denied"));
  console.log("results: original coordinated results and denial transcript preserved");
  // Exercise actual model-result scheduling as well as retained pending batches.
  const { MockLanguageModelV4 } = await import("ai/test");
  const { ContextContainer, contextStorage } = await import(`${sdk}context/container.js`);
  const { SessionKey } = await import(`${sdk}context/keys.js`);
  const ctx = new ContextContainer();
  ctx.set(SessionKey, {
    auth: { current: auth, initiator: auth },
    sessionId: "session",
    turn: { id: "turn-one" },
  });
  const { z } = await import("zod");
  for (const tool of tools.values()) {
    tool.inputSchema = z.object({});
  }
  const model = new MockLanguageModelV4({
    doGenerate: async () =>
      await Promise.resolve({
        content: [{ input: "{}", toolCallId: "call-one", toolName: "one", type: "tool-call" }],
        finishReason: { raw: "tool_calls", unified: "tool-calls" },
        usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
        warnings: [],
      }),
  });
  const initial = fixture();
  delete initial.state;
  initial.history = [];
  const generated = await contextStorage.run(ctx, () =>
    createToolLoopHarness({ resolveModel: async () => await Promise.resolve(model), tools })(
      initial,
      {
        message: "do work",
      },
    ),
  );
  assert.equal(getPendingInputBatches(generated.session.state).length, 1);
  assert.equal(getPendingCoordinationBatch(generated.session.state).tasks.length, 1);
  assert.equal(derivePendingState(generated.session).pendingCoordinationCallIds, undefined);
  console.log(
    "model result: actual generated approval and deferred task park without dispatch IDs",
  );
  const generatedDecision = async (optionId) => {
    const [pending] = getPendingInputBatches(generated.session.state);
    const generatedEvents = [];
    const run = createToolLoopHarness({
      handleEvent: async (e) => await Promise.resolve(generatedEvents.push(e)),
      resolveModel: async () => await Promise.reject(new Error("unexpected replay model call")),
      tools,
    });
    const generatedResult = await run(generated.session, {
      attributedInputResponses: [
        { auth, response: { optionId, requestId: pending.requests[0].requestId } },
      ],
    });
    return { events: generatedEvents, result: generatedResult };
  };
  const generatedApproved = await generatedDecision("approve");
  assert.deepEqual(
    derivePendingState(generatedApproved.result.session).pendingCoordinationCallIds,
    ["call-one"],
  );
  assert.ok(generatedApproved.events.some((e) => e.type === "approval.settled"));
  const generatedDenied = await generatedDecision("cancel");
  assert.deepEqual(getPendingCoordinationBatch(generatedDenied.result.session.state).tasks, []);
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Empty coordination must request the next native step, not park indefinitely.
  assert.equal(typeof generatedDenied.result.next, "function");
  const emptyResolution = await resolvePendingCoordination({
    session: generatedDenied.result.session,
    tools,
  });
  assert.equal(emptyResolution.outcome, "resolved");
  assert.equal(getPendingCoordinationBatch(emptyResolution.session.state), undefined);
  assert.ok(JSON.stringify(emptyResolution.messages).includes("execution-denied"));
  console.log(
    "actual model approve/deny: one original call scheduled; all-denied batch clears with its not-run result",
  );
  const changed = fixture();
  changed.state["eve.runtime.pendingInputBatches"][0].toolReplayIdentities = {
    "request-one": "old-identity",
  };
  const changedRun = createToolLoopHarness({
    resolveModel: async () => await Promise.reject(new Error("unexpected model call")),
    toolReplayIdentity: () => "new-identity",
    tools,
  });
  await assert.rejects(
    changedRun(changed, {
      attributedInputResponses: [
        { auth, response: { optionId: "approve", requestId: "request-one" } },
      ],
    }),
    /connection for this tool call changed/u,
  );
  console.log("authorization: changed replay identity is rejected before dispatch");
  let authorizations = 0;
  tools.get("one").approval = {
    request: () => true,
    response: async () => {
      authorizations += 1;
      return await Promise.resolve({ status: "allowed" });
    },
  };
  const authorizedGenerated = await contextStorage.run(ctx, () =>
    createToolLoopHarness({ resolveModel: async () => await Promise.resolve(model), tools })(
      initial,
      {
        message: "do work",
      },
    ),
  );
  const [authorizedPending] = getPendingInputBatches(authorizedGenerated.session.state);
  assert.deepEqual(authorizedPending.responseAuthRequiredRequestIds, [
    authorizedPending.requests[0].requestId,
  ]);
  const authorizedRun = createToolLoopHarness({
    resolveModel: async () => await Promise.reject(new Error("unexpected model call")),
    tools,
  });
  let authorized = await contextStorage.run(ctx, () =>
    authorizedRun(authorizedGenerated.session, {
      attributedInputResponses: [
        {
          auth,
          response: { optionId: "approve", requestId: authorizedPending.requests[0].requestId },
        },
      ],
    }),
  );
  assert.equal(derivePendingState(authorized.session).pendingCoordinationCallIds, undefined);
  assert.equal(authorizations, 0);
  authorized = await contextStorage.run(ctx, () => authorized.next(authorized.session));
  assert.equal(authorizations, 1);
  assert.deepEqual(derivePendingState(authorized.session).pendingCoordinationCallIds, ["call-one"]);
  console.log(
    "response policy: actual deferred model request retains and runs normal response authorizer",
  );
});

it.each([
  { optionId: "approve", withInput: false },
  { optionId: "approve", withInput: true },
  { optionId: "cancel", withInput: false },
  { cancelBeforeReplay: true, optionId: "approve", withInput: false },
])(
  "replays native decisions with coordinated results (%o)",
  async ({ withInput, optionId, cancelBeforeReplay }) => {
    const { createToolLoopHarness } = await import(`${sdk}harness/tool-loop.js`);
    const { getPendingInputBatches } = await import(`${sdk}harness/pending-input-batches.js`);
    const { ContextContainer, contextStorage } = await import(`${sdk}context/container.js`);
    const { SessionKey } = await import(`${sdk}context/keys.js`);
    const { MockLanguageModelV4 } = await import("ai/test");
    const { z } = await import("zod");
    const auth = { authenticator: "test", principalId: "owner", principalType: "user" };
    const ctx = new ContextContainer();
    ctx.set(SessionKey, {
      auth: { current: auth, initiator: auth },
      sessionId: "mixed-session",
      turn: { id: "mixed-turn" },
    });
    let executions = 0;
    let requests = 0;
    const tools = new Map([
      [
        "native",
        {
          approval: () => "user-approval",
          execute: (input) => {
            executions += 1;
            return `native-result:${input.value}`;
          },
          inputSchema: z.object({ value: z.string() }),
          name: "native",
        },
      ],
      [
        "deferred",
        {
          inputSchema: z.object({}),
          name: "deferred",
          workflowId: "workflow:deferred",
        },
      ],
    ]);
    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        requests += 1;
        if (requests === 1) {
          return {
            content: ["native", "deferred"].map((name) => ({
              input: name === "native" ? JSON.stringify({ value: "retained-native-input" }) : "{}",
              toolCallId: `mixed-${name}`,
              toolName: name,
              type: "tool-call",
            })),
            finishReason: { raw: "tool_calls", unified: "tool-calls" },
            usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
            warnings: [],
          };
        }
        const parts = prompt.flatMap((message) =>
          Array.isArray(message.content) ? message.content : [],
        );
        for (const name of ["native", "deferred"]) {
          assert.equal(
            parts.filter(
              (part) => part.type === "tool-result" && part.toolCallId === `mixed-${name}`,
            ).length,
            1,
          );
        }
        if (optionId === "approve") {
          assert.ok(
            parts.some(
              (part) =>
                part.type === "tool-result" &&
                part.toolCallId === "mixed-native" &&
                part.output.value === "native-result:retained-native-input",
            ),
          );
        }
        assert.equal(JSON.stringify(prompt).includes("new product reply"), requests > 2);
        assert.ok(JSON.stringify(prompt).includes("retained client context"));
        return {
          content: [{ text: "complete", type: "text" }],
          finishReason: { raw: "stop", unified: "stop" },
          usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
          warnings: [],
        };
      },
    });
    const run = createToolLoopHarness({ resolveModel: async () => model, tools });
    const invoke = (session, input) => contextStorage.run(ctx, () => run(session, input));
    const initial = {
      agent: { modelReference: { id: "model", provider: "test" }, system: "", tools: [] },
      compaction: { recentWindowSize: 10, threshold: 1e6 },
      continuationToken: "token",
      history: [],
      sessionId: "mixed-session",
      state: {
        "eve.harness.emission": {
          sequence: 1,
          sessionStarted: true,
          stepIndex: 0,
          turnId: "mixed-turn",
        },
      },
    };
    const { attachClientContext } = await import(`${sdk}internal/client-context.js`);
    const firstInput = { message: "do work" };
    attachClientContext(firstInput, ["retained client context"]);
    const generated = await invoke(initial, firstInput);
    const [pending] = getPendingInputBatches(generated.session.state);
    const approved = await invoke(generated.session, {
      attributedInputResponses: pending.requests.map((request) => ({
        auth,
        response: { optionId, requestId: request.requestId },
      })),
    });
    assert.equal(executions, 0);
    if (cancelBeforeReplay === true) {
      const abort = new AbortController();
      abort.abort(new Error("cancelled before replay"));
      const cancelled = createToolLoopHarness({
        abortSignal: abort.signal,
        resolveModel: async () => model,
        tools,
      });
      await assert.rejects(
        contextStorage.run(ctx, () =>
          cancelled(approved.session, {
            runtimeActionResults: [
              {
                callId: "mixed-deferred",
                kind: "tool-result",
                output: "deferred-result",
                toolName: "deferred",
              },
            ],
          }),
        ),
        { name: "TurnCancelledError" },
      );
      assert.equal(executions, 0);
      assert.equal(requests, 1);
      return;
    }
    let completed = await invoke(approved.session, {
      ...(withInput ? { context: ["new product context"], message: "new product reply" } : {}),
      runtimeActionResults: [
        {
          callId: "mixed-deferred",
          kind: "tool-result",
          output: "deferred-result",
          toolName: "deferred",
        },
      ],
    });
    assert.equal(executions, optionId === "approve" ? 1 : 0);
    assert.equal(requests, 2);
    if (withInput) {
      completed = await contextStorage.run(ctx, () => completed.next(completed.session));
      assert.equal(requests, 3);
      assert.equal(executions, 1);
      assert.ok(JSON.stringify(completed.session.history).includes("new product context"));
    }
  },
);

it("preserves approval tail metadata without changing original message parts", async () => {
  const { coalesceApprovalReplayTail } = await import(`${sdk}harness/approval-coordination.js`);
  const messages = [
    { content: "prefix", role: "assistant" },
    {
      content: [
        {
          approvalId: "first",
          approved: true,
          providerOptions: { test: { part: true, precedence: "part" } },
          type: "tool-approval-response",
        },
      ],
      providerOptions: { test: { message: true, precedence: "message" } },
      role: "tool",
    },
    {
      content: [{ approvalId: "second", approved: false, type: "tool-approval-response" }],
      role: "tool",
    },
    {
      content: [
        {
          output: { type: "text", value: "actual-result" },
          toolCallId: "completed",
          toolName: "deferred",
          type: "tool-result",
        },
      ],
      providerOptions: { test: { final: true } },
      role: "tool",
    },
  ];
  const before = structuredClone(messages);
  const merged = coalesceApprovalReplayTail(messages);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[1].content[0].providerOptions, {
    test: { message: true, part: true, precedence: "part" },
  });
  assert.deepEqual(merged[1].providerOptions, { test: { final: true } });
  assert.deepEqual(
    merged[1].content.map((part) => part.type),
    ["tool-approval-response", "tool-approval-response", "tool-result"],
  );
  assert.deepEqual(messages, before);
});

it.each([400, 503])(
  "retains actual coordinated and SDK replay outputs on provider failure %s",
  async (statusCode) => {
    const { createToolLoopHarness } = await import(`${sdk}harness/tool-loop.js`);
    const { getPendingInputBatches } = await import(`${sdk}harness/pending-input-batches.js`);
    const { getPendingCoordinationBatch } = await import(`${sdk}harness/coordination.js`);
    const { ContextContainer, contextStorage } = await import(`${sdk}context/container.js`);
    const { SessionKey } = await import(`${sdk}context/keys.js`);
    const { MockLanguageModelV4 } = await import("ai/test");
    const { APICallError } = await import("ai");
    const { z } = await import("zod");
    const auth = { authenticator: "test", principalId: "owner", principalType: "user" };
    const ctx = new ContextContainer();
    ctx.set(SessionKey, {
      auth: { current: auth, initiator: auth },
      sessionId: "failed-session",
      turn: { id: "failed-turn" },
    });
    let executions = 0;
    let providerRequests = 0;
    let generatedRequests = 0;
    const tools = new Map([
      [
        "native",
        {
          approval: () => "user-approval",
          execute: () => {
            executions += 1;
            return "native-completed";
          },
          inputSchema: z.object({}),
          name: "native",
        },
      ],
      [
        "deferred",
        { inputSchema: z.object({}), name: "deferred", workflowId: "workflow:deferred" },
      ],
    ]);
    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        generatedRequests += 1;
        if (generatedRequests > 1) {
          const parts = prompt.flatMap((message) =>
            Array.isArray(message.content) ? message.content : [],
          );
          for (const name of ["native", "deferred"]) {
            assert.equal(
              parts.filter(
                (part) => part.type === "tool-result" && part.toolCallId === `failed-${name}`,
              ).length,
              1,
            );
          }
          return {
            content: [{ text: "continued", type: "text" }],
            finishReason: { raw: "stop", unified: "stop" },
            usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
            warnings: [],
          };
        }
        return {
          content: ["native", "deferred"].map((name) => ({
            input: "{}",
            toolCallId: `failed-${name}`,
            toolName: name,
            type: "tool-call",
          })),
          finishReason: { raw: "tool_calls", unified: "tool-calls" },
          usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
          warnings: [],
        };
      },
      doStream: async () => {
        providerRequests += 1;
        throw new APICallError({
          isRetryable: false,
          message: "Synthetic nonretryable provider rejection",
          requestBodyValues: {},
          responseBody: "synthetic rejection",
          statusCode,
          url: "https://synthetic.invalid/model",
        });
      },
    });
    const invoke = (session, input, events) =>
      contextStorage.run(ctx, () =>
        createToolLoopHarness({
          resolveModel: async () => model,
          tools,
          ...(events === undefined
            ? {}
            : {
                handleEvent: async (event) => {
                  events.push(event);
                },
              }),
        })(session, input),
      );
    const generated = await invoke(
      {
        agent: { modelReference: { id: "model", provider: "test" }, system: "", tools: [] },
        compaction: { recentWindowSize: 10, threshold: 1e6 },
        continuationToken: "token",
        history: [],
        sessionId: "failed-session",
      },
      { message: "do work" },
    );
    const [pending] = getPendingInputBatches(generated.session.state);
    const approved = await invoke(generated.session, {
      attributedInputResponses: pending.requests.map((request) => ({
        auth,
        response: { optionId: "approve", requestId: request.requestId },
      })),
    });
    const events = [];
    const failed = await invoke(
      approved.session,
      {
        runtimeActionResults: [
          {
            callId: "failed-deferred",
            kind: "tool-result",
            output: "deferred-completed",
            toolName: "deferred",
          },
        ],
      },
      events,
    );
    const parts = failed.session.history.flatMap((message) =>
      Array.isArray(message.content) ? message.content : [],
    );
    const summary = {
      callCount: parts.filter((part) => part.type === "tool-call").length,
      nativeExecutions: executions,
      pendingCoordination: getPendingCoordinationBatch(failed.session.state) !== undefined,
      pendingInputs: getPendingInputBatches(failed.session.state).length,
      resultCount: parts.filter((part) => part.type === "tool-result").length,
      terminal: failed.next?.done === true,
    };
    console.log("provider rejection retained state", summary);
    assert.ok(
      events.some(
        (event) => event.type === "step.failed" && event.data.code === "MODEL_CALL_FAILED",
      ),
    );
    assert.deepEqual(summary, {
      callCount: 2,
      nativeExecutions: 1,
      pendingCoordination: false,
      pendingInputs: 0,
      resultCount: 2,
      terminal: statusCode === 400,
    });
    assert.equal(providerRequests, statusCode === 400 ? 1 : 3);
    assert.ok(JSON.stringify(parts).includes("native-completed"));
    assert.ok(JSON.stringify(parts).includes("deferred-completed"));
    if (statusCode === 503) {
      const continued = await invoke(failed.session, { message: "continue" });
      assert.equal(executions, 1);
      assert.equal(generatedRequests, 2);
      assert.ok(JSON.stringify(continued.session.history).includes("continued"));
    }
  },
);

it.each(["generic", "typed"])(
  "normalizes %s cancellation during the real response authorizer without settling or dispatching",
  async (reasonKind) => {
    const { createToolLoopHarness } = await import(`${sdk}harness/tool-loop.js`);
    const { TurnCancelledError, isTurnCancellation } = await import(
      `${sdk}harness/turn-cancellation.js`
    );
    const { appendPendingInputBatch } = await import(`${sdk}harness/pending-input-batches.js`);
    const { createApprovalCandidate, getApprovalAuditState } = await import(
      `${sdk}harness/approval-candidates.js`
    );
    const { ContextContainer, contextStorage } = await import(`${sdk}context/container.js`);
    const { SessionKey } = await import(`${sdk}context/keys.js`);
    const { z } = await import("zod");
    const abort = new AbortController();
    const reason =
      reasonKind === "typed"
        ? new TurnCancelledError("owner cancelled")
        : new Error("owner cancelled");
    const auth = { authenticator: "test", principalId: "owner", principalType: "user" };
    const ctx = new ContextContainer();
    ctx.set(SessionKey, {
      auth: { current: auth, initiator: auth },
      sessionId: "cancel-authorizer",
      turn: { id: "cancel-turn" },
    });
    let authorizations = 0;
    let executions = 0;
    let models = 0;
    const tools = new Map([
      [
        "protected",
        {
          approval: {
            request: () => true,
            response: async () => {
              authorizations += 1;
              abort.abort(reason);
              await Promise.resolve();
              return { status: "allowed" };
            },
          },
          execute: () => {
            executions += 1;
            return "must not execute";
          },
          inputSchema: z.object({}),
          name: "protected",
        },
      ],
    ]);
    let session = appendPendingInputBatch({
      requests: [
        {
          action: { callId: "call-protected", input: {}, kind: "tool-call", toolName: "protected" },
          allowFreeform: false,
          display: "confirmation",
          kind: "tool-approval",
          options: [{ id: "approve", label: "Approve" }],
          prompt: "Approve",
          requestId: "request-protected",
        },
      ],
      responseAuthRequiredRequestIds: ["request-protected"],
      responseMessages: [],
      session: {
        agent: { modelReference: { id: "model", provider: "test" }, system: "", tools: [] },
        compaction: { recentWindowSize: 10, threshold: 1e6 },
        continuationToken: "token",
        history: [],
        sessionId: "cancel-authorizer",
      },
    });
    session = {
      ...session,
      state: createApprovalCandidate({
        candidateIdPrefix: "candidate",
        createdAt: Date.now(),
        expiresAt: Number.MAX_SAFE_INTEGER,
        requestId: "request-protected",
        responder: auth,
        state: session.state,
      }).state,
    };
    const before = JSON.stringify(session.state);
    const run = createToolLoopHarness({
      abortSignal: abort.signal,
      resolveModel: async () => {
        models += 1;
        throw new Error("must not resolve model");
      },
      tools,
    });
    await assert.rejects(
      contextStorage.run(ctx, () => run(session)),
      (error) => {
        assert.equal(error.name, "TurnCancelledError");
        assert.equal(isTurnCancellation(error), true);
        if (reasonKind === "typed") {
          assert.equal(error, reason);
        }
        return true;
      },
    );
    assert.equal(authorizations, 1);
    assert.equal(executions, 0);
    assert.equal(models, 0);
    assert.equal(JSON.stringify(session.state), before);
    assert.equal(getApprovalAuditState(session.state).settlements.length, 0);
  },
);
