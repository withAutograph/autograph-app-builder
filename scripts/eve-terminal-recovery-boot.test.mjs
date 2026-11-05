/* oxlint-disable eslint/require-await -- Synthetic implementations retain the asynchronous native port contract. */
/* oxlint-disable promise/prefer-await-to-callbacks -- The inbox port registers an interrupt listener by contract. */
/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument -- Exercises installed native Eve modules through synthetic workflow ports. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { it, vi } from "vitest";

const require = createRequire(import.meta.url);
const sdk = pathToFileURL(
  `${path.resolve(process.env.EVE_RECOVERY_NATIVE_ROOT ?? path.dirname(require.resolve("eve/package.json")))}/dist/src/`,
).href;
const native = await import(`${sdk}execution/session/terminal-recovery.js`);
const { createDurableSessionState } = await import(`${sdk}execution/durable-session-store.js`);
const { bootTerminalRecoveryOwnerWithPorts } = await import(
  `${sdk}execution/session/terminal-recovery-boot.js`
);
const descriptor = {
  version: 1,
  operationId: "op-recovery",
  sourcePublicSessionId: "ses-parent",
  sourceOwnerRunId: "wrun-source",
  sourceAdapterGeneration: 1,
  logicalSessionId: "logical-original",
  originalAuthoritySessionId: "ses-authority",
  parentCancellationRevision: 2,
  sourceHandoffId: "handoff-original",
};
const auth = {
  authenticator: "test",
  principalType: "user",
  principalId: "owner",
  issuer: "issuer",
};
const provenance = {
  kind: "completed-terminal-turn-input",
  sourceStepId: "step-original",
  sourceEventId: "event-original",
  sourceSlot: 7,
  checkpointVersion: 1,
};
const checkpoint = () => ({
  version: 9,
  sessionTimeoutMs: false,
  capabilities: { requestInput: true },
  serializedContext: {
    "eve.sessionId": descriptor.logicalSessionId,
    "eve.auth": { current: auth },
    "authored.grant": {
      appId: "same-app",
      sessionId: descriptor.logicalSessionId,
      workspaceId: "same-drive",
    },
  },
  sessionState: createDurableSessionState({
    session: {
      sessionId: descriptor.logicalSessionId,
      continuationToken: "original-token",
      state: { deniedCall: true },
      history: [{ role: "assistant", content: "original" }],
      agent: { system: "retained system", tools: new Map() },
      compaction: {},
    },
  }),
});
const bootFixture = () => {
  const { promise: activation, resolve: resolveActivation } = Promise.withResolvers();
  const calls = [];
  const queue = [{ kind: "deliver", payloads: [{ message: "retained input" }] }];
  let interrupt;
  const inbox = {
    async claimSessionHooks(tokens) {
      calls.push(["claim", tokens]);
    },
    onInterrupt(callback) {
      interrupt = callback;
      return () => {
        interrupt = undefined;
      };
    },
    drain() {
      return queue.splice(0);
    },
    restore(items) {
      queue.unshift(...items);
    },
    async dispose() {
      calls.push(["dispose-inbox"]);
    },
  };
  const ports = {
    createSessionInbox(id) {
      assert.equal(id, descriptor.logicalSessionId);
      return inbox;
    },
    getWorkflowMetadata() {
      return { workflowRunId: "wrun-child" };
    },
    getWritable() {
      calls.push(["writable"]);
      return "new-stream";
    },
    async validateCheckpoint(input) {
      calls.push(["validate", input]);
    },
    createHook(options) {
      calls.push(["hook", options]);
      return Object.assign(activation, {
        async getConflict() {
          return null;
        },
        dispose() {
          calls.push(["dispose-hook"]);
        },
      });
    },
  };
  return {
    ports,
    calls,
    inbox,
    queue,
    activate: () =>
      resolveActivation({
        kind: "activate-terminal-recovery",
        operationId: descriptor.operationId,
        ownerRunId: "wrun-child",
      }),
    cancel: () => interrupt({ kind: "cancel" }),
  };
};
const inputFor = (cp = checkpoint()) => ({
  kind: "terminal-recovery",
  checkpoint: cp,
  descriptor,
  provenance,
  activationToken: "activation-private",
  ownerDeploymentId: "deployment-current",
  replayInput: {
    runtimeResults: { results: [{ toolCallId: "actual-call", output: "actual-output" }] },
  },
});

