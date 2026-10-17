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
