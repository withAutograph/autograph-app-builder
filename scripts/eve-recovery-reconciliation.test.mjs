/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument -- This fixture imports installed compiled Eve internals by package path; their private module declarations are not public exports. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";

const toolResultKind = "tool-result";
const originalDeferredCallId = "original-deferred";
const originalRequestId = "original-request";
const turnStepName = "step//eve//turnStep";
const uncommittedActionDispatchReason = "uncommitted-action-dispatch";
const uncommittedActionResultReason = "uncommitted-action-result";
const unconsumedNativeInboxReason = "unconsumed-native-inbox-input";

const originalTurnId = "turn-original";
const childDeploymentId = "child-deployment";
const originalNativeCallId = "original-native";
const originalOwnerId = "original-owner";
const completedStatus = "completed";
const eventsListOperation = "events.list";

const require = createRequire(import.meta.url);
const eve = path.resolve(
  process.env.EVE_RECOVERY_NATIVE_ROOT ?? path.dirname(require.resolve("eve/package.json")),
);
// oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
const load = (name) => import(pathToFileURL(path.join(eve, "dist/src", name)).href);
const {
  createTerminalRecoveryCandidateCollector,
  createOwnedLineagePreflightCollector,
  readOwnedLineagePreflight,
  reconcileOwnedLineagePreflight,
  readTerminalRecoveryCandidate,
  readTerminalNativeEventsSnapshot,
} = await load("execution/session/recovery-candidate.js");
const { reconcileTerminalRecoveryCandidate } = await load(
  "execution/session/recovery-reconciliation.js",
);
const { createDurableSessionState, readDurableSession } = await load(
  "execution/durable-session-store.js",
);
const { clearPendingCoordinationBatch, setPendingCoordinationBatch, resolvePendingCoordination } =
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
const batchEvent = { sequence: 1, stepIndex: 1, turnId: originalTurnId };
const emission = { sessionStarted: true, sequence: 1, stepIndex: 2, turnId: originalTurnId };
const actualRuntimeResult = {
  kind: toolResultKind,
  callId: originalDeferredCallId,
  toolName: "deferred",
  output: { value: "actual-native-outcome" },
};