it("native boot preserves exact checkpoint, grant, replay input and logical identity while owning a new stream", async () => {
  const fixture = bootFixture();
  const input = inputFor();
  const promise = bootTerminalRecoveryOwnerWithPorts(input, fixture.ports);
  await delay(0);
  assert.equal(
    fixture.calls.some(([name]) => name === "writable"),
    false,
  );
  assert.equal(fixture.queue.length, 1);
  fixture.activate();
  const result = await promise;
  assert.equal(result.session.sessionId, descriptor.logicalSessionId);
  assert.equal(result.session.streamRunId, "wrun-child");
  assert.equal(result.session.sessionWritable, "new-stream");
  assert.equal(result.session.serializedContext, input.checkpoint.serializedContext);
  assert.equal(result.session.sessionState, input.checkpoint.sessionState);
  assert.equal(result.session.initialTurnInput, input.replayInput);
  assert.equal(result.session.initialInput, undefined);
  assert.equal(result.session.awaitFirstMessage, false);
  assert.deepEqual(result.session.anchor, { kind: "self" });
  assert.equal(
    fixture.calls.some(([name]) => name === "dispose-inbox"),
    false,
  );
});
it("pre-activation cancellation runs no session or stream and releases claims", async () => {
  const fixture = bootFixture();
  const pending = bootTerminalRecoveryOwnerWithPorts(inputFor(), fixture.ports);
  await delay(0);
  fixture.cancel();
  assert.equal(await pending, undefined);
  assert.equal(
    fixture.calls.some(([name]) => name === "writable"),
    false,
  );
  assert.equal(
    fixture.calls.some(([name]) => name === "dispose-inbox"),
    true,
  );
});
it("native boot rejects changed logical identity before any claim", async () => {
  const fixture = bootFixture();
  const cp = checkpoint();
  cp.sessionState.sessionId = "different";
  await assert.rejects(
    bootTerminalRecoveryOwnerWithPorts(inputFor(cp), fixture.ports),
    /identity changed/u,
  );
  assert.equal(fixture.calls.length, 0);
});
it("a competing recovery owner cannot execute or replace logical hook ownership", async () => {
  const fixture = bootFixture();
  fixture.ports.createHook = () => ({
    async getConflict() {
      return { runId: "winner" };
    },
    dispose() {
      fixture.calls.push(["dispose-hook"]);
    },
  });
  assert.equal(await bootTerminalRecoveryOwnerWithPorts(inputFor(), fixture.ports), undefined);
  assert.equal(
    fixture.calls.some(([name]) => name === "writable"),
    false,
  );
});

