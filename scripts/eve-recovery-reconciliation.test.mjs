/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument -- This fixture imports installed compiled Eve internals by package path; their private module declarations are not public exports. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test, vi } from "vitest";
import {
  verifySettledGitHubDelivery,
  verifySettledGitHubDeliveryWithPriorReceipt,
} from "../lib/eve/native-recovery-github-delivery-witness";
import { createCancelledDeliveryWitnessFixture } from "../lib/eve/native-recovery-github-delivery-witness.test-fixture";

const toolResultKind = "tool-result";
const actionsRequestedKind = "actions.requested";
const originalDeferredCallId = "original-deferred";
const originalRequestId = "original-request";
const turnStepName = "step//eve//turnStep";
const uncommittedActionDispatchReason = "uncommitted-action-dispatch";
const uncommittedActionResultReason = "uncommitted-action-result";
const unconsumedNativeInboxReason = "unconsumed-native-inbox-input";
const cancelledWorkflowWitnessEvent = "builder.cancelled_workflow_witness";

const commandHookId = "command-hook";
const originalTurnId = "turn-original";
const childDeploymentId = "child-deployment";
const originalNativeCallId = "original-native";
const originalOwnerId = "original-owner";
const fixtureAppId = "fixture-app";
const completedStatus = "completed";
const afterChildTerminal = "after-terminal";
const afterChildStop = "after-stop";
const eventsListOperation = "events.list";
const sessionOwnerWorkflow = "session-owner";
const unrelatedDeliveryRunId = "wrun_unrelated_delivery";

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
const { WorkflowWorldError } = await load("compiled/@workflow/errors/index.js");
const reviveWritableReference = (value) =>
  Object.freeze({ kind: "native-recovery-transport-reference", type: "WritableStream", value });
const transportRevivers = { WritableStream: reviveWritableReference };
const { ContextContainer, contextStorage } = await load("context/container.js");
const { SessionKey } = await load("context/keys.js");
const { createToolLoopHarness } = await load("harness/tool-loop.js");
const {
  createActionPartialEvent,
  createActionResultEvent,
  createTurnCancelledEvent,
  createTurnStartedEvent,
  stampMessageStreamEvent,
} = await load("protocol/message.js");
const { createRuntimeToolResultFromValue } = await load("harness/action-result-helpers.js");
const { sessionCommandHookToken, sessionInboxHookToken } = await load(
  "execution/session-inbox/address.js",
);
const { settleCancelledToolHistory } = await load("harness/cancelled-tool-history.js");
const { registerWorkflowToolRun } = await load("harness/workflow-tool-runs.js");
const { workflowToolRunOutcomeToToolResult } = await load(
  "execution/tools/workflow/owner-inbox.js",
);
const { MockLanguageModelV4 } = await import("ai/test");
const { z } = await import("zod");
const ownerRunId = "wrun_physical_original";
const logicalSessionId = "wrun_logical_original";
const eventId = (slot) => `evnt_${String(slot).padStart(26, "0")}`;
const nativeWorldEvent = (runId, slot, eventType, correlationId, eventData = {}) => ({
  runId,
  eventId: eventId(slot),
  eventType,
  correlationId,
  eventData,
});
const batchEvent = { sequence: 1, stepIndex: 1, turnId: originalTurnId };
const emission = { sessionStarted: true, sequence: 1, stepIndex: 2, turnId: originalTurnId };
const actualRuntimeResult = {
  kind: toolResultKind,
  callId: originalDeferredCallId,
  toolName: "deferred",
  output: { value: "actual-native-outcome" },
};

