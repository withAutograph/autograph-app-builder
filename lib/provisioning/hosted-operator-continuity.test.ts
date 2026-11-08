/* oxlint-disable eslint/require-await -- Faithful controlled asynchronous ports exercise the actual continuity service without provider effects. */
import { describe, expect, it, vi } from "vitest";
import { isDeepStrictEqual } from "node:util";
import { HostedOperatorError, hostedOperatorPlanSchema } from "./hosted-operator-contract";
import type { HostedOperatorContext } from "./hosted-operator-service";
import {
  hostedContinuityPlanSchema,
  continuityRecordSchema,
  continuityStatus,
  continuityStatusSchema,
  continuityCheckpoints,
  continuityCheckpointSchema,
} from "./hosted-operator-continuity-contract";
import type {
  ContinuityRecord,
  ContinuityCapabilities,
} from "./hosted-operator-continuity-contract";
import { createPostgresContinuityJournalStore } from "./postgres-hosted-operator-continuity-journal";
import { createHostedContinuityOperations } from "./hosted-operator-continuity";
import type { HostedContinuityDependencies } from "./hosted-operator-continuity";
import { createContinuityCapabilityCustody } from "./hosted-operator-continuity-custody";

const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace",
  ownerUserId: "owner",
};
const context: HostedOperatorContext = {
  authority,
  target: {
    appId: "orchard",
    branch: "preview",
    environment: "preview",
    projectId: "app-project",
    sessionId: "saved-session",
    installationId: "installation",
    scopeId: "team",
    scopeType: "team",
  },
};
const preparedPlan = hostedOperatorPlanSchema.parse({
  version: 1,
  action: "prepare",
  access: [{ actorId: "actor-one", organizationId: "organization-one", roles: ["custom_role"] }],
  appDatabase: {
    database: "app_db",
    migratorRole: "app_migrator",
    resourceId: "app-resource",
    runtimeRole: "app_runtime",
  },
  authDatabase: {
    database: "auth_db",
    migratorRole: "auth_migrator",
    resourceId: "auth-resource",
    runtimeRole: "auth_runtime",
  },
  contextId: "ordinary-planning-context",
  cost: { class: "shared-recovery-group", description: "Controlled fixture", owner: "Fixture" },
  effects: [
    { description: "Prepare resources", id: "resources", kind: "resources" },
    { description: "Install app", id: "install", kind: "install" },
    { description: "Authorize app", id: "access", kind: "access" },
    { description: "Bind runtime", id: "bindings", kind: "bindings" },
  ],
  installer: { reference: "shared-installer", sha256: "a".repeat(64) },
  neon: {
    branchId: "branch",
    connectionRef: "private-connection",
    endpoint: "ep-controlled.us-east-1.aws.neon.tech",
    projectId: "database-project",
    source: "synthetic-only",
  },
  release: { artifactRef: "retained-app-release", id: "app-release", sha256: "b".repeat(64) },
  retention: { expiresAt: "2027-01-01T00:00:00.000Z", policy: "Original retention" },
  selection: {
    appId: context.target.appId,
    branch: context.target.branch,
    environment: "preview",
    projectId: context.target.projectId,
    sessionId: context.target.sessionId,
  },
});
const selection = {
  version: 1 as const,
  kind: "app-continuity-plan" as const,
  authority,
  target: context.target,
  originalSetup: {
    operationRef: "10000000-0000-4000-8000-000000000001",
    planDigest: "c".repeat(64),
    approvalId: "setup-human",
    approvedByCallId: "setup-call",
  },
  preparedPlan,
  runtime: {
    sandboxId: "owned-sandbox",
    root: "/controlled/source",
    projectId: "builder-project",
    ownerId: "team",
    appPort: 3000,
    bridgePort: 3100,
  },
  gateway: {
    projectId: "gateway-project",
    ownerId: "team",
    environment: "preview" as const,
    publicOrigin: "https://gateway.example",
  },
  actors: [{ actorId: "actor-one", organizationId: "organization-one" }],
};
const makePlan = () =>
  hostedContinuityPlanSchema.parse({
    ...selection,
    intentId: "20000000-0000-4000-8000-000000000002",
    planRef: "_protected-operator/continuity-plans/20000000-0000-4000-8000-000000000002",
  });