const recoveryFixture = () => {
  const calls = [];
  let receipt;
  let hook;
  let allowed = true;
  const cp = checkpoint();
  const candidate = Object.freeze({ kind: "private-native-recovery-candidate", version: 1 });
  const payload = {
    run: { runId: descriptor.sourceOwnerRunId },
    candidates: [
      {
        kind: provenance.kind,
        origin: {
          eventId: provenance.sourceEventId,
          stepId: provenance.sourceStepId,
          slot: provenance.sourceSlot,
        },
      },
    ],
  };
  const ports = {
    async authorize() {
      calls.push("authorize");
      if (!allowed) {
        throw new Error("cancelled");
      }
    },
    async authorizeActivation() {
      calls.push("authorize-activation");
      if (!allowed) {
        throw new Error("cancelled");
      }
    },
    async readReceipt() {
      calls.push("receipt-read");
      return receipt;
    },
    async commitReceipt(input) {
      calls.push("receipt-commit");
      if (!allowed) {
        throw new Error("cancelled");
      }
      receipt = input.recoveryBinding;
      return receipt;
    },
  };
  const deps = {
    async collect(input) {
      calls.push("collect");
      await input.authorizeOwner(input.binding);
      return { kind: "candidate", candidate };
    },
    async reconcile() {
      calls.push("reconcile");
      return {
        kind: "ready",
        checkpointCore: { serializedContext: cp.serializedContext, sessionState: cp.sessionState },
        replayInput: inputFor().replayInput,
        provenance: { selectedOrigin: payload.candidates[0].origin },
      };
    },
    readCandidate(handle) {
      assert.equal(handle, candidate);
      return payload;
    },
    async readEntry() {
      calls.push("policy");
      return { kind: "handoff", checkpoint: cp };
    },
    async start(input) {
      calls.push("start");
      assert.equal(input.checkpoint.serializedContext, cp.serializedContext);
      hook = {
        runId: "wrun-child",
        metadata: Promise.resolve({
          recoveryBinding: {
            ...descriptor,
            ownerRunId: "wrun-child",
            provenance: input.provenance,
          },
        }),
      };
    },
    async getHook() {
      if (hook === undefined) {
        throw new Error("missing");
      }
      return hook;
    },
    async resumeHook(_token, input) {
      calls.push("activate");
      assert.ok(receipt !== null && receipt !== undefined);
      assert.equal(input.ownerRunId, receipt.ownerRunId);
      hook = undefined;
    },
    isHookNotFound(error) {
      return error.message === "missing";
    },
    now: Date.now,
    async wait() {
      throw new Error("unexpected wait");
    },
  };
  return {
    calls,
    ports,
    deps,
    getReceipt: () => receipt,
    revoke: () => {
      allowed = false;
    },
  };
};
it("canonical receipt precedes activation and exact retry after closed inbox never recollects or restarts", async () => {
  const f = recoveryFixture();
  const first = await native.recoverTerminalSession({ auth, descriptor, ports: f.ports }, f.deps);
  assert.equal(first.kind, "accepted");
  assert.equal(f.calls.includes("activate"), false);
  await native.activateTerminalSession({ auth, descriptor, ports: f.ports }, f.deps);
  assert.ok(f.calls.indexOf("receipt-commit") < f.calls.indexOf("activate"));
  const second = await native.recoverTerminalSession({ auth, descriptor, ports: f.ports }, f.deps);
  assert.deepEqual(second, first);
  await native.activateTerminalSession({ auth, descriptor, ports: f.ports }, f.deps);
  for (const name of ["start", "collect", "activate"]) {
    assert.equal(f.calls.filter((call) => call === name).length, 1);
  }
});
it("lost receipt persistence is unknown and exact retry adopts the existing parked owner", async () => {
  const f = recoveryFixture();
  const commit = f.ports.commitReceipt.bind(f.ports);
  let once = true;
  f.ports.commitReceipt = async (input) => {
    if (once) {
      once = false;
      throw new Error("lost persistence");
    }
    return await commit(input);
  };
  await assert.rejects(
    native.recoverTerminalSession({ auth, descriptor, ports: f.ports }, f.deps),
    /lost persistence/u,
  );
  assert.equal(f.calls.includes("activate"), false);
  const recovered = await native.recoverTerminalSession(
    { auth, descriptor, ports: f.ports },
    f.deps,
  );
  assert.equal(recovered.kind, "accepted");
  assert.equal(f.calls.filter((call) => call === "start").length, 1);
});
it("changed authority after boot prevents receipt and activation", async () => {
  const f = recoveryFixture();
  const start = f.deps.start.bind(f.deps);
  f.deps.start = async (input) => {
    await start(input);
    f.revoke();
  };
  await assert.rejects(
    native.recoverTerminalSession({ auth, descriptor, ports: f.ports }, f.deps),
    /cancelled/u,
  );
  assert.equal(f.calls.includes("receipt-commit"), false);
  assert.equal(f.calls.includes("activate"), false);
});
it("uncertain effects never start a physical owner or synthesize results", async () => {
  const f = recoveryFixture();
  f.deps.reconcile = async () => ({ kind: "uncertain", reason: "unresolved-effect" });
  assert.deepEqual(
    await native.recoverTerminalSession({ auth, descriptor, ports: f.ports }, f.deps),
    { kind: "uncertain", reason: "unresolved-effect" },
  );
  assert.equal(f.calls.includes("start"), false);
});
it("only accepted trusted forwarding may request recovery and raw checkpoint/message fields are rejected", async () => {
  const payload = { operationId: descriptor.operationId, recovery: descriptor };
  const forbidden = await native.handleTerminalRecoveryRequest({
    payload,
    auth,
    forwarded: false,
    ports: recoveryFixture().ports,
  });
  assert.equal(forbidden.status, 403);
  const invalid = await native.handleTerminalRecoveryRequest({
    payload: { ...payload, message: "substitute" },
    auth,
    forwarded: true,
    ports: recoveryFixture().ports,
  });
  assert.equal(invalid.status, 400);
  assert.equal(
    native.parseTerminalRecoveryDescriptor(
      { ...descriptor, checkpoint: checkpoint() },
      descriptor.operationId,
    ),
    undefined,
  );
});
it("source policy honors original initial default and rejects missing recovered policy", () => {
  assert.equal(
    native.terminalRecoveryPolicy({ kind: "initial", serializedContext: {} }).sessionTimeoutMs,
    2_592_000_000,
  );
  assert.equal(native.terminalRecoveryPolicy({ kind: "handoff", checkpoint: {} }), undefined);
  assert.equal(
    native.terminalRecoveryPolicy({ kind: "terminal-recovery", checkpoint: checkpoint() })
      .sessionTimeoutMs,
    false,
  );
});