const attachHandoffWorld = async ({ options, sourcePair, world, events, steps, priorDelivery }) => {
  const boundOwnerRunId = options.handoff === true ? logicalSessionId : ownerRunId;
  const readOperations = [];
  if (options.handoff !== true) {
    return { boundOwnerRunId, readOperations };
  }
  {
    const anchorRunId = boundOwnerRunId;
    const token = `${anchorRunId}:handoff`;
    const parentDeliveryPlacement = options.handoffDeliveryCheckpoint;
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
    const deliveryEvents = (slot) => [
      nativeWorldEvent(priorDelivery.runId, slot, "step_started", priorDelivery.stepId, {
        stepName: priorDelivery.stepName,
      }),
      nativeWorldEvent(priorDelivery.runId, slot + 1, "step_completed", priorDelivery.stepId, {
        stepName: priorDelivery.stepName,
      }),
    ];
    const cutoffOffset = parentDeliveryPlacement === "before" ? 2 : 0;
    const parentEvents = [
      ...(cutoffOffset === 0 ? [] : deliveryEvents(1)),
      nativeWorldEvent(anchorRunId, 1 + cutoffOffset, "hook_created", "handoff-hook", { token }),
      nativeWorldEvent(anchorRunId, 2 + cutoffOffset, "step_started", startStep.stepId, {
        stepName: startStep.stepName,
      }),
      nativeWorldEvent(anchorRunId, 3 + cutoffOffset, "step_completed", startStep.stepId, {
        stepName: startStep.stepName,
      }),
      nativeWorldEvent(anchorRunId, 4 + cutoffOffset, "hook_received", "handoff-hook", {
        payload: await serialization.dehydrateStepReturnValue({ kind: "active" }, anchorRunId),
      }),
      ...(parentDeliveryPlacement === "after" ? deliveryEvents(5) : []),
      nativeWorldEvent(
        anchorRunId,
        5 + (parentDeliveryPlacement === "after" ? 2 : cutoffOffset),
        "run_completed",
      ),
    ];
    if (options.parentFrontierUnknown === true) {
      parentEvents.push(
        nativeWorldEvent(anchorRunId, 6, "step_started", "late-effect", {
          stepName: "step//eve//dispatchCoordinationStep",
        }),
      );
    }
    const address = await load("execution/session-inbox/address.js");
    const inbox = address.sessionInboxHookToken(address.sessionCommandHookToken(logicalSessionId));
    const childEvents = [
      nativeWorldEvent(ownerRunId, 1, "step_completed", validation.stepId, {
        stepName: validation.stepName,
      }),
      nativeWorldEvent(ownerRunId, 2, "hook_created", "claimed-inbox", {
        token: inbox,
        metadata: await serialization.dehydrateStepReturnValue(
          { sessionId: logicalSessionId },
          ownerRunId,
        ),
      }),
      nativeWorldEvent(ownerRunId, 3, "step_completed", activation.stepId, {
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
          workflowName: sessionOwnerWorkflow,
          input: await serialization.dehydrateWorkflowArguments([{ kind: "initial" }], anchorRunId),
        },
      ],
      [
        ownerRunId,
        {
          runId: ownerRunId,
          status: options.runStatus ?? "cancelled",
          deploymentId: childDeploymentId,
          workflowName: sessionOwnerWorkflow,
          input: await serialization.dehydrateWorkflowArguments([childEntry], ownerRunId),
        },
      ],
    ]);
    if (parentDeliveryPlacement === "unrelated") {
      runs.set(unrelatedDeliveryRunId, {
        runId: unrelatedDeliveryRunId,
        status: completedStatus,
        deploymentId: "unrelated-deployment",
        workflowName: sessionOwnerWorkflow,
        input: await serialization.dehydrateWorkflowArguments(
          [{ kind: "initial" }],
          unrelatedDeliveryRunId,
        ),
      });
    }
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
    const eventsForRun = (runId) => {
      if (runId === anchorRunId) {
        return parentEvents;
      }
      return runId === unrelatedDeliveryRunId ? deliveryEvents(1) : childEvents;
    };
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    world.events.list = ({ runId, resolveData }) => {
      readOperations.push([eventsListOperation, runId, resolveData]);
      if (runId === anchorRunId) {
        parentScans += 1;
      }
      const data = eventsForRun(runId);
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
      return Promise.resolve(eventsForRun(runId).find((event) => event.eventId === id));
    };
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    world.steps.get = (runId, id) => {
      readOperations.push(["steps.get", runId]);
      return Promise.resolve(
        [startStep, validation, activation, priorDelivery].find(
          (step) => step?.runId === runId && step.stepId === id,
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
      event(13 + index, "hook_received", commandHookId, {
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
const workflowReportStepId = "emit-workflow-report";
const workflowReportRun = {
  ownerRunId,
  ownerAnchorRunId: logicalSessionId,
  callId: "workflow-report-call",
  execution: "blocking",
  input: {
    baseBranch: "main",
    headSha: "a".repeat(40),
    name: "arrusted-development",
    owner: "withAutograph",
    proposalDigest: "b".repeat(64),
    pullRequestNumber: 1,
    repositoryId: "1",
    installationId: "2",
  },
  runId: "wrun_owned_delivery",
  sequence: emission.sequence,
  stepIndex: batchEvent.stepIndex,
  toolName: "finish-github-pr-delivery",
  turnId: originalTurnId,
};
const workflowReportUpdate = { status: "merged", mergeCommitSha: "c".repeat(40) };
const historicalDeliveryCallId = "original-committed-delivery";
const historicalDeliveryEvent = { sequence: 0, stepIndex: 1, turnId: "older-delivery-turn" };
const settlementOnly = "settlement-only";
const settlementOutputOnly = "settlement-output-only";
const historicalDeliveryResult = {
  ...workflowReportUpdate,
  nativeProduction: { status: "available", requestedRevision: "live" },
};
const historicalDeliveryMessages = () => [
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: historicalDeliveryCallId,
        toolName: workflowReportRun.toolName,
        input: workflowReportRun.input,
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: toolResultKind,
        toolCallId: historicalDeliveryCallId,
        toolName: workflowReportRun.toolName,
        output: { type: "json", value: historicalDeliveryResult },
      },
    ],
  },
];
const historicalHandoffDeliveryStep = async ({ key, placement, source, sourcePair }) => {
  if (placement === undefined) {
    return null;
  }
  const runId = placement === "unrelated" ? unrelatedDeliveryRunId : logicalSessionId;
  const output = {
    action: "park",
    ...sourcePair,
    sessionState: createDurableSessionState({
      session: {
        ...source,
        history: [source.history[0], ...historicalDeliveryMessages()],
        state: {
          ...source.state,
          "eve.harness.emission": {
            ...emission,
            ...historicalDeliveryEvent,
            stepIndex: historicalDeliveryEvent.stepIndex + 1,
          },
        },
      },
    }),
  };
  return {
    runId,
    stepId: "historical-delivery-step",
    stepName: turnStepName,
    status: completedStatus,
    output: await serialization.dehydrateStepReturnValue(output, runId, key),
  };
};
const workflowOutcomeStepId = "release-owned-workflow-invocation";
const cancelDescendantStepId = "cancel-owned-workflow";
const childResumeStepId = "send-owned-cancelled-outcome";
const childControlHookId = "owned-delivery-control-hook";
const childControlToken = "00000000-0000-4000-8000-000000000001";
const childCancelReason = "The turn that called the tool was cancelled.";
const parentInboxToken = sessionInboxHookToken(sessionCommandHookToken(logicalSessionId));
const workflowOutcomeResult = {
  status: completedStatus,
  output: { ...workflowReportUpdate, nativeProduction: { status: "available" } },
};
const defaultWorkflowOutcome = {
  kind: "outcome",
  from: workflowReportRun,
  result: workflowOutcomeResult,
};
const workflowOutcomeToolResult = workflowToolRunOutcomeToToolResult(defaultWorkflowOutcome);
const cancelledWorkflowOutcome = {
  ...defaultWorkflowOutcome,
  result: { status: "cancelled", reason: childCancelReason },
};

const ownedDeliveryState = (session) => {
  const { callId, toolName, turnId, stepIndex, runId } = workflowReportRun;
  return registerWorkflowToolRun(session, {
    callId,
    toolName,
    origin: { turnId, stepIndex },
    address: { runId, hookToken: childControlToken },
    lifetime: "turn",
  });
};

const attachCancelledWorkflowChild = async (world, key, evidence, deploymentId) => {
  if (evidence === undefined) {
    return;
  }
  const { runId, callId, toolName, stepIndex, input, execution } = workflowReportRun;
  const runInput = {
    callId,
    toolName,
    input,
    stepIndex,
    execution,
    workflowId: "workflow:fixture-owned-delivery",
    hookToken: childControlToken,
    owner: { inbox: parentInboxToken },
    session: {
      id: logicalSessionId,
      ownerRunId: evidence.foreignOwner === true ? "wrun_foreign_owner" : ownerRunId,
      ownerAnchorRunId: logicalSessionId,
      turn: { id: originalTurnId, sequence: emission.sequence },
    },
  };
  const childRun = {
    runId,
    workflowName: "workflow//eve//workflowToolRunWorkflow",
    status: evidence.runStatus ?? completedStatus,
    deploymentId,
    input: await serialization.dehydrateWorkflowArguments([runInput], runId, key),
  };
  const childResumeStep = {
    runId,
    stepId: childResumeStepId,
    stepName: "step//eve/execution/tools/workflow/resume-hook-step.js//resumeHookStep",
    status: completedStatus,
    input: await serialization.dehydrateStepArguments(
      {
        args: [
          evidence.foreignInbox === true ? "foreign-parent-inbox" : parentInboxToken,
          evidence.mismatchedOutcome === true ? defaultWorkflowOutcome : cancelledWorkflowOutcome,
          { ifPresent: true },
        ],
        closureVars: [],
      },
      runId,
      key,
    ),
  };
  const { delivery } = evidence;
  const retainedDeliverySteps = delivery?.completedSteps ?? [
    {
      name: "continueGitHubPrDelivery",
      args: [workflowReportRun.input],
      output: workflowReportUpdate,
    },
  ];
  const deliverySteps =
    delivery === undefined
      ? []
      : await Promise.all(
          retainedDeliverySteps.map(async (step, index) => ({
            runId,
            stepId: `prior-delivery-effect-${index}`,
            stepName: `step//./lib/agent/github-pr-delivery-step//${step.name}:eve-authorization`,
            status: delivery.status ?? completedStatus,
            input: await serialization.dehydrateStepArguments(
              { args: step.args, closureVars: [] },
              runId,
              key,
            ),
            output: await serialization.dehydrateStepReturnValue(step.output, runId, key),
          })),
        );
  const { pagedSteps } = evidence;
  const siblingStep =
    pagedSteps === undefined
      ? undefined
      : {
          runId,
          stepId: "separate-child-step",
          stepName: "step//eve//separateChildStep",
          status: pagedSteps.secondStatus,
        };
  const childEvent = (slot, eventType, correlationId, eventData) =>
    nativeWorldEvent(runId, slot, eventType, correlationId, eventData);
  const siblingEvent = (slot, eventType) =>
    childEvent(slot, eventType, siblingStep.stepId, { stepName: siblingStep.stepName });
  const deliveryEvents = deliverySteps.flatMap((step, index) => {
    if (delivery.dispatchLastAfterStop === true && index === deliverySteps.length - 1) {
      return [];
    }
    const slot = 1 + index * 2;
    const eventData = { stepName: step.stepName };
    const started = childEvent(slot, "step_started", step.stepId, eventData);
    return delivery.omitCompletion === true ||
      (delivery.schemaAfterStop !== undefined && index === deliverySteps.length - 1)
      ? [started]
      : [started, childEvent(slot + 1, "step_completed", step.stepId, eventData)];
  });
  const offset = deliverySteps.length * 2;
  const lastDelivery = deliverySteps.at(-1);
  const schemaSettledAfterTerminal = delivery?.schemaAfterStop === afterChildTerminal;
  const lateSchemaSlot = offset + (schemaSettledAfterTerminal ? 11 : 6);
  const lateSchemaEvent =
    delivery?.schemaAfterStop === undefined || lastDelivery === undefined
      ? undefined
      : childEvent(lateSchemaSlot, "step_completed", lastDelivery.stepId, {
          stepName: lastDelivery.stepName,
        });
  const lateDispatch =
    delivery?.dispatchLastAfterStop === true && lastDelivery !== undefined
      ? childEvent(offset + 4, "step_started", lastDelivery.stepId, {
          stepName: lastDelivery.stepName,
        })
      : undefined;
  const lateRetry =
    delivery?.schemaRetryAfterStop === true && lastDelivery !== undefined
      ? childEvent(offset + 5, "step_retrying", lastDelivery.stepId, {
          stepName: lastDelivery.stepName,
        })
      : undefined;
  const childEvents = [
    ...deliveryEvents,
    ...(siblingStep === undefined ? [] : [siblingEvent(1 + offset, "step_started")]),
    ...(delivery?.unlistedAuthoredStep === true
      ? [
          childEvent(1 + offset, "step_started", "unlisted-effect-step", {
            stepName: "step//./lib/agent/github-pr-delivery-step//unknownEffect:eve-authorization",
          }),
        ]
      : []),
    childEvent(2 + offset, "hook_created", childControlHookId, { token: childControlToken }),
    ...(evidence.omitControl === true
      ? []
      : [
          childEvent(3 + offset, "hook_received", childControlHookId, {
            token: childControlToken,
            payload: await serialization.dehydrateStepReturnValue(
              { kind: "cancel", reason: childCancelReason },
              runId,
              key,
            ),
          }),
        ]),
    ...(lateDispatch === undefined ? [] : [lateDispatch]),
    ...(lateRetry === undefined ? [] : [lateRetry]),
    ...(lateSchemaEvent === undefined || schemaSettledAfterTerminal ? [] : [lateSchemaEvent]),
    childEvent(7 + offset, "step_started", childResumeStepId, {
      stepName: childResumeStep.stepName,
    }),
    childEvent(8 + offset, "step_completed", childResumeStepId, {
      stepName: childResumeStep.stepName,
    }),
    ...(pagedSteps?.failureBeforeRun === true ? [siblingEvent(9 + offset, "step_failed")] : []),
    childEvent(10 + offset, "run_completed", undefined, {}),
    ...(lateSchemaEvent === undefined || !schemaSettledAfterTerminal ? [] : [lateSchemaEvent]),
    ...(pagedSteps?.failureAfterRun === true ? [siblingEvent(11 + offset, "step_failed")] : []),
    ...(pagedSteps?.unrelatedLateEvent === true
      ? [
          childEvent(12 + offset, "step_failed", "unknown-child-step", {
            stepName: "step//eve//unknownStep",
          }),
        ]
      : []),
  ];
  const { runs, events, steps } = world;
  world.runs = {
    ...runs,
    async get(id, options) {
      if (id !== runId) {
        return await runs.get(id, options);
      }
      if (evidence.runReadError !== undefined) {
        throw evidence.runReadError;
      }
      return childRun;
    },
  };
  world.events = {
    list: async (options) =>
      options.runId === runId ? { data: childEvents, hasMore: false } : await events.list(options),
    get: async (id, event, options) =>
      id === runId
        ? childEvents.find(({ eventId: childEventId }) => childEventId === event)
        : await events.get(id, event, options),
  };
  world.steps = {
    async list(request) {
      assert.equal(request.runId, runId);
      if (pagedSteps === undefined) {
        return await Promise.resolve({
          data: [...deliverySteps, childResumeStep],
          hasMore: false,
        });
      }

      const { pagination } = request;
      if (Object.hasOwn(pagination, "limit")) {
        throw new WorkflowWorldError("Explicit page size is unsupported", { status: 400 });
      }
      const { cursor } = pagination;
      pagedSteps.requests.push(request);
      if (cursor === undefined) {
        return { data: [childResumeStep], hasMore: true, cursor: "next-child-steps" };
      }

      return { data: [siblingStep], hasMore: false };
    },
    async get(id, stepId, options) {
      if (id === runId && stepId === childResumeStepId) {
        return childResumeStep;
      }
      const deliveryStep = deliverySteps.find((entry) => entry.stepId === stepId);
      if (id === runId && deliveryStep !== undefined) {
        return deliveryStep;
      }
      return await steps.get(id, stepId, options);
    },
  };
};

const workflowOutcomeHistory = (history, evidence) => {
  const { callId, toolName, input } = workflowReportRun;
  const called = [
    ...history,
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: callId, toolName, input }],
    },
  ];
  if (evidence.result === "synthetic") {
    return settleCancelledToolHistory(called, [{ callId, toolName }]);
  }
  if (evidence.result === "pending") {
    return called;
  }
  return [
    ...called,
    {
      role: "tool",
      content: [
        {
          type: toolResultKind,
          toolCallId: callId,
          toolName,
          output: { type: "json", value: evidence.historyOutput ?? workflowOutcomeResult.output },
        },
      ],
    },
  ];
};

