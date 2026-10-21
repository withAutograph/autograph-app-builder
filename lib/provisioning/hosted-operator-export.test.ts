import {
  createHostedOperatorClient,
  HostedOperatorTransportUnknown,
} from "./hosted-operator-client";
import { createProtectedHostedOperatorHandler } from "./hosted-operator-service";
import type {
  ProtectedHostedOperatorDependencies,
  HostedOperatorContext,
} from "./hosted-operator-service";
import {
  createTenantExportDispatcher,
  tenantExportTransportRequestSchema,
  tenantExportPlannedSchema,
} from "./hosted-operator-export-transport";
import { createOperatorWorkloadVerifier } from "./hosted-operator-workload";
/* oxlint-disable eslint/require-await -- Controlled asynchronous dependency ports exercise the real export state machine. */
import { describe, expect, it, vi } from "vitest";
import {
  createHostedTenantExportOperations,
  assertTenantExportCustomer,
  hostedTenantExportExecutionRecordSchema,
} from "./hosted-operator-export";
import type {
  HostedTenantExportDependencies,
  HostedTenantExportExecutionRecord,
  ExportCompletion,
} from "./hosted-operator-export";
import type { TenantExportWorkerInput } from "./hosted-operator-export-contract";
import { tenantExportWireFixtureSchema } from "./hosted-operator-export-contract";
import wire from "./fixtures/tenant-export-wire-v1.json";
import type { ExportPlanningStage } from "./hosted-operator-consent-diagnostic";
import { HostedOperatorError } from "./hosted-operator-contract";