it("recovered first turn admits a queued cancellation before any turn step", async () => {
  const { SessionExecution } = await import(`${sdk}execution/session/turn.js`);
  const { SessionInputQueue } = await import(`${sdk}execution/session/input-queue.js`);
  let steps = 0;
  let settled = 0;
  let cleanups = 0;
  const inbox = {
    onInterrupt() {
      return () => {
        cleanups += 1;
      };
    },
    onDelivery() {
      return () => {
        cleanups += 1;
      };
    },
    drain() {
      return [{ kind: "cancel" }];
    },
  };
  const execution = new SessionExecution({
    sessionId: descriptor.logicalSessionId,
    inbox,
    queue: new SessionInputQueue(),
    cursor: {
      sessionState: { emissionState: { sequence: 1, stepIndex: 1, turnId: "turn-original" } },
    },
  });
  execution.runTurnSteps = async () => {
    steps += 1;
    return { kind: "done", output: "should-not-run" };
  };
  execution.finishCancelledTurn = async () => {
    settled += 1;
    return { kind: "park", cancelled: true };
  };
  assert.deepEqual(await execution.runTurn(undefined, true), { kind: "park", cancelled: true });
  assert.equal(steps, 0);
  assert.equal(settled, 1);
  assert.equal(cleanups, 2);
});

it("a receipt with changed provenance cannot activate a parked recovery", async () => {
  const f = recoveryFixture();
  f.ports.commitReceipt = async ({ recoveryBinding }) => ({
    ...recoveryBinding,
    provenance: { ...recoveryBinding.provenance, sourceEventId: "different-event" },
  });
  await assert.rejects(
    native.recoverTerminalSession({ auth, descriptor, ports: f.ports }, f.deps),
    /physical owner and provenance/u,
  );
  assert.equal(f.calls.includes("activate"), false);
});
it("unreadable original policy returns unavailable before any owner is started", async () => {
  const f = recoveryFixture();
  f.deps.readEntry = async () => {
    throw new Error("unreadable policy");
  };
  assert.deepEqual(
    await native.recoverTerminalSession({ auth, descriptor, ports: f.ports }, f.deps),
    {
      kind: "unavailable",
      reason: "source-policy-unavailable",
    },
  );
  assert.equal(f.calls.includes("start"), false);
});