const nativeWorkflowReport = (run, update) =>
  stampMessageStreamEvent(
    createActionPartialEvent({
      sequence: run.sequence,
      stepIndex: run.stepIndex,
      turnId: run.turnId,
      result: createRuntimeToolResultFromValue({
        callId: run.callId,
        toolName: run.toolName,
        output: update,
      }),
    }),
  );

const addSettledCancellation = async ({
  args,
  events,
  event,
  output,
  source,
  sourcePair,
  steps,
  beforeCancellationSend,
  retainedInboxReceipt,
  cancellationSendEvidence,
  stopDuringTurnStep,
  workflowReport,
  workflowOutcome,
  cancelledOutcome,
}) => {
  const active = clearPendingCoordinationBatch({
    ...source,
    history: [source.history[0]],
  });
  const delivery = cancelledOutcome?.delivery;
  const historicalMessages =
    delivery?.historicalResult === undefined ? [] : historicalDeliveryMessages();
  if (delivery?.priorDeliveryPlacement !== settlementOutputOnly) {
    active.history.push(...historicalMessages);
  }
  if (beforeCancellationSend === true) {
    active.continuationToken = "old-turn-inbox";
  }
  const priorCommittedHistory = active.history;
  let settledActive = active;
  let settledHistory = active.history;
  if (workflowOutcome !== undefined) {
    settledHistory = workflowOutcomeHistory(active.history, workflowOutcome);
    settledActive = { ...active, history: settledHistory };
  }
  if (cancelledOutcome !== undefined) {
    const pendingHistory = workflowOutcomeHistory(active.history, { result: "pending" });
    const { callId, toolName } = workflowReportRun;
    settledActive = { ...active, history: pendingHistory };
    if (cancelledOutcome.omitRegistration !== true) {
      settledActive = ownedDeliveryState(settledActive);
    }
    settledHistory = settleCancelledToolHistory(pendingHistory, [{ callId, toolName }]);
  }
  const before = {
    ...sourcePair,
    sessionState: createDurableSessionState({ session: settledActive }),
  };
  if (delivery?.priorDeliveryPlacement === settlementOutputOnly) {
    settledHistory = [settledHistory[0], ...historicalMessages, ...settledHistory.slice(1)];
  }
  const compacted = delivery?.compacted;
  if (compacted !== undefined) {
    const withoutHistoricalDelivery = (history) =>
      history.filter(
        (message) =>
          !Array.isArray(message.content) ||
          message.content.some((part) => part.toolCallId === historicalDeliveryCallId) !== true,
      );
    const retained = withoutHistoricalDelivery(settledHistory);
    const marker = {
      role: "user",
      kind: "context.compaction",
      content: "[fixture compaction checkpoint]",
    };
    settledHistory = [retained[0], marker, ...retained.slice(1)];
    if (
      delivery.priorDeliveryCheckpoint !== undefined ||
      delivery.historicalCheckpointInParent === true
    ) {
      const history = withoutHistoricalDelivery(settledActive.history);
      before.sessionState = createDurableSessionState({
        session: { ...settledActive, history: [history[0], marker, ...history.slice(1)] },
      });
    }
    if (compacted === "conflicting") {
      settledHistory.push({
        role: "tool",
        content: [
          {
            type: toolResultKind,
            toolCallId: historicalDeliveryCallId,
            toolName: workflowReportRun.toolName,
            output: { type: "text", value: "A different retained output." },
          },
        ],
      });
    }
  }
  const idle = {
    ...active,
    history: settledHistory,
    state: {
      ...active.state,
      "eve.harness.emission": { ...emission, sequence: 2, stepIndex: 0, turnId: "" },
    },
  };
  if (beforeCancellationSend === true) {
    idle.continuationToken = "new-idle-inbox";
  }
  const settled = {
    ...sourcePair,
    sessionState: createDurableSessionState({ session: idle }),
  };
  const priorInbox = "turn-step-input-inbox";
  if (stopDuringTurnStep === true) {
    steps.get("prior").input = await args({
      ...before,
      sessionState: createDurableSessionState({
        session: { ...settledActive, continuationToken: priorInbox },
      }),
    });
  }
  const priorOutput = {
    action: stopDuringTurnStep === true ? "cancelled" : "park",
    ...before,
  };
  if (compacted !== undefined || delivery?.priorDeliveryPlacement === settlementOnly) {
    const priorEmission = delivery?.priorDeliveryCheckpoint;
    priorOutput.sessionState = createDurableSessionState({
      session: {
        ...settledActive,
        history:
          delivery?.priorDeliveryPlacement === settlementOnly ||
          delivery?.historicalCheckpointInParent === true
            ? [priorCommittedHistory[0]]
            : priorCommittedHistory,
        state: {
          ...settledActive.state,
          "eve.harness.emission": { ...emission, ...priorEmission },
        },
      },
    });
  }
  steps.get("prior").output = await output(priorOutput);
  steps.set(settledCancelStepId, {
    runId: ownerRunId,
    stepId: settledCancelStepId,
    stepName: "step//eve//settleCancelledTurnStep",
    status: completedStatus,
    input: await args(before),
    output: await output(settled),
  });
  const sendBeforeStop =
    beforeCancellationSend === true &&
    cancellationSendEvidence !== undefined &&
    cancellationSendEvidence.afterStop !== true;
  const firstReceiptSlot = stopDuringTurnStep === true ? 4 : 5;
  const standardStopSlot = sendBeforeStop ? firstReceiptSlot + 1 : firstReceiptSlot;
  const reportStopSlot =
    workflowReport !== undefined && workflowReport.afterStop !== true ? 8 : standardStopSlot;
  const stopSlot = workflowOutcome === undefined ? reportStopSlot : 11;
  const cancelReceipt = event(stopSlot, "hook_received", commandHookId, {
    token: `eve:session:${logicalSessionId}:inbox`,
    payload: await output({ kind: "cancel", turnId: originalTurnId }),
  });
  const receipts = [cancelReceipt];
  if (retainedInboxReceipt !== undefined) {
    receipts.push(
      event(firstReceiptSlot + 1, "hook_received", commandHookId, {
        token: `eve:session:${logicalSessionId}:inbox`,
        payload: await retainedInboxReceipt(),
      }),
    );
  }
  if (beforeCancellationSend === true) {
    const queuedSendSlot = sendBeforeStop ? firstReceiptSlot : firstReceiptSlot + 1;
    const command = { kind: "send", payload: { message: "accepted message" } };
    if (cancellationSendEvidence !== undefined) {
      Object.assign(command, {
        requestId: originalRequestId,
        auth: { principalId: originalOwnerId },
        delivery: {
          channelKind: "eve",
          channelName: "eve",
          deliveryId: cancellationSendEvidence.acceptedId,
        },
      });
    }
    const queuedSend = event(queuedSendSlot, "hook_received", "old-continuation", {
      token: stopDuringTurnStep === true ? priorInbox : "old-turn-inbox",
      payload: await output(command),
    });
    if (sendBeforeStop) {
      receipts.unshift(queuedSend);
    } else {
      receipts.push(queuedSend);
    }
  }
  if (workflowReport !== undefined) {
    const afterStop = workflowReport.afterStop === true;
    const reportSlot = afterStop ? 6 : 5;
    const report = {
      kind: "report",
      from: { ...workflowReportRun, ...workflowReport.from },
      update: workflowReportUpdate,
    };
    receipts.push(
      event(reportSlot, "hook_received", commandHookId, {
        token: `eve:session:${logicalSessionId}:inbox`,
        payload: await output(report),
      }),
    );
    if (workflowReport.omitStep !== true) {
      const sessionWritable = new WritableStream();
      Object.defineProperty(sessionWritable, Symbol.for("WORKFLOW_STREAM_NAME"), {
        value: "owner-session-stream",
      });
      steps.set(workflowReportStepId, {
        runId: ownerRunId,
        stepId: workflowReportStepId,
        stepName:
          "step//eve/execution/tools/workflow/emit-workflow-tool-run-report-step.js//emitWorkflowToolRunReportStep",
        status: completedStatus,
        input: await args({
          from: workflowReportRun,
          sessionWritable,
          update: workflowReport.stepUpdate ?? workflowReportUpdate,
        }),
        output: await output(),
      });
      receipts.push(
        event(reportSlot + 1, "step_started", workflowReportStepId),
        event(reportSlot + 2, "step_completed", workflowReportStepId),
      );
    }
  }
  if (workflowOutcome !== undefined) {
    const outcomeSlot = workflowReport === undefined ? 5 : 8;
    const outcome = {
      ...defaultWorkflowOutcome,
      from: { ...workflowReportRun, ...workflowOutcome.from },
      result: {
        ...workflowOutcomeResult,
        output: workflowOutcome.receiptOutput ?? workflowOutcomeResult.output,
      },
    };
    receipts.push(
      event(outcomeSlot, "hook_received", commandHookId, {
        token: `eve:session:${logicalSessionId}:inbox`,
        payload: await output(outcome),
      }),
    );
    if (workflowOutcome.omitStep !== true) {
      const { runId } = workflowReportRun;
      const releasing = ownedDeliveryState(active);
      steps.set(workflowOutcomeStepId, {
        runId: ownerRunId,
        stepId: workflowOutcomeStepId,
        stepName:
          "step//eve/execution/tools/subagent/invoke-step.js//releaseAgentInvocationOwnerStep",
        status: completedStatus,
        input: await args({
          ownerId: runId,
          cancelled: false,
          sessionState: createDurableSessionState({ session: releasing }),
        }),
        output: await output({
          sessionState: createDurableSessionState({ session: releasing }),
        }),
      });
      receipts.push(
        event(outcomeSlot + 1, "step_started", workflowOutcomeStepId),
        event(outcomeSlot + 2, "step_completed", workflowOutcomeStepId),
      );
    }
  }
  if (cancelledOutcome !== undefined) {
    const cleanupStart = stopSlot + (cancelledOutcome.beforeCleanup === true ? 2 : 1);
    const outcomeAfterStart = cancelledOutcome.afterCleanup === true ? 3 : 1;
    const outcomeSlot =
      cancelledOutcome.beforeCleanup === true ? cleanupStart - 1 : cleanupStart + outcomeAfterStart;
    if (cancelledOutcome.omitCleanup !== true) {
      const cleanupInput = cancelledOutcome.mismatchedPair === true ? sourcePair : before;
      steps.set(cancelDescendantStepId, {
        runId: ownerRunId,
        stepId: cancelDescendantStepId,
        stepName: "step//eve/execution/cancel-descendant-turns-step.js//cancelDescendantTurnsStep",
        status: completedStatus,
        input: await args(cleanupInput),
        output: await output(),
      });
      receipts.push(
        event(cleanupStart, "step_started", cancelDescendantStepId),
        event(cleanupStart + 2, "step_completed", cancelDescendantStepId),
      );
    }
    receipts.push(
      event(outcomeSlot, "hook_received", commandHookId, {
        token: parentInboxToken,
        payload: await output(cancelledWorkflowOutcome),
      }),
    );
  }
  receipts.sort((left, right) => left.eventId.localeCompare(right.eventId));
  const afterPriorStepStart = events.findIndex((entry) => entry.eventId === eventId(3)) + 1;
  const reportSettlementSlot = workflowReport === undefined ? 7 : 9;
  const outcomeSettlementSlot = workflowOutcome === undefined ? reportSettlementSlot : 12;
  const settlementSlot = cancelledOutcome === undefined ? outcomeSettlementSlot : stopSlot + 5;
  events.splice(
    afterPriorStepStart,
    events.length - afterPriorStepStart,
    ...(stopDuringTurnStep === true ? [] : [event(4, "step_completed", "prior")]),
    ...receipts,
    ...(stopDuringTurnStep === true ? [event(6, "step_completed", "prior")] : []),
    event(settlementSlot, "step_started", settledCancelStepId),
    event(settlementSlot + 1, "step_completed", settledCancelStepId),
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
      ...options.cancelledOutcome?.delivery?.serializedContext,
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
          retainedInboxReceipt:
            options.retainedInboxPayload === undefined
              ? undefined
              : async () =>
                  await serialization.dehydrateWorkflowArguments(
                    options.retainedInboxPayload,
                    ownerRunId,
                    key,
                  ),
          cancellationSendEvidence: options.cancellationSendEvidence,
          stopDuringTurnStep: options.stopDuringTurnStep,
          workflowReport: options.workflowReport,
          workflowOutcome: options.workflowOutcome,
          cancelledOutcome: options.cancelledOutcome,
        })
      : undefined;
  await appendHistoricalInbox(events, event, output, options.inboxSuffix, settled === undefined);
  const { cancellationSendEvidence, workflowReport, workflowOutcome } = options;
  const cancelledTurn = { sequence: emission.sequence, turnId: originalTurnId };
  const reportEvents =
    workflowReport === undefined || workflowReport.omitPartial === true
      ? []
      : [
          nativeWorkflowReport(
            workflowReportRun,
            workflowReport.partialUpdate ?? workflowReportUpdate,
          ),
        ];
  const historicalNativeDelivery =
    options.cancelledOutcome?.delivery?.historicalResult === undefined
      ? []
      : [
          {
            type: actionsRequestedKind,
            data: {
              ...historicalDeliveryEvent,
              actions: [
                {
                  callId: historicalDeliveryCallId,
                  kind: "tool-call",
                  toolName: workflowReportRun.toolName,
                  input: workflowReportRun.input,
                },
              ],
            },
          },
          stampMessageStreamEvent(
            createActionResultEvent({
              ...historicalDeliveryEvent,
              rejected: false,
              result: {
                kind: toolResultKind,
                callId: historicalDeliveryCallId,
                toolName: workflowReportRun.toolName,
                output: options.cancelledOutcome.delivery.historicalResult,
              },
            }),
          ),
        ];
  const compactionProven =
    options.cancelledOutcome?.delivery?.compacted === "marked" ||
    options.cancelledOutcome?.delivery?.compacted === "conflicting";
  const nativeEvents = [
    ...historicalNativeDelivery,
    ...(compactionProven
      ? [
          {
            type: "compaction.completed",
            data: {
              ...emission,
              sessionId: logicalSessionId,
              modelId: "fixture-compaction-model",
            },
          },
        ]
      : []),
    ...(cancellationSendEvidence === undefined
      ? []
      : [
          stampMessageStreamEvent(
            createTurnStartedEvent(cancelledTurn),
            cancellationSendEvidence.startedIds,
          ),
        ]),
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
    ...(options.uncommittedDispatch === true ||
    options.uncommittedAction !== undefined ||
    options.interruptedObservation !== undefined
      ? [
          {
            type: actionsRequestedKind,
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
                  ...options.uncommittedAction,
                },
              ],
            },
          },
        ]
      : []),
    ...(options.cancelledOutcome?.delivery === undefined
      ? []
      : [
          {
            type: actionsRequestedKind,
            data: {
              ...batchEvent,
              actions: [
                {
                  callId: workflowReportRun.callId,
                  kind: "tool-call",
                  toolName: workflowReportRun.toolName,
                  input: options.cancelledOutcome.delivery.dispatchInput ?? workflowReportRun.input,
                },
              ],
            },
          },
        ]),
    ...(workflowReport?.partialAfterCancellation === true ? [] : reportEvents),
    ...(workflowOutcome === undefined || workflowOutcome.omitNativeResult === true
      ? []
      : [
          stampMessageStreamEvent(
            createActionResultEvent({
              rejected: workflowOutcome.nativeRejected === true,
              sequence: workflowReportRun.sequence,
              stepIndex: workflowReportRun.stepIndex,
              turnId: workflowReportRun.turnId,
              result: {
                ...workflowOutcomeToolResult,
                output: workflowOutcome.nativeOutput ?? workflowOutcomeToolResult.output,
              },
            }),
          ),
        ]),
    ...(options.cancelled === true || settled !== undefined
      ? [
          cancellationSendEvidence === undefined
            ? createTurnCancelledEvent(cancelledTurn)
            : stampMessageStreamEvent(
                createTurnCancelledEvent(cancelledTurn),
                cancellationSendEvidence.cancelledIds,
              ),
        ]
      : []),
    ...(workflowReport?.partialAfterCancellation === true ? reportEvents : []),
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
    priorDelivery: await historicalHandoffDeliveryStep({
      key,
      placement: options.handoffDeliveryCheckpoint,
      source,
      sourcePair,
    }),
  });
  await attachCancelledWorkflowChild(
    world,
    key,
    options.cancelledOutcome,
    options.handoff === true ? childDeploymentId : undefined,
  );
  const snapshotKey = await attachNativeSnapshot(world, nativeEvents, options.snapshot);
  let authorized = false;
  const collect = collectorFor(options)({
    getWorld: async () => await Promise.resolve(world),
    hydrateHookPayload: async (value, _runId, payloadKey) =>
      serialization.deserializePreparedReplayPayload(
        await serialization.prepareReplayPayload(value, payloadKey),
        globalThis,
      ),
    hydrateStepArguments: (value, runId, payloadKey) =>
      serialization.hydrateStepArguments(
        value,
        runId,
        payloadKey,
        [],
        globalThis,
        transportRevivers,
      ),
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
    verifyCancelledWorkflowEffects: options.verifyCancelledWorkflowEffects,
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
  assert.equal(result.provenance.coveredNativeEventIds.includes(eventId(5)), true);
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
    interruptedObservation: { appId: fixtureAppId },
    stopDuringTurnStep: true,
  });
  const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
  assert.equal(result.kind, "ready");
  assert.equal(result.provenance.selectedOrigin.stepId, settledCancelStepId);
  assert.equal(result.provenance.coveredNativeEventIds.includes(eventId(4)), true);
  assert.equal(result.replayInput, undefined);
  assert.equal(result.carriedInbox, undefined);
  assert.deepEqual(result.checkpointCore, f.settled);
});

