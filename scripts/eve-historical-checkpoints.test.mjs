// Controlled SDK ports are asynchronous and carry intentionally opaque fixture values.
/* eslint-disable require-await, @typescript-eslint/no-unsafe-return, promise/prefer-await-to-callbacks */
/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-argument -- This exercises a private installed SDK module against a controlled World. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { it } from "vitest";

const require = createRequire(import.meta.url);
const sdk = process.env.EVE_PATCH_EDIT_DIR ?? path.dirname(require.resolve("eve/package.json"));
const { createHistoricalCheckpointVisitor } = await import(
  pathToFileURL(path.join(sdk, "dist/src/execution/session/historical-checkpoints.js")).href
);
const eventId = (slot) => `evnt_${String(slot).padStart(26, "0")}`;
const logical = "logical-session";
const key = "app.workflow";
const paired = (phase, extra = {}) => ({
  action: "park",
  serializedContext: { "eve.sessionId": logical, [key]: { phase, ...extra } },
  sessionState: { sessionId: logical, snapshot: { session: { sessionId: logical } } },
});
const event = (runId, slot, stepId, eventType = "step_completed", name = "turnStep") => ({
  runId,
  eventId: eventId(slot),
  correlationId: stepId,
  eventType,
  eventData: { stepName: name },
});
const step = (runId, stepId, output, input) => ({
  runId,
  stepId,
  stepName: "turnStep",
  status: "completed",
  output,
  ...(input === undefined ? {} : { input: { args: [input] } }),
});

const fixture = () => {
  const runId = "prior-owner";
  const events = [event(runId, 1, "review"), event(runId, 2, "cutoff"), event(runId, 3, "later")];
  const steps = new Map([
    ["review", step(runId, "review", paired("reviewed", { digest: "original" }))],
    ["cutoff", step(runId, "cutoff", paired("validated"))],
    ["later", step(runId, "later", paired("reviewed", { digest: "after-cutoff" }))],
  ]);
  let revoked = false;
  let onList;
  const reads = [];
  const world = {
    runs: {
      get: async (id) => {
        reads.push(["run", id]);
        return { runId: id, status: "completed" };
      },
    },
    events: {
      get: async (id, eid) => {
        reads.push(["event", id]);
        const found = events.find((entry) => entry.runId === id && entry.eventId === eid);
        if (found === undefined) {
          throw new Error("missing event");
        }
        return found;
      },
      list: async ({ runId: id, pagination }) => {
        reads.push(["page", id]);
        onList?.();
        const items = events
          .filter((entry) => entry.runId === id)
          .toSorted((a, b) =>
            pagination.sortOrder === "desc"
              ? b.eventId.localeCompare(a.eventId)
              : a.eventId.localeCompare(b.eventId),
          );
        const offset = Number(pagination.cursor ?? 0);
        const data = items.slice(offset, offset + 1);
        return { data, hasMore: offset + 1 < items.length, cursor: String(offset + 1) };
      },
      listByCorrelationId: async ({ runId: id, correlationId, pagination }) => {
        reads.push(["correlation", id]);
        const items = events
          .filter((entry) => entry.runId === id && entry.correlationId === correlationId)
          .toSorted((a, b) => a.eventId.localeCompare(b.eventId));
        const offset = Number(pagination.cursor ?? 0);
        const data = items.slice(offset, offset + 1);
        return { data, hasMore: offset + 1 < items.length, cursor: String(offset + 1) };
      },
    },
    steps: {
      get: async (id, stepId) => {
        reads.push(["step", id]);
        const value = steps.get(stepId);
        if (value === undefined || value.runId !== id) {
          throw new Error("missing step");
        }
        return value;
      },
    },
  };
  const authorizeRead = async () => {
    if (revoked) {
      throw new Error("owner revoked");
    }
  };
  const deps = {
    getWorld: async () => world,
    resolveRunEncryptionKey: async () => {
      // Fixture data is not encrypted.
    },
    hydrateStepReturnValue: async (value) => value,
    hydrateStepArguments: async (value) => value,
    readDurableSession: (value) => value.snapshot.session,
    requireEventSlot: (id) => Number(id.slice(5)),
    now: () => 0,
    guardWorld: (value) => value,
    guardedDependencies: () => {
      throw new Error("unexpected handoff");
    },
  };
  const cutoff = {
    kind: "committed-turn-output",
    checkpointOwnerRunId: runId,
    sourceEventId: eventId(2),
    sourceStepId: "cutoff",
    sourceSlot: 2,
    checkpointVersion: 1,
  };
  const options = {
    descriptor: { logicalSessionId: logical },
    payload: { handoffChain: [] },
    contextKey: key,
    authorizeCurrent: authorizeRead,
    visitPredecessors: async (visit) => {
      await visit({ ownerRunId: runId, logicalSessionId: logical, cutoff, authorizeRead });
    },
  };
  return {
    runId,
    events,
    steps,
    options,
    deps,
    cutoff,
    reads,
    revoke: () => {
      revoked = true;
    },
    onList: (callback) => {
      onList = callback;
    },
  };
};
const run = async (f) => {
  const values = [];
  await createHistoricalCheckpointVisitor(f.deps)({
    ...f.options,
    visit: async (item) => {
      values.push(item);
      return item.value?.phase === "reviewed" ? "stop" : "continue";
    },
  });
  return values;
};