const setup = () => {
  let row: ContinuityRecord | undefined;
  let owner = true;
  let approved = false;
  let setupCurrent = true;
  let held = false;
  let rejectCas = false;
  const events: string[] = [];
  const records: ContinuityRecord[] = [];
  const read = () => {
    if (row === undefined) {
      throw new Error("Missing controlled continuity row");
    }
    return structuredClone(row);
  };
  const custody = createContinuityCapabilityCustody({
    tokenKey: Buffer.alloc(32, 7),
    tokenKeyVersion: "fixture-key",
  });
  const deps: HostedContinuityDependencies = {
    store: {
      async read(input) {
        return row !== undefined &&
          input.intentId === row.requestId &&
          isDeepStrictEqual(input.authority, row.plan.authority)
          ? structuredClone(row)
          : undefined;
      },
      async reserve(input) {
        row ??= continuityRecordSchema.parse(structuredClone(input.record));
        records.push(read());
        return read();
      },
      async compareAndSet(input) {
        if (rejectCas || row?.revision !== input.expectedRevision) {
          rejectCas = false;
          // oxlint-disable-next-line unicorn/no-useless-undefined -- Optional CAS absence is the supported conflict result.
          return undefined;
        }
        row = continuityRecordSchema.parse(structuredClone(input.record));
        records.push(read());
        return read();
      },
    },
    assertOwner: vi.fn<HostedContinuityDependencies["assertOwner"]>(async () => {
      if (!owner) {
        throw new HostedOperatorError("authorization_required");
      }
    }),
    assertSetup: vi.fn<HostedContinuityDependencies["assertSetup"]>(async () => {
      if (!owner || !setupCurrent) {
        throw new HostedOperatorError("authorization_required");
      }
    }),
    resolvePlan: vi.fn<HostedContinuityDependencies["resolvePlan"]>(async (_context, runtime) => ({
      ...makePlan(),
      runtime: { ...selection.runtime, ...runtime },
    })),
    readApproval: vi.fn<HostedContinuityDependencies["readApproval"]>(
      async (_context, request, callId) =>
        approved
          ? {
              ...request,
              approvalId: "continuity-human",
              approvedByCallId: callId ?? "continuity-call",
            }
          : null,
    ),
    seal: (record, caps) => custody.seal(record, caps),
    unseal: (record) => custody.unseal(record),
    withResourceLease: async (input, run) => {
      if (held) {
        throw new HostedOperatorError("operation_in_progress");
      }
      held = true;
      try {
        await input.initializeUnderLock?.();
        const fence = await input.readCurrentFence();
        return await run(async () => {
          const current = await input.readCurrentFence();
          if (!isDeepStrictEqual(current, fence)) {
            throw new HostedOperatorError("reconciliation_required");
          }
        });
      } finally {
        held = false;
      }
    },
    runtime: {
      start: vi.fn<HostedContinuityDependencies["runtime"]["start"]>(
        async (_context, record, _capabilities, assertCurrent, checkpoint) => {
          await assertCurrent();
          events.push("start");
          const { attemptId } = record;
          if (attemptId === undefined) {
            throw new Error("Missing retained attempt");
          }
          await checkpoint({
            locator: {
              sandboxId: record.plan.runtime.sandboxId,
              root: record.plan.runtime.root,
              providerSessionId: "provider-session",
              commandId: "runtime-command",
              worker: {
                id: "managed-worker",
                executablePath: "/private/worker",
                sha256: "d".repeat(64),
                operationScope: "managed-app-runtime-v1",
                subcommand: "protected-managed-app-runtime",
              },
              attemptId,
              rootDirectory: "/controlled/runtime",
            },
            current: {
              intentId: record.requestId,
              approvalRef: "continuity-human",
              owner: { ...authority, sessionId: context.target.sessionId },
              appId: context.target.appId,
              runtimeAttemptId: attemptId,
              fence: record.fence,
              sandboxId: record.plan.runtime.sandboxId,
              providerSessionId: "provider-session",
              state: "ready",
              leaseExpiresAt: "2027-01-01T00:00:00.000Z",
            },
          });
        },
      ),
      runSuite: vi.fn<HostedContinuityDependencies["runtime"]["runSuite"]>(
        async (_context, _record, _capabilities, assertCurrent, checkpoint, allowDispatch) => {
          await assertCurrent();
          events.push(allowDispatch ? "dispatch-suite" : "read-suite");
          if (allowDispatch) {
            await checkpoint("suite-command");
          }
          return { exitCode: 0 };
        },
      ),
      close: vi.fn<HostedContinuityDependencies["runtime"]["close"]>(async () => {
        events.push("close");
      }),
      renew: vi.fn<HostedContinuityDependencies["runtime"]["renew"]>(async () => {
        events.push("renew");
      }),
    },
    projection: {
      publish: vi.fn<HostedContinuityDependencies["projection"]["publish"]>(
        async (_context, _record, _capabilities, assertCurrent) => {
          await assertCurrent();
          events.push("publish");
        },
      ),
      revoke: vi.fn<HostedContinuityDependencies["projection"]["revoke"]>(
        async (_context, _record, assertCurrent, checkpoint) => {
          await assertCurrent();
          events.push("revoke-owned-rows");
          await checkpoint([]);
        },
      ),
    },
    now: () => new Date("2026-10-20T14:00:00.000Z"),
  };
  return {
    operations: createHostedContinuityOperations(deps),
    deps,
    events,
    records,
    read,
    approve: () => {
      approved = true;
    },
    revokeOwner: () => {
      owner = false;
    },
    invalidateSetup: () => {
      setupCurrent = false;
    },
    rejectNextCas: () => {
      rejectCas = true;
    },
  };
};

const retainPreDispatchAttempt = async (f: ReturnType<typeof setup>) => {
  const planned = await f.operations.plan(context, selection.runtime, "retained-session-request");
  f.approve();
  const original = vi.mocked(f.deps.runtime.start).getMockImplementation();
  if (original === undefined) {
    throw new Error("Missing controlled runtime");
  }
  vi.mocked(f.deps.runtime.start).mockImplementationOnce(
    async (ctx, record, capabilities, guard, checkpoint) => {
      await original(ctx, record, capabilities, guard, async (patch) => {
        if (patch.locator === undefined || patch.current === undefined) {
          throw new Error("Missing controlled runtime checkpoint");
        }
        const locator = { ...patch.locator };
        delete locator.commandId;
        await checkpoint({
          locator,
          current: { ...patch.current, state: "starting" },
        });
        throw new Error("Interrupted before runtime dispatch");
      });
    },
  );
  await expect(f.operations.execute(context, planned.request, "continuity-call")).rejects.toThrow();
  return { planned, retained: f.read() };
};

it("projects retained checkpoints for the owner without resuming an uncertain attempt", async () => {
  const f = setup();
  const { planned, retained } = await retainPreDispatchAttempt(f);
  const eventsBefore = [...f.events];
  const writesBefore = f.records.length;
  const result = await f.operations.readPlan(context, planned.plan.intentId);
  expect(result.status).not.toHaveProperty("checkpoints");
  expect(continuityCheckpointSchema.parse(continuityCheckpoints(retained)).checkpoints).toEqual({
    environmentWrite: "unrecorded",
    outcome: "unrecorded",
    pendingStage: "runtime",
    publicationAttempt: "unrecorded",
    publicationCandidate: "unrecorded",
    runtimeCommand: "unrecorded",
    runtimeDispatch: "unrecorded",
    runtimeLocator: "recorded",
    suiteCommand: "unrecorded",
    suiteDispatch: "unrecorded",
  });
  expect(f.read()).toEqual(retained);
  expect(f.events).toEqual(eventsBefore);
  expect(f.records).toHaveLength(writesBefore);
  f.revokeOwner();
  await expect(f.operations.readPlan(context, planned.plan.intentId)).rejects.toMatchObject({
    code: "authorization_required",
  });
});