test("idle transfer rejects a queued Send received inside the producing turn step", async () => {
  const f = await settledIdleFixture({ beforeCancellationSend: true, stopDuringTurnStep: true });
  const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
  assert.deepEqual(result, { kind: "uncertain", reason: unconsumedNativeInboxReason });
});

const consumedCancellationSendId = "server-delivery-original";

const settledIdleWithSend = async (overrides = {}) =>
  await settledIdleFixture({
    beforeCancellationSend: true,
    stopDuringTurnStep: true,
    cancellationSendEvidence: {
      acceptedId: consumedCancellationSendId,
      startedIds: [consumedCancellationSendId],
      cancelledIds: [consumedCancellationSendId],
      ...overrides,
    },
  });

test("matching native delivery stamps cover an accepted Send without replay", async () => {
  const f = await settledIdleWithSend();
  const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
  assert.equal(result.kind, "ready");
  assert.equal(result.provenance.selectedOrigin.stepId, settledCancelStepId);
  assert.equal(result.provenance.selectedOrigin.kind, "committed-cancelled-turn-output");
  assert.equal(result.provenance.coveredNativeEventIds.includes(eventId(4)), true);
  assert.equal(result.replayInput, undefined);
  assert.equal(result.carriedInbox, undefined);
});

for (const { name, evidence } of [
  { name: "an unrelated stamped delivery ID", evidence: { startedIds: ["other-delivery"] } },
  { name: "a missing terminal delivery stamp", evidence: { cancelledIds: [] } },
  { name: "a missing accepted delivery ID", evidence: { acceptedId: null } },
  { name: "receipt after the Stop", evidence: { afterStop: true } },
]) {
  test(`idle transfer still refuses a prior Send with ${name}`, async () => {
    const f = await settledIdleWithSend(evidence);
    const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
    assert.deepEqual(result, { kind: "uncertain", reason: unconsumedNativeInboxReason });
  });
}

