/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument -- The installed Eve closure is an internal JavaScript module exercised through explicit synthetic ports. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { it } from "vitest";

const require = createRequire(import.meta.url);
const sdk = pathToFileURL(`${path.dirname(require.resolve("eve/package.json"))}/dist/src/`).href;
const { closeNoncanonicalRecoveryInboxHolder } = await import(
  `${sdk}execution/session/recovery-holder-closure.js`
);
const { recoverTerminalSession, terminalRecoveryActivationToken } = await import(
  `${sdk}execution/session/terminal-recovery.js`
);
const { sessionCommandHookToken, sessionInboxHookToken } = await import(
  `${sdk}execution/session-inbox/address.js`
);

let sequence = 0;
const fixture = () => {
  sequence += 1;
  const id = sequence;
  const descriptor = {
    version: 1,
    operationId: `current-operation-${id}`,
    sourcePublicSessionId: `source-public-${id}`,
    sourceOwnerRunId: `source-physical-${id}`,
    sourceAdapterGeneration: 1,
    logicalSessionId: `original-logical-${id}`,
    originalAuthoritySessionId: `original-public-${id}`,
    parentCancellationRevision: 0,
  };
  const holderDescriptor = {
    ...descriptor,
    operationId: `older-operation-${id}`,
    sourcePublicSessionId: `older-source-public-${id}`,
    sourceOwnerRunId: `older-source-physical-${id}`,
  };
  const auth = { authenticator: "fixture", principalId: `principal-${id}` };
  const holderOwnerRunId = `holder-physical-${id}`;
  const winnerOwnerRunId = `winner-physical-${id}`;
  const holderHookId = `hook-${id}`;
  const token = sessionInboxHookToken(sessionCommandHookToken(descriptor.logicalSessionId));
  const effects = [];
  const proofInputs = [];
  const reads = [];
  let currentError = null;
  let status = "running";
  const commandHook = {
    runId: holderOwnerRunId,
    hookId: holderHookId,
    specVersion: 1,
    metadata: Promise.resolve({ sessionId: descriptor.logicalSessionId }),
  };
  const hooksByToken = new Map([[token, commandHook]]);
  const hooksById = new Map([[holderHookId, commandHook]]);
  let entry = {
    kind: "terminal-recovery",
    descriptor: holderDescriptor,
    checkpoint: {
      serializedContext: { "eve.sessionId": descriptor.logicalSessionId },
      sessionState: { sessionId: descriptor.logicalSessionId, continuationToken: "" },
    },
  };
  let proof = { kind: "immutable-loser", winnerOwnerRunId };
  let onProof = () => Promise.resolve();
  let onCancel = () => Promise.resolve();
  let onDispose = (_request) => Promise.resolve();
  const input = {
    auth,
    descriptor,
    ports: {
      async authorizeRecoveryHolderClosure(request) {
        proofInputs.push(request);
        await onProof();
        return proof;
      },
    },
    authorizeCurrent() {
      if (currentError !== null) {
        throw new Error(currentError);
      }
      return Promise.resolve();
    },
  };
  const deps = {
    getHook(requestedToken) {
      reads.push({ kind: "token", requestedToken });
      const hook = hooksByToken.get(requestedToken);
      if (hook === undefined) {
        throw new Error("hook-not-found");
      }
      return Promise.resolve(hook);
    },
    getHookById(requestedHookId) {
      reads.push({ kind: "id", requestedHookId });
      const byId = hooksById.get(requestedHookId);
      if (byId === undefined) {
        throw new Error("hook-not-found");
      }
      return Promise.resolve(byId);
    },
    readRunEntry(runId) {
      reads.push({ kind: "entry", runId });
      assert.equal(runId, holderOwnerRunId);
      return Promise.resolve({ runId, status, entry });
    },
    readRun(runId) {
      reads.push({ kind: "run", runId });
      assert.equal(runId, holderOwnerRunId);
      return Promise.resolve({ runId, status });
    },
    async cancelRun(runId) {
      effects.push({ kind: "cancel", runId });
      assert.equal(runId, holderOwnerRunId);
      await onCancel();
      status = "cancelled";
    },
    async disposeHook(request) {
      effects.push({ kind: "dispose", ...request });
      if (hooksById.get(request.hookId)?.runId === request.ownerRunId) {
        hooksById.delete(request.hookId);
      }
      for (const [mappedToken, mappedHook] of hooksByToken) {
        if (mappedHook.hookId === request.hookId && mappedHook.runId === request.ownerRunId) {
          hooksByToken.delete(mappedToken);
        }
      }
      await onDispose(request);
    },
    isHookNotFound: (error) => error?.message === "hook-not-found",
  };
  return {
    auth,
    deps,
    descriptor,
    effects,
    holderDescriptor,
    holderHookId,
    holderOwnerRunId,
    input,
    proofInputs,
    reads,
    token,
    activationToken: terminalRecoveryActivationToken(auth, holderDescriptor),
    winnerOwnerRunId,
    close: async () => await closeNoncanonicalRecoveryInboxHolder(input, deps),
    setHook: (next, targetToken = token) => {
      if (next === undefined) {
        hooksByToken.delete(targetToken);
      } else {
        hooksByToken.set(targetToken, next);
      }
    },
    setById: (next, targetId = holderHookId) => {
      if (next === undefined) {
        hooksById.delete(targetId);
      } else {
        hooksById.set(targetId, next);
      }
    },
    addHook: (targetToken, next) => {
      hooksByToken.set(targetToken, next);
      hooksById.set(next.hookId, next);
    },
    setCheckpointAliases: (aliases, continuationToken = "") => {
      entry = {
        ...entry,
        checkpoint: {
          serializedContext: {
            "eve.sessionId": descriptor.logicalSessionId,
            "eve.continuationHookTokens": aliases,
          },
          sessionState: { sessionId: descriptor.logicalSessionId, continuationToken },
        },
      };
    },
    setEntry: (next) => {
      entry = next;
    },
    setStatus: (next) => {
      status = next;
    },
    setProof: (next) => {
      proof = next;
    },
    setOnProof: (effect) => {
      onProof = effect;
    },
    setOnCancel: (effect) => {
      onCancel = effect;
    },
    setOnDispose: (effect) => {
      onDispose = effect;
    },
    rejectCurrent: (reason) => {
      currentError = reason;
    },
  };
};

