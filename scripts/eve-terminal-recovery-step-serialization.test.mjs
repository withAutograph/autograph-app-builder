import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { it } from "vitest";

const require = createRequire(import.meta.url);
const sdk = pathToFileURL(`${path.dirname(require.resolve("eve/package.json"))}/dist/src/`);
const runtimeUrl = new URL("compiled/@workflow/core/runtime.js", sdk);
const runtimeSource = await readFile(runtimeUrl, "utf-8");
// Eve bundles the real Workflow createUseStep implementation as Xo. Expose that
// compiled function for this fixture without changing its body or running a World.
// Relative imports retain the actual installed SDK modules when loaded as data:.
const exposedRuntime = runtimeSource.replaceAll(
  /from"(?<relative>\.[^"]+)"/gu,
  (_match, relative) => `from${JSON.stringify(new URL(relative, runtimeUrl).href)}`,
);
const exportedSource = `${exposedRuntime}\nexport { Xo as createUseStepForFixture };\n`;
const runtimeModuleUrl = `data:text/javascript;base64,${Buffer.from(exportedSource).toString("base64")}`;
const { createUseStepForFixture } = await import(runtimeModuleUrl);
const { dehydrateStepArguments, hydrateStepArguments } = await import(
  new URL("compiled/@workflow/core/serialization.js", sdk).href
);
const { bootTerminalRecoveryOwnerWithPorts } = await import(
  new URL("execution/session/terminal-recovery-boot.js", sdk).href
);
const { createDurableSessionState } = await import(
  new URL("execution/durable-session-store.js", sdk).href
);
const logicalSessionId = "logical-fixture";
const workflowRunId = "wrun-synthetic";
const checkpoint = {
  capabilities: { requestInput: true },
  serializedContext: {
    "eve.capabilities": { requestInput: true },
    "eve.sessionId": logicalSessionId,
  },
  sessionState: createDurableSessionState({
    session: {
      agent: { system: "Synthetic serialization fixture", tools: new Map() },
      compaction: {},
      continuationToken: "fixture-continuation",
      history: [],
      sessionId: logicalSessionId,
      state: { approval: "retained-fixture" },
    },
  }),
  sessionTimeoutMs: false,
  version: 9,
};
const descriptor = {
  logicalSessionId,
  operationId: "fixture-recovery",
  originalAuthoritySessionId: "fixture-source",
  parentCancellationRevision: 0,
  sourceAdapterGeneration: 1,
  sourceOwnerRunId: "wrun-fixture-source",
  sourcePublicSessionId: "fixture-source",
  version: 1,
};
const provenance = {
  checkpointVersion: 1,
  kind: "committed-turn-output",
  sourceEventId: "evnt_00000000000000000000000001",
  sourceSlot: 1,
  sourceStepId: "fixture-checkpoint-step",
};

const fixture = () => {
  const queue = new Map();
  const context = {
    eventsConsumer: {
      subscribe() {
        /* No event delivered: the real proxy remains suspended. */
      },
    },
    generateUlid: () => "synthetic-correlation",
    invocationsQueue: queue,
    promiseQueue: Promise.resolve(),
  };
  const validateCheckpoint = createUseStepForFixture(context)(
    "step//eve/execution/session/handoff-steps.js//validateTerminalRecoveryCheckpointStep",
  );
  const calls = [];
  const ports = {
    createHook() {
      calls.push("createHook");
      throw new Error("Validation must suspend before hooks.");
    },
    createSessionInbox() {
      calls.push("createSessionInbox");
      throw new Error("Validation must suspend before inbox effects.");
    },
    getWorkflowMetadata() {
      calls.push("getWorkflowMetadata");
      throw new Error("Validation must suspend first.");
    },
    getWritable() {
      calls.push("getWritable");
      throw new Error("Validation must suspend first.");
    },
    validateCheckpoint,
  };
  const queuedArguments = () => {
    assert.equal(queue.size, 1);
    const [step] = queue.values();
    assert.equal(step.stepName, validateCheckpoint.stepId);
    return { args: step.args, closureVars: step.closureVars, thisVal: step.thisVal };
  };
  return { calls, ports, queuedArguments };
};

it("reproduces the member-step receiver failure through the real compiled Workflow proxy", async () => {
  const f = fixture();
  const suspended = f.ports.validateCheckpoint({ checkpoint });
  assert.ok(suspended instanceof Promise);
  const input = f.queuedArguments();
  assert.equal(input.thisVal, f.ports);
  await assert.rejects(
    dehydrateStepArguments(input, workflowRunId, undefined),
    (error) => error.name === "SerializationError" && error.message.includes(".thisVal.createHook"),
  );
  assert.deepEqual(f.calls, []);
});

it("serializes the actual terminal boot validation step without its function-bearing ports receiver", async () => {
  const f = fixture();
  const suspended = bootTerminalRecoveryOwnerWithPorts(
    {
      activationToken: "fixture-activation",
      checkpoint,
      descriptor,
      kind: "terminal-recovery",
      ownerDeploymentId: "fixture-deployment",
      provenance,
    },
    f.ports,
  );
  assert.ok(suspended instanceof Promise);
  const input = f.queuedArguments();
  const encoded = await dehydrateStepArguments(input, workflowRunId, undefined);
  const decoded = await hydrateStepArguments(encoded, workflowRunId, undefined);
  assert.equal(input.thisVal, undefined);
  assert.equal(decoded.thisVal, undefined);
  assert.deepEqual(decoded.args, [{ checkpoint }]);
  assert.deepEqual(f.calls, []);
});