test("an internal workflow receipt stays fenced and its private contents are not logged", async () => {
  const f = await settledIdleFixture({
    encrypted: true,
    retainedInboxPayload: {
      kind: "runtime-action-result",
      results: [{ ...actualRuntimeResult, output: { note: "private fixture value" } }],
    },
  });
  const records = [];
  const diagnostic = vi.spyOn(console, "info").mockImplementation((record) => {
    records.push(record);
  });
  try {
    const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
    assert.deepEqual(result, { kind: "uncertain", reason: unconsumedNativeInboxReason });
    assert.deepEqual(records, [
      JSON.stringify({
        event: "builder.cancellation_inbox_refusal",
        boundary: "runtime_action_result",
      }),
    ]);
  } finally {
    diagnostic.mockRestore();
  }
});

for (const afterStop of [false, true]) {
  test(`idle transfer accepts an exact emitted report received ${afterStop ? "after" : "before"} Stop`, async () => {
    const f = await settledIdleFixture({ encrypted: true, workflowReport: { afterStop } });
    const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
    assert.equal(result.kind, "ready");
    assert.equal(result.provenance.selectedOrigin.stepId, settledCancelStepId);
    assert.equal(
      result.provenance.coveredNativeEventIds.includes(eventId(afterStop ? 6 : 5)),
      true,
    );
    assert.equal(result.replayInput, undefined);
    assert.equal(result.carriedInbox, undefined);
    assert.deepEqual(result.checkpointCore, f.settled);
  });
}

