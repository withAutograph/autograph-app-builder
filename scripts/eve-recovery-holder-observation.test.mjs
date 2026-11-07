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

const HOOK_NOT_FOUND = "hook-not-found";
const TERMINAL_RECOVERY = "terminal-recovery";

let sequence = 0;
const fixture = () => {
  sequence += 1;
  const id = sequence;
  const descriptor = {
    logicalSessionId: `logical-${id}`,
    operationId: `op-current-${id}`,
    originalAuthoritySessionId: `ses-authority-${id}`,
    parentCancellationRevision: 0,
    sourceAdapterGeneration: 1,
    sourceOwnerRunId: `physical-source-${id}`,
    sourcePublicSessionId: `ses-source-${id}`,
    version: 1,
  };
  const holderDescriptor = {
    ...descriptor,
    operationId: `op-holder-${id}`,
    sourceOwnerRunId: `physical-older-source-${id}`,
    sourcePublicSessionId: `ses-older-source-${id}`,
  };
  const receipt = {
    ...descriptor,
    ownerRunId: `physical-receipt-${id}`,
    provenance: {
      checkpointVersion: 1,
      kind: "failed-turn-input",
      sourceEventId: "event-fixture",
      sourceSlot: 0,
      sourceStepId: "step-fixture",
    },
  };
  const holderOwnerRunId = `physical-holder-${id}`;
  const auth = { authenticator: "fixture", principalId: "fixture-owner" };
  const token = sessionInboxHookToken(sessionCommandHookToken(descriptor.logicalSessionId));
  const summaries = [];
  const seen = { bindings: [], reads: [], tokens: [] };
  let currentRejection = null;
  let hook = {
    metadata: Promise.resolve({ sessionId: descriptor.logicalSessionId }),
    runId: holderOwnerRunId,
  };
  let entry = {
    checkpoint: {
      serializedContext: { "eve.sessionId": descriptor.logicalSessionId },
      sessionState: { sessionId: descriptor.logicalSessionId },
    },
    descriptor: holderDescriptor,
    kind: TERMINAL_RECOVERY,
  };
  let onRead = async () => {
    // No read intervention unless a test installs one.
  };
  let onBinding = async () => {
    // No binding intervention unless a test installs one.
  };
  const facts = {
    committedChildMatches: false,
    descriptorMatches: true,
    operationFound: true,
    operationRejected: false,
    operationReserved: true,
    operationSubmissionUnknown: false,
    operationSucceeded: false,
    receiptOwnerMatches: false,
    receiptPresent: false,
    sourceBound: true,
    sourceCancellationMatches: true,
    sourceCancelled: false,
  };
  const ports = {
    async observeRecoveryHolderBinding(input) {
      seen.bindings.push(input);
      await onBinding();
      return facts;
    },
  };
  const deps = {
    async getHook(requestedToken) {
      seen.tokens.push(requestedToken);
      assert.equal(requestedToken, token);
      if (hook === undefined) {
        throw new Error(HOOK_NOT_FOUND);
      }
      return hook;
    },
    isHookNotFound: (error) => error?.message === HOOK_NOT_FOUND,
    now: () => 1,
    async readRunEntry(runId) {
      seen.reads.push(runId);
      assert.equal(runId, holderOwnerRunId);
      await onRead();
      return { entry, runId, status: "failed" };
    },
    record(summary) {
      summaries.push(summary);
    },
  };
  const input = {
    auth,
    async authorizeCurrent() {
      if (currentRejection !== null) {
        throw new Error(`current-${currentRejection}-canary`);
      }
    },
    descriptor,
    ports,
    receipt,
  };
  return {
    auth,
    deps,
    descriptor,
    facts,
    holderDescriptor,
    holderOwnerRunId,
    input,
    observe: async () => await observeRecoveryInboxHolder(input, deps),
    receipt,
    rejectCurrent: (reason) => {
      currentRejection = reason;
    },
    seen,
    setEntry: (next) => {
      entry = next;
    },
    setHook: (next) => {
      hook = next;
    },
    setOnBinding: (effect) => {
      onBinding = effect;
    },
    setOnRead: (effect) => {
      onRead = effect;
    },
    summaries,
    token,
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
        holderDescriptor: f.holderDescriptor,
        holderOwnerRunId: f.holderOwnerRunId,
      }),
    ),
    true,
  );
  assert.equal(
    f.seen.bindings.every((binding) => binding.holderOwnerRunId === f.holderOwnerRunId),
    true,
  );
  const [summary] = f.summaries;
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
    checkpoint: {
      serializedContext: { "eve.sessionId": committed.descriptor.logicalSessionId },
      sessionState: { sessionId: committed.descriptor.logicalSessionId },
    },
    descriptor: committed.descriptor,
    kind: TERMINAL_RECOVERY,
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
      f.setHook({ metadata: Promise.resolve(metadata), runId: f.holderOwnerRunId });
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
      metadata: Promise.resolve({ sessionId: f.descriptor.logicalSessionId }),
      runId: "new-physical-owner",
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
  changed.deps.getHook = async () => {
    lookups += 1;
    if (lookups === 1) {
      throw new Error(HOOK_NOT_FOUND);
    }
    return {
      metadata: Promise.resolve({ sessionId: changed.descriptor.logicalSessionId }),
      runId: changed.holderOwnerRunId,
    };
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