it("closes only a freshly proved immutable loser at the captured logical hook", async () => {
  const f = fixture();
  await f.close();
  assert.equal(
    f.proofInputs.some(
      (input) =>
        input.holderOwnerRunId === f.holderOwnerRunId && input.holderHookId === f.holderHookId,
    ),
    true,
  );
  assert.equal(
    f.effects.some((effect) => effect.kind === "cancel" && effect.runId === f.holderOwnerRunId),
    true,
  );
  assert.equal(
    f.effects.some(
      (effect) =>
        effect.kind === "dispose" &&
        effect.ownerRunId === f.holderOwnerRunId &&
        effect.hookId === f.holderHookId,
    ),
    true,
  );
  assert.equal(
    f.effects.every((effect) => effect.runId === undefined || effect.runId === f.holderOwnerRunId),
    true,
  );
});

it("closes the same loser's command and activation hooks with an empty continuation token", async () => {
  const f = fixture();
  const activationHookId = `activation-${f.holderHookId}`;
  f.addHook(f.activationToken, {
    runId: f.holderOwnerRunId,
    hookId: activationHookId,
    specVersion: 1,
    metadata: Promise.resolve({
      recoveryBinding: {
        ...f.holderDescriptor,
        ownerRunId: f.holderOwnerRunId,
        provenance: {
          kind: "failed-turn-input",
          sourceStepId: "step-fixture",
          sourceEventId: "event-fixture",
          sourceSlot: 0,
          checkpointVersion: 1,
        },
      },
    }),
  });
  await f.close();
  const disposedIds = new Set(
    f.effects.filter((effect) => effect.kind === "dispose").map((effect) => effect.hookId),
  );
  assert.equal(disposedIds.has(f.holderHookId), true);
  assert.equal(disposedIds.has(activationHookId), true);
  assert.equal(
    f.effects.every(
      (effect) => effect.ownerRunId === undefined || effect.ownerRunId === f.holderOwnerRunId,
    ),
    true,
  );
});