for (const { name, evidence } of [
  { name: "the foreign owner", evidence: { from: { ownerRunId: "wrun_foreign_owner" } } },
  { name: "the foreign child run", evidence: { from: { runId: "wrun_foreign_child" } } },
  {
    name: "the mismatched emitted step input",
    evidence: { stepUpdate: { progress: "Different" } },
  },
  { name: "the mismatched native partial", evidence: { partialUpdate: { progress: "Different" } } },
  { name: "a partial emitted after cancellation", evidence: { partialAfterCancellation: true } },
  { name: "missing emission proof", evidence: { omitStep: true, omitPartial: true } },
]) {
  test(`idle transfer refuses a retained workflow report with ${name}`, async () => {
    const f = await settledIdleFixture({ encrypted: true, workflowReport: evidence });
    const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
    assert.equal(result.kind, "uncertain");
    assert.equal(result.reason, unconsumedNativeInboxReason);
  });
}

test("idle transfer does not mistake a report received after Stop for an earlier emission", async () => {
  const f = await settledIdleFixture({
    encrypted: true,
    workflowReport: { afterStop: true, omitStep: true },
  });
  const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
  assert.equal(result.kind, "uncertain");
  assert.equal(result.reason, unconsumedNativeInboxReason);
});

test("an exactly consumed report leaves a later uncommitted effect fenced", async () => {
  const f = await settledIdleFixture({
    encrypted: true,
    workflowReport: {},
    uncommittedWrite: true,
  });
  const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
  assert.equal(result.kind, "uncertain");
  assert.equal(result.reason, uncommittedActionResultReason);
});

test("idle transfer accepts a consumed workflow outcome with its exact committed call and result", async () => {
  const f = await settledIdleFixture({
    encrypted: true,
    workflowOutcome: { historyOutput: { summary: "The app is available" } },
  });
  const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
  assert.equal(result.kind, "ready");
  assert.equal(result.provenance.selectedOrigin.stepId, settledCancelStepId);
  assert.equal(result.provenance.coveredNativeEventIds.includes(eventId(5)), true);
  assert.equal(result.replayInput, undefined);
  assert.equal(result.carriedInbox, undefined);
  assert.deepEqual(result.checkpointCore, f.settled);
});

test("idle transfer verifies the retained report and outcome for the same workflow without replay", async () => {
  const f = await settledIdleFixture({ encrypted: true, workflowReport: {}, workflowOutcome: {} });
  const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
  assert.equal(result.kind, "ready");
  assert.equal(result.provenance.coveredNativeEventIds.includes(eventId(5)), true);
  assert.equal(result.provenance.coveredNativeEventIds.includes(eventId(8)), true);
  assert.equal(result.replayInput, undefined);
  assert.equal(result.carriedInbox, undefined);
  assert.deepEqual(result.checkpointCore, f.settled);
});

for (const { name, evidence } of [
  { name: "an uncommitted result", evidence: { result: "pending" } },
  { name: "a synthetic cancelled result", evidence: { result: "synthetic" } },
  { name: "a mismatched native result", evidence: { nativeOutput: { status: "different" } } },
  { name: "no completed release step", evidence: { omitStep: true } },
  { name: "a mismatched receipt output", evidence: { receiptOutput: { status: "different" } } },
  { name: "a foreign owner", evidence: { from: { ownerRunId: "wrun_foreign_owner" } } },
  { name: "a foreign child run", evidence: { from: { runId: "wrun_foreign_child" } } },
  { name: "no native result", evidence: { omitNativeResult: true } },
  { name: "a native result marked rejected", evidence: { nativeRejected: true } },
]) {
  test(`idle transfer refuses a retained workflow outcome with ${name}`, async () => {
    const f = await settledIdleFixture({ encrypted: true, workflowOutcome: evidence });
    const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
    assert.equal(result.kind, "uncertain");
    assert.equal(result.reason, unconsumedNativeInboxReason);
  });
}

test("idle transfer accepts only the exact cancellation notice from the owned descendant", async () => {
  const f = await settledIdleFixture({ encrypted: true, cancelledOutcome: {} });
  const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
  assert.equal(result.kind, "ready");
  assert.equal(result.provenance.selectedOrigin.stepId, settledCancelStepId);
  assert.equal(result.provenance.coveredNativeEventIds.includes(eventId(7)), true);
  assert.equal(result.replayInput, undefined);
  assert.equal(result.carriedInbox, undefined);
  assert.deepEqual(result.checkpointCore, f.settled);
});

test("idle transfer accepts an exact cancellation notice recorded after cleanup and before settlement", async () => {
  const f = await settledIdleFixture({
    encrypted: true,
    cancelledOutcome: { afterCleanup: true },
  });
  const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
  assert.equal(result.kind, "ready");
  assert.equal(result.provenance.selectedOrigin.stepId, settledCancelStepId);
  assert.equal(result.provenance.coveredNativeEventIds.includes(eventId(9)), true);
  assert.equal(result.replayInput, undefined);
  assert.equal(result.carriedInbox, undefined);
  assert.deepEqual(result.checkpointCore, f.settled);
});

for (const { name, evidence } of [
  { name: "missing parent cleanup", evidence: { omitCleanup: true } },
  { name: "an unrelated parent checkpoint", evidence: { mismatchedPair: true } },
  { name: "no recorded child ownership", evidence: { omitRegistration: true } },
  { name: "a notice before parent cleanup", evidence: { beforeCleanup: true } },
  { name: "a foreign child owner", evidence: { foreignOwner: true } },
  { name: "a foreign parent inbox", evidence: { foreignInbox: true } },
  { name: "no child Stop receipt", evidence: { omitControl: true } },
  { name: "an unsettled child", evidence: { runStatus: "running" } },
  { name: "a different child outcome", evidence: { mismatchedOutcome: true } },
]) {
  test(`idle transfer refuses a cancelled descendant outcome with ${name}`, async () => {
    const f = await settledIdleFixture({ encrypted: true, cancelledOutcome: evidence });
    const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
    assert.equal(result.kind, "uncertain");
    assert.equal(result.reason, unconsumedNativeInboxReason);
  });
}

test("a missing child terminal witness logs only its fixed category and still blocks recovery", async () => {
  const witnessRecords = [];
  const diagnostic = vi.spyOn(console, "info").mockImplementation((record) => {
    if (String(record).includes(cancelledWorkflowWitnessEvent)) {
      witnessRecords.push(record);
    }
  });
  try {
    const f = await settledIdleFixture({
      encrypted: true,
      cancelledOutcome: { runStatus: "running" },
    });
    const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
    assert.deepEqual(result, { kind: "uncertain", reason: unconsumedNativeInboxReason });
    assert.deepEqual(witnessRecords, [
      JSON.stringify({
        event: cancelledWorkflowWitnessEvent,
        boundary: "child_not_completed",
      }),
    ]);
  } finally {
    diagnostic.mockRestore();
  }
});

