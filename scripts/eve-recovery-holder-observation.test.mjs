/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument -- The installed Eve diagnostic is an internal JavaScript module exercised through explicit synthetic ports. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { it } from "vitest";

const require = createRequire(import.meta.url);
const sdk = pathToFileURL(`${path.dirname(require.resolve("eve/package.json"))}/dist/src/`).href;
const { observeRecoveryInboxHolder } = await import(
  `${sdk}execution/session/recovery-holder-observation.js`
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
    operationId: `op-current-${id}`,
    sourcePublicSessionId: `ses-source-${id}`,
    sourceOwnerRunId: `physical-source-${id}`,
    sourceAdapterGeneration: 1,
    logicalSessionId: `logical-${id}`,
    originalAuthoritySessionId: `ses-authority-${id}`,
    parentCancellationRevision: 0,
  };
  const holderDescriptor = {
    ...descriptor,
    operationId: `op-holder-${id}`,
    sourcePublicSessionId: `ses-older-source-${id}`,
    sourceOwnerRunId: `physical-older-source-${id}`,
  };
  const receipt = {
    ...descriptor,
    ownerRunId: `physical-receipt-${id}`,
    provenance: {
      kind: "failed-turn-input",
      sourceStepId: "step-fixture",
      sourceEventId: "event-fixture",
      sourceSlot: 0,
      checkpointVersion: 1,
    },
  };
  const holderOwnerRunId = `physical-holder-${id}`;
  const auth = { authenticator: "fixture", principalId: "fixture-owner" };
  const token = sessionInboxHookToken(sessionCommandHookToken(descriptor.logicalSessionId));
  const summaries = [];
  const seen = { tokens: [], reads: [], bindings: [] };
  let currentRejection = null;
  let hook = {
    runId: holderOwnerRunId,
    metadata: Promise.resolve({ sessionId: descriptor.logicalSessionId }),
  };
  let entry = {
    kind: "terminal-recovery",
    descriptor: holderDescriptor,
    checkpoint: {
      serializedContext: { "eve.sessionId": descriptor.logicalSessionId },
      sessionState: { sessionId: descriptor.logicalSessionId },
    },
  };
  let onRead = () => Promise.resolve();
  let onBinding = () => Promise.resolve();
  const facts = {
    operationFound: true,
    descriptorMatches: true,
    sourceBound: true,
    operationSucceeded: false,
    operationReserved: true,
    operationSubmissionUnknown: false,
    operationRejected: false,
    sourceCancelled: false,
    sourceCancellationMatches: true,
    receiptPresent: false,
    receiptOwnerMatches: false,
    committedChildMatches: false,
  };
  const ports = {
    async observeRecoveryHolderBinding(input) {
      seen.bindings.push(input);
      await onBinding();
      return facts;
    },
  };
  const deps = {
    getHook(requestedToken) {
      seen.tokens.push(requestedToken);
      assert.equal(requestedToken, token);
      if (hook === undefined) {
        throw new Error("hook-not-found");
      }
      return Promise.resolve(hook);
    },
    isHookNotFound: (error) => error?.message === "hook-not-found",
    async readRunEntry(runId) {
      seen.reads.push(runId);
      assert.equal(runId, holderOwnerRunId);
      await onRead();
      return { runId, status: "failed", entry };
    },
    record(summary) {
      summaries.push(summary);
    },
    now: () => 1,
  };
  const input = {
    auth,
    descriptor,
    receipt,
    ports,
    authorizeCurrent() {
      if (currentRejection !== null) {
        throw new Error(`current-${currentRejection}-canary`);
      }
      return Promise.resolve();
    },
  };
  return {
    auth,
    deps,
    descriptor,
    facts,
    holderDescriptor,
    holderOwnerRunId,
    input,
    receipt,
    seen,
    summaries,
    token,
    observe: async () => await observeRecoveryInboxHolder(input, deps),
    setEntry: (next) => {
      entry = next;
    },
    setHook: (next) => {
      hook = next;
    },
    setOnRead: (effect) => {
      onRead = effect;
    },
    setOnBinding: (effect) => {
      onBinding = effect;
    },
    rejectCurrent: (reason) => {
      currentRejection = reason;
    },
  };
};

it("observes a real occupied logical inbox held by a distinct physical owner without effects", async () => {
  const f = fixture();
  await f.observe();
  assert.equal(
    f.seen.tokens.every(
      (token) => token === `eve:inbox:v1:eve:session:${f.descriptor.logicalSessionId}:inbox`,
    ),
    true,
  );
  assert.equal(f.seen.reads.includes(f.holderOwnerRunId), true);
  assert.equal(
    f.seen.reads.every((runId) => runId === f.holderOwnerRunId),
    true,
  );
  assert.equal(
    f.seen.bindings.some((binding) =>
      isDeepStrictEqual(binding, {
        auth: f.auth,
        descriptor: f.descriptor,
        holderOwnerRunId: f.holderOwnerRunId,
        holderDescriptor: f.holderDescriptor,
      }),
    ),
    true,
  );
  assert.equal(
    f.seen.bindings.every((binding) => binding.holderOwnerRunId === f.holderOwnerRunId),
    true,
  );
  const summary = f.summaries[0];
  assert.equal(summary.event, "eve.terminal_recovery_inbox_holder");
  assert.equal(summary.outcome, "observed");
  assert.equal(summary.entryKind, "terminal-recovery");
  assert.equal(summary.nativeStatus, "failed");
  assert.equal(summary.holderIsLogicalOwner, false);
  assert.equal(summary.holderIsSourceOwner, false);
  assert.equal(summary.holderIsReceiptOwner, false);
  assert.equal(summary.descriptorMatchesCurrent, false);
  assert.deepEqual(summary.canonicalFacts, f.facts);
  const emitted = JSON.stringify(f.summaries);
  for (const secret of [
    f.token,
    f.descriptor.logicalSessionId,
    f.holderOwnerRunId,
    f.holderDescriptor.operationId,
  ]) {
    assert.equal(emitted.includes(secret), false);
  }
});