it("closes only same-holder continuation aliases and preserves a foreign alias", async () => {
  const f = fixture();
  const sameAliases = ["retained-alias-a", "retained-alias-b", "retained-current-token"];
  const foreignAlias = "retained-foreign-alias";
  const missingAlias = "retained-missing-alias";
  f.setCheckpointAliases([...sameAliases, foreignAlias, missingAlias], sameAliases[2]);
  const sameHookIds = [];
  for (const alias of sameAliases) {
    const hookId = `${alias}-${f.holderHookId}`;
    sameHookIds.push(hookId);
    f.addHook(sessionInboxHookToken(alias), {
      runId: f.holderOwnerRunId,
      hookId,
      specVersion: 1,
      metadata: Promise.resolve({ sessionId: f.descriptor.logicalSessionId }),
    });
  }
  const foreignHookId = `foreign-${f.holderHookId}`;
  f.addHook(sessionInboxHookToken(foreignAlias), {
    runId: "foreign-physical-owner",
    hookId: foreignHookId,
    metadata: Promise.resolve({ sessionId: f.descriptor.logicalSessionId }),
  });
  await f.close();
  const disposedIds = new Set(
    f.effects.filter((effect) => effect.kind === "dispose").map((effect) => effect.hookId),
  );
  assert.equal(disposedIds.has(f.holderHookId), true);
  assert.equal(
    sameHookIds.every((hookId) => disposedIds.has(hookId)),
    true,
  );
  assert.equal(disposedIds.has(foreignHookId), false);
  const foreignCurrent = await f.deps.getHook(sessionInboxHookToken(foreignAlias));
  assert.equal(foreignCurrent.runId, "foreign-physical-owner");
  assert.equal(
    f.reads.some(
      (read) =>
        read.kind === "token" && read.requestedToken === sessionInboxHookToken(missingAlias),
    ),
    true,
  );
});

it("leaves an absent logical hook untouched", async () => {
  const f = fixture();
  f.setHook(undefined);
  await f.close();
  assert.deepEqual(f.effects, []);
  assert.deepEqual(f.proofInputs, []);
});

it("refuses an unproved or canonical holder", async () => {
  await Promise.all(
    ["reserved", "submission-unknown", "no-receipt", "unproved-response", "canonical-holder"].map(
      async (reason) => {
        const f = fixture();
        if (reason === "canonical-holder") {
          f.setProof({ kind: "immutable-loser", winnerOwnerRunId: f.holderOwnerRunId });
        } else if (reason === "unproved-response") {
          f.setProof(undefined);
        } else {
          f.setOnProof(() => {
            throw new Error(reason);
          });
        }
        await assert.rejects(f.close());
        assert.deepEqual(f.effects, []);
      },
    ),
  );
});

it("never reads a foreign logical holder entry or closes it", async () => {
  const f = fixture();
  f.setHook({
    runId: f.holderOwnerRunId,
    hookId: f.holderHookId,
    metadata: Promise.resolve({ sessionId: "foreign-logical" }),
  });
  await assert.rejects(f.close());
  assert.equal(
    f.reads.some((read) => read.kind === "entry"),
    false,
  );
  assert.deepEqual(f.proofInputs, []);
  assert.deepEqual(f.effects, []);
});