const fixture = tenantExportWireFixtureSchema.parse(wire);
const authority = {
  issuer: "https://builder.test/api/auth",
  audience: "https://builder.test/mcp",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const context: HostedOperatorContext = {
  authority,
  target: {
    appId: fixture.worker.scope.appId,
    branch: "preview",
    environment: "preview",
    installationId: "installation",
    projectId: "project",
    scopeId: "team",
    scopeType: "team",
    sessionId: "saved-session",
  },
};
const selection = {
  version: 1 as const,
  kind: "tenant-export-plan" as const,
  authority,
  target: {
    appId: context.target.appId,
    sessionId: context.target.sessionId,
    branch: context.target.branch,
    projectId: context.target.projectId,
  },
  originalSetup: {
    operationRef: "40000000-0000-4000-8000-000000000004",
    planDigest: "a".repeat(64),
    approvalId: "setup-human",
    approvedByCallId: "setup-call",
  },
  scope: fixture.worker.scope,
  resource: fixture.worker.resource,
  release: fixture.worker.release,
  selection: fixture.worker.selection,
  format: fixture.worker.format,
};
const completionFor = (worker: TenantExportWorkerInput): ExportCompletion => ({
  attemptId: worker.attemptId,
  snapshotId: worker.snapshotId,
  manifest: {
    ...fixture.manifestMember,
    artifactRef: `_protected-operator/artifacts/tenant-export/${worker.exportId}/${worker.attemptId}/manifest/${fixture.manifestMember.sha256}`,
  },
  fileCount: "2",
  rowCount: "1",
  byteLength: fixture.manifest.byteLength,
});
const setup = () => {
  let record: HostedTenantExportExecutionRecord | undefined;
  let owner = true;
  let approved = false;
  let held = false;
  const read = () => {
    if (record === undefined) {
      throw new Error("Missing export fixture journal");
    }
    return structuredClone(record);
  };
  const dependencies: HostedTenantExportDependencies = {
    store: {
      async read(input) {
        return record === undefined || record.journal.requestId !== input.exportId
          ? undefined
          : structuredClone(record);
      },
      async reserve(input) {
        record ??= hostedTenantExportExecutionRecordSchema.parse(input.record);
        return read();
      },
      async compareAndSet(input) {
        if (record?.journal.revision !== input.expectedRevision) {
          // oxlint-disable-next-line unicorn/no-useless-undefined -- Optional CAS result is the explicit conflict contract.
          return undefined;
        }
        record = hostedTenantExportExecutionRecordSchema.parse(input.record);
        return read();
      },
    },
    assertOwner: vi.fn<HostedTenantExportDependencies["assertOwner"]>(async () => {
      if (!owner) {
        throw new HostedOperatorError("authorization_required");
      }
    }),
    resolvePlan: vi.fn<HostedTenantExportDependencies["resolvePlan"]>(
      async (_context, customerId) => {
        assertTenantExportCustomer(
          {
            access: [
              {
                actorId: "actual-owner",
                organizationId: "customer-one",
                roles: ["arbitrary_app_role"],
              },
            ],
          },
          customerId,
        );
        return { ...selection, scope: { ...selection.scope, customerId } };
      },
    ),
    assertSetup: vi.fn<HostedTenantExportDependencies["assertSetup"]>(async () => {
      if (!owner) {
        throw new HostedOperatorError("authorization_required");
      }
    }),
    readApproval: vi.fn<HostedTenantExportDependencies["readApproval"]>(
      async (_context, request, callId) =>
        approved
          ? { ...request, approvalId: "export-human", approvedByCallId: callId ?? "export-call" }
          : null,
    ),
    async withResourceLease(input, run) {
      if (held) {
        throw new HostedOperatorError("operation_in_progress");
      }
      held = true;
      try {
        await input.initializeUnderLock?.();
        const initial = await input.readCurrentFence();
        return await run(async () => {
          expect(await input.readCurrentFence()).toEqual(initial);
        });
      } finally {
        held = false;
      }
    },
    inspect: vi.fn<HostedTenantExportDependencies["inspect"]>(async () => ({ status: "unknown" })),
    prepareWorker: vi.fn<HostedTenantExportDependencies["prepareWorker"]>(
      async (_context, _worker, assertCurrent) => {
        await assertCurrent();
        return { sandboxId: "trusted-private-vm", descriptor: fixture.descriptor };
      },
    ),
    runWorker: vi.fn<HostedTenantExportDependencies["runWorker"]>(
      async (_context, _worker, locator, assertCurrent, checkpoint) => {
        await assertCurrent();
        await checkpoint({ ...locator, commandId: "command-one" });
        return {
          async readManifest() {
            return new Uint8Array();
          },
          async *readMember() {
            yield new Uint8Array();
          },
        };
      },
    ),
    publish: vi.fn<HostedTenantExportDependencies["publish"]>(
      async (_context, worker, _source, assertCurrent) => {
        await assertCurrent();
        return completionFor(worker);
      },
    ),
  };
  return {
    dependencies,
    operations: createHostedTenantExportOperations(dependencies),
    read,
    approve() {
      approved = true;
    },
    revoke() {
      owner = false;
    },
  };
};

describe("protected tenant export orchestration", () => {
  it("plans once under the original owner without changing preparation or launching SQL", async () => {
    const f = setup();
    const planned = await f.operations.plan(context, "customer-one", "ordinary-request");
    expect(planned.plan.scope).toEqual({ appId: context.target.appId, customerId: "customer-one" });
    expect(planned.plan.originalSetup).toEqual(selection.originalSetup);
    expect(planned.plan.exportId).not.toBe(selection.originalSetup.operationRef);
    expect(await f.operations.plan(context, "customer-one", "ordinary-request")).toEqual(planned);
    expect(f.dependencies.resolvePlan).toHaveBeenCalledTimes(1);
    expect(f.dependencies.runWorker).not.toHaveBeenCalled();
    expect(await f.operations.status(context, planned.plan.exportId)).toMatchObject({
      state: "planned",
    });
    expect(f.dependencies.inspect).not.toHaveBeenCalled();
    await expect(f.operations.plan(context, "other-customer", "ordinary-request")).rejects.toThrow(
      "resource_mismatch",
    );
  });
  it("requires exact independent data approval and refuses changed intent before dispatch", async () => {
    const f = setup();
    const planned = await f.operations.plan(context, "customer-one", "ordinary-request");
    await expect(f.operations.execute(context, planned.request, "export-call")).rejects.toThrow(
      "authorization_required",
    );
    f.approve();
    await expect(
      f.operations.execute(
        context,
        { ...planned.request, planDigest: "f".repeat(64) },
        "export-call",
      ),
    ).rejects.toThrow();
    await expect(
      f.operations.execute(
        context,
        { ...planned.request, idempotencyKey: "different" },
        "export-call",
      ),
    ).rejects.toThrow("resource_mismatch");
    expect(f.dependencies.prepareWorker).not.toHaveBeenCalled();
    expect(f.dependencies.runWorker).not.toHaveBeenCalled();
  });
  it("publishes metadata-only completion and reuses it without new SQL or repeated human stream reads", async () => {
    const f = setup();
    const planned = await f.operations.plan(context, "customer-one", "ordinary-request");
    f.approve();
    const complete = await f.operations.execute(context, planned.request, "export-call");
    expect(complete).toMatchObject({
      state: "complete",
      counts: { fileCount: "2", rowCount: "1" },
      download: { indexPath: `/api/hosted-operator/exports/${planned.plan.exportId}` },
    });
    expect(await f.operations.execute(context, planned.request, "technical-retry")).toEqual(
      complete,
    );
    f.dependencies.assertSetup = vi.fn<HostedTenantExportDependencies["assertSetup"]>(async () => {
      throw new HostedOperatorError("resource_mismatch");
    });
    expect(await f.operations.execute(context, planned.request, "after-app-revision")).toEqual(
      complete,
    );
    expect(await f.operations.approval(context, planned.request)).toEqual({ approved: true });

    expect(await f.operations.status(context, planned.plan.exportId)).toEqual(complete);
    expect(f.dependencies.runWorker).toHaveBeenCalledTimes(1);
    expect(f.dependencies.readApproval).toHaveBeenCalledTimes(1);
    expect(f.read().workers[0]?.locator).toMatchObject({
      sandboxId: "trusted-private-vm",
      commandId: "command-one",
      descriptor: fixture.descriptor,
    });
    expect(JSON.stringify(complete)).not.toContain("ciphertext");
  });
  it("reuses completion committed by another request while waiting for the physical lease", async () => {
    const f = setup();
    const planned = await f.operations.plan(context, "customer-one", "ordinary-request");
    f.approve();
    const acquire = f.dependencies.withResourceLease;
    f.dependencies.withResourceLease = async (input, run) => {
      f.dependencies.withResourceLease = acquire;
      await f.operations.execute(context, planned.request, "concurrent-completion");
      return await acquire(input, run);
    };
    expect(await f.operations.execute(context, planned.request, "waiting-request")).toMatchObject({
      state: "complete",
    });
    expect(f.dependencies.runWorker).toHaveBeenCalledTimes(1);
    expect(f.dependencies.inspect).not.toHaveBeenCalled();
    expect(f.read().journal.claim).toBeUndefined();
  });
  it("retains an uncertain attempt and blocks fresh SQL until terminal incomplete readback", async () => {
    const f = setup();
    const planned = await f.operations.plan(context, "customer-one", "ordinary-request");
    f.approve();
    f.dependencies.runWorker = vi.fn<HostedTenantExportDependencies["runWorker"]>(
      async (_context, _worker, locator, _assertCurrent, checkpoint) => {
        await checkpoint({ ...locator, commandId: "unknown-command" });
        throw new Error("private database error");
      },
    );
    await expect(f.operations.execute(context, planned.request, "export-call")).rejects.toThrow(
      "reconciliation_required",
    );
    const prior = f.read();
    await expect(f.operations.execute(context, planned.request, "retry")).rejects.toThrow(
      "reconciliation_required",
    );
    expect(f.dependencies.runWorker).toHaveBeenCalledTimes(1);
    expect(f.read().journal.attempts).toEqual(prior.journal.attempts);
    f.dependencies.inspect = vi.fn<HostedTenantExportDependencies["inspect"]>(async () => ({
      status: "incomplete",
      workerTerminal: true,
    }));
    f.dependencies.runWorker = vi.fn<HostedTenantExportDependencies["runWorker"]>(
      async (_context, _worker, _locator, assertCurrent) => {
        await assertCurrent();
        return {
          async readManifest() {
            return new Uint8Array();
          },
          async *readMember() {
            yield new Uint8Array();
          },
        };
      },
    );
    expect(await f.operations.execute(context, planned.request, "retry")).toMatchObject({
      state: "complete",
    });
    const attempts = f.read().journal.attempts;
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.state).toBe("failed");
    expect(attempts[0]?.attemptId).not.toBe(attempts[1]?.attemptId);
    expect(attempts[0]?.snapshotId).not.toBe(attempts[1]?.snapshotId);
    expect(f.dependencies.runWorker).toHaveBeenCalledTimes(1);
  });
  it("settles an already published uncertain attempt before any reread or worker creation", async () => {
    const f = setup();
    const planned = await f.operations.plan(context, "customer-one", "ordinary-request");
    f.approve();
    f.dependencies.publish = vi.fn<HostedTenantExportDependencies["publish"]>(async () => {
      throw new Error("unknown publication acknowledgement");
    });
    await expect(f.operations.execute(context, planned.request, "export-call")).rejects.toThrow(
      "reconciliation_required",
    );
    f.dependencies.inspect = vi.fn<HostedTenantExportDependencies["inspect"]>(
      async (_context, worker) => ({
        status: "complete",
        completion: completionFor(worker),
      }),
    );
    expect(await f.operations.execute(context, planned.request, "retry")).toMatchObject({
      state: "complete",
    });
    expect(f.dependencies.prepareWorker).toHaveBeenCalledTimes(1);
    expect(f.dependencies.runWorker).toHaveBeenCalledTimes(1);
  });
  it("rechecks owner before dispatch and does not expose a completed export to revoked authority", async () => {
    const f = setup();
    const planned = await f.operations.plan(context, "customer-one", "ordinary-request");
    f.approve();
    f.dependencies.prepareWorker = vi.fn<HostedTenantExportDependencies["prepareWorker"]>(
      async () => {
        f.revoke();
        return { sandboxId: "trusted-private-vm", descriptor: fixture.descriptor };
      },
    );
    await expect(f.operations.execute(context, planned.request, "export-call")).rejects.toThrow(
      "authorization_required",
    );
    expect(f.dependencies.runWorker).not.toHaveBeenCalled();
    await expect(f.operations.status(context, planned.plan.exportId)).rejects.toThrow(
      "authorization_required",
    );
  });
});

