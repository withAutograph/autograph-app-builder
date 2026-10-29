/* oxlint-disable eslint/require-await -- Async mocks preserve the actual World SDK promise contract. */
/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument -- Synthetic regression loads private installed native SDK modules by package path. */
/* oxlint-disable sonarjs/no-duplicate-string -- Exact native fixture identities are reused across provenance assertions. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";

// Read the installed patched Eve package. No fixture copies or shared dependency writes.
const require = createRequire(import.meta.url);
const eve = path.resolve(
  process.env.EVE_RECOVERY_NATIVE_ROOT ?? path.dirname(require.resolve("eve/package.json")),
);
const nativePath = "dist/src/execution/session/recovery-candidate.js";
const load = (file) => import(pathToFileURL(path.resolve(eve, file)).href);
const {
  collectTerminalRecoveryCandidate,
  createTerminalRecoveryCandidateCollector,
  readTerminalRecoveryCandidate,
} = await load(nativePath);
const serialization = await load("dist/src/compiled/@workflow/core/serialization.js");
const { readDurableSession, createDurableSessionState } = await load(
  "dist/src/execution/durable-session-store.js",
);
const slotToEventId = (slot) => `evnt_${String(slot).padStart(26, "0")}`;
const requireEventSlot = (id) => {
  assert.match(id, /^evnt_[0-9]{26}$/u);
  return Number(id.slice(5));
};

const ownerRunId = "wrun_00000000000000000000000001";
const logicalSessionId = ownerRunId;
const binding = { ownerRunId, logicalSessionId };
const exactOutput = {
  changedFileCount: 3,
  status: "applied",
  syntheticPrivate: "must-not-be-public",
};
const protocolResult = {
  type: "action.result",
  data: {
    result: {
      kind: "tool-result",
      callId: "actual-call",
      toolName: "apply_app_creation",
      output: exactOutput,
    },
  },
};
const makeState = (phase) =>
  // Use the real native state projection; no handcrafted binary serialization.
  createDurableSessionState({
    session: {
      sessionId: logicalSessionId,
      continuationToken: "original-continuation",
      agent: { system: "system", tools: [] },
      history: [{ role: "user", content: "Original product brief" }],
      compaction: { threshold: 10_000, recentWindowSize: 10 },
      state: {
        "autograph-app-builder.workflow.v17": {
          version: 17,
          phase,
          appSpec: { appId: "spend-review", digest: "exact-original-spec" },
          workspace: { workspaceId: "original-workspace" },
        },
        "autograph-app-builder.private-apply-authority.v1": {
          grant: {
            appId: "spend-review",
            sessionId: logicalSessionId,
            workspaceId: "original-workspace",
            appSpecDigest: "exact-original-spec",
            proposalDigest: "exact-original-proposal",
          },
          pending: [],
        },
        "autograph-app-builder.staged-implementation.v1": {
          files: [{ path: "app.ts", content: "original private source" }],
        },
        "eve.runtime.pendingCoordinationBatch": {
          tasks: [{ callId: "actual-call" }],
          responseMessages: [],
          runtimeActions: [],
          event: { sequence: 1, turnId: "turn-original", stepIndex: 2 },
        },
      },
      sandboxState: {
        session: {
          providerName: "vercel",
          stateProtocolVersion: 1,
          state: { name: "original-sandbox", workspaceDrive: { id: "original-drive" } },
        },
      },
    },
  });
const pair = (phase) => ({
  serializedContext: {
    "eve.sessionId": logicalSessionId,
    "eve.bundle": { fixture: true },
    privateMetadata: "private",
  },
  sessionState: makeState(phase),
});

const fixture = async function fixture(options = {}) {
  const key =
    options.encrypted === true
      ? await serialization.deriveRunPayloadKeys(new Uint8Array(32).fill(7))
      : undefined;
  const prior = pair("planned");
  const final = pair("applied");
  const incoming = {
    delivery: {
      kind: "deliver",
      payloads: [
        { inputResponses: [{ requestId: "original-approval", kind: "approval", approved: true }] },
      ],
    },
    runtimeResults: { results: [protocolResult.data.result] },
  };
  const inputs = { prior, failed: { ...final, input: incoming }, final };
  const encodeArgs = (input) =>
    serialization.dehydrateStepArguments({ args: [input], closureVars: [] }, ownerRunId, key);
  const steps = new Map([
    [
      "step-prior",
      {
        runId: ownerRunId,
        stepId: "step-prior",
        stepName: "step//eve@0.68.0//turnStep",
        status: "completed",
        input: await encodeArgs(prior),
        output: await serialization.dehydrateStepReturnValue(
          { action: "park", ...prior },
          ownerRunId,
          key,
        ),
      },
    ],
    [
      "step-failed",
      {
        runId: ownerRunId,
        stepId: "step-failed",
        stepName: "step//eve@0.68.0//turnStep",
        status: "failed",
        input: await encodeArgs(inputs.failed),
        error: { name: "MODEL_CALL_FAILED" },
      },
    ],
    [
      "step-final",
      {
        runId: ownerRunId,
        stepId: "step-final",
        stepName: "step//eve@0.68.0//terminateChildSessionsStep",
        status: "completed",
        input: await encodeArgs(final),
      },
    ],
    [
      "step-later",
      {
        runId: ownerRunId,
        stepId: "step-later",
        stepName: "step//eve//unrecognizedNativeFact",
        status: "completed",
        input: await encodeArgs({ retained: true }),
        output: await serialization.dehydrateStepReturnValue(
          { actual: "retained-later-output" },
          ownerRunId,
          key,
        ),
      },
    ],
  ]);
  const event = (slot, eventType, stepId, eventData = {}) => ({
    runId: ownerRunId,
    eventId: slotToEventId(slot),
    eventType,
    ...(stepId === undefined ? {} : { correlationId: stepId }),
    eventData: {
      ...(steps.has(stepId) ? { stepName: steps.get(stepId).stepName } : {}),
      ...(eventType === "step_completed" ? { result: steps.get(stepId)?.output } : {}),
      ...eventData,
    },
    createdAt: new Date(10_000 - slot),
  });
  const events = [
    event(1, "run_created"),
    event(2, "step_started", "step-prior"),
    event(3, "step_completed", "step-prior"),
    event(4, "hook_received", "original-hook", { input: "exact-original-human-approval" }),
    event(5, "step_started", "step-failed"),
    event(6, "step_failed", "step-failed"),
    event(7, "step_started", "step-final"),
    event(8, "step_completed", "step-final"),
    event(9, "step_completed", "step-later"),
    event(10, options.status === "cancelled" ? "run_cancelled" : "run_failed"),
  ];
  const originalEntry = {
    kind: "initial",
    sessionTimeoutMs: false,
    retention: "default",
    serializedContext: { "eve.capabilities": { requestInput: true } },
  };
  const runInput = await serialization.dehydrateWorkflowArguments([originalEntry], ownerRunId, key);
  const calls = [];
  const world = {
    runs: {
      get: async (id, params) => {
        calls.push(["run", id, params]);
        return {
          runId: ownerRunId,
          status: options.status ?? "failed",
          deploymentId: "original-deployment",
          input: runInput,
          ...(options.expired === true ? { expiredAt: new Date(0) } : {}),
        };
      },
    },
    events: {
      list: async (params) => {
        calls.push(["events", params]);
        const start = params.pagination.cursor === undefined ? 0 : Number(params.pagination.cursor);
        const data = events.slice(start, start + 3);
        const end = start + data.length;
        return { data, hasMore: end < events.length, cursor: String(end) };
      },
    },
    steps: {
      get: async (runId, stepId, params) => {
        calls.push(["step", runId, stepId, params]);
        return steps.get(stepId);
      },
    },
  };
  const dependencies = {
    getWorld: async () => {
      calls.push(["world"]);
      return world;
    },
    resolveRunEncryptionKey: async (currentWorld, run) => {
      assert.equal(currentWorld, world);
      assert.equal(run.runId, ownerRunId);
      calls.push(["key"]);
      return key;
    },
    hydrateStepArguments: async (...args) => {
      calls.push(["hydrate-input"]);
      return serialization.hydrateStepArguments(...args);
    },
    hydrateStepReturnValue: async (...args) => {
      calls.push(["hydrate-output"]);
      return serialization.hydrateStepReturnValue(...args);
    },
    readDurableSession,
    requireEventSlot,
    now: () => 1000,
    async *readNativeEvents(id) {
      calls.push(["stream", id]);
      yield protocolResult;
      if (options.streamFailure === true) {
        throw new Error("private provider details never exposed");
      }
    },
  };
  const collect = createTerminalRecoveryCandidateCollector(dependencies);
  const input = {
    binding,
    authorizeOwner: async (authorized) => {
      calls.push(["authorize"]);
      assert.deepEqual(authorized, binding);
      assert.ok(Object.isFrozen(authorized));
    },
  };
  return {
    collect,
    input,
    calls,
    events,
    steps,
    world,
    dependencies,
    inputs,
    prior,
    final,
    key,
    originalEntry,
  };
};

test("native serialization preserves paired state, original approval, Drive and full frontier behind an opaque handle", async () => {
  const f = await fixture();
  const result = await f.collect(f.input);
  assert.equal(result.kind, "candidate");
  const payload = readTerminalRecoveryCandidate(result.candidate);
  assert.deepEqual(
    payload.candidates.map(({ kind }) => kind),
    ["terminal-finalizer-input", "failed-turn-input", "committed-turn-output"],
  );
  assert.deepEqual(payload.candidates[0].sessionState, f.final.sessionState);
  assert.deepEqual(payload.candidates[0].serializedContext, f.final.serializedContext);
  assert.deepEqual(payload.candidates[1].incoming, f.inputs.failed.input);
  assert.equal(
    payload.candidates[2].sessionState.snapshot.session.state["autograph-app-builder.workflow.v17"]
      .phase,
    "planned",
  );
  assert.deepEqual(payload.events, f.events);
  assert.equal(payload.candidates[0].origin.slot, 7);
  assert.equal(payload.candidates[1].origin.slot, 5);
  assert.equal(payload.frontier[1].events[0].eventType, "step_failed");
  assert.deepEqual(payload.frontier[2].events, f.events.slice(3));
  assert.deepEqual(payload.nativeEvents, [protocolResult]);
  assert.equal(
    payload.steps.some(({ step }) => step.stepId === "step-later"),
    false,
  );
  assert.deepEqual(
    await serialization.hydrateStepReturnValue(payload.events[8].eventData.result, ownerRunId),
    { actual: "retained-later-output" },
  );
  assert.deepEqual(result.inspection.uncertaintyReasons, ["failed-turn-effects-unreconciled"]);
  assert.equal(result.inspection.requiresTrustedReconciliation, true);
  assert.equal(result.inspection.candidates[1].incomingRuntimeResultCount, 1);
  assert.equal(f.calls[0][0], "authorize");
  const publicJson = JSON.stringify(result);
  for (const secret of [
    "original-drive",
    "private source",
    "exact-original-spec",
    "must-not-be-public",
    "original-approval",
    ownerRunId,
  ]) {
    assert.ok(!publicJson.includes(secret));
  }
  assert.throws(() => readTerminalRecoveryCandidate({ ...result.candidate }), /Unknown private/u);
  // Retain the relevant-state hydration and resource reuse assertions.
  const counts = Object.fromEntries(
    ["run", "key", "step", "hydrate-input", "hydrate-output", "stream"].map((kind) => [
      kind,
      f.calls.filter(([name]) => name === kind).length,
    ]),
  );
  assert.deepEqual(counts, {
    run: 1,
    key: 1,
    step: 3,
    "hydrate-input": 2,
    "hydrate-output": 1,
    stream: 1,
  });
  assert.equal(new Set(f.calls.filter(([name]) => name === "step").map((call) => call[2])).size, 3);
});

test("actual native encryption and hydration preserve original typed state", async () => {
  const f = await fixture({ encrypted: true });
  assert.ok(f.steps.get("step-prior").output instanceof Uint8Array);
  const result = await f.collect(f.input);
  const payload = readTerminalRecoveryCandidate(result.candidate);
  assert.deepEqual(payload.candidates[0].sessionState, f.final.sessionState);
  assert.deepEqual(
    await serialization.hydrateWorkflowArguments(
      payload.run.input,
      ownerRunId,
      payload.nativeRunKey,
    ),
    [f.originalEntry],
  );
});

test("completed native terminal step preserves its original paired input and real approval/results despite corrupt output", async () => {
  const f = await fixture({ status: "completed", encrypted: true });
  const corrupt = structuredClone(f.final);
  corrupt.sessionState.snapshot.session.history.push({
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "missing-output",
        toolName: "apply_app_creation",
        input: {},
      },
    ],
  });
  const terminal = f.steps.get("step-failed");
  terminal.status = "completed";
  terminal.output = await serialization.dehydrateStepReturnValue(
    { action: "done", output: "", ...corrupt },
    ownerRunId,
    f.key,
  );
  delete terminal.error;
  f.events[5].eventType = "step_completed";
  f.events[5].eventData.result = terminal.output;
  const result = await f.collect(f.input);
  const payload = readTerminalRecoveryCandidate(result.candidate);
  const original = payload.candidates.find(({ kind }) => kind === "completed-terminal-turn-input");
  assert.ok(original !== undefined);
  assert.deepEqual(original.sessionState, f.final.sessionState);
  assert.deepEqual(original.incoming, f.inputs.failed.input);
  assert.equal(original.origin.slot, 5);
  assert.equal(
    payload.frontier.find(({ origin }) => origin === original.origin).events.includes(f.events[5]),
    true,
  );
  assert.equal(
    payload.candidates.some(
      ({ kind, sessionState }) =>
        kind === "committed-turn-output" && sessionState.snapshot.session.history.length === 2,
    ),
    true,
  );
  assert.equal(
    result.inspection.uncertaintyReasons.includes("completed-terminal-effects-unreconciled"),
    true,
  );
  assert.equal(f.calls.filter(([kind]) => kind === "step").length, 3);
});

test("denied/missing canonical authorization makes no World or stream call", async () => {
  const f = await fixture();
  await assert.rejects(f.collect({ binding }), /Canonical server ownership/u);
  await assert.rejects(
    f.collect({
      binding,
      authorizeOwner: async () => {
        throw new Error("ownership-denied");
      },
    }),
    /ownership-denied/u,
  );
  assert.deepEqual(f.calls, []);
});

test("native production wiring imports successfully but denied authorization never opens a World", async () => {
  await assert.rejects(
    collectTerminalRecoveryCandidate({
      binding,
      authorizeOwner: async () => {
        throw new Error("synthetic-owner-denied");
      },
    }),
    /synthetic-owner-denied/u,
  );
});

test("legacy missing step-name metadata is resolved without hydrating unrelated facts", async () => {
  const f = await fixture();
  delete f.events[8].eventData.stepName;
  const result = await f.collect(f.input);
  const unrelated = readTerminalRecoveryCandidate(result.candidate).steps.find(
    ({ step }) => step.stepId === "step-later",
  );
  assert.ok(unrelated !== undefined);
  assert.equal(unrelated.arguments, undefined);
  assert.equal(unrelated.output, undefined);
  assert.equal(f.calls.filter(([kind]) => kind === "hydrate-input").length, 2);
  assert.equal(f.calls.filter(([kind]) => kind === "hydrate-output").length, 1);
});

test("authorization uses a frozen identity snapshot across awaits", async () => {
  const f = await fixture();
  const moving = { ...binding };
  await f.collect({
    binding: moving,
    authorizeOwner: async (authorized) => {
      moving.ownerRunId = "foreign";
      assert.equal(authorized.ownerRunId, ownerRunId);
    },
  });
  assert.equal(f.calls.find(([kind]) => kind === "run")[1], ownerRunId);
});

test("foreign logical checkpoints fail before the native stream is read", async () => {
  const f = await fixture();
  await assert.rejects(
    f.collect({
      ...f.input,
      binding: { ...binding, logicalSessionId: "foreign" },
      authorizeOwner: () => Promise.resolve(),
    }),
    /logical identity differs/u,
  );
  assert.ok(!f.calls.some(([kind]) => kind === "stream"));
});

test("terminal finalizer need not exist; genuine failed input and prior output remain candidates", async () => {
  const f = await fixture();
  const final = f.steps.get("step-final");
  final.stepName = "step//eve//otherFinalizer";
  for (const event of f.events) {
    if (event.correlationId === "step-final") {
      event.eventData.stepName = final.stepName;
    }
  }
  const result = await f.collect(f.input);
  const payload = readTerminalRecoveryCandidate(result.candidate);
  assert.deepEqual(
    payload.candidates.map(({ kind }) => kind),
    ["failed-turn-input", "committed-turn-output"],
  );
  assert.deepEqual(payload.candidates[0].incoming.runtimeResults.results, [
    protocolResult.data.result,
  ]);
});

test("unreadable final input retains the prior paired candidates and records uncertainty", async () => {
  const f = await fixture();
  f.steps.get("step-final").input = new Uint8Array([1, 2, 3]);
  const result = await f.collect(f.input);
  assert.deepEqual(
    result.inspection.candidates.map(({ kind }) => kind),
    ["failed-turn-input", "committed-turn-output"],
  );
  assert.equal(result.inspection.uncertaintyReasons.includes("native-step-input-unreadable"), true);
  assert.equal(
    readTerminalRecoveryCandidate(result.candidate).steps.find(
      ({ step }) => step.stepId === "step-final",
    ).step.input.length,
    3,
  );
});

test("partial native stream remains partial evidence with explicit uncertainty", async () => {
  const f = await fixture({ streamFailure: true });
  const result = await f.collect(f.input);
  assert.deepEqual(readTerminalRecoveryCandidate(result.candidate).nativeEvents, [protocolResult]);
  assert.equal(result.inspection.uncertaintyReasons.includes("native-stream-incomplete"), true);
  assert.ok(!JSON.stringify(result).includes("provider details"));
});

test("expired or non-failed runs return unavailable without decoding or stream reads", async () => {
  for (const options of [{ expired: true }, { status: "running" }, { status: "pending" }]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each isolated SDK fixture is verified in sequence.
    const f = await fixture(options);
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each isolated SDK fixture is verified in sequence.
    const result = await f.collect(f.input);
    assert.equal(result.kind, "unavailable");
    assert.ok(!f.calls.some(([kind]) => ["key", "events", "step", "stream"].includes(kind)));
  }
});

test("unknown/missing pairs are unavailable and never trigger a replay", async () => {
  const f = await fixture();
  for (const step of f.steps.values()) {
    step.stepName = "unrecognizedNativeStep";
  }
  for (const event of f.events) {
    if (f.steps.has(event.correlationId)) {
      event.eventData.stepName = "unrecognizedNativeStep";
    }
  }
  assert.deepEqual(await f.collect(f.input), {
    kind: "unavailable",
    reason: "paired-native-checkpoint-unavailable",
  });
});

test("stalled pagination and out-of-order native slots reject rather than select an arbitrary checkpoint", async () => {
  const f = await fixture();
  f.world.events.list = async () => ({ data: [f.events[0]], hasMore: true, cursor: "stuck" });
  await assert.rejects(f.collect(f.input), /pagination did not advance/u);
  f.world.events.list = async () => ({ data: [f.events[2], f.events[0]], hasMore: false });
  await assert.rejects(f.collect(f.input), /event order differs/u);
});

test("inspection never exposes malformed authored phase text", async () => {
  const f = await fixture();
  f.final.sessionState.snapshot.session.state["autograph-app-builder.workflow.v17"].phase =
    "private-untrusted-value";
  f.steps.get("step-final").input = await serialization.dehydrateStepArguments(
    { args: [f.final], closureVars: [] },
    ownerRunId,
  );
  const result = await f.collect(f.input);
  assert.equal(result.inspection.candidates[0].workflowPhase, "unavailable");
  assert.ok(!JSON.stringify(result).includes("private-untrusted-value"));
});

test("provider-cancelled terminal owner retains actual paired state and approval without effect authority", async () => {
  const f = await fixture({ status: "cancelled", encrypted: true });
  const result = await f.collect(f.input);
  assert.equal(result.kind, "candidate");
  const payload = readTerminalRecoveryCandidate(result.candidate);
  assert.equal(payload.run.status, "cancelled");
  assert.deepEqual(payload.candidates[0].sessionState, f.final.sessionState);
  assert.deepEqual(payload.candidates[1].incoming, f.inputs.failed.input);
  assert.deepEqual(payload.events, f.events);
  assert.deepEqual(
    payload.issues.map(({ reason }) => reason),
    ["failed-turn-effects-unreconciled"],
  );
  assert.deepEqual(
    readDurableSession(payload.candidates[0].sessionState).sandboxState,
    readDurableSession(f.final.sessionState).sandboxState,
  );
});