it("requires the actual retained terminal-recovery lineage before closure", async () => {
  const initial = fixture();
  initial.setEntry({
    kind: "initial",
    serializedContext: { "eve.sessionId": initial.descriptor.logicalSessionId },
  });
  await assert.rejects(initial.close());
  assert.deepEqual(initial.proofInputs, []);
  assert.deepEqual(initial.effects, []);

  const foreign = fixture();
  foreign.setEntry({
    kind: "terminal-recovery",
    descriptor: { ...foreign.holderDescriptor, originalAuthoritySessionId: "foreign-authority" },
    checkpoint: {
      serializedContext: { "eve.sessionId": foreign.descriptor.logicalSessionId },
      sessionState: { sessionId: foreign.descriptor.logicalSessionId },
    },
  });
  await assert.rejects(foreign.close());
  assert.deepEqual(foreign.proofInputs, []);
  assert.deepEqual(foreign.effects, []);
});

it("rechecks current authority and Stop state before effects", async () => {
  await Promise.all(
    ["source-stop", "winner-changed", "receipt-changed"].map(async (reason) => {
      const f = fixture();
      f.setOnProof(() => {
        f.rejectCurrent(reason);
      });
      await assert.rejects(f.close(), new RegExp(reason, "u"));
      assert.deepEqual(f.effects, []);
    }),
  );
});

it("refuses a changed hook ID or owner without targeting its new holder", async () => {
  await Promise.all(
    ["id", "owner"].map(async (change) => {
      const f = fixture();
      f.setOnProof(() => {
        if (change === "id") {
          f.setById({ runId: f.holderOwnerRunId, hookId: "replacement-hook" });
        } else {
          f.setHook({
            runId: "replacement-owner",
            hookId: "replacement-hook",
            metadata: Promise.resolve({ sessionId: f.descriptor.logicalSessionId }),
          });
        }
      });
      await assert.rejects(f.close());
      assert.equal(
        f.effects.some(
          (effect) => effect.runId === "replacement-owner" || effect.hookId === "replacement-hook",
        ),
        false,
      );
    }),
  );
});

it("converges an already terminal loser without cancelling it", async () => {
  const f = fixture();
  f.setStatus("completed");
  await f.close();
  assert.equal(
    f.effects.some((effect) => effect.kind === "cancel"),
    false,
  );
  assert.equal(
    f.effects.some((effect) => effect.kind === "dispose" && effect.hookId === f.holderHookId),
    true,
  );
});

it("requires fresh Stop authority again before releasing an exactly cancelled loser", async () => {
  const f = fixture();
  f.setOnCancel(() => {
    f.rejectCurrent("stop-after-cancel");
  });
  await assert.rejects(f.close(), /stop-after-cancel/u);
  assert.equal(
    f.effects.some((effect) => effect.kind === "cancel" && effect.runId === f.holderOwnerRunId),
    true,
  );
  assert.equal(
    f.effects.some((effect) => effect.kind === "dispose"),
    false,
  );
});

it("rechecks current authority before each captured alias release", async () => {
  const f = fixture();
  const alias = "still-owned-alias";
  const aliasToken = sessionInboxHookToken(alias);
  const aliasHookId = `alias-${f.holderHookId}`;
  f.setCheckpointAliases([alias]);
  f.addHook(aliasToken, {
    runId: f.holderOwnerRunId,
    hookId: aliasHookId,
    metadata: Promise.resolve({ sessionId: f.descriptor.logicalSessionId }),
  });
  f.setStatus("completed");
  f.setOnDispose((request) => {
    if (request.hookId === f.holderHookId) {
      f.rejectCurrent("stop-between-releases");
    }
  });
  await assert.rejects(f.close(), /stop-between-releases/u);
  assert.equal(
    f.effects.some((effect) => effect.kind === "dispose" && effect.hookId === aliasHookId),
    false,
  );
  const retainedAlias = await f.deps.getHook(aliasToken);
  assert.equal(retainedAlias.runId, f.holderOwnerRunId);
});