describe("existing operator transport export dispatch", () => {
  it("uses the real client and handler with explicit export actions while leaving preparation untouched", async () => {
    const f = setup();
    const selected = {
      appId: context.target.appId,
      branch: context.target.branch,
      environment: "preview" as const,
      projectId: context.target.projectId,
      sessionId: context.target.sessionId,
    };
    const ownerContext = {
      adapterGeneration: 1,
      adapterSessionId: "adapter",
      authority,
      kind: "direct" as const,
      principal: { ...authority, scopes: ["autograph:send"] },
      sessionId: context.target.sessionId,
    };
    const unavailable = async () => {
      throw new Error("Preparation must not execute during export");
    };
    const authorize = vi.fn<ProtectedHostedOperatorDependencies["authorize"]>(
      async (request, requestedSelection, owner) => {
        expect(request.headers.get("authorization")).toBe("Bearer workload-token");
        expect(request.headers.get("x-vercel-trusted-oidc-idp-token")).toBe("workload-token");
        expect(requestedSelection).toEqual(selected);
        expect(owner).toEqual(ownerContext);
        return { ...context, ownerContext };
      },
    );
    const prepare = vi.fn(unavailable);
    const authorizeRead = vi.fn(
      async (_request: Request, selectedContext: HostedOperatorContext) => selectedContext,
    );
    const dispatch = createTenantExportDispatcher({
      store: f.dependencies.store,
      operations: f.operations,
      verifyWorkload: async (request) => {
        expect(request.headers.get("authorization")).toBe("Bearer workload-token");
      },
      authorize,
      authorizeRead,
    });
    const handler = createProtectedHostedOperatorHandler({
      authorize,
      assertAuthorized: unavailable,
      plan: prepare,
      readApproval: unavailable,
      withResourceLease: unavailable,
      reconcile: unavailable,
      executeEffect: unavailable,
      verify: unavailable,
      bindings: unavailable,
      store: {
        read: unavailable,
        reserve: unavailable,
        compareAndSet: unavailable,
        reserveFenceGeneration: unavailable,
      },
      exportRequest: dispatch,
    });
    const client = createHostedOperatorClient({
      endpoint: "https://operator.test",
      ownerContext,
      sessionId: selected.sessionId,
      token: async () => "workload-token",
      fetch: async (url, init) => {
        expect(init).toHaveProperty("dispatcher");
        return await handler(new Request(url instanceof Request ? url.url : url, init));
      },
    });
    const planned = await client.planTenantExport(selected, "customer-one", "original-request");
    expect(await client.tenantExportApproval(planned.request)).toEqual({ approved: false });
    f.approve();
    expect(await client.tenantExportApproval(planned.request)).toEqual({ approved: true });
    await expect(
      client.planTenantExport(selected, "foreign-customer", "foreign-request"),
    ).rejects.toThrow("authorization_required");
    expect(f.dependencies.runWorker).not.toHaveBeenCalled();
    f.dependencies.publish = vi.fn<HostedTenantExportDependencies["publish"]>(
      async (_context, worker, _source, assertCurrent) => {
        for (let page = 0; page < 20; page += 1) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- Exercise repeated private publication guards under the same exact claim.
          await assertCurrent();
        }
        return completionFor(worker);
      },
    );
    const providerChecksBeforeExecution = authorize.mock.calls.length;
    const complete = await client.exportTenantData(planned.request, "export-call");
    expect(await client.tenantExportStatus(planned.plan.exportId)).toEqual(complete);
    expect(complete.state).toBe("complete");
    expect(prepare).not.toHaveBeenCalled();
    expect(authorize).toHaveBeenCalledTimes(providerChecksBeforeExecution + 1);
    expect(authorizeRead).toHaveBeenCalledTimes(3);
    expect(f.dependencies.runWorker).toHaveBeenCalledTimes(1);
  });
  it.each(["missing", "invalid"])(
    "rejects %s workload before private export lookup",
    async (credential) => {
      const f = setup();
      const planned = await f.operations.plan(context, "customer-one", "original-request");
      const read = vi.spyOn(f.dependencies.store, "read");
      const ownerContext = {
        adapterGeneration: 1,
        adapterSessionId: "adapter",
        authority,
        kind: "direct" as const,
        principal: { ...authority, scopes: ["autograph:send"] },
        sessionId: context.target.sessionId,
      };
      const authorize = vi.fn<ProtectedHostedOperatorDependencies["authorize"]>(
        async () => context,
      );
      const authorizeRead = vi.fn(
        async (_request: Request, selected: HostedOperatorContext) => selected,
      );
      const unavailable = async () => {
        throw new Error("No preparation or SQL may execute");
      };
      const verifyWorkload = createOperatorWorkloadVerifier(
        {
          audience: "https://vercel.com/team",
          environment: "production",
          issuer: "https://oidc.vercel.com/team",
          ownerId: "team",
          projectId: "builder",
          subject: "owner:team:project:builder:environment:production",
        },
        async () => {
          throw new Error("Malformed credentials must not reach key lookup");
        },
      );
      const dispatch = createTenantExportDispatcher({
        store: f.dependencies.store,
        operations: f.operations,
        verifyWorkload,
        authorize,
        authorizeRead,
      });
      const handler = createProtectedHostedOperatorHandler({
        authorize,
        assertAuthorized: unavailable,
        plan: unavailable,
        readApproval: unavailable,
        withResourceLease: unavailable,
        reconcile: unavailable,
        executeEffect: unavailable,
        verify: unavailable,
        bindings: unavailable,
        store: {
          read: unavailable,
          reserve: unavailable,
          compareAndSet: unavailable,
          reserveFenceGeneration: unavailable,
        },
        exportRequest: dispatch,
      });
      const actions = [
        { action: "export-status", exportId: planned.plan.exportId },
        { ...planned.request, action: "export-approval" },
        { ...planned.request, callId: "export-call" },
      ];
      for (const action of actions) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Each rejected ordinary transport action must remain before the private lookup.
        const response = await handler(
          new Request("https://operator.test/v1/runtime", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(credential === "invalid" ? { authorization: "Bearer invalid-token" } : {}),
            },
            body: JSON.stringify({ ...action, ownerContext }),
          }),
        );
        // oxlint-disable-next-line eslint/no-await-in-loop -- Read only this controlled rejection response.
        expect(await response.json()).toMatchObject({
          status: "blocked",
          code: "authorization_required",
        });
      }
      expect(read).not.toHaveBeenCalled();
      expect(authorize).not.toHaveBeenCalled();
      expect(authorizeRead).not.toHaveBeenCalled();
      expect(f.dependencies.prepareWorker).not.toHaveBeenCalled();
      expect(f.dependencies.runWorker).not.toHaveBeenCalled();
    },
  );
  it("denies a canonical foreign owner after the workload-authenticated metadata lookup without exporting data", async () => {
    const f = setup();
    const planned = await f.operations.plan(context, "customer-one", "original-request");
    const read = vi.spyOn(f.dependencies.store, "read");
    const verifyWorkload = vi.fn(async () => {});
    const authorizeRead = vi.fn(async () => {
      throw new HostedOperatorError("authorization_required");
    });
    const dispatch = createTenantExportDispatcher({
      store: f.dependencies.store,
      operations: f.operations,
      verifyWorkload,
      authorize: async () => context,
      authorizeRead,
    });
    const ownerContext = {
      adapterGeneration: 1,
      adapterSessionId: "stale-or-foreign-adapter",
      authority,
      kind: "direct" as const,
      principal: { ...authority, scopes: ["autograph:send"] },
      sessionId: context.target.sessionId,
    };
    await expect(
      dispatch(
        new Request("https://operator.test/v1/runtime", {
          headers: { authorization: "Bearer verified-workload" },
        }),
        {
          action: "export-status",
          exportId: planned.plan.exportId,
          ownerContext,
        },
      ),
    ).rejects.toThrow("authorization_required");
    expect(verifyWorkload).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(authorizeRead).toHaveBeenCalledTimes(1);
    expect(f.dependencies.prepareWorker).not.toHaveBeenCalled();
    expect(f.dependencies.runWorker).not.toHaveBeenCalled();
  });
  it.each(["fetch", "decode"])(
    "preserves uncertain export %s outcomes without retrying",
    async (failure) => {
      const f = setup();
      const planned = await f.operations.plan(context, "customer-one", "original-request");
      const transport = vi.fn<typeof fetch>(async (_url, options) => {
        expect(options).toHaveProperty("dispatcher");
        if (failure === "fetch") {
          throw new TypeError("connection outcome unknown");
        }
        return new Response("incomplete JSON", { status: 200 });
      });
      const client = createHostedOperatorClient({
        endpoint: "https://operator.test",
        ownerContext: {
          adapterGeneration: 1,
          adapterSessionId: "adapter",
          authority,
          kind: "direct",
          principal: { ...authority, scopes: ["autograph:send"] },
          sessionId: context.target.sessionId,
        },
        token: async () => "workload-token",
        fetch: transport,
      });
      await expect(client.exportTenantData(planned.request, "export-call")).rejects.toBeInstanceOf(
        HostedOperatorTransportUnknown,
      );
      expect(transport).toHaveBeenCalledTimes(1);
      const abort = new AbortController();
      abort.abort();
      transport.mockImplementationOnce(async () => {
        throw abort.signal.reason;
      });
      await expect(
        client.exportTenantData(planned.request, "cancelled-call", abort.signal),
      ).rejects.toBe(abort.signal.reason);
      expect(transport).toHaveBeenCalledTimes(2);
    },
  );
});

