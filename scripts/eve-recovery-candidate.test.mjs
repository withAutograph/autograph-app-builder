/* oxlint-disable eslint/require-await -- Async mocks preserve the actual World SDK promise contract. */
/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument -- Synthetic regression loads private installed native SDK modules by package path. */
/* oxlint-disable sonarjs/no-duplicate-string -- Exact native fixture identities are reused across provenance assertions. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { setImmediate as nextTurn } from "node:timers/promises";
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
const load = async (file) => await import(pathToFileURL(path.resolve(eve, file)).href);
const {
  collectTerminalRecoveryCandidate,
  createTerminalRecoveryCandidateCollector,
  readTerminalRecoveryCandidate,
} = await load(nativePath);
const serialization = await load("dist/src/compiled/@workflow/core/serialization.js");
const { readDurableSession, createDurableSessionState } = await load(
  "dist/src/execution/durable-session-store.js",
);
// Model World's documented resolveData:none contract: retain event metadata,
// leave opaque input/result/error/metadata/payload in the authoritative World.
const eventMetadata = (event) => {
  const data = { ...event.eventData };
  delete data.input;
  delete data.result;
  delete data.output;
  delete data.error;
  delete data.metadata;
  delete data.payload;
  return { ...event, eventData: data };
};
const slotToEventId = (slot) => `evnt_${String(slot).padStart(26, "0")}`;
const requireEventSlot = (id) => {
  assert.match(id, /^evnt_[0-9]{26}$/u);
  return Number(id.slice(5));
};

const ownerRunId = "wrun_00000000000000000000000001";
const logicalSessionId = ownerRunId;
const binding = { logicalSessionId, ownerRunId };
const exactOutput = {
  changedFileCount: 3,
  status: "applied",
  syntheticPrivate: "must-not-be-public",
};
const protocolResult = {
  data: {
    result: {
      callId: "actual-call",
      kind: "tool-result",
      output: exactOutput,
      toolName: "apply_app_creation",
    },
  },
  type: "action.result",
};
const makeState = (phase) =>
  // Use the real native state projection; no handcrafted binary serialization.
  createDurableSessionState({
    session: {
      agent: { system: "system", tools: [] },
      compaction: { recentWindowSize: 10, threshold: 10_000 },
      continuationToken: "original-continuation",
      history: [{ content: "Original product brief", role: "user" }],
      sandboxState: {
        session: {
          providerName: "vercel",
          state: { name: "original-sandbox", workspaceDrive: { id: "original-drive" } },
          stateProtocolVersion: 1,
        },
      },
      sessionId: logicalSessionId,
      state: {
        "autograph-app-builder.private-apply-authority.v1": {
          grant: {
            appId: "spend-review",
            appSpecDigest: "exact-original-spec",
            proposalDigest: "exact-original-proposal",
            sessionId: logicalSessionId,
            workspaceId: "original-workspace",
          },
          pending: [],
        },
        "autograph-app-builder.staged-implementation.v1": {
          files: [{ content: "original private source", path: "app.ts" }],
        },
        "autograph-app-builder.workflow.v17": {
          appSpec: { appId: "spend-review", digest: "exact-original-spec" },
          phase,
          version: 17,
          workspace: { workspaceId: "original-workspace" },
        },
        "eve.runtime.pendingCoordinationBatch": {
          event: { sequence: 1, stepIndex: 2, turnId: "turn-original" },
          responseMessages: [],
          runtimeActions: [],
          tasks: [{ callId: "actual-call" }],
        },
      },
    },
  });
const pair = (phase) => ({
  serializedContext: {
    "eve.bundle": { fixture: true },
    "eve.sessionId": logicalSessionId,
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
        { inputResponses: [{ approved: true, kind: "approval", requestId: "original-approval" }] },
      ],
    },
    runtimeResults: { results: [protocolResult.data.result] },
  };
  const inputs = { failed: { ...final, input: incoming }, final, prior };
  const encodeArgs = (input) =>
    serialization.dehydrateStepArguments({ args: [input], closureVars: [] }, ownerRunId, key);
  const steps = new Map([
    [
      "step-prior",
      {
        input: await encodeArgs(prior),
        output: await serialization.dehydrateStepReturnValue(
          { action: "park", ...prior },
          ownerRunId,
          key,
        ),
        runId: ownerRunId,
        status: "completed",
        stepId: "step-prior",
        stepName: "step//eve@0.68.0//turnStep",
      },
    ],
    [
      "step-failed",
      {
        error: { name: "MODEL_CALL_FAILED" },
        input: await encodeArgs(inputs.failed),
        runId: ownerRunId,
        status: "failed",
        stepId: "step-failed",
        stepName: "step//eve@0.68.0//turnStep",
      },
    ],
    [
      "step-final",
      {
        input: await encodeArgs(final),
        runId: ownerRunId,
        status: "completed",
        stepId: "step-final",
        stepName: "step//eve@0.68.0//terminateChildSessionsStep",
      },
    ],
    [
      "step-later",
      {
        input: await encodeArgs({ retained: true }),
        output: await serialization.dehydrateStepReturnValue(
          { actual: "retained-later-output" },
          ownerRunId,
          key,
        ),
        runId: ownerRunId,
        status: "completed",
        stepId: "step-later",
        stepName: "step//eve//unrecognizedNativeFact",
      },
    ],
  ]);
  const event = (slot, eventType, stepId, eventData = {}) => ({
    eventId: slotToEventId(slot),
    eventType,
    runId: ownerRunId,
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
    retention: "default",
    serializedContext: { "eve.capabilities": { requestInput: true } },
    sessionTimeoutMs: false,
  };
  const runInput = await serialization.dehydrateWorkflowArguments([originalEntry], ownerRunId, key);
  const calls = [];
  const world = {
    events: {
      list: async (params) => {
        calls.push(["events", params]);
        const start = params.pagination.cursor === undefined ? 0 : Number(params.pagination.cursor);
        const data = events
          .slice(start, start + 3)
          .map((nativeEvent) =>
            params.resolveData === "none" ? eventMetadata(nativeEvent) : nativeEvent,
          );
        const end = start + data.length;
        return { cursor: String(end), data, hasMore: end < events.length };
      },
    },
    runs: {
      get: async (id, params) => {
        calls.push(["run", id, params]);
        const result = {
          deploymentId: "original-deployment",
          input: runInput,
          runId: ownerRunId,
          status: options.status ?? "failed",
        };
        if (options.expired === true) result.expiredAt = new Date(0);
        return result;
      },
    },
    steps: {
      get: async (runId, stepId, params) => {
        calls.push(["step", runId, stepId, params]);
        const step = steps.get(stepId);
        return params.resolveData === "none"
          ? { ...step, input: undefined, output: undefined }
          : step;
      },
    },
  };
  const dependencies = {
    getWorld: async () => {
      calls.push(["world"]);
      return world;
    },
    hydrateStepArguments: async (...args) => {
      calls.push(["hydrate-input"]);
      return serialization.hydrateStepArguments(...args);
    },
    hydrateStepReturnValue: async (...args) => {
      calls.push(["hydrate-output"]);
      return serialization.hydrateStepReturnValue(...args);
    },
    now: () => 1000,
    readDurableSession,
    async *readNativeEvents(id) {
      calls.push(["stream", id]);
      yield protocolResult;
      if (options.streamFailure === true) {
        throw new Error("private provider details never exposed");
      }
    },
    requireEventSlot,
    resolveRunEncryptionKey: async (currentWorld, run) => {
      assert.equal(currentWorld, world);
      assert.equal(run.runId, ownerRunId);
      calls.push(["key"]);
      return key;
    },
  };
  const collect = createTerminalRecoveryCandidateCollector(dependencies);
  const input = {
    authorizeOwner: async (authorized) => {
      calls.push(["authorize"]);
      assert.deepEqual(authorized, binding);
      assert.ok(Object.isFrozen(authorized));
    },
    binding,
  };
  return {
    calls,
    collect,
    dependencies,
    events,
    final,
    input,
    inputs,
    key,
    originalEntry,
    prior,
    steps,
    world,
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
  assert.deepEqual(payload.events, f.events.map(eventMetadata));
  assert.equal(payload.candidates[0].origin.slot, 7);
  assert.equal(payload.candidates[1].origin.slot, 5);
  assert.equal(payload.frontier[1].events[0].eventType, "step_failed");
  assert.deepEqual(payload.frontier[2].events, f.events.slice(3).map(eventMetadata));
  assert.deepEqual(payload.nativeEvents, [protocolResult]);
  assert.equal(
    payload.steps.some(({ step }) => step.stepId === "step-later"),
    false,
  );
  assert.deepEqual(
    await serialization.hydrateStepReturnValue(f.events[8].eventData.result, ownerRunId),
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
    "hydrate-input": 2,
    "hydrate-output": 1,
    key: 1,
    run: 1,
    step: 3,
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
  const f = await fixture({ encrypted: true, status: "completed" });
  const corrupt = structuredClone(f.final);
  corrupt.sessionState.snapshot.session.history.push({
    content: [
      {
        input: {},
        toolCallId: "missing-output",
        toolName: "apply_app_creation",
        type: "tool-call",
      },
    ],
    role: "assistant",
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
    payload.frontier
      .find(({ origin }) => origin === original.origin)
      .events.some((event) => event.eventId === f.events[5].eventId),
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
      authorizeOwner: async () => {
        throw new Error("ownership-denied");
      },
      binding,
    }),
    /ownership-denied/u,
  );
  assert.deepEqual(f.calls, []);
});

test("native production wiring imports successfully but denied authorization never opens a World", async () => {
  await assert.rejects(
    collectTerminalRecoveryCandidate({
      authorizeOwner: async () => {
        throw new Error("synthetic-owner-denied");
      },
      binding,
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
    authorizeOwner: async (authorized) => {
      moving.ownerRunId = "foreign";
      assert.equal(authorized.ownerRunId, ownerRunId);
    },
    binding: moving,
  });
  assert.equal(f.calls.find(([kind]) => kind === "run")[1], ownerRunId);
});

test("foreign logical checkpoints fail before the native stream is read", async () => {
  const f = await fixture();
  await assert.rejects(
    f.collect({
      ...f.input,
      authorizeOwner: async () => {
        // Permit the owner so the logical identity check is exercised.
      },
      binding: { ...binding, logicalSessionId: "foreign" },
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
  assert.equal(f.steps.get("step-final").input.length, 3);
  assert.equal(
    readTerminalRecoveryCandidate(result.candidate).steps.find(
      ({ step }) => step.stepId === "step-final",
    ).step.input,
    undefined,
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

test("explicit parked preflight traverses the real collector and owner resolver", async () => {
  await Promise.all(
    ["pending", "running"].map(async (status) => {
      const f = await fixture({ status });
      const result = await f.collect({ ...f.input, allowParked: true });
      assert.equal(result.kind, "candidate");
      assert.equal(
        readTerminalRecoveryCandidate(result.candidate).checkpointOwnerRunId,
        ownerRunId,
      );
      assert.ok(f.calls.some(([kind]) => kind === "step"));
    }),
  );
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
  f.world.events.list = async () => ({ cursor: "stuck", data: [f.events[0]], hasMore: true });
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
  const f = await fixture({ encrypted: true, status: "cancelled" });
  const result = await f.collect(f.input);
  assert.equal(result.kind, "candidate");
  const payload = readTerminalRecoveryCandidate(result.candidate);
  assert.equal(payload.run.status, "cancelled");
  assert.deepEqual(payload.candidates[0].sessionState, f.final.sessionState);
  assert.deepEqual(payload.candidates[1].incoming, f.inputs.failed.input);
  assert.deepEqual(payload.events, f.events.map(eventMetadata));
  assert.deepEqual(
    payload.issues.map(({ reason }) => reason),
    ["failed-turn-effects-unreconciled"],
  );
  assert.deepEqual(
    readDurableSession(payload.candidates[0].sessionState).sandboxState,
    readDurableSession(f.final.sessionState).sandboxState,
  );
});

const { readTerminalNativeEventsSnapshot } = await load(nativePath);
const frameNativeHistory = async (values, key) => {
  const frames = [];
  const input = new ReadableStream({
    start(controller) {
      for (const value of values) {
        controller.enqueue(value);
      }
      controller.close();
    },
  });
  for await (const frame of input.pipeThrough(
    serialization.getSerializeStream(serialization.getWorkflowReducers(globalThis), key),
  )) {
    frames.push(frame);
  }
  return frames.map((data, index) => ({ data, index }));
};
const snapshotFixture = async (fault, packing = "split") => {
  const f = await fixture({ encrypted: true, status: "cancelled" });
  const native = Array.from({ length: 5 }, (_, index) => ({
    data: { text: `original private native text ${index}` },
    type: "text.delta",
  }));
  const chunks = await frameNativeHistory(
    native.map((event) => new TextEncoder().encode(`${JSON.stringify(event)}\n`)),
    f.key,
  );
  const framed = chunks.map(({ data }) => new Uint8Array(data));
  if (fault === "missing") {
    framed.splice(2, 1);
  }
  if (fault === "truncated") {
    framed[4] = framed[4].slice(0, -1);
  }
  if (fault === "header-eof") {
    framed[4] = framed[4].slice(0, 2);
  }
  if (fault === "ciphertext") {
    framed[2][framed[2].length - 1] = (framed[2].at(-1) + 1) % 256;
  }
  if (fault === "zero-frame") {
    framed[2].fill(0, 0, 4);
  }
  if (fault === "extra-frame") {
    framed.push(framed[0]);
  }
  const size = framed.reduce((total, frame) => total + frame.length, 0);
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const frame of framed) {
    joined.set(frame, offset);
    offset += frame.length;
  }
  const wire = [];
  if (packing === "coalesced") {
    wire.push(fault === "transport" ? joined.subarray(0, Math.floor(joined.length / 2)) : joined);
  } else {
    for (let index = 0; index < joined.length; index += 3) {
      wire.push(joined.subarray(index, index + 3));
    }
  }
  let infos = 0;
  let cancelled = false;
  f.world.streams = {
    async get(id, name, startIndex) {
      f.calls.push(["snapshot-stream", id, name]);
      assert.equal(startIndex, 0);
      let index = 0;
      return new ReadableStream({
        cancel() {
          cancelled = true;
          f.calls.push(["snapshot-cancel"]);
          if (fault === "cancel") {
            throw new Error("private cancellation failure");
          }
        },
        pull(controller) {
          if (index < wire.length) {
            controller.enqueue(wire[index]);
            index += 1;
          } else if (fault === "transport") {
            controller.error(new Error("private transport failure"));
          } else if (
            fault !== undefined &&
            !["changed-tail", "changed-done", "cancel"].includes(fault)
          ) {
            controller.close();
          }
          // A successful source remains open forever: the finite reader must cancel it.
        },
      });
    },
    getChunks() {
      throw new Error("Serial pagination must not be used.");
    },
    async getInfo(id, name) {
      f.calls.push(["snapshot-info", id, name]);
      assert.equal(id, ownerRunId);
      assert.equal(name, `${ownerRunId.replace("wrun_", "strm_")}_user`);
      infos += 1;
      return {
        done: fault === "changed-done" && infos > 1,
        tailIndex: chunks.length - 1 + (fault === "changed-tail" && infos > 1 ? 1 : 0),
      };
    },
  };
  f.dependencies.readNativeEvents = (id) => readTerminalNativeEventsSnapshot(f.world, id, f.key);
  return { ...f, cancelled: () => cancelled, native };
};

for (const packing of ["split", "coalesced"]) {
  test(`finite encrypted unclosed snapshot counts native frames across ${packing} network reads`, async () => {
    const f = await snapshotFixture(undefined, packing);
    const result = await f.collect(f.input);
    const payload = readTerminalRecoveryCandidate(result.candidate);
    assert.deepEqual(payload.nativeEvents, f.native);
    assert.deepEqual(payload.candidates[0].sessionState, f.final.sessionState);
    assert.deepEqual(payload.candidates[0].serializedContext, f.final.serializedContext);
    assert.deepEqual(payload.candidates[1].incoming, f.inputs.failed.input);
    assert.equal(f.calls.filter(([type]) => type === "snapshot-stream").length, 1);
    assert.equal(f.calls.filter(([type]) => type === "snapshot-info").length, 2);
    assert.equal(f.cancelled(), true);
    assert.equal(
      payload.issues.some(({ reason }) => reason === "native-stream-incomplete"),
      false,
    );
  });
}
for (const fault of [
  "truncated",
  "header-eof",
  "missing",
  "changed-tail",
  "changed-done",
  "ciphertext",
  "zero-frame",
  "extra-frame",
  "transport",
  "cancel",
]) {
  test(`incomplete or changed native snapshot fails closed: ${fault}`, async () => {
    const f = await snapshotFixture(fault, "coalesced");
    const result = await f.collect(f.input);
    const payload = readTerminalRecoveryCandidate(result.candidate);
    assert.deepEqual(payload.nativeEvents, []);
    assert.equal(
      payload.issues.some(({ reason }) => reason === "native-stream-incomplete"),
      true,
    );
  });
}

const join = (parts) => {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
};

const reconnectingSnapshot = async (mode) => {
  const native = Array.from({ length: 5 }, (_, index) => ({
    data: { text: index < 2 ? "same valid repeated value" : `private ${index}` },
    type: "text.delta",
  }));
  const key = await serialization.deriveRunPayloadKeys(new Uint8Array(32).fill(7));
  const chunks = await frameNativeHistory(
    native.map((event) => new TextEncoder().encode(`${JSON.stringify(event)}\n`)),
    key,
  );
  let partial = new Uint8Array();
  if (mode === "partial-header") {
    partial = chunks[2].data.subarray(0, 2);
  }
  if (mode === "partial-payload") {
    partial = chunks[2].data.subarray(0, 12);
  }
  const first =
    mode === "zero-progress"
      ? chunks[0].data.subarray(0, 2)
      : join([chunks[0].data, chunks[1].data, partial]);
  const starts = [];
  let infos = 0;
  let cancelled = false;
  const world = {
    streams: {
      async get(_run, _name, startIndex) {
        starts.push(startIndex);
        assert.equal(startIndex, starts.length === 1 ? 0 : 2);
        let sent = false;
        return new ReadableStream({
          cancel() {
            cancelled = true;
          },
          async pull(controller) {
            if (starts.length === 2 && mode === "stalled-resume") {
              controller.close();
              return;
            }
            if (!sent) {
              sent = true;
              controller.enqueue(
                starts.length === 1
                  ? first
                  : join(chunks.slice(startIndex).map(({ data }) => data)),
              );
            } else if (starts.length === 1) {
              await nextTurn();
              if (mode === "transport-error") {
                controller.error(new Error("private transport disconnect"));
              } else {
                controller.close();
              }
            }
          },
        });
      },
      async getInfo() {
        infos += 1;
        return {
          done: mode === "changed-done" && infos > 1,
          tailIndex: chunks.length - 1 + (mode === "changed-tail" && infos > 1 ? 1 : 0),
        };
      },
    },
  };
  return { cancelled: () => cancelled, key, native, starts, world };
};
for (const mode of ["clean-eof", "partial-header", "partial-payload", "transport-error"]) {
  test(`finite reader resumes only the interrupted native frame after ${mode}`, async () => {
    const f = await reconnectingSnapshot(mode);
    const events = [];
    for await (const event of readTerminalNativeEventsSnapshot(f.world, ownerRunId, f.key)) {
      events.push(event);
    }
    assert.deepEqual(events, f.native);
    assert.deepEqual(f.starts, [0, 2]);
    assert.equal(f.cancelled(), true);
  });
}
for (const mode of ["zero-progress", "stalled-resume", "changed-tail", "changed-done"]) {
  test(`finite reconnect refuses ${mode} without yielding a partial native prefix`, async () => {
    const f = await reconnectingSnapshot(mode);
    const events = [];
    await assert.rejects(async () => {
      for await (const event of readTerminalNativeEventsSnapshot(f.world, ownerRunId, f.key)) {
        events.push(event);
      }
    }, /Native stream made no progress|Changed native stream/u);
    assert.deepEqual(events, []);
    assert.deepEqual(f.starts, mode === "stalled-resume" ? [0, 2] : [0]);
  });
}

test("reconnect preserves a UTF-8 NDJSON value split across complete native frames", async () => {
  const native = { data: { text: "private 😃 value" }, type: "text.delta" };
  const bytes = new TextEncoder().encode(`${JSON.stringify(native)}\n`);
  const cut = bytes.indexOf(240) + 2;
  assert.ok(cut > 2);
  const chunks = await frameNativeHistory([bytes.subarray(0, cut), bytes.subarray(cut)]);
  const starts = [];
  const world = {
    streams: {
      async get(_run, _name, startIndex) {
        starts.push(startIndex);
        assert.equal(startIndex, starts.length - 1);
        let sent = false;
        return new ReadableStream({
          pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue(chunks[startIndex].data);
            } else if (startIndex === 0) {
              controller.close();
            }
          },
        });
      },
      async getInfo() {
        return { done: false, tailIndex: 1 };
      },
    },
  };
  const events = [];
  for await (const event of readTerminalNativeEventsSnapshot(world, ownerRunId)) {
    events.push(event);
  }
  assert.deepEqual(events, [native]);
  assert.deepEqual(starts, [0, 1]);
});

for (const interrupted of [false, true]) {
  test(`finite reader retains all 171094 native frames across transport EOFs (interrupted=${interrupted})`, async () => {
    const frameCount = 171_094;
    const native = { data: { text: "private native content" }, type: "text.delta" };
    const [frame] = await frameNativeHistory([
      new TextEncoder().encode(`${JSON.stringify(native)}\n`),
    ]);
    assert.notEqual(frame, undefined);
    let cancelled = false;
    let infos = 0;
    const starts = [];
    const world = {
      streams: {
        async get(_run, _name, startIndex) {
          starts.push(startIndex);
          assert.equal(startIndex, interrupted ? (starts.length - 1) * 75_274 : 0);
          let sent = startIndex;
          const end = interrupted ? Math.min(startIndex + 75_274, frameCount) : frameCount;
          return new ReadableStream({
            cancel() {
              cancelled = true;
            },
            pull(controller) {
              if (sent === end) {
                if (end !== frameCount) {
                  controller.close();
                }
                return;
              }
              const count = Math.min(256, end - sent);
              const bytes = new Uint8Array(count * frame.data.length);
              for (let index = 0; index < count; index += 1) {
                bytes.set(frame.data, index * frame.data.length);
              }
              sent += count;
              controller.enqueue(bytes);
            },
          });
        },
        async getInfo() {
          infos += 1;
          return { done: false, tailIndex: frameCount - 1 };
        },
      },
    };
    let observed = 0;
    for await (const event of readTerminalNativeEventsSnapshot(world, ownerRunId)) {
      assert.deepEqual(event, native);
      observed += 1;
    }
    assert.equal(observed, frameCount);
    assert.equal(cancelled, true);
    assert.deepEqual(starts, interrupted ? [0, 75_274, 150_548] : [0]);
    assert.equal(infos, interrupted ? 4 : 2);
  }, 30_000);
}

test("an empty unclosed captured tail never opens a live stream", async () => {
  let infos = 0;
  const world = {
    streams: {
      get() {
        throw new Error("empty tail must not follow stream");
      },
      async getInfo() {
        infos += 1;
        return { done: false, tailIndex: -1 };
      },
    },
  };
  const events = [];
  for await (const event of readTerminalNativeEventsSnapshot(world, ownerRunId)) {
    events.push(event);
  }
  assert.deepEqual(events, []);
  assert.equal(infos, 2);
});

for (const status of ["running", "pending"]) {
  test(`nonterminal ${status} owner never reads native snapshot`, async () => {
    const f = await snapshotFixture();
    const { get } = f.world.runs;
    f.world.runs.get = async (...args) => ({ ...(await get(...args)), status });
    const result = await f.collect(f.input);
    assert.partialDeepStrictEqual(result, { kind: "unavailable", reason: "source-not-terminal" });
    assert.equal(
      f.calls.some(([type]) => type.startsWith("snapshot-") === true),
      false,
    );
  });
}

test("metadata collection retains every frontier and hydrated checkpoint without duplicate step blobs", async () => {
  const f = await fixture({ encrypted: true });
  const rawInput = new Uint8Array(f.steps.get("step-final").input);
  const rawOutput = new Uint8Array(f.steps.get("step-prior").output);
  const result = await f.collect(f.input);
  const payload = readTerminalRecoveryCandidate(result.candidate);
  assert.deepEqual(
    payload.events.map(({ eventId }) => eventId),
    f.events.map(({ eventId }) => eventId),
  );
  assert.equal(
    f.calls
      .filter(([kind]) => kind === "events")
      .every(([, params]) => params.resolveData === "none"),
    true,
  );
  assert.equal(
    payload.steps.every(({ step }) => step.input === undefined && step.output === undefined),
    true,
  );
  assert.deepEqual(
    payload.steps.find(({ step }) => step.stepId === "step-final").arguments.args[0],
    f.final,
  );
  assert.deepEqual(
    payload.steps.find(({ step }) => step.stepId === "step-prior").output.sessionState,
    f.prior.sessionState,
  );
  assert.deepEqual(f.steps.get("step-final").input, rawInput);
  assert.deepEqual(f.steps.get("step-prior").output, rawOutput);
});

test("legacy missing names read metadata before hydrating only relevant native steps", async () => {
  const f = await fixture({ encrypted: true });
  for (const nativeEvent of f.events) {
    if (["step-prior", "step-later"].includes(nativeEvent.correlationId)) {
      delete nativeEvent.eventData.stepName;
    }
  }
  const result = await f.collect(f.input);
  const payload = readTerminalRecoveryCandidate(result.candidate);
  const relevantReads = f.calls
    .filter((call) => call[0] === "step" && call[2] === "step-prior")
    .map((call) => call[3].resolveData);
  assert.equal(relevantReads[0], "none");
  assert.equal(relevantReads.filter((mode) => mode === "all").length, 1);
  const unrelatedReads = f.calls
    .filter((call) => call[0] === "step" && call[2] === "step-later")
    .map((call) => call[3].resolveData);
  assert.equal(unrelatedReads.length > 0, true);
  assert.equal(
    unrelatedReads.every((mode) => mode === "none"),
    true,
  );
  assert.deepEqual(
    payload.candidates.find(({ kind }) => kind === "committed-turn-output").sessionState,
    f.prior.sessionState,
  );
});

const { createRecoveryHistoryInterner } = await load(
  "dist/src/execution/session/recovery-history-interning.js",
);
const memoryCheckpoint = (history, state = {}) => ({
  serializedContext: { "eve.sessionId": logicalSessionId },
  sessionState: {
    emissionState: { sequence: 1, stepIndex: 1, turnId: "original" },
    sessionId: logicalSessionId,
    snapshot: { session: { history, sessionId: logicalSessionId, state } },
    version: 1,
  },
});
test("646 independent checkpoint histories retain every value while sharing immutable equal message nodes", () => {
  const intern = createRecoveryHistoryInterner(logicalSessionId);
  const history = Array.from({ length: 16 }, (_, index) => ({
    content: [
      {
        output: { type: "json", value: "x".repeat(1024) },
        toolCallId: `original-${index}`,
        type: "tool-result",
      },
    ],
    role: "tool",
  }));
  const records = Array.from({ length: 646 }, (_, index) => {
    const original = memoryCheckpoint(structuredClone(history), {
      grant: { original: index },
    });
    const shared = intern.checkpoint(original);
    assert.deepEqual(shared, original);
    assert.equal(shared.serializedContext, original.serializedContext);
    assert.equal(
      shared.sessionState.snapshot.session.state,
      original.sessionState.snapshot.session.state,
    );
    assert.notEqual(
      shared.sessionState.snapshot.session.history,
      original.sessionState.snapshot.session.history,
    );
    return shared;
  });
  assert.equal(records.length, 646);
  const uniqueMessages = new Set(
    records.flatMap((value) => value.sessionState.snapshot.session.history),
  );
  assert.equal(uniqueMessages.size, history.length);
  const [firstRecord] = records;
  const [shared] = firstRecord.sessionState.snapshot.session.history;
  assert.equal(Object.isFrozen(shared), true);
  assert.equal(Object.isFrozen(shared.content[0].output), true);
  assert.throws(() => {
    shared.content[0].output.value = "changed";
  }, TypeError);
  assert.equal(
    records[645].sessionState.snapshot.session.history[0].content[0].output.value,
    "x".repeat(1024),
  );
});
test("mutable context, session and permission aliases remain untouched while historical evidence is immutable", () => {
  const message = {
    content: [{ approvalId: "original", approved: true, type: "tool-approval-response" }],
    role: "tool",
  };
  const history = [message];
  const permission = { historicalMessage: message, mutableGrant: true };
  const original = memoryCheckpoint(history, permission);
  original.serializedContext.originalSession = original.sessionState.snapshot.session;
  original.serializedContext.originalHistory = history;
  const shared = createRecoveryHistoryInterner(logicalSessionId).checkpoint(original);
  assert.equal(shared.serializedContext, original.serializedContext);
  assert.equal(shared.sessionState.snapshot.session.state, permission);
  assert.equal(original.sessionState.snapshot.session.history, history);
  assert.equal(shared.serializedContext.originalHistory, history);
  assert.notEqual(shared.sessionState.snapshot.session, original.sessionState.snapshot.session);
  assert.notEqual(shared.sessionState.snapshot.session.history[0], message);
  permission.mutableGrant = false;
  permission.historicalMessage.content[0].approved = false;
  history.push({ content: "later live state", role: "user" });
  assert.equal(Object.isFrozen(permission), false);
  assert.equal(Object.isFrozen(message), false);
  assert.equal(shared.sessionState.snapshot.session.state.mutableGrant, false);
  assert.equal(shared.sessionState.snapshot.session.history.length, 1);
  assert.equal(shared.sessionState.snapshot.session.history[0].content[0].approved, true);
});
test("different approvals and results never share a canonical history node", () => {
  const intern = createRecoveryHistoryInterner(logicalSessionId);
  const values = [
    {
      content: [{ approvalId: "original", approved: true, type: "tool-approval-response" }],
      role: "tool",
    },
    {
      content: [{ approvalId: "original", approved: false, type: "tool-approval-response" }],
      role: "tool",
    },
    {
      content: [{ output: { value: "one" }, toolCallId: "original", type: "tool-result" }],
      role: "tool",
    },
    {
      content: [{ output: { value: "two" }, toolCallId: "original", type: "tool-result" }],
      role: "tool",
    },
  ];
  const shared = values.map(
    (message) =>
      intern.checkpoint(memoryCheckpoint([message])).sessionState.snapshot.session.history[0],
  );
  assert.equal(new Set(shared).size, values.length);
  assert.deepEqual(shared, values);
});
test("unsupported branded, cyclic and non-JSON-safe history values stay unchanged without invoking accessors", () => {
  let accessed = 0;
  const getter = {
    get content() {
      accessed += 1;
      return "must-not-read";
    },
    role: "assistant",
  };
  const proxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        accessed += 1;
        throw new Error("must-not-read");
      },
    },
  );
  const cyclic = { role: "assistant" };
  cyclic.content = cyclic;
  class Branded {
    role = "assistant";
    content = "branded";
  }
  const messages = [
    getter,
    proxy,
    cyclic,
    new Branded(),
    { content: new Map(), role: "tool" },
    { content: undefined, role: "tool" },
    { content: new Uint8Array([1]), role: "tool" },
    { content: { kind: "native-recovery-transport-reference", value: "private" }, role: "tool" },
  ];
  const shared = createRecoveryHistoryInterner(logicalSessionId).checkpoint(
    memoryCheckpoint(messages),
  );
  for (const [index, message] of messages.entries()) {
    assert.equal(shared.sessionState.snapshot.session.history[index], message);
  }
  assert.equal(accessed, 0);
});
test("real encrypted checkpoint hydration shares history but preserves all paired origins and authority", async () => {
  const f = await fixture({ encrypted: true });
  const result = await f.collect(f.input);
  const payload = readTerminalRecoveryCandidate(result.candidate);
  const messages = payload.candidates.map(
    (value) => readDurableSession(value.sessionState).history[0],
  );
  assert.equal(new Set(messages).size, 1);
  assert.equal(Object.isFrozen(messages[0]), true);
  assert.deepEqual(payload.candidates[0].sessionState, f.final.sessionState);
  assert.deepEqual(payload.candidates[0].serializedContext, f.final.serializedContext);
  assert.deepEqual(payload.candidates[1].incoming, f.inputs.failed.input);
});

test("context primitive canonicalization preserves mutable identities, descriptors and unsupported branches", () => {
  const sharedPermission = { issuer: "same-issuer", scope: "original" };
  let getterReads = 0;
  const context = { array: ["same-issuer"], permission: sharedPermission, readonly: "same-issuer" };
  Object.defineProperty(context, "readonly", {
    enumerable: true,
    value: "same-issuer",
    writable: false,
  });
  Object.defineProperty(context, "accessor", {
    enumerable: true,
    get() {
      getterReads += 1;
      return "must-not-read";
    },
  });
  context.self = context;
  context.branded = new Map([["issuer", "same-issuer"]]);
  const beforeKeys = Reflect.ownKeys(context);
  const readonly = Object.getOwnPropertyDescriptor(context, "readonly");
  const value = memoryCheckpoint([], { grant: sharedPermission });
  value.serializedContext = context;
  const intern = createRecoveryHistoryInterner(logicalSessionId);
  const result = intern.checkpoint(value);
  assert.equal(result.serializedContext, context);
  assert.equal(result.serializedContext.permission, sharedPermission);
  assert.equal(result.sessionState.snapshot.session.state.grant, sharedPermission);
  assert.deepEqual(Reflect.ownKeys(context), beforeKeys);
  assert.deepEqual(Object.getOwnPropertyDescriptor(context, "readonly"), readonly);
  assert.equal(context.self, context);
  assert.equal(getterReads, 0);
  sharedPermission.scope = "revoked";
  assert.equal(result.serializedContext.permission.scope, "revoked");
  assert.equal(Object.isFrozen(sharedPermission), false);
});

test("independently decoded retained contexts use less heap after exact primitive replacement", () => {
  const moduleUrl = pathToFileURL(
    path.resolve(eve, "dist/src/execution/session/recovery-history-interning.js"),
  ).href;
  const script = `
    import { createRecoveryHistoryInterner } from ${JSON.stringify(moduleUrl)};
    const optimized = process.argv[1] === "optimized";
    const intern = createRecoveryHistoryInterner("synthetic");
    const wire = JSON.stringify({ source: "synthetic-fixture-" + "x".repeat(262144), grant: { issuer: "synthetic-owner", active: true } });
    global.gc(); const before = process.memoryUsage().heapUsed;
    const contexts = [];
    for (let index = 0; index < 192; index++) {
      const context = JSON.parse(wire);
      const grant = context.grant;
      if (optimized) {
        const output = intern.checkpoint({ serializedContext: context });
        if (output.serializedContext !== context || context.grant !== grant) throw new Error("identity changed");
      }
      contexts.push(context);
    }
    global.gc(); global.gc();
    console.log(JSON.stringify({ count: contexts.length, bytes: process.memoryUsage().heapUsed - before,
      valuesEqual: contexts[0].source === contexts.at(-1).source, writable: !Object.isFrozen(contexts[0].grant) }));
  `;
  const run = (mode) => {
    const result = spawnSync(
      process.execPath,
      ["--expose-gc", "--max-old-space-size=128", "--input-type=module", "-e", script, mode],
      { encoding: "utf-8", env: { NODE_NO_WARNINGS: "1" } },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const baseline = run("baseline");
  const optimized = run("optimized");
  assert.equal(baseline.count, 192);
  assert.equal(optimized.count, 192);
  assert.equal(optimized.valuesEqual, true);
  assert.equal(optimized.writable, true);
  assert.equal(baseline.bytes > 32 * 1024 * 1024, true);
  assert.equal(optimized.bytes < baseline.bytes * 0.4, true);
});

test("actual collector identifies the exact authority-anchor status refusal without leaking unknown status", async () => {
  await Promise.all(
    ["waiting", "private-canary-status"].map(async (status) => {
      const f = await fixture({ status });
      const result = await f.collect({ ...f.input, allowParked: true });
      assert.deepEqual(result, {
        boundary: {
          allowParked: true,
          stage: "authority_anchor",
          status: status === "waiting" ? "waiting" : "other",
        },
        kind: "unavailable",
        reason: "source-not-terminal",
      });
      assert.equal(JSON.stringify(result).includes("private-canary"), false);
    }),
  );
});