const attachHandoffWorld = async ({ options, sourcePair, world, events, steps }) => {
  const boundOwnerRunId = options.handoff === true ? logicalSessionId : ownerRunId;
  const readOperations = [];
  if (options.handoff !== true) {
    return { boundOwnerRunId, readOperations };
  }
  {
    const anchorRunId = boundOwnerRunId;
    const token = `${anchorRunId}:handoff`;
    const checkpoint = {
      ...sourcePair,
      serializedContext: { ...sourcePair.serializedContext, "eve.sessionId": logicalSessionId },
    };
    const delivery = { kind: "deliver", payloads: [{ message: "retained approved intent" }] };
    const startInput = {
      anchorRunId,
      logicalSessionId,
      targetDeploymentId: childDeploymentId,
      activationToken: token,
      checkpoint,
      delivery,
    };
    const childEntry = {
      kind: "handoff",
      sessionId: logicalSessionId,
      streamRunId: anchorRunId,
      activationToken: token,
      ownerDeploymentId: childDeploymentId,
      checkpoint,
      delivery,
    };
    const makeStep = async (runId, id, name, value) => ({
      runId,
      stepId: id,
      stepName: `step//eve//${name}`,
      status: completedStatus,
      input: await serialization.dehydrateStepArguments({ args: [value], closureVars: [] }, runId),
    });
    const startStep = await makeStep(
      anchorRunId,
      "start-owner",
      "startSessionOwnerStep",
      startInput,
    );
    const validation = await makeStep(
      ownerRunId,
      "validate-handoff",
      "validateSessionCheckpointStep",
      { checkpoint },
    );
    const activation = await makeStep(
      ownerRunId,
      "signal-handoff",
      "signalSessionOwnerActivationStep",
      { token, activation: { kind: "active" } },
    );
    const typedEvent = (runId, slot, eventType, correlationId, eventData = {}) => ({
      runId,
      eventId: eventId(slot),
      eventType,
      correlationId,
      eventData,
    });
    const parentEvents = [
      typedEvent(anchorRunId, 1, "hook_created", "handoff-hook", { token }),
      typedEvent(anchorRunId, 2, "step_started", startStep.stepId, {
        stepName: startStep.stepName,
      }),
      typedEvent(anchorRunId, 3, "step_completed", startStep.stepId, {
        stepName: startStep.stepName,
      }),
      typedEvent(anchorRunId, 4, "hook_received", "handoff-hook", {
        payload: await serialization.dehydrateStepReturnValue({ kind: "active" }, anchorRunId),
      }),
      typedEvent(anchorRunId, 5, "run_completed"),
    ];
    if (options.parentFrontierUnknown === true) {
      parentEvents.push(
        typedEvent(anchorRunId, 6, "step_started", "late-effect", {
          stepName: "step//eve//dispatchCoordinationStep",
        }),
      );
    }
    const address = await load("execution/session-inbox/address.js");
    const inbox = address.sessionInboxHookToken(address.sessionCommandHookToken(logicalSessionId));
    const childEvents = [
      typedEvent(ownerRunId, 1, "step_completed", validation.stepId, {
        stepName: validation.stepName,
      }),
      typedEvent(ownerRunId, 2, "hook_created", "claimed-inbox", {
        token: inbox,
        metadata: await serialization.dehydrateStepReturnValue(
          { sessionId: logicalSessionId },
          ownerRunId,
        ),
      }),
      typedEvent(ownerRunId, 3, "step_completed", activation.stepId, {
        stepName: activation.stepName,
      }),
      ...events.map((event) => ({
        ...event,
        eventId: eventId(Number(event.eventId.slice(5)) + 3),
      })),
    ];
    const runs = new Map([
      [
        anchorRunId,
        {
          runId: anchorRunId,
          status: options.anchorStatus ?? completedStatus,
          deploymentId: "anchor-deployment",
          workflowName: "session-owner",
          input: await serialization.dehydrateWorkflowArguments([{ kind: "initial" }], anchorRunId),
        },
      ],
      [
        ownerRunId,
        {
          runId: ownerRunId,
          status: options.runStatus ?? "cancelled",
          deploymentId: childDeploymentId,
          workflowName: "session-owner",
          input: await serialization.dehydrateWorkflowArguments([childEntry], ownerRunId),
        },
      ],
    ]);
    if (options.finalStatusTransition === true) {
      let reads = 0;
      Object.defineProperty(runs.get(ownerRunId), "status", {
        get: () => {
          reads += 1;
          return reads === 1 ? completedStatus : "suspended";
        },
      });
    }
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    world.runs.get = (id) => {
      readOperations.push(["runs.get", id]);
      return Promise.resolve(runs.get(id));
    };
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    world.runs.list = () => {
      readOperations.push(["runs.list"]);
      return Promise.resolve({
        data: options.omitListedOwner === true ? [runs.get(anchorRunId)] : [...runs.values()],
        hasMore: false,
      });
    };
    if (options.omitListedOwner === true) {
      world.hooks = {
        // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
        getByToken: (requestedToken) => {
          assert.equal(requestedToken, inbox);
          return Promise.resolve({ runId: ownerRunId });
        },
      };
    }
    let parentScans = 0;
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    world.events.list = ({ runId, resolveData }) => {
      readOperations.push([eventsListOperation, runId, resolveData]);
      if (runId === anchorRunId) {
        parentScans += 1;
      }
      const data = runId === anchorRunId ? parentEvents : childEvents;
      const drifted = options.parentScanDrift === true && runId === anchorRunId && parentScans > 1;
      const observed = drifted ? [...data, { ...data.at(-1), eventId: eventId(99) }] : data;
      return Promise.resolve({
        data: observed.map((event) => {
          if (resolveData !== "none") {
            return event;
          }
          const eventData = { ...event.eventData };
          delete eventData.input;
          delete eventData.result;
          delete eventData.output;
          delete eventData.error;
          delete eventData.metadata;
          delete eventData.payload;
          return { ...event, eventData };
        }),
        hasMore: false,
      });
    };
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    world.events.get = (runId, id) => {
      readOperations.push(["events.get", runId]);
      return Promise.resolve(
        (runId === anchorRunId ? parentEvents : childEvents).find((event) => event.eventId === id),
      );
    };
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    world.steps.get = (runId, id) => {
      readOperations.push(["steps.get", runId]);
      return Promise.resolve(
        [startStep, validation, activation].find(
          (step) => step.runId === runId && step.stepId === id,
        ) ?? steps.get(id),
      );
    };
  }
  return { boundOwnerRunId, readOperations };
};

