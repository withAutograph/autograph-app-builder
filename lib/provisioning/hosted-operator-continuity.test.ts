/* oxlint-disable eslint/require-await -- Faithful controlled asynchronous ports exercise the actual continuity service without provider effects. */
import { describe, expect, it, vi } from "vitest";
import { isDeepStrictEqual } from "node:util";
import { HostedOperatorError, hostedOperatorPlanSchema } from "./hosted-operator-contract";
import type { HostedOperatorContext } from "./hosted-operator-service";
import {
  hostedContinuityPlanSchema,
  continuityRecordSchema,
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
    runtimeRole: "app_runtime",
    resourceId: "app-resource",
  },
  authDatabase: {
    database: "auth_db",
    migratorRole: "auth_migrator",
    runtimeRole: "auth_runtime",
    resourceId: "auth-resource",
  },
  contextId: "ordinary-planning-context",
  cost: { class: "shared-recovery-group", description: "Controlled fixture", owner: "Fixture" },
  effects: [
    { id: "resources", kind: "resources", description: "Prepare resources" },
    { id: "install", kind: "install", description: "Install app" },
    { id: "access", kind: "access", description: "Authorize app" },
    { id: "bindings", kind: "bindings", description: "Bind runtime" },
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

describe("approved managed app continuity service", () => {
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
    const started = vi.mocked(f.deps.runtime.start).mock.calls[0];
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