test("a failed child run read logs only fixed diagnostics and still blocks recovery", async () => {
  const canary = "private child World response";
  const failure = new WorkflowWorldError(canary, { status: 503, url: canary, code: canary });
  const witnessRecords = [];
  const diagnostic = vi.spyOn(console, "info").mockImplementation((record) => {
    if (String(record).includes(cancelledWorkflowWitnessEvent)) {
      witnessRecords.push(record);
    }
  });
  try {
    const f = await settledIdleFixture({
      encrypted: true,
      cancelledOutcome: { runReadError: failure },
    });
    const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
    assert.deepEqual(result, { kind: "uncertain", reason: unconsumedNativeInboxReason });
    assert.deepEqual(
      witnessRecords.map((record) => JSON.parse(record)),
      [
        {
          event: cancelledWorkflowWitnessEvent,
          boundary: "child_witness_unavailable",
          stage: "child_run_read",
          errorCategory: "http_unavailable",
        },
      ],
    );
  } finally {
    diagnostic.mockRestore();
  }
});

for (const secondStatus of [completedStatus, "pending"]) {
  test(`descendant cancellation inspects both default-sized step pages with a ${secondStatus} later step`, async () => {
    const requests = [];
    const f = await settledIdleFixture({
      encrypted: true,
      cancelledOutcome: { pagedSteps: { requests, secondStatus } },
    });
    const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
    assert.deepEqual(requests, [
      {
        runId: workflowReportRun.runId,
        pagination: { sortOrder: "asc" },
        resolveData: "none",
      },
      {
        runId: workflowReportRun.runId,
        pagination: { sortOrder: "asc", cursor: "next-child-steps" },
        resolveData: "none",
      },
    ]);
    if (secondStatus === completedStatus) {
      assert.equal(result.kind, "ready");
      assert.equal(result.replayInput, undefined);
      assert.equal(result.carriedInbox, undefined);
    } else {
      assert.deepEqual(result, { kind: "uncertain", reason: unconsumedNativeInboxReason });
    }
  });
}

for (const { name, sibling } of [
  { name: "cancelled", sibling: { secondStatus: "cancelled" } },
  {
    name: "failed before run completion",
    sibling: { secondStatus: "failed", failureBeforeRun: true },
  },
  {
    name: "failed after run completion",
    sibling: { secondStatus: "failed", failureAfterRun: true },
  },
]) {
  test(`idle transfer accepts a proven cancellation notice with a ${name} sibling step`, async () => {
    const f = await settledIdleFixture({
      encrypted: true,
      cancelledOutcome: { pagedSteps: { requests: [], ...sibling } },
    });
    const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
    assert.equal(result.kind, "ready");
    assert.equal(result.replayInput, undefined);
    assert.equal(result.carriedInbox, undefined);
    assert.deepEqual(result.checkpointCore, f.settled);
  });
}

test("an unrelated late child event still prevents cancellation recovery", async () => {
  const f = await settledIdleFixture({
    encrypted: true,
    cancelledOutcome: {
      pagedSteps: {
        requests: [],
        secondStatus: "failed",
        failureAfterRun: true,
        unrelatedLateEvent: true,
      },
    },
  });
  const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
  assert.deepEqual(result, { kind: "uncertain", reason: unconsumedNativeInboxReason });
});

test("a proven descendant cancellation notice does not resolve an unrelated dispatched write", async () => {
  const f = await settledIdleFixture({
    encrypted: true,
    cancelledOutcome: { pagedSteps: { requests: [], secondStatus: "cancelled" } },
    uncommittedDispatch: true,
  });
  const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
  assert.equal(result.kind, "uncertain");
  assert.equal(result.reason, uncommittedActionDispatchReason);
});

const cancelledDeliveryWitnessFixture = (options = {}) =>
  createCancelledDeliveryWitnessFixture({
    callId: workflowReportRun.callId,
    turnId: workflowReportRun.turnId,
    turnSequence: workflowReportRun.sequence,
    logicalSessionId,
    checkpointOwnerRunId: ownerRunId,
    sourceOwnerRunId: ownerRunId,
    toolInput: workflowReportRun.input,
    ...options,
  });

test.each([
  { name: "keeps the reviewed app ready to resume", unlistedAuthoredStep: false },
  { name: "stays fenced with an unlisted authored child step", unlistedAuthoredStep: true },
])("exact cancelled child delivery $name", async ({ unlistedAuthoredStep }) => {
  const retainedDelivery = cancelledDeliveryWitnessFixture();
  const read = [];
  const f = await settledIdleFixture({
    encrypted: true,
    cancelledOutcome: {
      delivery: {
        unlistedAuthoredStep,
        completedSteps: retainedDelivery.witness.completedSteps,
        serializedContext: retainedDelivery.context,
      },
    },
    verifyCancelledWorkflowEffects: async (witness) => {
      read.push(witness);
      return await Promise.resolve(verifySettledGitHubDelivery(witness, retainedDelivery.owner));
    },
  });
  const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
  if (unlistedAuthoredStep) {
    assert.equal(read.length, 0);
    assert.equal(result.kind, "uncertain");
    assert.equal(result.reason, uncommittedActionDispatchReason);
    return;
  }
  assert.equal(read.length, 1);
  assert.equal(read[0].callId, workflowReportRun.callId);
  assert.equal(read[0].turnSequence, workflowReportRun.sequence);
  assert.equal(read[0].logicalSessionId, logicalSessionId);
  assert.deepEqual(read[0].toolInput, workflowReportRun.input);
  assert.deepEqual(read[0].completedSteps, retainedDelivery.witness.completedSteps);
  assert.equal(result.kind, "ready");
  assert.deepEqual(result.checkpointCore, f.settled);
  assert.equal(result.replayInput, undefined);
  assert.equal(result.carriedInbox, undefined);
});

test.each([
  { name: "the verifier refuses", delivery: {}, verify: false },
  {
    name: "the dispatch input differs",
    delivery: { dispatchInput: { other: true } },
    verify: true,
  },
  { name: "the effect step failed", delivery: { status: "failed" }, verify: true },
  { name: "the completion event is missing", delivery: { omitCompletion: true }, verify: true },
])("idle transfer keeps delivery fenced when $name", async ({ delivery, verify }) => {
  const f = await settledIdleFixture({
    encrypted: true,
    cancelledOutcome: { delivery },
    verifyCancelledWorkflowEffects: async () => await Promise.resolve(verify),
  });
  const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
  assert.equal(result.kind, "uncertain");
  assert.equal(result.reason, uncommittedActionDispatchReason);
});

test.each([
  { name: "exact committed earlier result", nativeResult: historicalDeliveryResult, ready: true },
  {
    name: "earlier exact result removed by native compaction",
    nativeResult: historicalDeliveryResult,
    compacted: "marked",
    ready: true,
  },
  {
    name: "unmarked disappearance of the earlier exact result",
    nativeResult: historicalDeliveryResult,
    compacted: "unmarked",
    ready: false,
  },
  {
    name: "conflicting latest result after native compaction",
    nativeResult: historicalDeliveryResult,
    compacted: "conflicting",
    ready: false,
  },
  {
    name: "earlier result absent from committed history",
    nativeResult: { ...historicalDeliveryResult, mergeCommitSha: "e".repeat(40) },
    ready: false,
  },
])("settled delivery uses only the $name", async ({ nativeResult, compacted, ready }) => {
  const witnessFixture = cancelledDeliveryWitnessFixture();
  const f = await settledIdleFixture({
    encrypted: true,
    cancelledOutcome: {
      delivery: {
        historicalResult: nativeResult,
        compacted,
        completedSteps: witnessFixture.witness.completedSteps,
      },
    },
    verifyCancelledWorkflowEffects: async (witness) => {
      assert.equal(await witness.readCommittedDelivery(witness.callId), undefined);
      const retained = await witness.readCommittedDelivery(historicalDeliveryCallId);
      if (retained === undefined) {
        return await Promise.resolve(false);
      }
      assert.deepEqual(retained.toolInput, workflowReportRun.input);
      assert.deepEqual(retained.result, historicalDeliveryResult);
      return await Promise.resolve(true);
    },
  });
  const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
  assert.equal(result.kind, ready ? "ready" : "uncertain");
  if (ready) {
    assert.equal(result.replayInput, undefined);
  } else {
    assert.equal(result.reason, uncommittedActionDispatchReason);
  }
});

const sameTurnDelivery = {
  priorDeliveryCheckpoint: { ...historicalDeliveryEvent, stepIndex: 2 },
  compacted: "marked",
};

