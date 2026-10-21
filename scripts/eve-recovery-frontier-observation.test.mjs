/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument -- The fixture imports installed compiled Eve internals by private package path. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, test } from "vitest";

const require = createRequire(import.meta.url);
const eve = path.dirname(require.resolve("eve/package.json"));
const load = (name) => import(pathToFileURL(path.join(eve, "dist/src", name)).href);
const { recordTerminalRecoveryObservation, protocolIdentityHash } = await load(
  "harness/model-protocol-diagnostic.js",
);
const { appendPendingInputBatch } = await load("harness/pending-input-batches.js");
const { setPendingCoordinationBatch } = await load("harness/coordination.js");
const { setLogRecordSubscriber } = await load("internal/logging.js");
const logs = [];
setLogRecordSubscriber((record) => {
  const prefix = "terminal-recovery-observation ";
  if (record.message.startsWith(prefix) === true) {
    logs.push(JSON.parse(record.message.slice(prefix.length)));
  }
});
afterAll(() => setLogRecordSubscriber());
const secret = "PRIVATE_ARGUMENT_RESULT_OR_PROMPT";
const call = {
  type: "tool-call",
  toolCallId: "call-original",
  toolName: "private-tool",
  input: { secret },
};
const request = {
  kind: "tool-approval",
  requestId: "approval-original",
  action: {
    kind: "tool-call",
    callId: call.toolCallId,
    toolName: call.toolName,
    input: call.input,
  },
  prompt: secret,
};
const response = { requestId: request.requestId, optionId: "approve" };
const coordinates = { sequence: 7, stepIndex: 2, turnId: "private-turn" };
const setup = () => {
  let before = appendPendingInputBatch({
    session: { sessionId: "logical", history: [], state: {} },
    requests: [request],
    responseMessages: [
      {
        role: "assistant",
        content: [
          call,
          {
            type: "tool-approval-request",
            approvalId: request.requestId,
            toolCallId: call.toolCallId,
          },
        ],
      },
    ],
    event: coordinates,
    responseAuthRequiredRequestIds: [request.requestId],
    toolReplayIdentities: { [request.requestId]: secret },
  });
  before = setPendingCoordinationBatch({
    session: before,
    responseMessages: [],
    tasks: [{ callId: call.toolCallId, toolName: call.toolName }],
    runtimeActions: [],
    event: coordinates,
  });
  const after = {
    ...before,
    state: {},
    history: [
      {
        role: "assistant",
        content: [
          call,
          {
            type: "tool-approval-request",
            approvalId: request.requestId,
            toolCallId: call.toolCallId,
          },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-approval-response", approvalId: request.requestId, approved: true },
        ],
      },
      { role: "user", kind: "context.instruction", content: secret },
    ],
  };
  const state = (session) => ({ snapshot: { session } });
  const candidates = [
    {
      kind: "terminal-finalizer-input",
      origin: { slot: 30, stepId: "finalizer", eventId: "evnt_30" },
      sessionState: state(after),
    },
    {
      kind: "completed-terminal-turn-input",
      origin: { slot: 20, stepId: "turnStep", eventId: "evnt_20" },
      sessionState: state(before),
      incoming: {
        delivery: { auth: { principalId: secret }, payloads: [{ inputResponses: [response] }] },
      },
    },
  ];
  const nativeEvents = [
    {
      type: "input.resolved",
      data: {
        ...coordinates,
        resolutions: [
          { requestId: request.requestId, kind: "tool-approval", outcome: "approved", response },
        ],
      },
    },
    {
      type: "approval.settled",
      data: {
        ...coordinates,
        requestId: request.requestId,
        outcome: "approved",
        responderPrincipalId: secret,
      },
    },
    { type: "step.started", data: coordinates },
    {
      type: "step.failed",
      data: {
        ...coordinates,
        code: "MODEL_CALL_FAILED",
        message: `No tool output found for function call ${call.toolCallId}`,
      },
    },
  ];
  return {
    descriptor: {
      operationId: "operation",
      sourceOwnerRunId: "owner",
      logicalSessionId: "logical",
      sourceAdapterGeneration: 1,
      parentCancellationRevision: 0,
    },
    ownerRunId: "owner",
    receiptPresent: true,
    outcome: "candidate",
    payload: {
      run: { status: "completed" },
      candidates,
      nativeEvents,
      issues: [],
      frontier: [],
      events: [
        {
          eventId: "evnt_21",
          eventType: "step_started",
          correlationId: "dispatch",
          eventData: { stepName: "dispatchCoordinationStep", input: secret },
        },
      ],
      steps: [
        {
          step: { stepId: "dispatch", stepName: "dispatchCoordinationStep", status: "completed" },
          arguments: { args: [{ sessionState: state(before), sessionWritable: {} }] },
          output: { results: [{ callId: call.toolCallId, output: secret }] },
        },
        {
          step: { stepId: "turnStep", stepName: "turnStep", status: "completed" },
          arguments: { args: [{ sessionState: state(before), sessionWritable: {} }] },
        },
      ],
    },
  };
};
test("reports exact retained approval lineage, outcome frontier and durable dispatch without authored content", () => {
  const input = setup();
  const unchanged = JSON.stringify(input);
  assert.equal(recordTerminalRecoveryObservation(input), true);
  const summary = logs.at(-1);
  const fact = summary.missingCallFrontier.sample[0];
  assert.equal(fact.callHash, protocolIdentityHash(call.toolCallId));
  assert.equal(fact.toolNameHash, protocolIdentityHash(call.toolName));
  assert.equal(fact.bindingSample[0].sameCallBytes, true);
  assert.equal(fact.bindingSample[0].acceptedIncomingResponseMatchCount, 1);
  assert.equal(fact.bindingSample[0].responseAuthRequired, true);
  assert.equal(fact.bindingSample[0].retainedExecutionClass, "workflow-task");
  assert.equal(fact.approvalSettledCount, 1);
  assert.equal(fact.exactMissingCallFailureCount, 1);
  assert.equal(fact.durableDispatchCount, 1);
  assert.equal(fact.durableResultStepCount, 1);
  assert.equal(fact.retainedTurnInputWithStreamCount, 1);
  assert.equal(fact.individualHarnessAttemptEvidenceAvailable, false);
  assert.equal(summary.latestTailStructure.at(-1).kind, "context.instruction");
  assert.equal(JSON.stringify(input), unchanged);
  for (const raw of [secret, call.toolCallId, call.toolName, request.requestId, "private-turn"]) {
    assert.equal(JSON.stringify(summary).includes(raw), false);
  }
});
test("does not call missing outcome an execution proof and counts mismatching accepted response", () => {
  const input = setup();
  input.payload.steps = [];
  input.payload.candidates[1].incoming.delivery.payloads[0].inputResponses[0] = {
    ...response,
    optionId: "deny",
  };
  assert.equal(recordTerminalRecoveryObservation(input), true);
  const fact = logs.at(-1).missingCallFrontier.sample[0];
  assert.equal(fact.bindingSample[0].acceptedIncomingResponseMatchCount, 0);
  assert.equal(fact.actionResultCount, 0);
  assert.equal(fact.durableResultStepCount, 0);
  assert.equal(fact.registeredToolExecutionClassAvailable, false);
  assert.equal("safeToReplay" in fact, false);
});
test("reports child without ancestor evidence honestly", () => {
  const input = setup();
  input.payload.candidates.length = 1;
  input.payload.nativeEvents = [];
  input.payload.steps = [];
  assert.equal(recordTerminalRecoveryObservation(input), true);
  const fact = logs.at(-1).missingCallFrontier.sample[0];
  assert.equal(fact.bindingCount, 0);
  assert.equal(fact.frontierUsesWholeStream, true);
  assert.equal(fact.retainedTurnInputCount, 0);
});
test("bounded failure samples retain full counts and reject malformed payload only advisory", () => {
  const input = setup();
  const failure = input.payload.nativeEvents.at(-1);
  input.payload.nativeEvents.push(...Array.from({ length: 30 }, () => failure));
  assert.equal(recordTerminalRecoveryObservation(input), true);
  const fact = logs.at(-1).missingCallFrontier.sample[0];
  assert.equal(fact.failedStepOrTurnCount, 31);
  assert.equal(fact.failureSample.length, 12);
  assert.equal(fact.exactMissingCallFailureCount, 31);
  assert.equal(recordTerminalRecoveryObservation({ descriptor: null }), false);
});

test("logs only typed safe app facts and retained native retry counters", () => {
  const input = setup();
  input.candidateFacts = {
    flags: { explicitNull: true, absent: null, raw: secret },
    counts: { matched: 2, invalid: -1 },
    hashes: { callId: protocolIdentityHash(call.toolCallId), raw: secret, absent: null },
  };
  input.payload.steps[0].step.attempt = 2;
  input.payload.events[0].eventData.attempt = 2;
  assert.equal(recordTerminalRecoveryObservation(input), true);
  const report = logs.at(-1);
  assert.deepEqual(report.candidateFacts, {
    flags: { explicitNull: true, absent: null },
    counts: { matched: 2 },
    hashes: { callId: protocolIdentityHash(call.toolCallId), absent: null },
  });
  assert.equal(report.nativeStepFrontier.retainedStepSample[0].attempt, 2);
  assert.equal(JSON.stringify(report).includes(secret), false);
});