it("reports a matching committed holder and a missing canonical receipt distinctly", async () => {
  const committed = fixture();
  committed.input.receipt = { ...committed.receipt, ownerRunId: committed.holderOwnerRunId };
  committed.setEntry({
    kind: "terminal-recovery",
    descriptor: committed.descriptor,
    checkpoint: {
      serializedContext: { "eve.sessionId": committed.descriptor.logicalSessionId },
      sessionState: { sessionId: committed.descriptor.logicalSessionId },
    },
  });
  committed.facts.operationReserved = false;
  committed.facts.operationSucceeded = true;
  committed.facts.receiptPresent = true;
  committed.facts.receiptOwnerMatches = true;
  committed.facts.committedChildMatches = true;
  await committed.observe();
  assert.equal(committed.summaries[0].holderIsReceiptOwner, true);
  assert.equal(committed.summaries[0].descriptorMatchesCurrent, true);
  assert.equal(committed.summaries[0].canonicalFacts.committedChildMatches, true);

  const uncommitted = fixture();
  uncommitted.input.receipt = null;
  await uncommitted.observe();
  assert.equal(uncommitted.summaries[0].receiptOwnerHash, null);
  assert.equal(uncommitted.summaries[0].holderIsReceiptOwner, null);
  assert.equal(uncommitted.summaries[0].canonicalFacts.operationReserved, true);
});

it("does not hydrate a holder whose hook metadata lacks the exact logical session", async () => {
  await Promise.all(
    [{}, { sessionId: "foreign-logical" }].map(async (metadata) => {
      const f = fixture();
      f.setHook({ runId: f.holderOwnerRunId, metadata: Promise.resolve(metadata) });
      await f.observe();
      assert.deepEqual(f.seen.reads, []);
      assert.deepEqual(f.seen.bindings, []);
      assert.equal(f.summaries[0]?.hookLogicalIdentityMatches, false);
    }),
  );
});

it("reports a nonrecovery holder without asking the app to adopt its entry", async () => {
  const f = fixture();
  f.setEntry({
    kind: "initial",
    serializedContext: { "eve.sessionId": f.descriptor.logicalSessionId },
  });
  await f.observe();
  assert.equal(f.summaries[0].entryKind, "initial");
  assert.equal(f.summaries[0].recoveryDescriptorPresent, false);
  assert.deepEqual(f.seen.bindings, []);
});

it("suppresses stale facts when descriptor, receipt, or Stop state changes during private inspection", async () => {
  await Promise.all(
    ["descriptor", "receipt", "stop"].flatMap((reason) =>
      ["read", "binding"].map(async (phase) => {
        const f = fixture();
        const revoke = () => {
          f.rejectCurrent(reason);
        };
        if (phase === "read") {
          f.setOnRead(revoke);
        } else {
          f.setOnBinding(revoke);
        }
        await assert.rejects(f.observe(), new RegExp(`current-${reason}-canary`, "u"));
        assert.deepEqual(f.summaries, []);
      }),
    ),
  );
});

it("suppresses stale facts when the logical inbox changes owner during inspection", async () => {
  const f = fixture();
  f.setOnRead(() => {
    f.setHook({
      runId: "new-physical-owner",
      metadata: Promise.resolve({ sessionId: f.descriptor.logicalSessionId }),
    });
  });
  await assert.rejects(f.observe(), /owner changed/u);
  assert.deepEqual(f.summaries, []);
});

it("a missing holder stays read only and cannot emit stale absence after a new claim", async () => {
  const absent = fixture();
  absent.setHook(undefined);
  await absent.observe();
  assert.deepEqual(absent.seen.reads, []);
  assert.equal(absent.summaries[0]?.outcome, "absent");

  const changed = fixture();
  let lookups = 0;
  changed.deps.getHook = () => {
    lookups += 1;
    if (lookups === 1) {
      throw new Error("hook-not-found");
    }
    return Promise.resolve({
      runId: changed.holderOwnerRunId,
      metadata: Promise.resolve({ sessionId: changed.descriptor.logicalSessionId }),
    });
  };
  await assert.rejects(changed.observe(), /owner changed/u);
  assert.deepEqual(changed.summaries, []);
});

it("contains hostile private failures and emits only fixed diagnostic facts", async () => {
  const canary = "private-holder-error-and-token-canary";
  const f = fixture();
  f.deps.readRunEntry = () => {
    throw new Error(canary);
  };
  await f.observe();
  assert.equal(f.summaries[0]?.outcome, "unavailable");
  assert.equal(JSON.stringify(f.summaries).includes(canary), false);
  const callback = fixture();
  callback.setOnBinding(() => {
    throw new Error(canary);
  });
  await callback.observe();
  assert.equal(callback.summaries[0]?.canonicalFacts.operationFound, null);
  assert.equal(JSON.stringify(callback.summaries).includes(canary), false);
});