it("preserves a replacement hook after the exact loser is cancelled", async () => {
  const f = fixture();
  f.setOnCancel(() => {
    f.setHook({
      runId: "replacement-owner",
      hookId: "replacement-hook",
      metadata: Promise.resolve({ sessionId: f.descriptor.logicalSessionId }),
    });
  });
  await f.close();
  assert.equal(
    f.effects.some((effect) => effect.kind === "cancel" && effect.runId === f.holderOwnerRunId),
    true,
  );
  assert.equal(
    f.effects.some(
      (effect) => effect.runId === "replacement-owner" || effect.hookId === "replacement-hook",
    ),
    false,
  );
});

it("does not retarget a continuation alias reassigned during cancellation", async () => {
  const f = fixture();
  const alias = "reassigned-continuation";
  const aliasToken = sessionInboxHookToken(alias);
  const oldAliasHookId = `old-alias-${f.holderHookId}`;
  const newAliasHookId = `new-alias-${f.holderHookId}`;
  f.setCheckpointAliases([alias]);
  f.addHook(aliasToken, {
    runId: f.holderOwnerRunId,
    hookId: oldAliasHookId,
    specVersion: 1,
    metadata: Promise.resolve({ sessionId: f.descriptor.logicalSessionId }),
  });
  f.setOnCancel(() => {
    f.setHook(
      {
        runId: "replacement-physical-owner",
        hookId: newAliasHookId,
        metadata: Promise.resolve({ sessionId: f.descriptor.logicalSessionId }),
      },
      aliasToken,
    );
  });
  await f.close();
  assert.equal(
    f.effects.some((effect) => effect.kind === "dispose" && effect.hookId === newAliasHookId),
    false,
  );
  const reassignedAlias = await f.deps.getHook(aliasToken);
  assert.equal(reassignedAlias.runId, "replacement-physical-owner");
});

it("adopts an already committed receipt or a concurrent winner without entering closure or collection", async () => {
  await Promise.all(
    ["already-committed", "committed-during-closure"].map(async (phase) => {
      const f = fixture();
      const binding = {
        ...f.descriptor,
        ownerRunId: f.winnerOwnerRunId,
        provenance: {
          kind: "failed-turn-input",
          sourceStepId: "step-fixture",
          sourceEventId: "event-fixture",
          sourceSlot: 0,
          checkpointVersion: 1,
        },
      };
      let receipt = phase === "already-committed" ? binding : null;
      const invoked = [];
      const ports = {
        authorize: () => Promise.resolve(),
        readReceipt: () => Promise.resolve(receipt),
        commitReceipt: () => {
          throw new Error("unexpected-commit");
        },
      };
      const dependencies = {
        getHook: () => {
          throw new Error("hook-not-found");
        },
        isHookNotFound: (error) => error?.message === "hook-not-found",
        async closeHolder(input) {
          invoked.push("closure");
          await input.authorizeCurrent();
          receipt = binding;
        },
        collect: () => {
          throw new Error("unexpected-collection");
        },
      };
      const result = await recoverTerminalSession(
        { auth: f.auth, descriptor: f.descriptor, ports },
        dependencies,
      );
      assert.equal(result.kind, "accepted");
      assert.equal(result.recoveryBinding?.ownerRunId, f.winnerOwnerRunId);
      assert.equal(invoked.includes("closure"), phase === "committed-during-closure");
    }),
  );
});

it("reports a fixed failure stage without private IDs or hostile exception text", async () => {
  const f = fixture();
  const canary = `private-holder-error-${f.holderOwnerRunId}`;
  const reports = [];
  const previous = console.error;
  console.error = (...parts) => {
    reports.push(parts.join(" "));
  };
  try {
    f.setOnProof(() => {
      throw new Error(canary);
    });
    await assert.rejects(f.close(), new RegExp(canary, "u"));
  } finally {
    console.error = previous;
  }
  const emitted = reports.join("\n");
  assert.equal(emitted.includes("eve.terminal_recovery_holder_closure_failed"), true);
  assert.equal(emitted.includes('"stage":"authorize"'), true);
  for (const privateValue of [canary, f.token, f.descriptor.logicalSessionId, f.holderOwnerRunId]) {
    assert.equal(emitted.includes(privateValue), false);
  }
  assert.deepEqual(f.effects, []);
});
