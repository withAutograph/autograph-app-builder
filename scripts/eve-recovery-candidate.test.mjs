/* oxlint-disable eslint/require-await -- Async mocks preserve the actual World SDK promise contract. */
/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument -- Synthetic regression loads private installed native SDK modules by package path. */
/* oxlint-disable sonarjs/no-duplicate-string -- Exact native fixture identities are reused across provenance assertions. */
import assert from "node:assert/strict";
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
        const data = events
          .slice(start, start + 3)
          .map((nativeEvent) =>
            params.resolveData === "none" ? eventMetadata(nativeEvent) : nativeEvent,
          );
        const end = start + data.length;
        return { data, hasMore: end < events.length, cursor: String(end) };
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
  return frames.map((data, index) => ({ index, data }));
};
const snapshotFixture = async (fault, packing = "split") => {
  const f = await fixture({ status: "cancelled", encrypted: true });
  const native = Array.from({ length: 5 }, (_, index) => ({
    type: "text.delta",
    data: { text: `original private native text ${index}` },
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
    async getInfo(id, name) {
      f.calls.push(["snapshot-info", id, name]);
      assert.equal(id, ownerRunId);
      assert.equal(name, `${ownerRunId.replace("wrun_", "strm_")}_user`);
      infos += 1;
      return {
        tailIndex: chunks.length - 1 + (fault === "changed-tail" && infos > 1 ? 1 : 0),
        done: fault === "changed-done" && infos > 1,
      };
    },
    async get(id, name, startIndex) {
      f.calls.push(["snapshot-stream", id, name]);
      assert.equal(startIndex, 0);
      let index = 0;
      return new ReadableStream({
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
        cancel() {
          cancelled = true;
          f.calls.push(["snapshot-cancel"]);
          if (fault === "cancel") {
            throw new Error("private cancellation failure");
          }
        },
      });
    },
    getChunks() {
      throw new Error("Serial pagination must not be used.");
    },
  };
  f.dependencies.readNativeEvents = (id) => readTerminalNativeEventsSnapshot(f.world, id, f.key);
  return { ...f, native, cancelled: () => cancelled };
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
    assert.ok(payload.issues.some(({ reason }) => reason === "native-stream-incomplete"));
  });
}

const reconnectingSnapshot = async (mode) => {
  const native = Array.from({ length: 5 }, (_, index) => ({
    type: "text.delta",
    data: { text: index < 2 ? "same valid repeated value" : `private ${index}` },
  }));
  const key = await serialization.deriveRunPayloadKeys(new Uint8Array(32).fill(7));
  const chunks = await frameNativeHistory(
    native.map((event) => new TextEncoder().encode(`${JSON.stringify(event)}\n`)),
    key,
  );
  const join = (parts) => {
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    return bytes;
  };
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
      async getInfo() {
        infos += 1;
        return {
          tailIndex: chunks.length - 1 + (mode === "changed-tail" && infos > 1 ? 1 : 0),
          done: mode === "changed-done" && infos > 1,
        };
      },
      async get(_run, _name, startIndex) {
        starts.push(startIndex);
        assert.equal(startIndex, starts.length === 1 ? 0 : 2);
        let sent = false;
        return new ReadableStream({
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
          cancel() {
            cancelled = true;
          },
        });
      },
    },
  };
  return { native, key, world, starts, cancelled: () => cancelled };
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
  const native = { type: "text.delta", data: { text: "private 😃 value" } };
  const bytes = new TextEncoder().encode(`${JSON.stringify(native)}\n`);
  const cut = bytes.indexOf(240) + 2;
  assert.ok(cut > 2);
  const chunks = await frameNativeHistory([bytes.subarray(0, cut), bytes.subarray(cut)]);
  const starts = [];
  const world = {
    streams: {
      async getInfo() {
        return { tailIndex: 1, done: false };
      },
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
    const native = { type: "text.delta", data: { text: "private native content" } };
    const [frame] = await frameNativeHistory([
      new TextEncoder().encode(`${JSON.stringify(native)}\n`),
    ]);
    assert.ok(frame);
    let cancelled = false;
    let infos = 0;
    const starts = [];
    const world = {
      streams: {
        async getInfo() {
          infos += 1;
          return { tailIndex: frameCount - 1, done: false };
        },
        async get(_run, _name, startIndex) {
          starts.push(startIndex);
          assert.equal(startIndex, interrupted ? (starts.length - 1) * 75_274 : 0);
          let sent = startIndex;
          const end = interrupted ? Math.min(startIndex + 75_274, frameCount) : frameCount;
          return new ReadableStream({
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
            cancel() {
              cancelled = true;
            },
          });
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
      async getInfo() {
        infos += 1;
        return { tailIndex: -1, done: false };
      },
      get() {
        throw new Error("empty tail must not follow stream");
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
    const get = f.world.runs.get;
    f.world.runs.get = async (...args) => ({ ...(await get(...args)), status });
    const result = await f.collect(f.input);
    assert.deepEqual(result, { kind: "unavailable", reason: "source-not-terminal" });
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