describe("export planning failure boundaries", () => {
  const ownerContext = {
    adapterGeneration: 1,
    adapterSessionId: "adapter",
    authority,
    kind: "direct" as const,
    principal: { ...authority, scopes: ["autograph:send"] },
    sessionId: context.target.sessionId,
  };
  const input = {
    action: "export-plan" as const,
    selection: { ...context.target, environment: "preview" as const },
    customerId: "customer-one",
    idempotencyKey: "diagnostic-request",
    ownerContext,
  };
  const request = () => new Request("https://operator.test/v1/runtime");

  it.each([
    "dispatcher_workload_verification",
    "dispatcher_owner_authorization",
    "plan_owner_authorization",
    "plan_prior_read",
    "release_selection",
    "release_match",
    "release_read",
    "setup_phase_validation",
    "setup_approval_authorization",
    "setup_match_resource",
    "plan_reservation",
    "plan_reservation_match",
  ] as const)("reports %s once and preserves the exact rejection", async (stage) => {
    const f = setup();
    const failure = new HostedOperatorError("resource_mismatch");
    const reject = async () => {
      throw failure;
    };
    const reserve = vi.spyOn(f.dependencies.store, "reserve");
    if (stage === "plan_owner_authorization") {
      f.dependencies.assertOwner = reject;
    } else if (stage === "plan_prior_read") {
      vi.spyOn(f.dependencies.store, "read").mockImplementation(reject);
    } else if (stage.startsWith("release_")) {
      f.dependencies.resolvePlan = async (_context, _customer, observe) => {
        observe?.(stage);
        throw failure;
      };
    } else if (stage.startsWith("setup_")) {
      f.dependencies.assertSetup = async (_context, _plan, observe) => {
        observe?.(stage);
        throw failure;
      };
    } else if (stage === "plan_reservation") {
      reserve.mockImplementation(reject);
    } else if (stage === "plan_reservation_match") {
      reserve.mockImplementation(async ({ record }) => ({
        ...record,
        journal: { ...record.journal, idempotencyKey: "conflicting-request" },
      }));
    }
    const consoleSink = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const dispatch = createTenantExportDispatcher({
        store: f.dependencies.store,
        operations: createHostedTenantExportOperations(f.dependencies),
        verifyWorkload: stage === "dispatcher_workload_verification" ? reject : async () => {},
        authorize: stage === "dispatcher_owner_authorization" ? reject : async () => context,
        authorizeRead: async (_request, selected) => selected,
      });
      const outcome = dispatch(request(), input);
      await (stage === "plan_reservation_match"
        ? expect(outcome).rejects.toThrow("resource_mismatch")
        : expect(outcome).rejects.toBe(failure));
      expect(consoleSink).toHaveBeenCalledOnce();
      expect(consoleSink.mock.calls[0]?.[1]).toMatchObject({
        boundary: "operator",
        exportPlanningFailure: { stage, errorClass: "operator_error" },
      });
      expect(JSON.stringify(consoleSink.mock.calls)).not.toContain(context.target.sessionId);
      expect(f.dependencies.runWorker).not.toHaveBeenCalled();
      if (!stage.startsWith("plan_reservation")) {
        expect(reserve).not.toHaveBeenCalled();
      }
    } finally {
      consoleSink.mockRestore();
    }
  });

  it("keeps a throwing observer from changing nested plan checks or reservation", async () => {
    const f = setup();
    const nested: ExportPlanningStage[] = [];
    f.dependencies.resolvePlan = async (_context, _customer, observe) => {
      observe?.("release_selection");
      nested.push("release_selection");
      return selection;
    };
    f.dependencies.assertSetup = async (_context, _plan, observe) => {
      observe?.("setup_match");
      nested.push("setup_match");
    };
    const planned = await f.operations.plan(context, "customer-one", "safe-observer", () => {
      throw new Error("private diagnostic sink failure");
    });
    expect(planned.status.state).toBe("planned");
    expect(nested).toEqual(["release_selection", "setup_match"]);
    expect(f.read().journal.plan).toEqual(planned.plan);
    expect(f.dependencies.runWorker).not.toHaveBeenCalled();
  });

  it("does not emit export-plan diagnostics for a status rejection", async () => {
    const f = setup();
    const failure = new HostedOperatorError("resource_mismatch");
    const consoleSink = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const dispatch = createTenantExportDispatcher({
        store: {
          read: async () => {
            throw failure;
          },
        },
        operations: f.operations,
        verifyWorkload: async () => {},
        authorize: async () => context,
        authorizeRead: async (_request, selected) => selected,
      });
      await expect(
        dispatch(request(), {
          action: "export-status",
          ownerContext,
          exportId: "40000000-0000-4000-8000-000000000004",
        }),
      ).rejects.toBe(failure);
      expect(consoleSink).not.toHaveBeenCalled();
    } finally {
      consoleSink.mockRestore();
    }
  });

  it("preserves workload failure when the diagnostic context or console sink throws", async () => {
    const f = setup();
    const failure = new TypeError("private failure details");
    const consoleSink = vi.spyOn(console, "info").mockImplementation(() => {
      throw new Error("sink unavailable");
    });
    const dispatch = createTenantExportDispatcher({
      store: f.dependencies.store,
      operations: f.operations,
      verifyWorkload: async () => {
        throw failure;
      },
      authorize: async () => context,
      authorizeRead: async (_request, selected) => selected,
    });
    try {
      await expect(dispatch(request(), input)).rejects.toBe(failure);
      const hostileInput = {
        ...input,
        get ownerContext(): typeof ownerContext {
          throw new Error("invalid diagnostic context");
        },
      };
      await expect(dispatch(request(), hostileInput)).rejects.toBe(failure);
    } finally {
      consoleSink.mockRestore();
    }
  });
});

