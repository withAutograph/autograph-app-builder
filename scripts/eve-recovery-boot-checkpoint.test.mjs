/* oxlint-disable eslint/no-empty-function -- Unused native ports intentionally have no effects in the controlled boot fixture. */
/* oxlint-disable eslint/require-await -- Fixtures implement the asynchronous native World and recovery port contracts. */
/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument -- Exercise installed private native framework modules and native serialization. */
/* oxlint-disable sonarjs/no-duplicate-string -- Repeated identities bind the same native recovery fixture. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";

const require = createRequire(import.meta.url);
const sdk = pathToFileURL(`${path.dirname(require.resolve("eve/package.json"))}/dist/src/`).href;
const load = (file) => import(`${sdk}${file}`);
const { createTerminalRecoveryCandidateCollector, readTerminalRecoveryCandidate } = await load(
  "execution/session/recovery-candidate.js",
);
const { reconcileTerminalRecoveryCandidate } = await load(
  "execution/session/recovery-reconciliation.js",
);
const { readFailedRecoveryBootStatus } = await load("execution/session/recovery-boot-status.js");
const { bootTerminalRecoveryOwnerWithPorts } = await load(
  "execution/session/terminal-recovery-boot.js",
);
const { recoverTerminalSession, activateTerminalSession } = await load(
  "execution/session/terminal-recovery.js",
);
const { createSessionStreamResponse } = await load("eve-channel/request.js");
const serialization = await load("compiled/@workflow/core/serialization.js");
const { createDurableSessionState, readDurableSession } = await load(
  "execution/durable-session-store.js",
);
const ownerRunId = "wrun-failed-recovery";
const logicalSessionId = "wrun-original-logical-session";
const binding = { ownerRunId, logicalSessionId };
const eventId = (slot) => `evnt_${String(slot).padStart(26, "0")}`;
const requireEventSlot = (id) => Number(id.slice(5));
const descriptor = {
  version: 1,
  operationId: "previous-recovery",
  sourcePublicSessionId: "ses-prior-child",
  sourceOwnerRunId: "wrun-prior-owner",
  sourceAdapterGeneration: 2,
  logicalSessionId,
  originalAuthoritySessionId: "ses-original-authority",
  parentCancellationRevision: 0,
};
const auth = {
  authenticator: "test",
  principalType: "user",
  principalId: "original-owner",
  issuer: "builder",
};

const metadata = (value) => {
  const data = { ...value.eventData };
  delete data.payload;
  return { ...value, eventData: data };
};

const fixture = async function fixture(change = () => {}) {
  const originalState = {
    "builder.workflow": {
      appId: "original-app",
      repository: "owner/original-repository",
      pendingProposal: { digest: "original-proposal", approved: false },
    },
    "builder.owner": { userId: "original-owner", workspaceId: "original-workspace" },
  };
  const checkpoint = {
    version: 9,
    sessionTimeoutMs: false,
    capabilities: { requestInput: true },
    serializedContext: {
      "eve.sessionId": logicalSessionId,
      "eve.auth": { current: auth },
      "builder.originalAuthority": descriptor.originalAuthoritySessionId,
    },
    sessionState: createDurableSessionState({
      session: {
        sessionId: logicalSessionId,
        continuationToken: "original-continuation",
        state: originalState,
        history: [{ role: "user", content: "Continue the same app with the same data." }],
        agent: { system: "original instructions", tools: new Map() },
        compaction: {},
      },
    }),
  };
  const entry = {
    kind: "terminal-recovery",
    descriptor: structuredClone(descriptor),
    checkpoint,
    provenance: {
      kind: "committed-turn-output",
      sourceStepId: "step-prior",
      sourceEventId: eventId(50),
      sourceSlot: 50,
      checkpointVersion: 1,
      resumePhase: "await-input",
    },
    activationToken: "exact-private-activation",
    ownerDeploymentId: "current-deployment",
  };
  const steps = new Map([
    [
      "step-derive",
      { stepName: "step//eve@0.68.0//deriveTerminalRecoveryResumePhase", status: "completed" },
    ],
    [
      "step-validate",
      {
        stepName: "step//eve@0.68.0//validateTerminalRecoveryCheckpointStep",
        status: "completed",
        argument: { checkpoint },
      },
    ],
    [
      "step-wait",
      { stepName: "step//eve@0.68.0//emitTerminalRecoveryWaitingStep", status: "failed" },
    ],
  ]);
  const event = (slot, eventType, correlationId, eventData = {}) => {
    const value = { runId: ownerRunId, eventId: eventId(slot), eventType };
    if (correlationId !== undefined) {
      value.correlationId = correlationId;
    }
    const details = {};
    if (steps.has(correlationId)) {
      details.stepName = steps.get(correlationId).stepName;
    }
    value.eventData = { ...details, ...eventData };
    return value;
  };
  const events = [
    event(1, "run_created"),
    event(2, "step_created", "step-derive"),
    event(3, "step_completed", "step-derive"),
    event(4, "step_created", "step-validate"),
    event(5, "step_completed", "step-validate"),
    event(6, "hook_created", "hook-activation", { token: entry.activationToken }),
    event(7, "hook_received", "hook-activation", {
      payload: {
        kind: "activate-terminal-recovery",
        operationId: descriptor.operationId,
        ownerRunId,
      },
    }),
    event(8, "step_created", "step-wait"),
    event(9, "step_failed", "step-wait"),
    event(10, "run_failed"),
  ];
  const run = { runId: ownerRunId, status: "failed", deploymentId: entry.ownerDeploymentId };
  const nativeEvents = [];
  const f = { entry, checkpoint, steps, events, run, event, nativeEvents, originalState };
  change(f);
  run.input = await serialization.dehydrateWorkflowArguments([entry], ownerRunId);
  await Promise.all(
    [...steps].map(async ([stepId, step]) => {
      Object.assign(step, { runId: ownerRunId, stepId });
      if (step.argument !== undefined) {
        step.input = await serialization.dehydrateStepArguments(
          { args: [step.argument], closureVars: [] },
          ownerRunId,
        );
      }
    }),
  );
  for (const [index, current] of events.entries()) {
    current.eventId = eventId(index + 1);
  }
  await Promise.all(
    events.map(async (current) => {
      if (current.eventData.payload !== undefined) {
        current.eventData.payload = await serialization.dehydrateWorkflowArguments(
          current.eventData.payload,
          ownerRunId,
        );
      }
    }),
  );
  const world = {
    events: {
      get: async (_runId, id) => events.find((current) => current.eventId === id),
      list: async () => ({ data: events.map(metadata), hasMore: false }),
    },
    runs: { get: async () => run },
    steps: {
      get: async (_runId, id, options) =>
        // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Preserve the existing explicit undefined value.
        options.resolveData === "none" ? { ...steps.get(id), input: undefined } : steps.get(id),
    },
  };
  let authorized = true;
  const { hydrateWorkflowArguments, hydrateStepArguments, hydrateStepReturnValue } = serialization;
  const { hydrateWorkflowArguments: hydrateHookPayload } = serialization;
  const { now } = Date;
  const collect = createTerminalRecoveryCandidateCollector({
    getWorld: async () => world,
    hydrateHookPayload,
    hydrateStepArguments,
    hydrateStepReturnValue,
    hydrateWorkflowArguments,
    now,
    readDurableSession,
    async *readNativeEvents() {
      yield* nativeEvents;
    },
    requireEventSlot,
    resolveRunEncryptionKey: async () => {},
  });
  const input = {
    authorizeOwner: async (value) => {
      assert.deepEqual(value, binding);
      if (!authorized) {
        throw new Error("owner revoked");
      }
    },
    binding,
  };
  return {
    ...f,
    world,
    collect,
    input,
    revoke: () => {
      authorized = false;
    },
    status: (tail = -1) =>
      readFailedRecoveryBootStatus(ownerRunId, tail, {
        collect,
        readCandidate: readTerminalRecoveryCandidate,
        readEntry: async () => ({ entry, run }),
      }),
  };
};

test("failed waiting boot retains the validated original app, owner, unapproved proposal and idle admission", async () => {
  const f = await fixture();
  // Reproduce failure after real boot validation/activation, before the first authored turn.
  await assert.rejects(
    bootTerminalRecoveryOwnerWithPorts(f.entry, {
      createHook: () =>
        Object.assign(
          Promise.resolve({
            kind: "activate-terminal-recovery",
            operationId: descriptor.operationId,
            ownerRunId,
          }),
          { dispose() {}, getConflict: async () => null },
        ),
      createSessionInbox: () => ({
        claimSessionHooks: async () => {},
        dispose: async () => {},
        drain: () => [],
        onInterrupt: () => () => {},
        restore() {},
      }),
      emitIdleWaiting: async () => {
        throw new Error("step argument serialization failed");
      },
      getWorkflowMetadata: () => ({ workflowRunId: ownerRunId }),
      getWritable: () => "native-stream",
      validateCheckpoint: async () => {},
    }),
    /step argument serialization failed/u,
  );
  const result = await f.collect(f.input);
  assert.equal(result.kind, "candidate");
  const payload = readTerminalRecoveryCandidate(result.candidate);
  assert.equal(payload.candidates[0].kind, "validated-recovery-input");
  assert.equal(payload.checkpointOwnerRunId, ownerRunId);
  const ready = await reconcileTerminalRecoveryCandidate(result.candidate);
  assert.equal(ready.kind, "ready");
  assert.deepEqual(ready.checkpointCore.serializedContext, f.checkpoint.serializedContext);
  const session = readDurableSession(ready.checkpointCore.sessionState);
  assert.deepEqual(session.state, f.originalState);
  assert.equal(session.sessionId, logicalSessionId);
  assert.equal(session.continuationToken, "original-continuation");
  assert.equal(session.state["builder.workflow"].pendingProposal.approved, false);
  assert.equal(ready.replayInput, undefined);
  assert.equal(await f.status(), "failed");
});

for (const [name, change] of [
  [
    "unvalidated",
    (f) => {
      f.steps.get("step-validate").status = "failed";
    },
  ],
  [
    "foreign validated checkpoint",
    (f) => {
      f.steps.get("step-validate").argument = {
        checkpoint: { ...f.checkpoint, serializedContext: { "eve.sessionId": "foreign" } },
      };
    },
  ],
  [
    "unactivated",
    (f) => {
      f.events.splice(6, 1);
    },
  ],
  [
    "different activation operation",
    (f) => {
      f.events[6].eventData.payload.operationId = "foreign-operation";
    },
  ],
  [
    "different activation owner",
    (f) => {
      f.events[6].eventData.payload.ownerRunId = "foreign-owner";
    },
  ],
  [
    "different deployment",
    (f) => {
      f.run.deploymentId = "foreign-deployment";
    },
  ],
  [
    "different logical session",
    (f) => {
      f.entry.descriptor.logicalSessionId = "foreign-logical";
    },
  ],
  [
    "ambiguous activation hooks",
    (f) => {
      f.events.splice(
        6,
        0,
        f.event(6.5, "hook_created", "other-hook", { token: f.entry.activationToken }),
      );
    },
  ],
  [
    "later unknown effect",
    (f) => {
      f.steps.set("step-unknown", { stepName: "step//app//writeProvider", status: "failed" });
      f.events.splice(9, 0, f.event(9.5, "step_created", "step-unknown"));
    },
  ],
  [
    "retained inbox not proven consumed",
    (f) => {
      f.entry.carriedInbox = [
        { payload: { kind: "deliver", payloads: [{ message: "unconsumed" }] } },
      ];
    },
  ],
]) {
  test(`does not recover ${String(name)}`, async () => {
    const f = await fixture(change);
    const result = await f.collect(f.input);
    assert.equal(result.kind, "unavailable");
    assert.equal(await f.status(), undefined);
  });
}

test("rejects malformed carried inbox evidence while retaining an explicit empty inbox", async () => {
  await Promise.all(
    [{}, { length: 0 }, null, "", 0, false].map(async (value) => {
      const malformed = await fixture((f) => {
        f.entry.carriedInbox = value;
      });
      const result = await malformed.collect(malformed.input);
      assert.equal(result.kind, "unavailable");
      assert.equal(await malformed.status(), undefined);
    }),
  );
  const empty = await fixture((f) => {
    f.entry.carriedInbox = [];
  });
  const result = await empty.collect(empty.input);
  assert.equal(result.kind, "candidate");
  assert.equal(await empty.status(), "failed");
});

test("owner revocation precedes private checkpoint reads", async () => {
  const f = await fixture();
  f.revoke();
  await assert.rejects(f.collect(f.input), /owner revoked/u);
});

test("unsettled effects and nonempty streams are not classified as failed boot", async () => {
  const f = await fixture((value) => {
    value.nativeEvents.push({
      type: "action.result",
      data: {
        result: {
          kind: "tool-result",
          callId: "unknown-write",
          toolName: "publish",
          output: "unknown",
        },
      },
    });
  });
  const result = await f.collect(f.input);
  assert.equal(result.kind, "candidate");
  const reconciled = await reconcileTerminalRecoveryCandidate(result.candidate);
  assert.equal(reconciled.kind, "uncertain");
  assert.equal(await f.status(), undefined);
  assert.equal(await f.status(0), undefined);
});

test("the exact empty native stream exposes boot failure without adding events", async () => {
  const f = await fixture();
  const response = await createSessionStreamResponse(
    new Request("https://builder.test/stream?includeTailIndex=true&tail=true"),
    {
      getEventStream: async () =>
        new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
      getStreamTailIndex: async () => -1,
      id: ownerRunId,
    },
    async (id, tail) => {
      assert.equal(id, ownerRunId);
      return await f.status(tail);
    },
  );
  assert.equal(response.headers.get("x-eve-native-recovery-boot-status"), "failed");
  assert.equal(response.headers.get("x-eve-stream-tail-index"), "-1");
  const body = await response.text();
  assert.equal(body.trim(), "");
});

test("same recovery request adopts once, preserves original authority, and activation remains receipt-bound", async () => {
  const f = await fixture();
  const next = {
    ...descriptor,
    operationId: "recover-failed-boot",
    sourcePublicSessionId: "ses-failed-child",
    sourceOwnerRunId: ownerRunId,
    sourceAdapterGeneration: 3,
  };
  let activations = 0;
  let hook;
  let receipt;
  let started;
  let starts = 0;
  const ports = {
    authorize: async () => {},
    authorizeActivation: async () => {},
    commitReceipt: async ({ recoveryBinding }) => {
      receipt ??= recoveryBinding;
      return receipt;
    },
    readReceipt: async () => receipt,
  };
  const dependencies = {
    collect: f.collect,
    getHook: async () => {
      if (hook === undefined) {
        throw new Error("missing");
      }
      return hook;
    },
    isHookNotFound: (error) => error.message === "missing",
    now: Date.now,
    readCandidate: readTerminalRecoveryCandidate,
    readEntry: async () => f.entry,
    reconcile: reconcileTerminalRecoveryCandidate,
    resumeHook: async (_token, input) => {
      assert.equal(input.ownerRunId, receipt.ownerRunId);
      activations += 1;
      // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Preserve the existing explicit undefined value.
      hook = undefined;
    },
    start: async (input) => {
      starts += 1;
      started = input;
      hook = {
        runId: "wrun-recovered",
        metadata: Promise.resolve({
          recoveryBinding: { ...next, ownerRunId: "wrun-recovered", provenance: input.provenance },
        }),
      };
    },
    wait: async () => {
      throw new Error("unexpected readiness wait");
    },
  };
  const { commitReceipt } = ports;
  let failFirstCommit = true;
  ports.commitReceipt = async (input) => {
    if (failFirstCommit) {
      failFirstCommit = false;
      throw new Error("receipt persistence interrupted");
    }
    return await commitReceipt(input);
  };
  await assert.rejects(
    recoverTerminalSession({ auth, descriptor: next, ports }, dependencies),
    /receipt persistence interrupted/u,
  );
  assert.equal(activations, 0);
  const concurrent = await Promise.all([
    recoverTerminalSession({ auth, descriptor: next, ports }, dependencies),
    recoverTerminalSession({ auth, descriptor: next, ports }, dependencies),
  ]);
  const [accepted] = concurrent;
  assert.deepEqual(concurrent[1], accepted);
  assert.equal(accepted.kind, "accepted");
  assert.equal(receipt.originalAuthoritySessionId, descriptor.originalAuthoritySessionId);
  assert.equal(receipt.logicalSessionId, logicalSessionId);
  assert.equal(receipt.provenance.kind, "validated-recovery-input");
  assert.equal(receipt.provenance.resumePhase, "await-input");
  assert.deepEqual(readDurableSession(started.checkpoint.sessionState).state, f.originalState);
  // Concurrent exact retries use the durable winner, not a second recovered app or owner.
  const retries = await Promise.all([
    recoverTerminalSession({ auth, descriptor: next, ports }, dependencies),
    recoverTerminalSession({ auth, descriptor: next, ports }, dependencies),
  ]);
  assert.deepEqual(retries, [accepted, accepted]);
  await activateTerminalSession({ auth, descriptor: next, ports }, dependencies);
  await activateTerminalSession({ auth, descriptor: next, ports }, dependencies);
  assert.equal(starts, 1);
  assert.equal(activations, 1);
});

for (const [name, change] of [
  [
    "running",
    (f) => {
      f.run.status = "running";
    },
  ],
  [
    "foreign physical owner",
    (f) => {
      f.run.runId = "foreign-run";
    },
  ],
]) {
  test(`empty stream does not invent terminal failure for ${String(name)}`, async () => {
    const f = await fixture(change);
    assert.equal(await f.status(), undefined);
  });
}

test("unavailable native metadata does not change stream status", async () => {
  assert.equal(
    await readFailedRecoveryBootStatus(ownerRunId, -1, {
      readEntry: async () => {
        throw new Error("metadata unavailable");
      },
    }),
    undefined,
  );
});