it("projects recorded dispatch markers without revealing private command or capability values", async () => {
  const f = setup();
  const { retained } = await retainPreDispatchAttempt(f);
  if (retained.locator === undefined) {
    throw new Error("Missing locator");
  }
  retained.locator.dispatchAttempted = true;
  retained.locator.commandId = "private-runtime-command";
  retained.deliveryAttempted = true;
  retained.suiteDispatched = true;
  retained.suiteCommandId = "private-suite-command";
  expect(continuityStatusSchema.parse(continuityStatus(retained))).not.toHaveProperty(
    "checkpoints",
  );
  const status = continuityCheckpointSchema.parse(continuityCheckpoints(retained));
  expect(status.checkpoints).toMatchObject({
    outcome: "unrecorded",
    publicationAttempt: "recorded",
    runtimeCommand: "recorded",
    runtimeDispatch: "recorded",
    suiteCommand: "recorded",
    suiteDispatch: "recorded",
  });
  expect(JSON.stringify(status)).not.toContain("private-runtime-command");
  expect(JSON.stringify(status)).not.toContain("private-suite-command");
});

const sessionRebindPatch = (record: ContinuityRecord) => {
  if (record.locator === undefined || record.current === undefined) {
    throw new Error("Missing retained runtime identity");
  }
  return {
    locator: { ...record.locator, providerSessionId: "resumed-provider-session" },
    current: {
      ...record.current,
      owner: { ...record.current.owner },
      providerSessionId: "resumed-provider-session",
      leaseExpiresAt: "2027-01-01T01:00:00.000Z",
    },
  };
};

const resumeControlledSession = (f: ReturnType<typeof setup>, beforeCheckpoint?: () => void) => {
  vi.mocked(f.deps.runtime.start).mockImplementation(
    async (_ctx, record, _capabilities, guard, checkpoint) => {
      await guard();
      beforeCheckpoint?.();
      const patch = sessionRebindPatch(record);
      await checkpoint(patch);
      f.events.push("launch-after-session-checkpoint");
      await checkpoint({
        locator: { ...patch.locator, dispatchAttempted: true, commandId: "runtime-command" },
        current: { ...patch.current, state: "ready" },
      });
    },
  );
};