describe("approved installed tenant export scope", () => {
  it.each([false, true])(
    "freezes the resolved tenant and keeps extraction approval separate (semantic=%s)",
    async (semantic) => {
      const f = setup();
      const resolveOwnerOrganization = vi.fn(async () => {
        if (!semantic) {
          throw new Error("Explicit selection must bypass historical resolution");
        }
        return "customer-one";
      });
      const dispatch = createTenantExportDispatcher({
        store: f.dependencies.store,
        operations: f.operations,
        verifyWorkload: async () => {},
        authorize: async () => context,
        authorizeRead: async (_request, selected) => selected,
        resolveOwnerOrganization,
      });
      const response = await dispatch(
        new Request("https://operator.test/exports", { method: "POST" }),
        tenantExportTransportRequestSchema.parse({
          action: "export-plan",
          idempotencyKey: "owned-selection",
          selection: {
            appId: context.target.appId,
            branch: context.target.branch,
            environment: "preview",
            projectId: context.target.projectId,
            sessionId: context.target.sessionId,
          },
          ownerContext: {
            adapterGeneration: 1,
            adapterSessionId: "adapter",
            authority,
            kind: "direct",
            principal: { ...authority, scopes: ["autograph:send"] },
            sessionId: context.target.sessionId,
          },
          ...(semantic ? { customerScope: "owner-organization" } : { customerId: "customer-one" }),
        }),
      );
      expect(response.status).toBe(200);
      expect(f.read().journal.plan.scope.customerId).toBe("customer-one");
      expect(resolveOwnerOrganization).toHaveBeenCalledTimes(semantic ? 1 : 0);
      expect(f.dependencies.runWorker).not.toHaveBeenCalled();
      await expect(
        f.operations.execute(
          context,
          tenantExportPlannedSchema.parse(await response.json()).request,
          "unapproved-extraction",
        ),
      ).rejects.toThrow();
      expect(f.dependencies.runWorker).not.toHaveBeenCalled();
    },
  );

  it("allows retained installed tenants without regranting current actor access", () => {
    const plan = {
      access: [{ actorId: "qa-actor", organizationId: "qa-org", roles: ["reviewer"] }],
      appInstallation: { customerIds: ["original-org", "qa-org"] },
    };
    expect(() => {
      assertTenantExportCustomer(plan, "original-org");
    }).not.toThrow();
    expect(() => {
      assertTenantExportCustomer(plan, "foreign-org");
    }).toThrow();
    expect(() => {
      assertTenantExportCustomer({ access: plan.access }, "original-org");
    }).toThrow();
  });
  it("requires exactly one raw or semantic export selection", () => {
    const base = {
      action: "export-plan",
      selection: {
        appId: context.target.appId,
        branch: context.target.branch,
        environment: "preview",
        projectId: context.target.projectId,
        sessionId: context.target.sessionId,
      },
      idempotencyKey: "selection",
      ownerContext: {
        adapterGeneration: 1,
        adapterSessionId: "adapter",
        authority,
        kind: "direct",
        principal: { ...authority, scopes: ["autograph:send"] },
        sessionId: context.target.sessionId,
      },
    };
    expect(
      tenantExportTransportRequestSchema.safeParse({ ...base, customerId: "original-org" }).success,
    ).toBe(true);
    expect(
      tenantExportTransportRequestSchema.safeParse({ ...base, customerScope: "owner-organization" })
        .success,
    ).toBe(true);
    expect(tenantExportTransportRequestSchema.safeParse(base).success).toBe(false);
    expect(
      tenantExportTransportRequestSchema.safeParse({
        ...base,
        customerId: "original-org",
        customerScope: "owner-organization",
      }).success,
    ).toBe(false);
  });
});