it("acceptance observation backs off and a timed-out exact retry adopts the later-ready owner", async () => {
  const f = recoveryFixture();
  const readHook = f.deps.getHook.bind(f.deps);
  const waits = [];
  let clock = 0;
  let visible = false;
  f.deps.now = () => clock;
  f.deps.wait = async (ms) => {
    waits.push(ms);
    clock += ms;
  };
  f.deps.getHook = async (token) => {
    if (!visible) {
      throw new Error("missing");
    }
    return await readHook(token);
  };
  await assert.rejects(
    native.recoverTerminalSession({ auth, descriptor, ports: f.ports }, f.deps),
    /acceptance is unknown/u,
  );
  assert.deepEqual(waits.slice(0, 4), [250, 500, 1000, 2000]);
  assert.ok(waits.every((ms) => ms >= 250 && ms <= 2000));
  assert.equal(clock, 30_000);
  assert.equal(f.calls.includes("activate"), false);
  visible = true;
  const result = await native.recoverTerminalSession({ auth, descriptor, ports: f.ports }, f.deps);
  assert.equal(result.kind, "accepted");
  assert.equal(f.calls.filter((call) => call === "start").length, 1);
  assert.equal(f.calls.filter((call) => call === "activate").length, 0);
  await native.activateTerminalSession({ auth, descriptor, ports: f.ports }, f.deps);
  assert.equal(f.calls.filter((call) => call === "activate").length, 1);
});

it("activation rejects before canonical child authority and cancellation, without recollecting or starting", async () => {
  const f = recoveryFixture();
  await native.recoverTerminalSession({ auth, descriptor, ports: f.ports }, f.deps);
  f.ports.authorizeActivation = async () => {
    throw new Error("public child not committed");
  };
  await assert.rejects(
    native.activateTerminalSession({ auth, descriptor, ports: f.ports }, f.deps),
    /public child not committed/u,
  );
  assert.equal(f.calls.includes("activate"), false);
  f.ports.authorizeActivation = async () => {
    await f.ports.authorize();
  };
  f.revoke();
  await assert.rejects(
    native.activateTerminalSession({ auth, descriptor, ports: f.ports }, f.deps),
    /cancelled/u,
  );
  assert.equal(f.calls.filter((call) => call === "collect").length, 1);
  assert.equal(f.calls.filter((call) => call === "start").length, 1);
  assert.equal(f.calls.includes("activate"), false);
});
it("lost activation ACK reuses only the committed owner and never collects or starts", async () => {
  const f = recoveryFixture();
  await native.recoverTerminalSession({ auth, descriptor, ports: f.ports }, f.deps);
  const resume = f.deps.resumeHook.bind(f.deps);
  f.deps.resumeHook = async (...args) => {
    await resume(...args);
    throw new Error("lost ACK");
  };
  await assert.rejects(
    native.activateTerminalSession({ auth, descriptor, ports: f.ports }, f.deps),
    /lost ACK/u,
  );
  await native.activateTerminalSession({ auth, descriptor, ports: f.ports }, f.deps);
  assert.equal(f.calls.filter((call) => call === "activate").length, 1);
  assert.equal(f.calls.filter((call) => call === "collect").length, 1);
  assert.equal(f.calls.filter((call) => call === "start").length, 1);
});

it("two-phase preparation parks the actual native boot until canonical child activation", async () => {
  const f = recoveryFixture();
  const boot = bootFixture();
  /** @type {Promise<{session: {sessionId: string, initialTurnInput: unknown}}> | undefined} */
  let pending;
  let committedChild = false;
  const start = f.deps.start.bind(f.deps);
  f.deps.start = async (input) => {
    await start(input);
    pending = bootTerminalRecoveryOwnerWithPorts(
      { ...input, kind: "terminal-recovery", ownerDeploymentId: "deployment-current" },
      boot.ports,
    );
    await delay(0);
  };
  f.ports.authorizeActivation = async () => {
    assert.equal(committedChild, true, "the canonical public child must precede activation");
    await f.ports.authorize();
  };
  const resume = f.deps.resumeHook.bind(f.deps);
  f.deps.resumeHook = async (...args) => {
    assert.equal(committedChild, true);
    await resume(...args);
    boot.activate();
  };
  await native.recoverTerminalSession({ auth, descriptor, ports: f.ports }, f.deps);
  assert.equal(
    boot.calls.some(([name]) => name === "writable"),
    false,
  );
  assert.equal(f.calls.includes("activate"), false);
  committedChild = true;
  await native.activateTerminalSession({ auth, descriptor, ports: f.ports }, f.deps);
  assert.ok(pending !== undefined);
  const result = await pending;
  assert.equal(result.session.sessionId, descriptor.logicalSessionId);
  assert.deepEqual(result.session.initialTurnInput, inputFor().replayInput);
  assert.equal(boot.calls.filter(([name]) => name === "writable").length, 1);
});

