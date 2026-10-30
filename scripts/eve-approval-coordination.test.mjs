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
        name,
        workflowId: `workflow:${name}`,
        inputSchema: { type: "object" },
        approval: () => true,
      },
    ]),
  );
  const auth = { authenticator: "test", principalId: "owner", principalType: "user" };
  const fixture = (names = ["one"], batches = [["one"]]) => {
    const calls = names.map((name) => ({
      type: "tool-call",
      toolName: name,
      toolCallId: `call-${name}`,
      input: {},
    }));
    const approvals = batches.flat().map((name) => ({
      type: "tool-approval-request",
      approvalId: `request-${name}`,
      toolCallId: `call-${name}`,
    }));
    let session = {
      agent: { system: "", tools: [], modelReference: { id: "model", provider: "test" } },
      sessionId: "session",
      continuationToken: "token",
      compaction: { threshold: 1e6, recentWindowSize: 10 },
      history: [{ role: "assistant", content: [...calls, ...approvals] }],
    };
    session = setPendingCoordinationBatch({
      session,
      event,
      runtimeActions: [],
      tasks: names.map((name) => ({
        kind: "workflow-task",
        toolName: name,
        callId: `call-${name}`,
        input: {},
        workflowId: `workflow:${name}`,
      })),
      responseMessages: [],
    });
    for (const batch of batches) {
      session = appendPendingInputBatch({
        session,
        event,
        requests: batch.map((name) => ({
          kind: "tool-approval",
          requestId: `request-${name}`,
          action: { callId: `call-${name}`, toolName: name, input: {}, kind: "tool-call" },
          options: [
            { id: "approve", label: "Approve" },
            { id: "cancel", label: "Cancel" },
          ],
          prompt: "approve",
          allowFreeform: false,
          display: "confirmation",
        })),
        responseMessages: [],
      });
    }
    return session;
  };
  const answer = async (session, decisions) => {
    const events = [];
    const run = createToolLoopHarness({
      tools,
      handleEvent: async (streamEvent) => {
        await Promise.resolve(events.push(streamEvent));
      },
      resolveModel: async () => await Promise.reject(new Error("unexpected model call")),
    });
    let result = await run(session, {
      attributedInputResponses: Object.entries(decisions).map(([name, optionId]) => ({
        auth,
        response: { requestId: `request-${name}`, optionId },
      })),
    });
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- StepNext intentionally distinguishes a continuation function from a terminal record.
    for (let n = 0; typeof result.next === "function" && n < 5; n += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each SDK step consumes the preceding durable state.
      result = await result.next(result.session);
    }
    return { result, events };
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
    tools,
    stepInput: {
      runtimeActionResults: [
        { kind: "tool-result", callId: "call-one", toolName: "one", output: "one-result" },
        { kind: "tool-result", callId: "call-free", toolName: "free", output: "free-result" },
      ],
    },
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
    sessionId: "session",
    auth: { current: auth, initiator: auth },
    turn: { id: "turn-one" },
  });
  const { z } = await import("zod");
  for (const tool of tools.values()) {
    tool.inputSchema = z.object({});
  }
  const model = new MockLanguageModelV4({
    doGenerate: async () =>
      await Promise.resolve({
        content: [{ type: "tool-call", toolCallId: "call-one", toolName: "one", input: "{}" }],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
        warnings: [],
      }),
  });
  const initial = fixture();
  delete initial.state;
  initial.history = [];
  const generated = await contextStorage.run(ctx, () =>
    createToolLoopHarness({ tools, resolveModel: async () => await Promise.resolve(model) })(
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
      tools,
      handleEvent: async (e) => await Promise.resolve(generatedEvents.push(e)),
      resolveModel: async () => await Promise.reject(new Error("unexpected replay model call")),
    });
    const generatedResult = await run(generated.session, {
      attributedInputResponses: [
        { auth, response: { requestId: pending.requests[0].requestId, optionId } },
      ],
    });
    return { result: generatedResult, events: generatedEvents };
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
    tools,
    toolReplayIdentity: () => "new-identity",
    resolveModel: async () => await Promise.reject(new Error("unexpected model call")),
  });
  await assert.rejects(
    changedRun(changed, {
      attributedInputResponses: [
        { auth, response: { requestId: "request-one", optionId: "approve" } },
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
    createToolLoopHarness({ tools, resolveModel: async () => await Promise.resolve(model) })(
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
    tools,
    resolveModel: async () => await Promise.reject(new Error("unexpected model call")),
  });
  let authorized = await contextStorage.run(ctx, () =>
    authorizedRun(authorizedGenerated.session, {
      attributedInputResponses: [
        {
          auth,
          response: { requestId: authorizedPending.requests[0].requestId, optionId: "approve" },
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
  { withInput: false, optionId: "approve" },
  { withInput: true, optionId: "approve" },
  { withInput: false, optionId: "cancel" },
  { withInput: false, optionId: "approve", cancelBeforeReplay: true },
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
      sessionId: "mixed-session",
      auth: { current: auth, initiator: auth },
      turn: { id: "mixed-turn" },
    });
    let executions = 0;
    let requests = 0;
    const tools = new Map([
      [
        "native",
        {
          name: "native",
          inputSchema: z.object({ value: z.string() }),
          approval: () => "user-approval",
          execute: (input) => {
            executions += 1;
            return `native-result:${input.value}`;
          },
        },
      ],
      [
        "deferred",
        {
          name: "deferred",
          inputSchema: z.object({}),
          workflowId: "workflow:deferred",
        },
      ],
    ]);
    const model = new MockLanguageModelV4({
      doGenerate: ({ prompt }) => {
        requests += 1;
        if (requests === 1) {
          return Promise.resolve({
            content: ["native", "deferred"].map((name) => ({
              type: "tool-call",
              toolCallId: `mixed-${name}`,
              toolName: name,
              input: name === "native" ? JSON.stringify({ value: "retained-native-input" }) : "{}",
            })),
            finishReason: { unified: "tool-calls", raw: "tool_calls" },
            usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
            warnings: [],
          });
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
        return Promise.resolve({
          content: [{ type: "text", text: "complete" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
          warnings: [],
        });
      },
    });
    const run = createToolLoopHarness({ tools, resolveModel: () => Promise.resolve(model) });
    const invoke = (session, input) => contextStorage.run(ctx, () => run(session, input));
    const initial = {
      agent: { system: "", tools: [], modelReference: { id: "model", provider: "test" } },
      sessionId: "mixed-session",
      continuationToken: "token",
      history: [],
      state: {
        "eve.harness.emission": {
          sessionStarted: true,
          sequence: 1,
          stepIndex: 0,
          turnId: "mixed-turn",
        },
      },
      compaction: { threshold: 1e6, recentWindowSize: 10 },
    };
    const { attachClientContext } = await import(`${sdk}internal/client-context.js`);
    const firstInput = { message: "do work" };
    attachClientContext(firstInput, ["retained client context"]);
    const generated = await invoke(initial, firstInput);
    const [pending] = getPendingInputBatches(generated.session.state);
    const approved = await invoke(generated.session, {
      attributedInputResponses: pending.requests.map((request) => ({
        auth,
        response: { requestId: request.requestId, optionId },
      })),
    });
    assert.equal(executions, 0);
    if (cancelBeforeReplay === true) {
      const abort = new AbortController();
      abort.abort(new Error("cancelled before replay"));
      const cancelled = createToolLoopHarness({
        tools,
        abortSignal: abort.signal,
        resolveModel: () => Promise.resolve(model),
      });
      await assert.rejects(
        contextStorage.run(ctx, () =>
          cancelled(approved.session, {
            runtimeActionResults: [
              {
                kind: "tool-result",
                callId: "mixed-deferred",
                toolName: "deferred",
                output: "deferred-result",
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
      ...(withInput ? { message: "new product reply", context: ["new product context"] } : {}),
      runtimeActionResults: [
        {
          kind: "tool-result",
          callId: "mixed-deferred",
          toolName: "deferred",
          output: "deferred-result",
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
    { role: "assistant", content: "prefix" },
    {
      role: "tool",
      providerOptions: { test: { message: true, precedence: "message" } },
      content: [
        {
          type: "tool-approval-response",
          approvalId: "first",
          approved: true,
          providerOptions: { test: { part: true, precedence: "part" } },
        },
      ],
    },
    {
      role: "tool",
      content: [{ type: "tool-approval-response", approvalId: "second", approved: false }],
    },
    {
      role: "tool",
      providerOptions: { test: { final: true } },
      content: [
        {
          type: "tool-result",
          toolCallId: "completed",
          toolName: "deferred",
          output: { type: "text", value: "actual-result" },
        },
      ],
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
      sessionId: "failed-session",
      auth: { current: auth, initiator: auth },
      turn: { id: "failed-turn" },
    });
    let executions = 0;
    let providerRequests = 0;
    let generatedRequests = 0;
    const tools = new Map([
      [
        "native",
        {
          name: "native",
          inputSchema: z.object({}),
          approval: () => "user-approval",
          execute: () => {
            executions += 1;
            return "native-completed";
          },
        },
      ],
      [
        "deferred",
        { name: "deferred", inputSchema: z.object({}), workflowId: "workflow:deferred" },
      ],
    ]);
    const model = new MockLanguageModelV4({
      doGenerate: ({ prompt }) => {
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
          return Promise.resolve({
            content: [{ type: "text", text: "continued" }],
            finishReason: { unified: "stop", raw: "stop" },
            usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
            warnings: [],
          });
        }
        return Promise.resolve({
          content: ["native", "deferred"].map((name) => ({
            type: "tool-call",
            toolCallId: `failed-${name}`,
            toolName: name,
            input: "{}",
          })),
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
          warnings: [],
        });
      },
      doStream: () => {
        providerRequests += 1;
        return Promise.reject(
          new APICallError({
            message: "Synthetic nonretryable provider rejection",
            url: "https://synthetic.invalid/model",
            requestBodyValues: {},
            statusCode,
            responseBody: "synthetic rejection",
            isRetryable: false,
          }),
        );
      },
    });
    const invoke = (session, input, events) =>
      contextStorage.run(ctx, () =>
        createToolLoopHarness({
          tools,
          resolveModel: () => Promise.resolve(model),
          ...(events === undefined
            ? {}
            : {
                handleEvent: (event) => {
                  events.push(event);
                  return Promise.resolve();
                },
              }),
        })(session, input),
      );
    const generated = await invoke(
      {
        agent: { system: "", tools: [], modelReference: { id: "model", provider: "test" } },
        sessionId: "failed-session",
        continuationToken: "token",
        history: [],
        compaction: { threshold: 1e6, recentWindowSize: 10 },
      },
      { message: "do work" },
    );
    const [pending] = getPendingInputBatches(generated.session.state);
    const approved = await invoke(generated.session, {
      attributedInputResponses: pending.requests.map((request) => ({
        auth,
        response: { requestId: request.requestId, optionId: "approve" },
      })),
    });
    const events = [];
    const failed = await invoke(
      approved.session,
      {
        runtimeActionResults: [
          {
            kind: "tool-result",
            callId: "failed-deferred",
            toolName: "deferred",
            output: "deferred-completed",
          },
        ],
      },
      events,
    );
    const parts = failed.session.history.flatMap((message) =>
      Array.isArray(message.content) ? message.content : [],
    );
    const summary = {
      nativeExecutions: executions,
      callCount: parts.filter((part) => part.type === "tool-call").length,
      resultCount: parts.filter((part) => part.type === "tool-result").length,
      pendingInputs: getPendingInputBatches(failed.session.state).length,
      pendingCoordination: getPendingCoordinationBatch(failed.session.state) !== undefined,
      terminal: failed.next?.done === true,
    };
    console.log("provider rejection retained state", summary);
    assert.ok(
      events.some(
        (event) => event.type === "step.failed" && event.data.code === "MODEL_CALL_FAILED",
      ),
    );
    assert.deepEqual(summary, {
      nativeExecutions: 1,
      callCount: 2,
      resultCount: 2,
      pendingInputs: 0,
      pendingCoordination: false,
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
      sessionId: "cancel-authorizer",
      auth: { current: auth, initiator: auth },
      turn: { id: "cancel-turn" },
    });
    let authorizations = 0;
    let executions = 0;
    let models = 0;
    const tools = new Map([
      [
        "protected",
        {
          name: "protected",
          inputSchema: z.object({}),
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
        },
      ],
    ]);
    let session = appendPendingInputBatch({
      session: {
        agent: { system: "", tools: [], modelReference: { id: "model", provider: "test" } },
        sessionId: "cancel-authorizer",
        continuationToken: "token",
        history: [],
        compaction: { threshold: 1e6, recentWindowSize: 10 },
      },
      requests: [
        {
          kind: "tool-approval",
          requestId: "request-protected",
          action: { kind: "tool-call", callId: "call-protected", toolName: "protected", input: {} },
          options: [{ id: "approve", label: "Approve" }],
          prompt: "Approve",
          allowFreeform: false,
          display: "confirmation",
        },
      ],
      responseAuthRequiredRequestIds: ["request-protected"],
      responseMessages: [],
    });
    session = {
      ...session,
      state: createApprovalCandidate({
        state: session.state,
        candidateIdPrefix: "candidate",
        requestId: "request-protected",
        responder: auth,
        createdAt: Date.now(),
        expiresAt: Number.MAX_SAFE_INTEGER,
      }).state,
    };
    const before = JSON.stringify(session.state);
    const run = createToolLoopHarness({
      tools,
      abortSignal: abort.signal,
      resolveModel: () => {
        models += 1;
        return Promise.reject(new Error("must not resolve model"));
      },
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
