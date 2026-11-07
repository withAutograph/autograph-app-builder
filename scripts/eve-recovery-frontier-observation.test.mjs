/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument -- The fixture imports installed compiled Eve internals by private package path. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, test } from "vitest";

const require = createRequire(import.meta.url);
const eve = path.dirname(require.resolve("eve/package.json"));
const load = async (name) => await import(pathToFileURL(path.join(eve, "dist/src", name)).href);
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
  input: { secret },
  toolCallId: "call-original",
  toolName: "private-tool",
  type: "tool-call",
};
const request = {
  action: {
    callId: call.toolCallId,
    input: call.input,
    kind: "tool-call",
    toolName: call.toolName,
  },
  kind: "tool-approval",
  prompt: secret,
  requestId: "approval-original",
};
const response = { optionId: "approve", requestId: request.requestId };
const coordinates = { sequence: 7, stepIndex: 2, turnId: "private-turn" };
const state = (session) => ({ snapshot: { session } });
const setup = () => {
  let before = appendPendingInputBatch({
    event: coordinates,
    requests: [request],
    responseAuthRequiredRequestIds: [request.requestId],
    responseMessages: [
      {
        content: [
          call,
          {
            approvalId: request.requestId,
            toolCallId: call.toolCallId,
            type: "tool-approval-request",
          },
        ],
        role: "assistant",
      },
    ],
    session: { history: [], sessionId: "logical", state: {} },
    toolReplayIdentities: { [request.requestId]: secret },
  });
  before = setPendingCoordinationBatch({
    event: coordinates,
    responseMessages: [],
    runtimeActions: [],
    session: before,
    tasks: [{ callId: call.toolCallId, toolName: call.toolName }],
  });
  const after = {
    ...before,
    history: [
      {
        content: [
          call,
          {
            approvalId: request.requestId,
            toolCallId: call.toolCallId,
            type: "tool-approval-request",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          { approvalId: request.requestId, approved: true, type: "tool-approval-response" },
        ],
        role: "tool",
      },
      { content: secret, kind: "context.instruction", role: "user" },
    ],
    state: {},
  };
  const candidates = [
    {
      kind: "terminal-finalizer-input",
      origin: { eventId: "evnt_30", slot: 30, stepId: "finalizer" },
      sessionState: state(after),
    },
    {
      incoming: {
        delivery: { auth: { principalId: secret }, payloads: [{ inputResponses: [response] }] },
      },
      kind: "completed-terminal-turn-input",
      origin: { eventId: "evnt_20", slot: 20, stepId: "turnStep" },
      sessionState: state(before),
    },
  ];
  const nativeEvents = [
    {
      data: {
        ...coordinates,
        resolutions: [
          { kind: "tool-approval", outcome: "approved", requestId: request.requestId, response },
        ],
      },
      type: "input.resolved",
    },
    {
      data: {
        ...coordinates,
        outcome: "approved",
        requestId: request.requestId,
        responderPrincipalId: secret,
      },
      type: "approval.settled",
    },
    { data: coordinates, type: "step.started" },
    {
      data: {
        ...coordinates,
        code: "MODEL_CALL_FAILED",
        message: `No tool output found for function call ${call.toolCallId}`,
      },
      type: "step.failed",
    },
  ];
  return {
    descriptor: {
      logicalSessionId: "logical",
      operationId: "operation",
      parentCancellationRevision: 0,
      sourceAdapterGeneration: 1,
      sourceOwnerRunId: "owner",
    },
    outcome: "candidate",
    ownerRunId: "owner",
    payload: {
      candidates,
      events: [
        {
          correlationId: "dispatch",
          eventData: { input: secret, stepName: "dispatchCoordinationStep" },
          eventId: "evnt_21",
          eventType: "step_started",
        },
      ],
      frontier: [],
      issues: [],
      nativeEvents,
      run: { status: "completed" },
      steps: [
        {
          arguments: { args: [{ sessionState: state(before), sessionWritable: {} }] },
          output: { results: [{ callId: call.toolCallId, output: secret }] },
          step: { status: "completed", stepId: "dispatch", stepName: "dispatchCoordinationStep" },
        },
        {
          arguments: { args: [{ sessionState: state(before), sessionWritable: {} }] },
          step: { status: "completed", stepId: "turnStep", stepName: "turnStep" },
        },
      ],
    },
    receiptPresent: true,
  };
};
test("reports exact retained approval lineage, outcome frontier and durable dispatch without authored content", () => {
  const input = setup();
  const unchanged = JSON.stringify(input);
  assert.equal(recordTerminalRecoveryObservation(input), true);
  const summary = logs.at(-1);
  const [fact] = summary.missingCallFrontier.sample;
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
  const [fact] = logs.at(-1).missingCallFrontier.sample;
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
  const [fact] = logs.at(-1).missingCallFrontier.sample;
  assert.equal(fact.bindingCount, 0);
  assert.equal(fact.frontierUsesWholeStream, true);
  assert.equal(fact.retainedTurnInputCount, 0);
});
test("bounded failure samples retain full counts and reject malformed payload only advisory", () => {
  const input = setup();
  const failure = input.payload.nativeEvents.at(-1);
  input.payload.nativeEvents.push(...Array.from({ length: 30 }, () => failure));
  assert.equal(recordTerminalRecoveryObservation(input), true);
  const [fact] = logs.at(-1).missingCallFrontier.sample;
  assert.equal(fact.failedStepOrTurnCount, 31);
  assert.equal(fact.failureSample.length, 12);
  assert.equal(fact.exactMissingCallFailureCount, 31);
  assert.equal(recordTerminalRecoveryObservation({ descriptor: null }), false);
});

test("logs only typed safe app facts and retained native retry counters", () => {
  const input = setup();
  input.candidateFacts = {
    counts: { invalid: -1, matched: 2 },
    flags: { absent: null, explicitNull: true, raw: secret },
    hashes: { absent: null, callId: protocolIdentityHash(call.toolCallId), raw: secret },
  };
  input.payload.steps[0].step.attempt = 2;
  input.payload.events[0].eventData.attempt = 2;
  assert.equal(recordTerminalRecoveryObservation(input), true);
  const report = logs.at(-1);
  assert.deepEqual(report.candidateFacts, {
    counts: { matched: 2 },
    flags: { absent: null, explicitNull: true },
    hashes: { absent: null, callId: protocolIdentityHash(call.toolCallId) },
  });
  assert.equal(report.nativeStepFrontier.retainedStepSample[0].attempt, 2);
  assert.equal(JSON.stringify(report).includes(secret), false);
});