it("finds only the latest review before the exact committed cutoff", async () => {
  const f = fixture();
  const values = await run(f);
  assert.deepEqual(
    values.map((item) => item.value.phase),
    ["validated", "reviewed"],
  );
  assert.equal(values.at(-1).value.digest, "original");
  assert.equal(values.at(-1).origin.slot, 1);
});

it("rejects a foreign logical session before projecting its checkpoint", async () => {
  const f = fixture();
  f.steps.get("cutoff").output.sessionState.snapshot.session.sessionId = "foreign";
  await assert.rejects(run(f), /logical identity differs/u);
});

it("searches a verified native handoff parent before older public predecessors", async () => {
  const f = fixture();
  f.events[2] = event(f.runId, 3, "handoff", "step_started", "startSessionOwnerStep");
  f.options.payload.handoffChain = [
    { parentRunId: f.runId, ownerRunId: "current-owner", startStepId: "handoff", events: f.events },
  ];
  f.options.visitPredecessors = async () => {
    throw new Error("older predecessor should not be scanned");
  };
  const values = await run(f);
  assert.equal(values.at(-1).value.digest, "original");
});

it("delivers all equal-slot reviewed projections before honoring stop", async () => {
  const f = fixture();
  f.steps.set(
    "cutoff",
    step(
      f.runId,
      "cutoff",
      { ...paired("reviewed", { digest: "output" }), action: "done" },
      paired("reviewed", { digest: "input" }),
    ),
  );
  const values = await run(f);
  assert.deepEqual(
    values.map((item) => [item.origin.slot, item.value.digest]),
    [
      [2, "output"],
      [2, "input"],
    ],
  );
});

it("rejects a tampered cutoff event before emitting review values", async () => {
  const f = fixture();
  f.cutoff.sourceStepId = "foreign-step";
  await assert.rejects(run(f), /cutoff identity differs/u);
});

it("rechecks owner authorization after a World page returns", async () => {
  const f = fixture();
  f.onList(() => {
    f.revoke();
  });
  await assert.rejects(run(f), /owner revoked/u);
});

it("refuses an interrupted page before claiming no review", async () => {
  const f = fixture();
  let calls = 0;
  f.onList(() => {
    calls += 1;
    if (calls === 2) {
      throw new Error("page unavailable");
    }
  });
  await assert.rejects(run(f), /page unavailable/u);
});

it("rechecks owner authorization after checkpoint hydration", async () => {
  const f = fixture();
  f.deps.hydrateStepReturnValue = async (value) => {
    f.revoke();
    return value;
  };
  await assert.rejects(run(f), /owner revoked/u);
});

it("refuses an unreadable newer completed checkpoint instead of falling back", async () => {
  const f = fixture();
  f.steps.get("cutoff").output = { action: "park" };
  await assert.rejects(run(f), /paired checkpoint is incomplete/u);
});

it("refuses a required terminal input that is unavailable", async () => {
  const f = fixture();
  f.steps.set("cutoff", step(f.runId, "cutoff", { action: "done" }));
  f.cutoff.kind = "completed-terminal-turn-input";
  await assert.rejects(run(f), /input cutoff unavailable/u);
});

it("refuses a newer terminal input missing after the valid cutoff", async () => {
  const f = fixture();
  f.steps.set("review", step(f.runId, "review", { action: "done" }));
  await assert.rejects(run(f), /checkpoint input unavailable/u);
});