const attachNativeSnapshot = async (world, nativeEvents, enabled) => {
  if (enabled !== true) {
    return null;
  }
  const snapshotKey = await serialization.deriveRunPayloadKeys(new Uint8Array(32).fill(9));
  const chunks = [];
  const values = [...nativeEvents, { type: "text.delta", data: { text: "retained private tail" } }];
  const readable = new ReadableStream({
    start(controller) {
      for (const nativeEvent of values) {
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify(nativeEvent)}\n`));
      }
      controller.close();
    },
  }).pipeThrough(
    serialization.getSerializeStream(serialization.getWorkflowReducers(globalThis), snapshotKey),
  );
  for await (const data of readable) {
    chunks.push({ index: chunks.length, data });
  }
  world.streams = {
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    get: (_id, _name, startIndex) => {
      assert.equal(startIndex, 0);
      let index = 0;
      return Promise.resolve(
        new ReadableStream({
          pull(controller) {
            if (index < chunks.length) {
              controller.enqueue(chunks[index].data);
              index += 1;
            }
            // Leave the source open; the finite reader must stop at its captured tail.
          },
        }),
      );
    },
    getChunks: () => {
      throw new Error("Serial native snapshot pagination is forbidden.");
    },
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    getInfo: () => Promise.resolve({ tailIndex: chunks.length - 1, done: false }),
  };
  return snapshotKey;
};

const fixtureKey = (encrypted) =>
  encrypted === true
    ? serialization.deriveRunPayloadKeys(new Uint8Array(32).fill(3))
    : Promise.resolve();
const appendHistoricalInbox = async (events, event, output, suffix, terminal = true) => {
  if (suffix === undefined || suffix.length === 0) {
    return;
  }
  const encoded = await Promise.all(suffix.map((payload) => output(payload)));
  if (terminal) {
    events.pop();
  }
  events.push(
    ...encoded.map((payload, index) =>
      event(13 + index, "hook_received", "command-hook", {
        token: `eve:session:${logicalSessionId}:inbox`,
        payload,
      }),
    ),
  );
  if (terminal) {
    events.push(event(13 + suffix.length, "run_cancelled"));
  }
};

const settledCancelStepId = "settled-turn-cancellation";

const addSettledCancellation = async ({
  args,
  events,
  event,
  output,
  source,
  sourcePair,
  steps,
  beforeCancellationSend,
  stopDuringTurnStep,
}) => {
  const active = clearPendingCoordinationBatch({
    ...source,
    history: [source.history[0]],
    ...(beforeCancellationSend === true ? { continuationToken: "old-turn-inbox" } : {}),
  });
  const before = { ...sourcePair, sessionState: createDurableSessionState({ session: active }) };
  const settled = {
    ...sourcePair,
    sessionState: createDurableSessionState({
      session: {
        ...active,
        ...(beforeCancellationSend === true ? { continuationToken: "new-idle-inbox" } : {}),
        state: {
          ...active.state,
          "eve.harness.emission": { ...emission, sequence: 2, stepIndex: 0, turnId: "" },
        },
      },
    }),
  };
  steps.get("prior").output = await output({
    action: stopDuringTurnStep === true ? "cancelled" : "park",
    ...before,
  });
  steps.set(settledCancelStepId, {
    runId: ownerRunId,
    stepId: settledCancelStepId,
    stepName: "step//eve//settleCancelledTurnStep",
    status: completedStatus,
    input: await args(before),
    output: await output(settled),
  });
  const cancelReceipt = event(stopDuringTurnStep === true ? 4 : 5, "hook_received", "command-hook", {
    token: `eve:session:${logicalSessionId}:inbox`,
    payload: await output({ kind: "cancel", turnId: originalTurnId }),
  });
  const queuedSend =
    beforeCancellationSend === true
      ? event(stopDuringTurnStep === true ? 5 : 6, "hook_received", "old-continuation", {
          token: "old-turn-inbox",
          payload: await output({ kind: "send", payload: { message: "still queued" } }),
        })
      : undefined;
  const afterPriorStepStart = events.findIndex((entry) => entry.eventId === eventId(3)) + 1;
  events.splice(
    afterPriorStepStart,
    events.length - afterPriorStepStart,
    ...(stopDuringTurnStep === true ? [] : [event(4, "step_completed", "prior")]),
    cancelReceipt,
    ...(queuedSend === undefined ? [] : [queuedSend]),
    ...(stopDuringTurnStep === true ? [event(6, "step_completed", "prior")] : []),
    event(7, "step_started", settledCancelStepId),
    event(8, "step_completed", settledCancelStepId),
  );
  return settled;
};

const collectorFor = (options) =>
  options.collectFactory ?? createTerminalRecoveryCandidateCollector;
const expectedCollectionKind = (options) =>
  options.expectedKind ?? (options.expectedUnavailable === true ? "unavailable" : "candidate");

const fixture = async (options = {}) => {
  const key = await fixtureKey(options.encrypted);
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
        pending: [{ callId: originalNativeCallId, scope: originalGrant }],
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
            approvalId: originalRequestId,
            approved: options.denied !== true,
          },
          ...(options.denied === true
            ? [
                {
                  type: toolResultKind,
                  toolCallId: originalNativeCallId,
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
        callId: originalDeferredCallId,
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
            toolCallId: originalNativeCallId,
            toolName: "native",
            input: { value: "exact-original-input" },
          },
          {
            type: "tool-call",
            toolCallId: originalDeferredCallId,
            toolName: "deferred",
            input: {},
          },
          {
            type: "tool-approval-request",
            approvalId: originalRequestId,
            toolCallId: originalNativeCallId,
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
      "eve.auth": { principalId: originalOwnerId },
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
      kind: "deliver",
      auth: { principalId: originalOwnerId },
      payloads: [{ message: "already admitted" }],
    };
  }
  const args = (value) =>
    serialization.dehydrateStepArguments({ args: [value], closureVars: [] }, ownerRunId, key);
  const output = (value) => serialization.dehydrateStepReturnValue(value, ownerRunId, key);
  const steps = new Map([
    [
      "prior",
      {
        runId: ownerRunId,
        stepId: "prior",
        stepName: turnStepName,
        status: completedStatus,
        input: await args(sourcePair),
        output: await output({ action: "park", ...sourcePair }),
      },
    ],
    [
      "terminal",
      {
        runId: ownerRunId,
        stepId: "terminal",
        stepName: turnStepName,
        status: options.failedTurn === true ? "failed" : completedStatus,
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
        status: completedStatus,
        input: await args(latestPair),
      },
    ],
  ]);
  if (options.historicalFailure === true) {
    steps.set("historical", {
      runId: ownerRunId,
      stepId: "historical",
      stepName: turnStepName,
      status: "failed",
      input: await args(sourcePair),
      error: { name: "older failure" },
    });
  }
  if (options.unreadableLater === true) {
    steps.set("unreadable", {
      runId: ownerRunId,
      stepId: "unreadable",
      stepName: turnStepName,
      status: completedStatus,
      output: new Uint8Array([99, 1, 2, 3]),
    });
  }
  const event = (slot, eventType, stepId, eventData = {}) => {
    const value = { runId: ownerRunId, eventId: eventId(slot), eventType };
    if (stepId !== undefined) {
      value.correlationId = stepId;
    }
    const details = {};
    if (steps.has(stepId)) {
      details.stepName = steps.get(stepId).stepName;
    }
    value.eventData = { ...details, ...eventData };
    return value;
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
  ];
  const inboxEventData = {};
  if (options.inboxAfterSource === true) {
    inboxEventData.token = `eve:session:${logicalSessionId}:inbox`;
  }
  inboxEventData.payload = { untouchedNativeFact: true };
  events.push(
    event(11, "hook_received", "ordinary-hook", inboxEventData),
    event(12, options.runStatus === "cancelled" ? "run_cancelled" : "run_completed"),
  );
  const settled =
    options.settledCancellation === true
      ? await addSettledCancellation({
          args,
          events,
          event,
          output,
          source,
          sourcePair,
          steps,
          beforeCancellationSend: options.beforeCancellationSend,
          stopDuringTurnStep: options.stopDuringTurnStep,
        })
      : undefined;
  await appendHistoricalInbox(events, event, output, options.inboxSuffix, settled === undefined);
  const nativeEvents = [
    ...(settled === undefined
      ? [{ type: "action.result", data: { ...batchEvent, result: actualRuntimeResult } }]
      : []),
    ...(options.uncommittedWrite === true
      ? [
          {
            type: "action.result",
            data: {
              ...(settled === undefined
                ? emission
                : { sequence: 2, stepIndex: 0, turnId: "following-turn" }),
              result: {
                kind: toolResultKind,
                callId: originalNativeCallId,
                toolName: "native",
                output: "may-have-written",
              },
            },
          },
        ]
      : []),
    ...(options.uncommittedDispatch === true || options.interruptedObservation !== undefined
      ? [
          {
            type: "actions.requested",
            data: {
              ...emission,
              actions: [
                {
                  callId: "new-uncommitted-write",
                  kind: "tool-call",
                  toolName:
                    options.interruptedObservation === undefined
                      ? "native"
                      : "observe-app-production",
                  input: options.interruptedObservation ?? {},
                },
              ],
            },
          },
        ]
      : []),
    ...(options.cancelled === true || settled !== undefined
      ? [{ type: "turn.cancelled", data: { sequence: 1, turnId: originalTurnId } }]
      : []),
  ];
  const world = {
    events: {
      // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
      get: (_runId, id) => Promise.resolve(events.find((value) => value.eventId === id)),
      list: async () => await Promise.resolve({ data: events, hasMore: false }),
    },
    runs: {
      get: async () =>
        await Promise.resolve({
          runId: ownerRunId,
          status: options.runStatus ?? (options.failedTurn === true ? "failed" : completedStatus),
          input: "original-entry-retained",
        }),
    },
    steps: {
      get: async (runId, id) => {
        assert.equal(runId, ownerRunId);
        return await Promise.resolve(steps.get(id));
      },
    },
  };
  const { boundOwnerRunId, readOperations } = await attachHandoffWorld({
    events,
    options,
    sourcePair,
    steps,
    world,
  });
  const snapshotKey = await attachNativeSnapshot(world, nativeEvents, options.snapshot);
  let authorized = false;
  const collect = collectorFor(options)({
    getWorld: async () => await Promise.resolve(world),
    hydrateHookPayload: async (value, _runId, payloadKey) =>
      serialization.deserializePreparedReplayPayload(
        await serialization.prepareReplayPayload(value, payloadKey),
        globalThis,
      ),
    hydrateStepArguments: (...values) => serialization.hydrateStepArguments(...values),
    hydrateStepReturnValue: (...values) => serialization.hydrateStepReturnValue(...values),
    hydrateWorkflowArguments: (...values) => serialization.hydrateWorkflowArguments(...values),
    now: () => 0,
    readDurableSession,
    async *readNativeEvents(runId) {
      yield* options.snapshot === true
        ? readTerminalNativeEventsSnapshot(world, runId, snapshotKey)
        : nativeEvents;
    },
    requireEventSlot: (id) => Number(id.slice(5)),
    resolveRunEncryptionKey: async () => {
      await Promise.resolve();
      return key;
    },
  });
  const collected = await collect({
    allowParked: options.allowParked === true,
    binding: { ownerRunId: boundOwnerRunId, logicalSessionId },
    authorizeOwner: async (currentBinding) => {
      assert.deepEqual(currentBinding, { logicalSessionId, ownerRunId: boundOwnerRunId });
      assert.ok(Object.isFrozen(currentBinding));
      authorized = true;
      await Promise.resolve();
    },
  });
  assert.equal(collected.kind, expectedCollectionKind(options));
  assert.equal(authorized, true);
  return {
    collected,
    events,
    incoming,
    latest,
    latestPair,
    nativeEvents,
    originalGrant,
    settled,
    readOperations,
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
            (part) => part.type === toolResultKind && part.toolCallId === `original-${name}`,
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
  const auth = { authenticator: "test", principalId: originalOwnerId, principalType: "user" };
  ctx.set(SessionKey, {
    sessionId: logicalSessionId,
    auth: { current: auth, initiator: auth },
    turn: { id: originalTurnId },
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
  { options: { uncommittedWrite: true }, reason: uncommittedActionResultReason },
  { options: { uncommittedDispatch: true }, reason: uncommittedActionDispatchReason },
  { options: { failedTurn: true }, reason: "failed-turn-effects-unreconciled" },
  { options: { delivery: true }, reason: "delivery-consumption-unreconciled" },
  { options: { missingResult: true }, reason: "coordination-results-incomplete" },
  { options: { cancelled: true }, reason: "cancelled-turn-replay" },
  { options: { unreadableLater: true }, reason: "unreadable-native-effect-frontier" },
  { options: { inboxAfterSource: true }, reason: unconsumedNativeInboxReason },
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

const approvals = (history) =>
  history
    .flatMap(({ content }) => (Array.isArray(content) ? content : []))
    .filter((part) => part.type === "tool-approval-response");

test("provider-cancelled physical handoff reconciles latest native typed state without replay or effect execution", async () => {
  const f = await fixture({ handoff: true, runStatus: "cancelled", snapshot: true });
  const payload = readTerminalRecoveryCandidate(f.collected.candidate);
  assert.equal(payload.run.status, "cancelled");
  assert.equal(payload.checkpointOwnerRunId, ownerRunId);
  assert.equal(payload.binding.ownerRunId, logicalSessionId);
  assert.equal(payload.handoffChain.length, 1);
  assert.equal(
    f.readOperations.filter(
      ([operation, id]) => operation === eventsListOperation && id === logicalSessionId,
    ).length,
    2,
  );
  assert.equal(
    f.readOperations
      .filter(([operation]) => operation === eventsListOperation)
      .every((call) => call[2] === "none"),
    true,
  );
  assert.equal(payload.handoffChain[0].ownerRunId, ownerRunId);
  const before = structuredClone(payload.candidates);
  const result = await reconcileTerminalRecoveryCandidate(f.collected.candidate);
  assert.equal(result.kind, "ready");
  const recovered = readDurableSession(result.checkpointCore.sessionState);
  for (const key of ["fixture.program", "fixture.authority", "eve.runtime.hitl.approvedTools"]) {
    assert.deepEqual(recovered.state[key], f.latest.state[key]);
  }
  assert.deepEqual(approvals(recovered.history), approvals(f.source.history));
  assert.equal(
    approvals(recovered.history).some(
      (approval) => approval.approvalId === originalRequestId && approval.approved === true,
    ),
    true,
  );
  assert.deepEqual(recovered.sandboxState, f.latest.sandboxState);
  assert.deepEqual(result.checkpointCore.serializedContext, f.latestPair.serializedContext);
  assert.equal(result.provenance.logicalSessionId, logicalSessionId);
  assert.deepEqual(payload.candidates, before);
  assert.ok(
    f.readOperations.every(([operation]) =>
      ["runs.get", "runs.list", "events.get", eventsListOperation, "steps.get"].includes(operation),
    ),
  );
});

for (const options of [
  { handoff: true, runStatus: "running" },
  { handoff: true, runStatus: "pending" },
  { handoff: true, runStatus: "cancelled", anchorStatus: "running" },
  { handoff: true, runStatus: "cancelled", parentFrontierUnknown: true },
  { handoff: true, runStatus: "cancelled", parentScanDrift: true },
]) {
  test(`cancelled owner discovery preserves unavailable or uncertain handoff boundary ${JSON.stringify(options)}`, async () => {
    const f = await fixture({ ...options, expectedUnavailable: true });
    assert.equal(f.collected.kind, "unavailable");
    assert.equal(
      f.collected.reason,
      options.parentFrontierUnknown === true || options.parentScanDrift === true
        ? "handoff-parent-frontier-uncertain"
        : "source-not-terminal",
    );
  });
}
for (const { options, reason } of [
  { options: { cancelled: true }, reason: "cancelled-turn-replay" },
  { options: { uncommittedDispatch: true }, reason: uncommittedActionDispatchReason },
  { options: { uncommittedWrite: true }, reason: uncommittedActionResultReason },
]) {
  test(`provider cancellation grants no replay authority for ${reason}`, async () => {
    const f = await fixture({ handoff: true, runStatus: "cancelled", ...options });
    const result = await reconcileTerminalRecoveryCandidate(f.collected.candidate);
    assert.equal(result.kind, "uncertain");
    assert.equal(result.reason, reason);
  });
}

const settledIdleFixture = async (options = {}) =>
  await fixture({
    ...options,
    settledCancellation: true,
    runStatus: "running",
    collectFactory: createOwnedLineagePreflightCollector,
    expectedKind: "preflight",
  });

test("idle transfer uses the paired output that settled the native cancellation", async () => {
  const f = await settledIdleFixture();
  const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
  assert.equal(result.kind, "ready");
  assert.equal(result.provenance.selectedOrigin.stepId, settledCancelStepId);
  assert.equal(result.provenance.selectedOrigin.kind, "committed-cancelled-turn-output");
  assert.ok(result.provenance.coveredNativeEventIds.includes(eventId(5)));
  assert.equal(result.replayInput, undefined);
  assert.equal(result.carriedInbox, undefined);
  assert.deepEqual(result.checkpointCore, f.settled);
  const { deriveTerminalRecoveryResumePhase } = await load(
    "execution/session/recovery-resume-phase.js",
  );
  assert.equal(await deriveTerminalRecoveryResumePhase(result), "await-input");
});

test("idle transfer can recover a Stop received inside the producing turn step", async () => {
  const f = await settledIdleFixture({
    interruptedObservation: { appId: "fixture-app" },
    stopDuringTurnStep: true,
  });
  const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
  assert.equal(result.kind, "ready");
  assert.equal(result.provenance.selectedOrigin.stepId, settledCancelStepId);
  assert.ok(result.provenance.coveredNativeEventIds.includes(eventId(4)));
  assert.equal(result.replayInput, undefined);
  assert.equal(result.carriedInbox, undefined);
  assert.deepEqual(result.checkpointCore, f.settled);
});

test("idle transfer rejects an earlier Send received inside the producing turn step", async () => {
  const f = await settledIdleFixture({ beforeCancellationSend: true, stopDuringTurnStep: true });
  const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
  assert.deepEqual(result, { kind: "uncertain", reason: unconsumedNativeInboxReason });
});

test("idle transfer preserves a genuine send queued after the cancellation checkpoint", async () => {
  const queued = {
    kind: "send",
    requestId: "new-native-request",
    auth: { principalId: originalOwnerId },
    payload: { message: "new accepted intent" },
    delivery: { originalEvidence: true },
  };
  const f = await settledIdleFixture({ inboxSuffix: [queued] });
  const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
  assert.equal(result.kind, "ready");
  assert.deepEqual(
    result.carriedInbox.map((entry) => entry.payload),
    [queued],
  );
  const { deriveTerminalRecoveryResumePhase } = await load(
    "execution/session/recovery-resume-phase.js",
  );
  assert.equal(await deriveTerminalRecoveryResumePhase(result), undefined);
});

test("a queued send on the previous continuation is not consumed by cancellation", async () => {
  const f = await settledIdleFixture({ beforeCancellationSend: true });
  const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
  assert.deepEqual(result, { kind: "uncertain", reason: unconsumedNativeInboxReason });
});

test("a later uncommitted native result still blocks the settled cancellation checkpoint", async () => {
  const f = await settledIdleFixture({ uncommittedWrite: true });
  const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
  assert.equal(result.kind, "uncertain");
  assert.equal(result.reason, uncommittedActionResultReason);
});

test("an unknown dispatched action in the cancelled turn still prevents idle recovery", async () => {
  const f = await settledIdleFixture({ uncommittedDispatch: true });
  const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
  assert.equal(result.kind, "uncertain");
  assert.equal(result.reason, uncommittedActionDispatchReason);
});

test("settled cancellation can retain an interrupted read-only Production observation", async () => {
  const f = await settledIdleFixture({ interruptedObservation: { appId: "fixture-app" } });
  const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
  assert.equal(result.kind, "ready");
  assert.equal(result.provenance.selectedOrigin.stepId, settledCancelStepId);
  assert.equal(result.replayInput, undefined);
  assert.equal(result.carriedInbox, undefined);
});

test("an interrupted Production observation with another input remains uncertain", async () => {
  const f = await settledIdleFixture({
    interruptedObservation: { appId: "fixture-app", other: "unsupported" },
  });
  const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
  assert.equal(result.kind, "uncertain");
  assert.equal(result.reason, uncommittedActionDispatchReason);
});

const acceptedSuffix = () => [
  { kind: "cancel", turnId: originalTurnId },
  {
    kind: "send",
    requestId: "original-native-request",
    auth: { principalId: originalOwnerId },
    payload: { message: "original accepted intent" },
    delivery: { originalEvidence: true },
  },
  { kind: "cancel", turnId: originalTurnId },
];

test("exact encrypted post-checkpoint cancel/send/cancel is retained for ordinary owner admission", async () => {
  const suffix = acceptedSuffix();
  const f = await fixture({ encrypted: true, inboxSuffix: suffix, runStatus: "cancelled" });
  const payload = readTerminalRecoveryCandidate(f.collected.candidate);
  assert.deepEqual(
    payload.carriedInbox.map((entry) => entry.payload),
    suffix,
  );
  const result = await reconcileTerminalRecoveryCandidate(f.collected.candidate);
  assert.equal(result.kind, "ready");
  assert.deepEqual(result.carriedInbox, payload.carriedInbox);
  assert.deepEqual(
    result.carriedInbox.map((entry) => entry.slot),
    [13, 14, 15],
  );
  assert.deepEqual(
    readDurableSession(result.checkpointCore.sessionState).state["fixture.authority"],
    f.latest.state["fixture.authority"],
  );
  assert.deepEqual(result.checkpointCore.serializedContext, f.latestPair.serializedContext);
});
for (const kind of ["reset", "session-timeout", "unknown"]) {
  test(`unsupported historical inbox ${kind} remains uncertain`, async () => {
    const f = await fixture({ inboxSuffix: [{ kind }], runStatus: "cancelled" });
    const result = await reconcileTerminalRecoveryCandidate(f.collected.candidate);
    assert.deepEqual(result, { kind: "uncertain", reason: unconsumedNativeInboxReason });
  });
}
for (const mutation of [
  "foreign-run",
  "duplicate-id",
  "changed-correlation",
  "wrong-turn",
  "task-cancel",
  "missing-envelope",
]) {
  test(`historical inbox cannot waive uncertainty with ${mutation}`, async () => {
    const f = await fixture({ inboxSuffix: acceptedSuffix(), runStatus: "cancelled" });
    const payload = readTerminalRecoveryCandidate(f.collected.candidate);
    const [first] = payload.carriedInbox;
    if (mutation === "foreign-run") {
      first.runId = "wrun-foreign";
    }
    if (mutation === "duplicate-id") {
      payload.carriedInbox.push(first);
    }
    if (mutation === "changed-correlation") {
      first.correlationId = "different-hook";
    }
    if (mutation === "wrong-turn") {
      first.payload.turnId = "different-turn";
    }
    if (mutation === "task-cancel") {
      first.payload.tasks = true;
    }
    if (mutation === "missing-envelope") {
      payload.carriedInbox.splice(0, 1);
    }
    const result = await reconcileTerminalRecoveryCandidate(f.collected.candidate);
    assert.deepEqual(result, { kind: "uncertain", reason: unconsumedNativeInboxReason });
  });
}
test("retained inbox commands never waive unknown native effects", async () => {
  const f = await fixture({
    inboxSuffix: acceptedSuffix(),
    runStatus: "cancelled",
    uncommittedWrite: true,
  });
  const result = await reconcileTerminalRecoveryCandidate(f.collected.candidate);
  assert.deepEqual(result, {
    callId: originalNativeCallId,
    kind: "uncertain",
    reason: uncommittedActionResultReason,
  });
});

test("a later authored step leaves historical command admission uncertain", async () => {
  const f = await fixture({ inboxSuffix: acceptedSuffix(), runStatus: "cancelled" });
  const payload = readTerminalRecoveryCandidate(f.collected.candidate);
  payload.events.push({
    runId: ownerRunId,
    eventId: eventId(17),
    eventType: "step_started",
    correlationId: "later-authored-step",
    eventData: { stepName: "turnStep" },
  });
  const result = await reconcileTerminalRecoveryCandidate(f.collected.candidate);
  assert.deepEqual(result, { kind: "uncertain", reason: unconsumedNativeInboxReason });
});

for (const item of [
  {
    options: { anchorStatus: "running", runStatus: completedStatus },
    stage: "handoff_parent",
    status: "running",
  },
  {
    options: { runStatus: "waiting" },
    parentStatus: completedStatus,
    stage: "handoff_successor",
    status: "waiting",
  },
  { options: { finalStatusTransition: true }, stage: "final_owner", status: "suspended" },
]) {
  test(`actual native handoff resolver identifies ${item.stage} refusal`, async () => {
    const f = await fixture({
      allowParked: true,
      expectedUnavailable: true,
      handoff: true,
      ...item.options,
    });
    assert.equal(f.collected.reason, "source-not-terminal");
    const expectedBoundary = {
      stage: item.stage,
      status: item.status,
    };
    if (item.parentStatus !== undefined) {
      expectedBoundary.parentStatus = item.parentStatus;
    }
    expectedBoundary.allowParked = true;
    assert.deepEqual(f.collected.boundary, expectedBoundary);
  });
}

test("running anchored-result parent is observable only through an opaque lineage preflight", async () => {
  const options = {
    allowParked: true,
    anchorStatus: "running",
    handoff: true,
    runStatus: "running",
  };
  const terminal = await fixture({ ...options, expectedUnavailable: true });
  assert.equal(terminal.collected.boundary.stage, "handoff_parent");
  const observed = await fixture({
    ...options,
    collectFactory: createOwnedLineagePreflightCollector,
    expectedKind: "preflight",
    omitListedOwner: true,
  });
  const payload = readOwnedLineagePreflight(observed.collected.preflight);
  assert.equal(payload.handoffChain.length, 1);
  assert.equal(payload.binding.ownerRunId, logicalSessionId);
  assert.equal(payload.checkpointOwnerRunId, ownerRunId);
  assert.throws(
    () => readTerminalRecoveryCandidate(observed.collected.preflight),
    /Unknown private native recovery candidate/u,
  );
  const reconciled = await reconcileOwnedLineagePreflight(observed.collected.preflight);
  assert.equal(reconciled.kind, "ready");
  assert.equal(reconciled.checkpointCore.sessionState.sessionId, logicalSessionId);
});