describe("approved managed app continuity service", () => {
  it("commits a resumed session pair before launch and preserves the approved attempt through suite cleanup", async () => {
    const f = setup();
    const { planned, retained } = await retainPreDispatchAttempt(f);
    resumeControlledSession(f);
    const result = await f.operations.execute(context, planned.request, "resumed-call");
    expect(result.state).toBe("settled");
    expect(f.read()).toMatchObject({
      approval: retained.approval,
      attemptId: retained.attemptId,
      fence: retained.fence,
      privateState: retained.privateState,
      locator: { ...retained.locator, providerSessionId: "resumed-provider-session" },
    });
    expect(
      f.records.every(
        (record) => record.locator?.providerSessionId === record.current?.providerSessionId,
      ),
    ).toBe(true);
    expect(f.events.filter((event) => event === "dispatch-suite")).toHaveLength(1);
    expect(f.events.lastIndexOf("close")).toBeLessThan(f.events.lastIndexOf("revoke-owned-rows"));
    const events = [...f.events];
    await f.operations.execute(context, planned.request, "another-call");
    expect(f.events).toEqual(events);
  });

  it("does not launch or partially rebind on CAS conflict, then resumes the same attempt after a fresh read", async () => {
    const f = setup();
    const { planned, retained } = await retainPreDispatchAttempt(f);
    resumeControlledSession(f, f.rejectNextCas);
    await expect(
      f.operations.execute(context, planned.request, "conflicting-call"),
    ).rejects.toThrow();
    expect(f.read().locator).toEqual(retained.locator);
    expect(f.read().current).toEqual(retained.current);
    expect(f.events).not.toContain("launch-after-session-checkpoint");
    resumeControlledSession(f);
    const resumed = await f.operations.execute(context, planned.request, "resumed-call");
    expect(resumed.state).toBe("settled");
    expect(f.read().attemptId).toBe(retained.attemptId);
    expect(f.events.filter((event) => event === "dispatch-suite")).toHaveLength(1);
  });

  it("does not renew an undispatched old session and renews only the rebound identity once dispatch may exist", async () => {
    vi.useFakeTimers();
    try {
      const f = setup();
      const { planned } = await retainPreDispatchAttempt(f);
      vi.mocked(f.deps.runtime.start).mockImplementationOnce(
        async (_ctx, record, _capabilities, guard, checkpoint) => {
          await guard();
          await vi.advanceTimersByTimeAsync(15_000);
          expect(f.deps.runtime.renew).not.toHaveBeenCalled();
          const patch = sessionRebindPatch(record);
          await checkpoint(patch);
          await vi.advanceTimersByTimeAsync(15_000);
          expect(f.deps.runtime.renew).not.toHaveBeenCalled();
          // Even an uncertain launch needs renewal once its durable marker exists.
          await checkpoint({ locator: { ...patch.locator, dispatchAttempted: true } });
          await vi.advanceTimersByTimeAsync(15_000);
          expect(f.deps.runtime.renew).toHaveBeenCalledTimes(1);
          const renewed = vi.mocked(f.deps.runtime.renew).mock.calls[0]?.[1];
          expect(renewed?.locator?.providerSessionId).toBe("resumed-provider-session");
          expect(renewed?.current?.providerSessionId).toBe("resumed-provider-session");
          await checkpoint({
            locator: { ...patch.locator, dispatchAttempted: true, commandId: "runtime-command" },
            current: { ...patch.current, state: "ready" },
          });
        },
      );
      const result = await f.operations.execute(context, planned.request, "resumed-call");
      expect(result.state).toBe("settled");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads back a committed session pair after response loss without changing the attempt or duplicating dispatch", async () => {
    const f = setup();
    const { planned, retained } = await retainPreDispatchAttempt(f);
    const { compareAndSet } = f.deps.store;
    let responseLost = false;
    f.deps.store.compareAndSet = async (input) => {
      const saved = await compareAndSet(input);
      if (!responseLost && input.record.locator?.providerSessionId === "resumed-provider-session") {
        responseLost = true;
        // oxlint-disable-next-line unicorn/no-useless-undefined -- A committed CAS can lose its response.
        return undefined;
      }
      return saved;
    };
    resumeControlledSession(f);
    await expect(
      f.operations.execute(context, planned.request, "response-lost-call"),
    ).rejects.toThrow();
    expect(f.read().locator?.providerSessionId).toBe("resumed-provider-session");
    expect(f.read().current?.providerSessionId).toBe("resumed-provider-session");
    expect(f.events).not.toContain("launch-after-session-checkpoint");
    const resumed = await f.operations.execute(context, planned.request, "readback-call");
    expect(resumed.state).toBe("settled");
    expect(f.read().attemptId).toBe(retained.attemptId);
    expect(f.events.filter((event) => event === "dispatch-suite")).toHaveLength(1);
  });

  it.each(["locator-only", "current-only", "attempt-directory", "owner", "capabilities"])(
    "refuses a %s session checkpoint without launching or changing the retained pair",
    async (kind) => {
      const f = setup();
      const { planned, retained } = await retainPreDispatchAttempt(f);
      vi.mocked(f.deps.runtime.start).mockImplementationOnce(
        async (_ctx, record, _capabilities, guard, checkpoint) => {
          await guard();
          const patch: Partial<ContinuityRecord> = sessionRebindPatch(record);
          if (kind === "locator-only") {
            delete patch.current;
          }
          if (kind === "current-only") {
            delete patch.locator;
          }
          if (kind === "attempt-directory" && patch.locator !== undefined) {
            patch.locator.rootDirectory = "/another-attempt";
          }
          if (kind === "owner" && patch.current !== undefined) {
            patch.current.owner.ownerUserId = "another-owner";
          }
          if (kind === "capabilities") {
            patch.privateState = retained.privateState;
          }
          await checkpoint(patch);
          f.events.push("unexpected-launch");
        },
      );
      await expect(
        f.operations.execute(context, planned.request, "invalid-call"),
      ).rejects.toThrow();
      expect(f.read().locator).toEqual(retained.locator);
      expect(f.read().current).toEqual(retained.current);
      expect(f.events).not.toContain("unexpected-launch");
      expect(f.events).not.toContain("dispatch-suite");
    },
  );

  it("returns the original saved plan and request without consulting newer setup or executing work", async () => {
    const f = setup();
    const planned = await f.operations.plan(context, selection.runtime, "saved-original-request");
    const original = f.read();
    vi.mocked(f.deps.resolvePlan).mockClear().mockRejectedValue(new Error("No replanning"));
    vi.mocked(f.deps.assertSetup).mockClear().mockRejectedValue(new Error("New setup differs"));
    const reserve = vi.spyOn(f.deps.store, "reserve");
    const cas = vi.spyOn(f.deps.store, "compareAndSet");
    f.invalidateSetup();
    const saved = await f.operations.readPlan(context, planned.plan.intentId);
    expect(saved).toEqual(planned);
    expect(saved.request.idempotencyKey).toBe("saved-original-request");
    expect(f.read()).toEqual(original);
    expect(f.deps.resolvePlan).not.toHaveBeenCalled();
    expect(f.deps.assertSetup).not.toHaveBeenCalled();
    expect(f.deps.readApproval).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(cas).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
  });
  it("denies foreign owner and session reads while keeping the saved continuity record unchanged", async () => {
    const f = setup();
    const planned = await f.operations.plan(context, selection.runtime, "saved-request");
    const original = f.read();
    await expect(
      f.operations.readPlan(
        {
          ...context,
          authority: { ...authority, ownerUserId: "foreign-owner" },
        },
        planned.plan.intentId,
      ),
    ).rejects.toMatchObject({ code: "resource_mismatch" });
    await expect(
      f.operations.readPlan(
        {
          ...context,
          target: { ...context.target, sessionId: "foreign-session" },
        },
        planned.plan.intentId,
      ),
    ).rejects.toMatchObject({ code: "authorization_required" });
    f.revokeOwner();
    await expect(f.operations.readPlan(context, planned.plan.intentId)).rejects.toMatchObject({
      code: "authorization_required",
    });
    expect(f.read()).toEqual(original);
    expect(f.events).toEqual([]);
  });
  it("rejects a saved continuity plan whose recorded digest no longer binds its request", async () => {
    const f = setup();
    const planned = await f.operations.plan(context, selection.runtime, "saved-request");
    const original = f.read();
    vi.spyOn(f.deps.store, "read").mockResolvedValue({ ...original, planDigest: "f".repeat(64) });
    await expect(f.operations.readPlan(context, planned.plan.intentId)).rejects.toMatchObject({
      code: "resource_mismatch",
    });
    expect(f.read()).toEqual(original);
    expect(f.events).toEqual([]);
  });
  it("reserves a positive first database revision and preserves idempotence and CAS recovery", async () => {
    const f = setup();
    const values = vi.fn((value: { revision: number; record: ContinuityRecord }) => {
      // Model the real PostgreSQL revision CHECK at the terminal database boundary.
      if (value.revision <= 0) {
        throw new Error("Controlled builder_provisioning_journal_revision_check failure");
      }
      expect(value.revision).toBe(value.record.revision);
      return {
        onConflictDoNothing: () => ({ returning: async () => [{ record: value.record }] }),
      };
    });
    const database = { insert: () => ({ values }) };
    // SAFETY: This controlled terminal database implements every method used by reservation;
    // the actual PostgreSQL adapter still maps and parses the operation's record.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Isolate the existing SQL adapter without opening a database or mocking its implementation.
    const postgresStore = createPostgresContinuityJournalStore(database as never);
    const retain = f.deps.store.reserve;
    f.deps.store.reserve = async (input) =>
      await retain({ ...input, record: await postgresStore.reserve(input) });

    const planned = await f.operations.plan(context, selection.runtime, "database-revision");
    const initialRevision = f.read().revision;
    expect(initialRevision).toBeGreaterThan(0);
    expect(f.read().fence).toBe(0);
    expect(await f.operations.plan(context, selection.runtime, "database-revision")).toEqual(
      planned,
    );
    expect(values).toHaveBeenCalledOnce();
    f.approve();
    f.rejectNextCas();
    await expect(
      f.operations.execute(context, planned.request, "continuity-call"),
    ).rejects.toThrow();
    expect(f.read().revision).toBe(initialRevision);
    expect(f.events).toEqual([]);
    const recovered = await f.operations.execute(context, planned.request, "continuity-call");
    expect(recovered.state).toBe("settled");
    expect(f.read().revision).toBeGreaterThan(initialRevision);
    expect(f.events.filter((event) => event === "dispatch-suite")).toHaveLength(1);
  });
  it("plans idempotently and status/approval reads perform no runtime or projection work", async () => {
    const f = setup();
    const first = await f.operations.plan(context, selection.runtime, "request");
    const again = await f.operations.plan(
      context,
      { ...selection.runtime, root: "/ordinary/new/source" },
      "request",
    );
    expect(again.request).toEqual(first.request);
    expect(again.plan.intentId).toBe(first.plan.intentId);
    const status = await f.operations.status(context, first.plan.intentId);
    expect(status.state).toBe("planned");
    expect(await f.operations.approval(context, first.request)).toEqual({ approved: false });
    expect(f.events).toEqual([]);
    await expect(f.operations.execute(context, first.request, "continuity-call")).rejects.toThrow();
    expect(f.events).toEqual([]);
  });
  it("requires the same owner, target, original setup and independent continuity approval", async () => {
    const f = setup();
    const planned = await f.operations.plan(context, selection.runtime, "request");
    f.approve();
    await expect(
      f.operations.execute(
        { ...context, target: { ...context.target, sessionId: "foreign-session" } },
        planned.request,
        "continuity-call",
      ),
    ).rejects.toThrow();
    await expect(
      f.operations.execute(
        context,
        { ...planned.request, planDigest: "f".repeat(64) },
        "continuity-call",
      ),
    ).rejects.toThrow();
    f.revokeOwner();
    await expect(f.operations.status(context, planned.plan.intentId)).rejects.toThrow();
    await expect(
      f.operations.execute(context, planned.request, "continuity-call"),
    ).rejects.toThrow();
    expect(f.events).toEqual([]);
  });
  it("settles cleanup after owned shutdown and keeps capability bearers out of public results and journal plaintext", async () => {
    const f = setup();
    const planned = await f.operations.plan(context, selection.runtime, "request");
    f.approve();
    const result = await f.operations.execute(context, planned.request, "continuity-call");
    expect(result.state).toBe("settled");
    expect(result.outcome?.exitCode).toBe(0);
    expect(f.events.indexOf("close")).toBeLessThan(f.events.indexOf("revoke-owned-rows"));
    const [started] = vi.mocked(f.deps.runtime.start).mock.calls;
    if (started === undefined) {
      throw new Error("Runtime did not start");
    }
    const caps = started[2];
    for (const bearer of Object.values(caps)) {
      expect(JSON.stringify(result)).not.toContain(bearer);
      expect(JSON.stringify(f.read())).not.toContain(bearer);
    }
    expect(f.records.every((record) => record.kind === "app-continuity")).toBe(true);
    expect(f.read().plan.preparedPlan).toEqual(preparedPlan);
    const effectsBeforeReplay = [...f.events];
    expect(await f.operations.execute(context, planned.request, "continuity-call")).toEqual(result);
    expect(f.events).toEqual(effectsBeforeReplay);
  });
  it("records the suite's actual nonzero outcome without turning it into an app admission rule", async () => {
    const f = setup();
    vi.mocked(f.deps.runtime.runSuite).mockImplementationOnce(
      async (_context, _record, _caps, guard, checkpoint) => {
        await guard();
        await checkpoint("suite-command");
        return { exitCode: 7 };
      },
    );
    const planned = await f.operations.plan(context, selection.runtime, "request");
    f.approve();
    const result = await f.operations.execute(context, planned.request, "continuity-call");
    expect(result.state).toBe("settled");
    expect(result.outcome?.exitCode).toBe(7);
  });
  it("retains the same command, attempt and capabilities after uncertain suite completion and reconciles before redispatch", async () => {
    const f = setup();
    const observed: {
      attemptId: string | undefined;
      caps: ContinuityCapabilities;
      allowDispatch: boolean;
      commandId: string | undefined;
    }[] = [];
    vi.mocked(f.deps.runtime.runSuite).mockImplementation(
      async (_context, record, caps, guard, checkpoint, allowDispatch) => {
        await guard();
        observed.push({
          attemptId: record.attemptId,
          caps,
          allowDispatch,
          commandId: record.suiteCommandId,
        });
        if (allowDispatch) {
          await checkpoint("retained-suite-command");
          throw new Error("Controlled lost command completion");
        }
        return { exitCode: 0 };
      },
    );
    const planned = await f.operations.plan(context, selection.runtime, "request");
    f.approve();
    await expect(
      f.operations.execute(context, planned.request, "continuity-call"),
    ).rejects.toThrow();
    expect(f.read().state).toBe("reconciliation-required");
    expect(f.read().suiteCommandId).toBe("retained-suite-command");
    const result = await f.operations.execute(context, planned.request, "continuity-call");
    expect(result.state).toBe("settled");
    expect(observed[0]?.allowDispatch).toBe(true);
    expect(observed[1]?.allowDispatch).toBe(false);
    expect(observed[1]?.commandId).toBe("retained-suite-command");
    expect(observed[1]?.attemptId).toBe(observed[0]?.attemptId);
    expect(observed[1]?.caps).toEqual(observed[0]?.caps);
    expect(f.events.filter((event) => event === "start")).toHaveLength(1);
  });
  it("retains failed publication as revocation-only recovery before closing its runtime", async () => {
    const f = setup();
    vi.mocked(f.deps.projection.publish).mockImplementationOnce(
      async (_context, _record, _caps, guard) => {
        await guard();
        f.events.push("publish-unknown");
        throw new Error("Controlled uncertain publication");
      },
    );
    vi.mocked(f.deps.runtime.close).mockImplementationOnce(async (_context, record) => {
      expect(record.pendingStage).toBe("revocation");
      expect(record.failure?.stage).toBe("publication");
      f.events.push("close");
    });
    vi.mocked(f.deps.projection.revoke).mockRejectedValueOnce(
      new Error("Controlled unknown row removal"),
    );
    const planned = await f.operations.plan(context, selection.runtime, "request");
    f.approve();
    await expect(
      f.operations.execute(context, planned.request, "continuity-call"),
    ).rejects.toThrow();
    const retained = f.read();
    expect(retained.pendingStage).toBe("revocation");
    expect(retained.failure?.stage).toBe("publication");
    const result = await f.operations.execute(context, planned.request, "continuity-call");
    expect(result.state).toBe("revoked");
    expect(result.failure).toEqual(retained.failure);
    expect(result.outcome).toBeUndefined();
    expect(f.read().attemptId).toBe(retained.attemptId);
    expect(f.deps.runtime.start).toHaveBeenCalledTimes(1);
    expect(f.deps.projection.publish).toHaveBeenCalledTimes(1);
    expect(f.deps.runtime.runSuite).not.toHaveBeenCalled();
  });
  it("closes failed publication even when its first revocation journal write conflicts", async () => {
    const f = setup();
    vi.mocked(f.deps.projection.publish).mockImplementationOnce(async () => {
      f.rejectNextCas();
      throw new Error("Controlled publication failure before a journal conflict");
    });
    const planned = await f.operations.plan(context, selection.runtime, "request");
    f.approve();
    await expect(
      f.operations.execute(context, planned.request, "continuity-call"),
    ).rejects.toThrow();
    expect(f.deps.runtime.close).toHaveBeenCalledTimes(1);
    expect(f.deps.runtime.runSuite).not.toHaveBeenCalled();
    expect(f.read().state).toBe("revoked");
    expect(f.read().failure?.stage).toBe("publication");
  });
  it("closes the owned runtime on cancellation before attempting fresh-fence row removal", async () => {
    const f = setup();
    const abort = new AbortController();
    vi.mocked(f.deps.runtime.runSuite).mockImplementationOnce(
      async (_context, _record, _caps, guard, checkpoint) => {
        await guard();
        await checkpoint("retained-suite-command");
        abort.abort();
        throw new Error("Controlled cancellation");
      },
    );
    const planned = await f.operations.plan(context, selection.runtime, "request");
    f.approve();
    await expect(
      f.operations.execute(context, planned.request, "continuity-call", abort.signal),
    ).rejects.toThrow();
    expect(f.events.indexOf("close")).toBeGreaterThanOrEqual(0);
    expect(f.events.indexOf("close")).toBeLessThan(f.events.indexOf("revoke-owned-rows"));
    expect(f.read().state).toBe("revoked");
    const effectsBeforeReplay = [...f.events];
    const retried = await f.operations.execute(context, planned.request, "continuity-call");
    expect(retried.state).toBe("revoked");
    expect(f.events).toEqual(effectsBeforeReplay);
  });
  it("retains unknown cancellation cleanup for revocation-only retry, never suite dispatch", async () => {
    const f = setup();
    const abort = new AbortController();
    vi.mocked(f.deps.runtime.runSuite).mockImplementationOnce(
      async (_context, _record, _caps, guard, checkpoint) => {
        await guard();
        await checkpoint("retained-suite-command");
        abort.abort();
        throw new Error("Controlled cancellation");
      },
    );
    vi.mocked(f.deps.runtime.close).mockImplementationOnce(async () => {
      f.events.push("close-unknown");
      throw new Error("Controlled uncertain close");
    });
    const planned = await f.operations.plan(context, selection.runtime, "request");
    f.approve();
    await expect(
      f.operations.execute(context, planned.request, "continuity-call", abort.signal),
    ).rejects.toThrow();
    expect(f.read().state).toBe("reconciliation-required");
    expect(f.read().pendingStage).toBe("revocation");
    expect(f.events).not.toContain("revoke-owned-rows");
    const suiteCalls = vi.mocked(f.deps.runtime.runSuite).mock.calls.length;
    const attempt = f.read().attemptId;
    const retried = await f.operations.execute(context, planned.request, "continuity-call");
    expect(retried.state).toBe("revoked");
    expect(vi.mocked(f.deps.runtime.runSuite).mock.calls.length).toBe(suiteCalls);
    expect(f.read().attemptId).toBe(attempt);
  });
  it("stops owned work when authority is lost but does not remove provider rows under stale authority", async () => {
    const f = setup();
    vi.mocked(f.deps.runtime.runSuite).mockImplementationOnce(
      async (_context, _record, _caps, guard, checkpoint) => {
        await guard();
        await checkpoint("suite-command");
        f.revokeOwner();
        throw new Error("Controlled revoked owner");
      },
    );
    const planned = await f.operations.plan(context, selection.runtime, "request");
    f.approve();
    await expect(
      f.operations.execute(context, planned.request, "continuity-call"),
    ).rejects.toThrow();
    expect(f.events).toContain("close");
    expect(f.events).not.toContain("revoke-owned-rows");
  });
  it("does not perform work after a failed journal compare-and-set", async () => {
    const f = setup();
    const planned = await f.operations.plan(context, selection.runtime, "request");
    f.approve();
    f.rejectNextCas();
    await expect(
      f.operations.execute(context, planned.request, "continuity-call"),
    ).rejects.toThrow();
    expect(f.events).toEqual([]);
  });
  it("does not substitute prior setup approval for current setup authority", async () => {
    const f = setup();
    const planned = await f.operations.plan(context, selection.runtime, "request");
    f.approve();
    f.invalidateSetup();
    await expect(
      f.operations.execute(context, planned.request, "continuity-call"),
    ).rejects.toThrow();
    expect(f.events).toEqual([]);
  });
  it("allows only one competing mutating continuation to dispatch its suite", async () => {
    const f = setup();
    const planned = await f.operations.plan(context, selection.runtime, "request");
    f.approve();
    await f.operations.approval(context, planned.request);
    const results = await Promise.allSettled([
      f.operations.execute(context, planned.request, "continuity-call"),
      f.operations.execute(context, planned.request, "continuity-call"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(f.events.filter((event) => event === "dispatch-suite")).toHaveLength(1);
    expect(f.read().state).toBe("settled");
  });
  it("awaits an in-flight renewal before closing the runtime and removing its owned rows", async () => {
    vi.useFakeTimers();
    const f = setup();
    const suiteEntered = Promise.withResolvers<boolean>();
    const releaseSuite = Promise.withResolvers<boolean>();
    const renewalEntered = Promise.withResolvers<boolean>();
    const releaseRenewal = Promise.withResolvers<boolean>();
    let execution: Promise<unknown> | undefined;
    vi.mocked(f.deps.runtime.runSuite).mockImplementationOnce(
      async (_context, _record, _caps, guard, checkpoint) => {
        await guard();
        await checkpoint("suite-command");
        suiteEntered.resolve(true);
        await releaseSuite.promise;
        return { exitCode: 0 };
      },
    );
    vi.mocked(f.deps.runtime.renew).mockImplementationOnce(async () => {
      f.events.push("renew-entered");
      renewalEntered.resolve(true);
      await releaseRenewal.promise;
      f.events.push("renew-complete");
    });
    try {
      const planned = await f.operations.plan(context, selection.runtime, "request");
      f.approve();
      execution = f.operations.execute(context, planned.request, "continuity-call");
      await suiteEntered.promise;
      await vi.runOnlyPendingTimersAsync();
      await renewalEntered.promise;
      releaseSuite.resolve(true);
      await vi.waitFor(() => {
        expect(f.read().pendingStage).toBe("revocation");
      });
      expect(f.events).not.toContain("close");
      expect(f.events).not.toContain("revoke-owned-rows");
      releaseRenewal.resolve(true);
      await execution;
      expect(f.events.indexOf("renew-complete")).toBeLessThan(f.events.indexOf("close"));
      expect(f.events.indexOf("close")).toBeLessThan(f.events.indexOf("revoke-owned-rows"));
    } finally {
      releaseSuite.resolve(true);
      releaseRenewal.resolve(true);
      await execution;
      vi.useRealTimers();
    }
  });
});

describe("continuity recovery preserves frozen plans", () => {
  const recovered = () => {
    const f = setup();
    const rows = new Map<string, ContinuityRecord>();
    f.deps.store = {
      read: async ({ intentId }) => structuredClone(rows.get(intentId)),
      reserve: async ({ record }) => {
        if (!rows.has(record.requestId)) {
          rows.set(record.requestId, structuredClone(record));
        }
        const saved = rows.get(record.requestId);
        if (saved === undefined) {
          throw new Error("Controlled record missing");
        }
        return structuredClone(saved);
      },
      compareAndSet: async ({ record, expectedRevision }) => {
        if (rows.get(record.requestId)?.revision !== expectedRevision) {
          // oxlint-disable-next-line unicorn/no-useless-undefined -- CAS conflicts explicitly return no row.
          return undefined;
        }
        rows.set(record.requestId, structuredClone(record));
        return structuredClone(record);
      },
    };
    return { ...f, rows, operations: createHostedContinuityOperations(f.deps) };
  };
  it("creates a new exact approval for a corrected runtime and keeps the old plan", async () => {
    const f = recovered();
    const old = await f.operations.plan(context, selection.runtime, "old");
    const runtime = {
      ...selection.runtime,
      root: "/workspace/recovered",
      browserSelection: { maxFailures: 1, retries: 0, testName: "@acceptance", workers: 1 },
    };
    const next = await f.operations.plan(context, runtime, "recovery", {
      predecessorIntentId: old.plan.intentId,
    });
    expect(next.plan.intentId).not.toBe(old.plan.intentId);
    expect(next.plan.predecessorIntentId).toBe(old.plan.intentId);
    expect(next.plan.runtime.browserSelection).toEqual(runtime.browserSelection);
    expect(f.rows.get(old.plan.intentId)?.plan).toEqual(old.plan);
    expect(f.rows.get(old.plan.intentId)?.supersededBy).toBe(next.plan.intentId);
    expect(f.rows.get(next.plan.intentId)?.approval).toBeUndefined();
    expect(await f.operations.approval(context, next.request)).toEqual({ approved: false });
    await expect(f.operations.execute(context, old.request, "old-call")).rejects.toThrow(
      "reconciliation_required",
    );
    expect(f.events).toEqual([]);
    const repeated = await f.operations.plan(context, runtime, "recovery", {
      predecessorIntentId: old.plan.intentId,
    });
    expect(repeated.request).toEqual(next.request);
  });
  it("refuses to replace an attempt with uncertain effects", async () => {
    const f = recovered();
    const old = await f.operations.plan(context, selection.runtime, "old");
    const prior = f.rows.get(old.plan.intentId);
    if (prior === undefined) {
      throw new Error("Controlled record missing");
    }
    prior.state = "reconciliation-required";
    await expect(
      f.operations.plan(context, { ...selection.runtime, root: "/new" }, "recovery", {
        predecessorIntentId: old.plan.intentId,
      }),
    ).rejects.toThrow("reconciliation_required");
    expect(f.rows.size).toBe(1);
  });
  it.each([false, true])(
    "rejects successor supersession when the original execution wins CAS (existing=%s)",
    async (existing) => {
      const f = recovered();
      const old = await f.operations.plan(context, selection.runtime, "old-race");
      const recovery = { predecessorIntentId: old.plan.intentId };
      const runtime = { ...selection.runtime, root: "/recovered" };
      const cas = f.deps.store.compareAndSet;
      if (existing) {
        f.deps.store.compareAndSet = async (input) =>
          input.record.supersededBy === undefined ? await cas(input) : undefined;
        await expect(
          f.operations.plan(context, runtime, "successor-race", recovery),
        ).rejects.toThrow("operation_in_progress");
      }
      const entered = Promise.withResolvers<boolean>();
      const release = Promise.withResolvers<boolean>();
      f.deps.store.compareAndSet = async (input) => {
        if (input.record.supersededBy !== undefined) {
          entered.resolve(true);
          await release.promise;
        }
        return await cas(input);
      };
      const successor = f.operations.plan(context, runtime, "successor-race", recovery);
      const rejected = expect(successor).rejects.toThrow("operation_in_progress");
      await entered.promise;
      f.approve();
      await f.operations.execute(context, old.request, "original-call");
      release.resolve(true);
      await rejected;
      expect(f.rows.get(old.plan.intentId)?.supersededBy).toBeUndefined();
      expect(f.rows.get(old.plan.intentId)?.fence).toBe(1);
      await expect(f.operations.plan(context, runtime, "successor-race", recovery)).rejects.toThrow(
        "reconciliation_required",
      );
      expect(f.events.filter((event) => event === "dispatch-suite")).toHaveLength(1);
    },
  );
  it("does not start the original runtime when successor supersession wins claim CAS", async () => {
    const f = recovered();
    const old = await f.operations.plan(context, selection.runtime, "old-claim-race");
    f.approve();
    await f.operations.approval(context, old.request);
    const entered = Promise.withResolvers<boolean>();
    const release = Promise.withResolvers<boolean>();
    const cas = f.deps.store.compareAndSet;
    f.deps.store.compareAndSet = async (input) => {
      if (input.record.requestId === old.plan.intentId && input.record.state === "starting") {
        entered.resolve(true);
        await release.promise;
      }
      return await cas(input);
    };
    const execution = f.operations.execute(context, old.request, "original-call");
    const rejected = expect(execution).rejects.toThrow("operation_in_progress");
    await entered.promise;
    const successor = await f.operations.plan(
      context,
      { ...selection.runtime, root: "/recovered" },
      "successor-claim-race",
      { predecessorIntentId: old.plan.intentId },
    );
    release.resolve(true);
    await rejected;
    expect(f.rows.get(old.plan.intentId)?.supersededBy).toBe(successor.plan.intentId);
    expect(f.rows.get(old.plan.intentId)?.attemptId).toBeUndefined();
    expect(f.events).toEqual([]);
  });
  it("retains original approval evidence but refuses it as successor authority", async () => {
    const f = recovered();
    const original = await f.operations.plan(context, selection.runtime, "approved-original");
    f.approve();
    await f.operations.approval(context, original.request);
    const retained = structuredClone(f.rows.get(original.plan.intentId));
    expect(retained?.approval).toBeDefined();
    const successor = await f.operations.plan(
      context,
      { ...selection.runtime, root: "/recovered" },
      "fresh-successor",
      { predecessorIntentId: original.plan.intentId },
    );
    const originalAfter = f.rows.get(original.plan.intentId);
    expect(originalAfter).toEqual({
      ...retained,
      revision: (retained?.revision ?? 0) + 1,
      supersededBy: successor.plan.intentId,
    });
    vi.mocked(f.deps.readApproval).mockResolvedValue(retained?.approval ?? null);
    await expect(
      f.operations.execute(context, successor.request, "successor-call"),
    ).rejects.toThrow("authorization_required");
    expect(f.rows.get(successor.plan.intentId)?.approval).toBeUndefined();
    expect(f.rows.get(successor.plan.intentId)?.attemptId).toBeUndefined();
    expect(f.events).toEqual([]);
  });
  it("binds focused selection into the exact continuity approval", async () => {
    const f = recovered();
    const planned = await f.operations.plan(
      context,
      { ...selection.runtime, browserSelection: { testName: "@acceptance" } },
      "focused",
    );
    const { continuityPlanDigest } = await import("./hosted-operator-continuity-contract");
    expect(
      continuityPlanDigest({
        ...planned.plan,
        runtime: { ...planned.plan.runtime, browserSelection: { testName: "another" } },
      }),
    ).not.toBe(planned.request.planDigest);
  });
});
