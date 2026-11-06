/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument -- The installed Eve prepare path is an internal JavaScript module exercised through explicit synthetic ports. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { it } from "vitest";

const require = createRequire(import.meta.url);
const sdk = pathToFileURL(`${path.dirname(require.resolve("eve/package.json"))}/dist/src/`).href;
const { recoverTerminalSession } = await import(`${sdk}execution/session/terminal-recovery.js`);

const descriptor = {
  logicalSessionId: "prepare-private-logical-canary",
  operationId: "prepare-private-operation-canary",
  originalAuthoritySessionId: "prepare-private-authority-canary",
  parentCancellationRevision: 0,
  sourceAdapterGeneration: 1,
  sourceOwnerRunId: "prepare-private-physical-canary",
  sourcePublicSessionId: "prepare-private-source-canary",
  version: 1,
};
const auth = {
  authenticator: "fixture",
  issuer: "fixture-issuer",
  principalId: "private-principal-canary",
  principalType: "user",
};
const provenance = {
  checkpointVersion: 1,
  kind: "failed-turn-input",
  sourceEventId: "prepare-private-event-canary",
  sourceSlot: 0,
  sourceStepId: "prepare-private-step-canary",
};

const fixture = (failure) => {
  const fault = new Error(`private-${failure}-message-canary`);
  fault.code = "TRANSPORT";
  fault.status = 503;
  const checkpoint = {
    capabilities: { requestInput: true },
    serializedContext: { "eve.sessionId": descriptor.logicalSessionId },
    sessionState: { continuationToken: "", sessionId: descriptor.logicalSessionId },
    sessionTimeoutMs: false,
    version: 9,
  };
  const candidate = Object.freeze({ kind: "private-native-recovery-candidate", version: 1 });
  const payload = {
    binding: {
      logicalSessionId: descriptor.logicalSessionId,
      ownerRunId: descriptor.sourceOwnerRunId,
    },
    candidates: [
      {
        kind: provenance.kind,
        origin: {
          eventId: provenance.sourceEventId,
          slot: provenance.sourceSlot,
          stepId: provenance.sourceStepId,
        },
      },
    ],
  };
  let started = false;
  let holderClosed = false;
  let readyHook;
  const ports = {
    async authorize() {
      if (failure === "source_authorization") {
        throw fault;
      }
    },
    async commitReceipt(input) {
      if (failure === "receipt_commit") {
        throw fault;
      }
      if (failure === "success") {
        return input.recoveryBinding;
      }
      throw new Error("unexpected-commit");
    },
    async readReceipt() {
      if (failure === "receipt_read" || (failure === "post_holder_receipt_read" && holderClosed)) {
        throw fault;
      }
      return null;
    },
  };
  const deps = {
    async closeHolder(input) {
      await input.authorizeCurrent();
      if (failure === "holder_closure") {
        throw fault;
      }
      holderClosed = true;
    },
    async collect(input) {
      await input.authorizeOwner(input.binding);
      return { candidate, kind: "candidate" };
    },
    async getHook() {
      if (failure === "initial_ready_lookup" || (failure === "owner_readiness_lookup" && started)) {
        throw fault;
      }
      if (readyHook === undefined) {
        throw new Error("hook-not-found");
      }
      return readyHook;
    },
    isHookNotFound: (error) => error?.message === "hook-not-found",
    now: Date.now,
    readCandidate(handle) {
      assert.equal(handle, candidate);
      return payload;
    },
    async readEntry() {
      return { checkpoint, kind: "handoff" };
    },
    async reconcile() {
      return {
        checkpointCore: {
          serializedContext: checkpoint.serializedContext,
          sessionState: checkpoint.sessionState,
        },
        kind: "ready",
        provenance: { selectedOrigin: payload.candidates[0].origin },
      };
    },
    async start(input) {
      if (failure === "owner_start") {
        throw fault;
      }
      started = true;
      readyHook = {
        metadata: Promise.resolve({
          recoveryBinding: {
            ...descriptor,
            ownerRunId: "prepared-child-physical",
            provenance: input.provenance,
          },
        }),
        runId: "prepared-child-physical",
      };
    },
    wait() {
      throw new Error("unexpected-wait");
    },
  };
  return {
    deps,
    fault,
    ports,
    recover: async () => await recoverTerminalSession({ auth, descriptor, ports }, deps),
  };
};

const failureCases = [
  { failure: "source_authorization", stage: "source_authorization" },
  { failure: "receipt_read", stage: "receipt_read" },
  { failure: "initial_ready_lookup", stage: "initial_ready_lookup" },
  { failure: "holder_closure", stage: "holder_closure" },
  { failure: "post_holder_receipt_read", stage: "post_holder_receipt_read" },
  { failure: "owner_start", stage: "owner_start" },
  { failure: "owner_readiness_lookup", stage: "owner_readiness_lookup" },
  { failure: "receipt_commit", stage: "receipt_commit" },
];

for (const { failure, stage } of failureCases) {
  it(`reports ${stage} while preserving its original prepare failure and private data`, async () => {
    const f = fixture(failure);
    /** @type {string[]} */
    const reports = [];
    const previous = console.error;
    console.error = (...parts) => {
      reports.push(parts.join(" "));
    };
    try {
      await assert.rejects(f.recover(), (error) => error === f.fault);
    } finally {
      console.error = previous;
    }
    const report =
      reports.find((line) => line.startsWith("[eve:terminal-recovery-prepare] ")) ?? "";
    assert.equal(report.length > 0, true);
    const summary = JSON.parse(report.slice(report.indexOf("{")));
    assert.equal(summary.event, "eve.terminal_recovery_prepare_failed");
    assert.equal(summary.stage, stage);
    assert.equal(["other", "Error"].includes(summary.errorClass), true);
    assert.equal(summary.code, "TRANSPORT");
    assert.equal(summary.status, 503);
    assert.equal(
      Object.keys(summary).every((key) =>
        ["event", "stage", "errorClass", "code", "status"].includes(key),
      ),
      true,
    );
    const emitted = reports.join("\n");
    for (const privateValue of [
      f.fault.message,
      descriptor.operationId,
      descriptor.logicalSessionId,
      descriptor.sourceOwnerRunId,
      auth.principalId,
    ]) {
      assert.equal(emitted.includes(privateValue), false);
    }
  });
}

it("emits no prepare failure for an accepted recovery", async () => {
  const f = fixture("success");
  /** @type {string[]} */
  const reports = [];
  const previous = console.error;
  console.error = (...parts) => {
    reports.push(parts.join(" "));
  };
  try {
    const result = await f.recover();
    assert.equal(result.kind, "accepted");
  } finally {
    console.error = previous;
  }
  assert.equal(
    reports.some((line) => line.startsWith("[eve:terminal-recovery-prepare] ")),
    false,
  );
});