const historicalInbox = () => [
  {
    runId: descriptor.sourceOwnerRunId,
    eventId: `evnt_${String(8).padStart(26, "0")}`,
    correlationId: "original-command-hook",
    slot: 8,
    payload: { kind: "cancel", turnId: "turn-original" },
  },
  {
    runId: descriptor.sourceOwnerRunId,
    eventId: `evnt_${String(9).padStart(26, "0")}`,
    correlationId: "original-command-hook",
    slot: 9,
    payload: {
      kind: "send",
      requestId: "original-request",
      auth: { principalId: "original-owner" },
      payload: { message: "preserved accepted message" },
    },
  },
  {
    runId: descriptor.sourceOwnerRunId,
    eventId: `evnt_${String(10).padStart(26, "0")}`,
    correlationId: "original-command-hook",
    slot: 10,
    payload: { kind: "cancel", turnId: "turn-original" },
  },
];
const historicalInput = () => {
  const input = inputFor();
  input.checkpoint.sessionState.emissionState.turnId = "turn-original";
  return { ...input, carriedInbox: historicalInbox() };
};
it("receipt-bound historical FIFO reaches real ActiveTurn cancellation and retains the accepted SEND", async () => {
  const { SessionExecution } = await import(`${sdk}execution/session/turn.js`);
  const { SessionInputQueue } = await import(`${sdk}execution/session/input-queue.js`);
  const f = bootFixture();
  f.queue.splice(0);
  const input = historicalInput();
  const before = structuredClone(input);
  const pending = bootTerminalRecoveryOwnerWithPorts(input, f.ports);
  await delay(0);
  assert.equal(
    f.queue.length,
    0,
    "historical cancels must not become new-owner preactivation vetoes",
  );
  f.activate();
  const boot = await pending;
  assert.deepEqual(
    f.queue,
    input.carriedInbox.map((entry) => entry.payload),
  );
  assert.deepEqual(input, before);
  let turnSteps = 0;
  let cancellationBoundaries = 0;
  f.inbox.onDelivery = () => () => {
    f.calls.push(["unsubscribe-delivery"]);
  };
  const queue = new SessionInputQueue();
  const execution = new SessionExecution({
    sessionId: descriptor.logicalSessionId,
    inbox: f.inbox,
    queue,
    cursor: { sessionState: boot.session.sessionState },
  });
  execution.runTurnSteps = async () => {
    turnSteps += 1;
    throw new Error("old cancelled turn must not execute");
  };
  execution.finishCancelledTurn = async () => {
    cancellationBoundaries += 1;
    return { kind: "park", cancelled: true };
  };
  assert.deepEqual(await execution.runTurn(boot.session.initialTurnInput, true), {
    kind: "park",
    cancelled: true,
  });
  assert.equal(turnSteps, 0);
  assert.equal(cancellationBoundaries, 1);
  const next = queue.takeNext(boot.session.sessionState.snapshot.session.state);
  assert.equal(next.kind, "turn");
  assert.deepEqual(next.delivery.payloads, [input.carriedInbox[1].payload.payload]);
  assert.deepEqual(next.delivery.auth, input.carriedInbox[1].payload.auth);
  assert.equal(next.delivery.requestId, "original-request");
  assert.equal(queue.pendingCount, 0);
});
it("a newly accepted preactivation Stop vetoes boot without restoring historical commands", async () => {
  const f = bootFixture();
  f.queue.splice(0);
  const pending = bootTerminalRecoveryOwnerWithPorts(historicalInput(), f.ports);
  await delay(0);
  f.cancel();
  assert.equal(await pending, undefined);
  assert.deepEqual(f.queue, []);
  assert.equal(
    f.calls.some(([name]) => name === "writable"),
    false,
  );
});
for (const mutation of ["foreign-owner", "duplicate-event", "wrong-turn"]) {
  it(`historical command ${mutation} cannot enter a recovery owner`, async () => {
    const f = bootFixture();
    const input = historicalInput();
    if (mutation === "foreign-owner") {
      input.carriedInbox[0].runId = "foreign-owner";
    }
    if (mutation === "duplicate-event") {
      input.carriedInbox[1].eventId = input.carriedInbox[0].eventId;
    }
    if (mutation === "wrong-turn") {
      input.carriedInbox[0].payload.turnId = "another-turn";
    }
    await assert.rejects(
      bootTerminalRecoveryOwnerWithPorts(input, f.ports),
      /inbox binding changed/u,
    );
    assert.equal(f.calls.length, 0);
  });
}
it("exact recovery retry preserves the immutable historical entry and starts only one owner", async () => {
  const f = recoveryFixture();
  const reconcile = f.deps.reconcile.bind(f.deps);
  const carriedInbox = historicalInbox();
  f.deps.reconcile = async (...args) => ({ ...(await reconcile(...args)), carriedInbox });
  const start = f.deps.start.bind(f.deps);
  const started = [];
  f.deps.start = async (input) => {
    started.push(input);
    await start(input);
  };
  const first = await native.recoverTerminalSession({ auth, descriptor, ports: f.ports }, f.deps);
  const second = await native.recoverTerminalSession({ auth, descriptor, ports: f.ports }, f.deps);
  assert.deepEqual(second, first);
  assert.equal(started.length, 1);
  assert.deepEqual(started[0].carriedInbox, carriedInbox);
  assert.equal(f.calls.includes("activate"), false);
  f.revoke();
  await assert.rejects(
    native.activateTerminalSession({ auth, descriptor, ports: f.ports }, f.deps),
    /cancelled/u,
  );
  assert.equal(f.calls.includes("activate"), false);
});

