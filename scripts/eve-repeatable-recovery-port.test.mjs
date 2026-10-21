/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument -- Exercises installed native recovery using synthetic typed authority and workflow ports. */
/* oxlint-disable eslint/require-await -- Synthetic asynchronous ports perform no live I/O. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";

const require = createRequire(import.meta.url);
const sdk = path.dirname(require.resolve("eve/package.json"));
const { recoverTerminalSession } = await import(
  pathToFileURL(path.join(sdk, "dist/src/execution/session/terminal-recovery.js")).href
);
const fixture = () => {
  const descriptor = {
    version: 1,
    operationId: "repeatable-operation",
    sourcePublicSessionId: "public-source",
    sourceOwnerRunId: "physical-source",
    sourceAdapterGeneration: 1,
    logicalSessionId: "logical-original",
    originalAuthoritySessionId: "public-original",
    parentCancellationRevision: 0,
  };
  const auth = { authenticator: "test", principalType: "user", principalId: "owner" };
  const provenance = {
    kind: "committed-turn-output",
    sourceStepId: "step-retained",
    sourceEventId: "event-retained",
    sourceSlot: 4,
    checkpointVersion: 1,
  };
  const accepted = { ...descriptor, ownerRunId: "physical-child", provenance };
  const origin = { stepId: "step-retained", eventId: "event-retained", slot: 4 };
  const payload = {
    binding: {
      ownerRunId: descriptor.sourceOwnerRunId,
      logicalSessionId: descriptor.logicalSessionId,
    },
    run: { runId: descriptor.sourceOwnerRunId },
    candidates: [{ kind: provenance.kind, origin }],
    nativeEvents: [],
  };
  const checkpointCore = {
    serializedContext: { "eve.sessionId": descriptor.logicalSessionId, originalGrant: "unchanged" },
    sessionState: { sessionId: descriptor.logicalSessionId, originalState: "unchanged" },
  };
  const state = {
    calls: [],
    receipt: undefined,
    hook: undefined,
    denied: false,
    options: undefined,
  };
  const ports = {
    async authorize() {
      state.calls.push("authorize");
      if (state.denied) {
        throw new Error("authority revoked");
      }
    },
    async readReceipt() {
      state.calls.push("read-receipt");
      return state.receipt;
    },
    async commitReceipt({ recoveryBinding }) {
      state.calls.push("commit");
      state.receipt = recoveryBinding;
      return recoveryBinding;
    },
    async authorizeActivation() {
      throw new Error("unexpected activation");
    },
  };
  const deps = {
    async collect({ binding, authorizeOwner }) {
      state.calls.push("collect");
      await authorizeOwner(binding);
      return { kind: "candidate", candidate: payload };
    },
    readCandidate: (candidate) => candidate,
    async reconcile(candidate, options) {
      assert.equal(candidate, payload);
      state.calls.push("reconcile");
      state.options = options;
      return options?.repeatableCallIds?.includes("original-call") === true
        ? { kind: "ready", checkpointCore, provenance: { selectedOrigin: origin } }
        : { kind: "uncertain", reason: "approval-transcript-unavailable" };
    },
    async readEntry() {
      return {
        kind: "handoff",
        checkpoint: { sessionTimeoutMs: false, capabilities: { original: true } },
      };
    },
    async start(input) {
      state.calls.push("start");
      assert.equal(input.checkpoint.serializedContext, checkpointCore.serializedContext);
      assert.equal(input.checkpoint.sessionState, checkpointCore.sessionState);
      state.hook = {
        runId: accepted.ownerRunId,
        metadata: Promise.resolve({ recoveryBinding: accepted }),
      };
    },
    async getHook() {
      if (state.hook === undefined) {
        throw new Error("hook missing");
      }
      return state.hook;
    },
    isHookNotFound: (error) => error.message === "hook missing",
    now: () => 0,
    async wait() {
      throw new Error("unexpected wait");
    },
  };
  return { input: { auth, descriptor, ports }, deps, state, payload, accepted };
};

test("only exact trusted IDs reach reconciliation after current authority and receipt revalidation", async () => {
  const f = fixture();
  const before = JSON.stringify(f.payload);
  f.input.ports.authorizeRepeatableRecoveryCalls = async (input) => {
    f.state.calls.push("decision");
    assert.equal(input.auth, f.input.auth);
    assert.equal(input.descriptor, f.input.descriptor);
    assert.equal(input.payload, f.payload);
    assert.deepEqual(input.binding, f.payload.binding);
    return ["original-call", "original-call"];
  };
  assert.deepEqual(await recoverTerminalSession(f.input, f.deps), {
    kind: "accepted",
    recoveryBinding: f.accepted,
  });
  assert.deepEqual(f.state.options, { repeatableCallIds: ["original-call"] });
  const decision = f.state.calls.indexOf("decision");
  const reconcile = f.state.calls.indexOf("reconcile");
  assert.deepEqual(f.state.calls.slice(decision + 1, reconcile), ["authorize", "read-receipt"]);
  assert.equal(JSON.stringify(f.payload), before);
  assert.equal(f.state.calls.filter((call) => call === "start").length, 1);
});
test("missing, failed or malformed app decisions grant no IDs and cannot start an owner", async () => {
  const decisions = [
    undefined,
    async () => {
      throw new Error("unavailable");
    },
    async () => ["original-call", null],
  ];
  await Promise.all(
    decisions.map(async (decision) => {
      const f = fixture();
      f.input.ports.authorizeRepeatableRecoveryCalls = decision;
      assert.deepEqual(await recoverTerminalSession(f.input, f.deps), {
        kind: "uncertain",
        reason: "approval-transcript-unavailable",
      });
      assert.equal(f.state.options, undefined);
      assert.equal(f.state.calls.includes("start"), false);
      assert.equal(f.state.calls.includes("commit"), false);
    }),
  );
});
test("revocation during the trusted decision prevents reconciliation and owner creation", async () => {
  const f = fixture();
  f.input.ports.authorizeRepeatableRecoveryCalls = async () => {
    f.state.denied = true;
    return ["original-call"];
  };
  await assert.rejects(recoverTerminalSession(f.input, f.deps), /authority revoked/u);
  assert.equal(f.state.calls.includes("reconcile"), false);
  assert.equal(f.state.calls.includes("start"), false);
});
test("a concurrently committed receipt prevents replay planning and exact retry adopts that owner", async () => {
  const f = fixture();
  let decisions = 0;
  f.input.ports.authorizeRepeatableRecoveryCalls = async () => {
    decisions += 1;
    f.state.receipt = f.accepted;
    return ["original-call"];
  };
  await assert.rejects(recoverTerminalSession(f.input, f.deps), /receipt changed/u);
  assert.deepEqual(await recoverTerminalSession(f.input, f.deps), {
    kind: "accepted",
    recoveryBinding: f.accepted,
  });
  assert.equal(decisions, 1);
  assert.equal(f.state.calls.includes("reconcile"), false);
  assert.equal(f.state.calls.includes("start"), false);
});
test("a foreign candidate binding cannot reach the trusted policy", async () => {
  const f = fixture();
  let decisions = 0;
  f.payload.binding.ownerRunId = "foreign-owner";
  f.input.ports.authorizeRepeatableRecoveryCalls = async () => {
    decisions += 1;
    return ["original-call"];
  };
  await assert.rejects(recoverTerminalSession(f.input, f.deps), /source binding changed/u);
  assert.equal(decisions, 0);
  assert.equal(f.state.calls.includes("reconcile"), false);
});
test("an existing parked owner is committed without recollecting or invoking the policy", async () => {
  const f = fixture();
  f.state.hook = {
    runId: f.accepted.ownerRunId,
    metadata: Promise.resolve({ recoveryBinding: f.accepted }),
  };
  f.input.ports.authorizeRepeatableRecoveryCalls = async () => {
    throw new Error("unexpected policy");
  };
  assert.deepEqual(await recoverTerminalSession(f.input, f.deps), {
    kind: "accepted",
    recoveryBinding: f.accepted,
  });
  assert.equal(f.state.calls.includes("collect"), false);
  assert.equal(f.state.calls.includes("reconcile"), false);
  assert.equal(f.state.calls.includes("start"), false);
});