it("visits an older native handoff parent only after the receipt-bound run has no review", async () => {
  const f = fixture();
  f.steps.set("review", step(f.runId, "review", paired("validated")));
  const parent = "handoff-parent";
  const older = event(parent, 1, "parent-review");
  const start = event(parent, 2, "parent-handoff", "step_started", "startSessionOwnerStep");
  f.events.push(older, start);
  f.steps.set(
    "parent-review",
    step(parent, "parent-review", paired("reviewed", { digest: "native-parent" })),
  );
  f.options.visitPredecessors = async (visit) => {
    await visit({
      ownerRunId: parent,
      logicalSessionId: logical,
      cutoff: f.cutoff,
      authorizeRead: async () => {
        // This controlled window remains authorized.
      },
    });
  };
  f.deps.guardedDependencies = () => f.deps;
  f.deps.resolveTerminalCheckpointOwner = async () => ({
    kind: "resolved",
    checkpointOwnerRunId: f.runId,
    chain: [
      {
        parentRunId: parent,
        ownerRunId: f.runId,
        startStepId: "parent-handoff",
        events: [older, start],
      },
    ],
  });
  const values = await run(f);
  assert.equal(values.at(-1).value.digest, "native-parent");
  assert.equal(values.at(-1).runIndex, 2);
});

it("accepts an unambiguous legacy terminal input without a recorded input origin", async () => {
  const f = fixture();
  f.steps.set(
    "review",
    step(f.runId, "review", { action: "done" }, paired("reviewed", { digest: "legacy" })),
  );
  const values = await run(f);
  assert.equal(values.at(-1).value.digest, "legacy");
});

it("continues past a non-review legacy fallback without inventing a review", async () => {
  const f = fixture();
  f.steps.set(
    "cutoff",
    step(f.runId, "cutoff", { ...paired("validated"), action: "done" }, paired("validated")),
  );
  const values = await run(f);
  assert.equal(values.at(-1).value.digest, "original");
});

it("refuses legacy fallback ordering when another review competes", async () => {
  const f = fixture();
  f.steps.set(
    "cutoff",
    step(
      f.runId,
      "cutoff",
      { ...paired("validated"), action: "done" },
      paired("reviewed", { digest: "unpositioned" }),
    ),
  );
  await assert.rejects(run(f), /input order is ambiguous/u);
});

it("crosses a receipt-bound validated recovery boot to the earlier committed review", async () => {
  const f = fixture();
  const boot = "failed-recovery-owner";
  const bootStep = "boot-validation";
  f.events.push(
    event(boot, 1, bootStep, "step_completed", "validateTerminalRecoveryCheckpointStep"),
  );
  f.steps.set(bootStep, {
    ...step(boot, bootStep, undefined, { checkpoint: paired("validated") }),
    stepName: "step//eve@0.68.0//validateTerminalRecoveryCheckpointStep",
  });
  const priorVisit = f.options.visitPredecessors;
  f.options.visitPredecessors = async (visit) => {
    const action = await visit({
      ownerRunId: boot,
      logicalSessionId: logical,
      cutoff: {
        ...f.cutoff,
        kind: "validated-recovery-input",
        checkpointOwnerRunId: boot,
        sourceStepId: bootStep,
        sourceEventId: eventId(1),
        sourceSlot: 1,
      },
      authorizeRead: f.options.authorizeCurrent,
    });
    assert.equal(action, "continue");
    await priorVisit(visit);
  };
  const values = await run(f);
  assert.equal(values.at(-1).value.digest, "original");
  assert.equal(values.at(-1).runIndex, 2);
  assert.ok(f.reads.some(([kind, id]) => kind === "step" && id === boot));
});

it.each(["failed", "foreign", "wrong-step", "wrong-event"])(
  "rejects %s boot predecessor checkpoints before older history",
  async (invalid) => {
    const f = fixture();
    f.cutoff.kind = "validated-recovery-input";
    const cp = paired("validated");
    if (invalid === "foreign") {
      cp.serializedContext["eve.sessionId"] = "foreign";
    }
    f.steps.set("cutoff", {
      ...step(f.runId, "cutoff", undefined, { checkpoint: cp }),
      stepName: invalid === "wrong-step" ? "turnStep" : "validateTerminalRecoveryCheckpointStep",
      status: invalid === "failed" ? "failed" : "completed",
    });
    if (invalid === "wrong-event") {
      f.events[1].eventType = "step_created";
    }
    await assert.rejects(run(f), /validated recovery cutoff unavailable|logical identity differs/u);
    assert.equal(
      f.reads.some(([kind]) => kind === "page"),
      false,
    );
  },
);