it("an idle recovery owner enters the actual inbox wait without admitting a model turn", async () => {
  const { runPreparedSession } = await import(`${sdk}execution/session/program.js`);
  const { promise: activation, resolve: activate } = Promise.withResolvers();
  const { promise: enteredWait, resolve: enterWait } = Promise.withResolvers();
  const { promise: parkedWait } = Promise.withResolvers();
  let claims = 0;
  let writableReads = 0;
  const inbox = {
    claimSessionHooks: async () => {
      claims += 1;
    },
    onInterrupt: () => vi.fn(),
    drain: () => [],
    restore: vi.fn(),
    hasPending: () => false,
    next: () => {
      enterWait();
      return parkedWait;
    },
    dispose: vi.fn(() => Promise.resolve()),
  };
  const ports = {
    createSessionInbox: () => inbox,
    getWorkflowMetadata: () => ({ workflowRunId: "idle-successor" }),
    validateCheckpoint: vi.fn(() => Promise.resolve()),
    getWritable: () => {
      writableReads += 1;
      return new WritableStream();
    },
    createHook: () =>
      Object.assign(activation, { getConflict: () => Promise.resolve(), dispose: vi.fn() }),
  };
  const input = {
    kind: "terminal-recovery",
    descriptor,
    checkpoint: checkpoint(),
    provenance: { ...provenance, resumePhase: "await-input" },
    activationToken: "idle-activation",
    ownerDeploymentId: "deployment",
  };
  const pending = bootTerminalRecoveryOwnerWithPorts(input, ports);
  await Promise.resolve();
  assert.equal(writableReads, 0);
  activate({
    kind: "activate-terminal-recovery",
    operationId: descriptor.operationId,
    ownerRunId: "idle-successor",
  });
  const boot = await pending;
  assert.equal(claims, 1);
  assert.equal(boot.session.initialTurnInput, undefined);
  const running = runPreparedSession(boot.session, boot.inbox);
  await Promise.race([
    enteredWait,
    (async () => {
      await running;
      throw new Error("Idle owner ended before receiving input.");
    })(),
  ]);
  assert.equal(boot.session.awaitFirstMessage, true);
  await assert.rejects(
    bootTerminalRecoveryOwnerWithPorts(
      {
        ...input,
        replayInput: { delivery: { kind: "deliver", payloads: [{ message: "old response" }] } },
      },
      ports,
    ),
    /pending work/u,
  );
  assert.equal(claims, 1);
});