test.each([
  { name: "a same-turn checkpoint after the result step", delivery: sameTurnDelivery, ready: true },
  {
    name: "a same-turn checkpoint at the result step",
    delivery: {
      ...sameTurnDelivery,
      priorDeliveryCheckpoint: { ...sameTurnDelivery.priorDeliveryCheckpoint, stepIndex: 1 },
    },
    ready: false,
  },
  {
    name: "a checkpoint from another turn with the same sequence",
    delivery: {
      ...sameTurnDelivery,
      priorDeliveryCheckpoint: {
        ...sameTurnDelivery.priorDeliveryCheckpoint,
        turnId: "different-older-turn",
      },
    },
    ready: false,
  },
  {
    name: "the exact pair in both cancellation settlement snapshots",
    delivery: { priorDeliveryPlacement: settlementOnly },
    ready: true,
  },
  {
    name: "an unproven pair present only in cancellation settlement output",
    delivery: { priorDeliveryPlacement: settlementOutputOnly },
    ready: false,
  },
])("earlier delivery recovery checks $name", async ({ delivery, ready }) => {
  const { witness } = cancelledDeliveryWitnessFixture();
  const reads = [];
  const f = await settledIdleFixture({
    encrypted: true,
    cancelledOutcome: {
      delivery: {
        historicalResult: historicalDeliveryResult,
        completedSteps: witness.completedSteps,
        ...delivery,
      },
    },
    verifyCancelledWorkflowEffects: async (evidence) => {
      const prior = await evidence.readCommittedDelivery(historicalDeliveryCallId);
      reads.push(prior);
      return await Promise.resolve(prior !== undefined);
    },
  });
  const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
  if (ready) {
    assert.deepEqual(reads, [
      { toolInput: workflowReportRun.input, result: historicalDeliveryResult },
    ]);
    assert.equal(result.kind, "ready");
    assert.equal(result.replayInput, undefined);
    assert.equal(result.carriedInbox, undefined);
  } else {
    assert.deepEqual(reads, [undefined]);
    assert.equal(result.kind, "uncertain");
    assert.equal(result.reason, uncommittedActionDispatchReason);
  }
});

test.each([
  { placement: "before", ready: true },
  { placement: "unrelated", ready: false },
])(
  "a compacted delivery reads a checkpoint $placement the verified handoff",
  async ({ placement, ready }) => {
    const { witness } = cancelledDeliveryWitnessFixture();
    const reads = [];
    const f = await settledIdleFixture({
      encrypted: true,
      snapshot: true,
      handoff: true,
      handoffDeliveryCheckpoint: placement,
      cancelledOutcome: {
        delivery: {
          historicalResult: historicalDeliveryResult,
          historicalCheckpointInParent: true,
          compacted: "marked",
          completedSteps: witness.completedSteps,
        },
      },
      verifyCancelledWorkflowEffects: async (evidence) => {
        const prior = await evidence.readCommittedDelivery(historicalDeliveryCallId);
        reads.push(prior);
        return prior !== undefined;
      },
    });
    const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
    if (ready) {
      assert.deepEqual(reads, [
        { toolInput: workflowReportRun.input, result: historicalDeliveryResult },
      ]);
      assert.equal(result.kind, "ready");
      assert.equal(result.replayInput, undefined);
    } else {
      assert.deepEqual(reads, [undefined]);
      assert.equal(result.kind, "uncertain");
      assert.equal(result.reason, uncommittedActionDispatchReason);
      assert.ok(f.readOperations.every(([, runId]) => runId !== unrelatedDeliveryRunId));
    }
  },
);

test("a completed delivery checkpoint after handoff cannot authorize recovery", async () => {
  const f = await fixture({
    allowParked: true,
    encrypted: true,
    snapshot: true,
    handoff: true,
    handoffDeliveryCheckpoint: "after",
    collectFactory: createOwnedLineagePreflightCollector,
    expectedUnavailable: true,
  });
  assert.equal(f.collected.reason, "handoff-parent-frontier-uncertain");
});

test.each([
  { timing: afterChildStop, retry: false, ready: true },
  { timing: afterChildTerminal, retry: false, ready: true },
  { timing: afterChildStop, retry: true, ready: false },
])("settles a running schema step $timing only without a later retry ($retry)", async (proof) => {
  const witnessFixture = cancelledDeliveryWitnessFixture();
  const f = await settledIdleFixture({
    encrypted: true,
    cancelledOutcome: {
      delivery: {
        completedSteps: witnessFixture.witness.completedSteps,
        serializedContext: witnessFixture.context,
        schemaAfterStop: proof.timing,
        schemaRetryAfterStop: proof.retry,
      },
    },
    verifyCancelledWorkflowEffects: async (witness) =>
      await Promise.resolve(verifySettledGitHubDelivery(witness, witnessFixture.owner)),
  });
  const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
  assert.equal(result.kind, proof.ready ? "ready" : "uncertain");
  if (proof.ready) {
    assert.equal(result.replayInput, undefined);
  } else {
    assert.equal(result.reason, uncommittedActionDispatchReason);
  }
});

test.each([
  { name: "exact earlier receipt", hasPriorReceipt: true, lateMerge: false, ready: true },
  { name: "no earlier receipt", hasPriorReceipt: false, lateMerge: false, ready: false },
  { name: "an after-Stop merge", hasPriorReceipt: true, lateMerge: true, ready: false },
])("after-Stop delivery recovery with $name", async ({ hasPriorReceipt, lateMerge, ready }) => {
  const fixtureProof = cancelledDeliveryWitnessFixture({ priorMerge: true });
  const steps = fixtureProof.witness.completedSteps;
  const seen = [];
  const f = await settledIdleFixture({
    encrypted: true,
    cancelledOutcome: {
      delivery: {
        dispatchLastAfterStop: true,
        schemaAfterStop: afterChildStop,
        completedSteps: lateMerge ? steps.slice(0, 1) : steps,
        serializedContext: fixtureProof.context,
      },
    },
    verifyCancelledWorkflowEffects: async (witness) => {
      seen.push(witness.completedSteps.at(-1)?.afterStop);
      return await verifySettledGitHubDeliveryWithPriorReceipt(
        { ...witness, readCommittedDelivery: fixtureProof.witness.readCommittedDelivery },
        fixtureProof.owner,
        async () =>
          await Promise.resolve(hasPriorReceipt ? fixtureProof.priorMergeReceipt : undefined),
      );
    },
  });
  const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
  assert.deepEqual(seen, lateMerge ? [] : [true]);
  assert.equal(result.kind, ready ? "ready" : "uncertain");
  if (ready) {
    assert.equal(result.replayInput, undefined);
  } else {
    assert.equal(result.reason, uncommittedActionDispatchReason);
  }
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

test("unresolved workflow delivery logs only fixed action facts and still blocks recovery", async () => {
  const event = "builder.recovery_uncommitted_action";
  const diagnosticRecords = [];
  const diagnostic = vi.spyOn(console, "info").mockImplementation((record) => {
    if (String(record).includes(event)) {
      diagnosticRecords.push(JSON.parse(record));
    }
  });
  try {
    const f = await settledIdleFixture({
      uncommittedAction: {
        toolName: "finish-github-pr-delivery",
        input: { privateValue: "secret workflow input fixture" },
      },
    });
    const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
    assert.equal(result.kind, "uncertain");
    assert.equal(result.reason, uncommittedActionDispatchReason);
    assert.deepEqual(diagnosticRecords, [
      {
        event,
        frontier: "settled_cancellation",
        category: "finish_github_pr_delivery",
        stoppedChild: false,
        hasInput: false,
        beforeCancel: true,
      },
    ]);
  } finally {
    diagnostic.mockRestore();
  }
});

test("settled cancellation can retain an interrupted read-only Production observation", async () => {
  const f = await settledIdleFixture({ interruptedObservation: { appId: fixtureAppId } });
  const result = await reconcileOwnedLineagePreflight(f.collected.preflight);
  assert.equal(result.kind, "ready");
  assert.equal(result.provenance.selectedOrigin.stepId, settledCancelStepId);
  assert.equal(result.replayInput, undefined);
  assert.equal(result.carriedInbox, undefined);
});

test("an interrupted Production observation with another input remains uncertain", async () => {
  const f = await settledIdleFixture({
    interruptedObservation: { appId: fixtureAppId, other: "unsupported" },
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
