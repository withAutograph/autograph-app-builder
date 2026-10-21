/* oxlint-disable unicorn/no-await-expression-member -- Assertions inspect the completed journal outcome directly. */
import { describe, expect, it, vi } from "vitest";
import type { ApprovalResponseContext } from "eve/tools/approval";
import {
  createNativeTargetOnboardingRuntime,
  nativeTargetPlanRequestSchema,
  nativeTargetPreparationRequestSchema,
} from "./native-target-onboarding-runtime";
import type {
  NativeTargetSelectedAppState,
  NativeTargetPreparationRequest,
  NativeTargetOnboardingRuntimePorts,
} from "./native-target-onboarding-runtime";
import type {
  NativeTargetOnboardingPlan,
  NativeTargetOnboardingApproval,
} from "../provisioning/native-target-onboarding-contract";
import { nativeTargetRequiredProjectProtection } from "../provisioning/native-target-onboarding-contract";
import {
  createInMemoryNativeTargetOnboardingStore,
  createNativeTargetOnboardingRegistry,
} from "../provisioning/native-target-onboarding-store";

const fixture = () => {
  const time = new Date("2026-10-21T16:00:00Z");
  const authority = {
    issuer: "https://builder.example/api/auth",
    audience: "https://builder.example/mcp",
    workspaceId: "workspace",
    ownerUserId: "owner",
  };
  const owner = {
    authority,
    publicSessionId: "public-session",
    adapterSessionId: "adapter",
    adapterGeneration: 1,
  };
  const plan: NativeTargetOnboardingPlan = {
    version: 1,
    appId: "invoice-review",
    origin: {
      publicSessionId: owner.publicSessionId,
      adapterSessionId: owner.adapterSessionId,
      adapterGeneration: 1,
      appSpecDigest: "a".repeat(64),
      release: {
        id: "release-1",
        artifactRef: "artifact",
        manifestSha256: "b".repeat(64),
        schemaSha256: "c".repeat(64),
      },
    },
    project: {
      name: "invoice-review",
      teamId: "team",
      installationId: "installation",
      projectSettings: {
        framework: null,
        rootDirectory: "apps/invoice-review",
        sourceFilesOutsideRootDirectory: true,
      },
      protection: nativeTargetRequiredProjectProtection,
    },
    branch: "preview",
    appDatabase: {
      resourceId: "app-resource",
      database: "invoice_data",
      migratorRole: "invoice_migrator",
      runtimeRole: "invoice_runtime",
    },
    productRoles: [],
    nativeNeon: {
      approvalReference: "neon-human-approval",
      nativeStore: {
        configurationId: "configuration",
        resourceId: "native-resource",
        sourceProjectId: "source-project",
      },
      scope: {
        projectId: "neon-project",
        branchId: "neon-branch",
        endpointId: "endpoint",
        hostname: "db.example",
        maintenanceDatabase: "neondb",
        maintenanceRole: "maintenance",
      },
    },
    worker: {
      id: "worker",
      executablePath: "/worker/install",
      sha256: "d".repeat(64),
      operationScope: "generated-app-release-install-v1",
      subcommand: "protected-generated-app-install",
    },
    cost: { ownership: "current-owner", description: "Dedicated Preview project" },
    retention: { policy: "Retain until owner cleanup" },
    conflictPolicy: "stop-on-conflict",
  };
  const state: NativeTargetSelectedAppState = {
    phase: "app_spec_accepted",
    appSpec: { appId: plan.appId, digest: plan.origin.appSpecDigest },
  };
  const ctx = {
    session: { id: "adapter", auth: {} },
    callId: "call",
    abortSignal: new AbortController().signal,
  };
  const store = createInMemoryNativeTargetOnboardingStore();
  let receipt: NativeTargetOnboardingApproval | null = null;
  let allowed = true;
  const authorize = () => {
    if (!allowed) {
      throw new Error("denied");
    }
    return Promise.resolve(owner);
  };
  const registry = createNativeTargetOnboardingRegistry({
    store,
    authorize,
    assertPlanOrigin: () => Promise.resolve(),
    readApproval: () => Promise.resolve(receipt),
    now: () => time,
  });
  const read = async () => {
    await authorize();
    return await store.read({ authority, appId: plan.appId });
  };
  const createProject = vi.fn<NativeTargetOnboardingRuntimePorts["createProject"]>(
    async (_ctx, input) => {
      await input.authorizeAttempt();
      await input.acceptProjectId("created-project");
      return {
        status: "verified",
        projectId: "created-project",
        name: input.candidateName,
        scopeId: plan.project.teamId,
        settings: plan.project.projectSettings,
        protection: plan.project.protection,
      };
    },
  );
  const observeProject = vi.fn<NativeTargetOnboardingRuntimePorts["observeProject"]>(
    (_ctx, input) =>
      Promise.resolve({
        status: "verified",
        projectId: input.projectId,
        name: input.candidateName,
        scopeId: plan.project.teamId,
        settings: plan.project.projectSettings,
        protection: plan.project.protection,
      }),
  );
  const ports: NativeTargetOnboardingRuntimePorts = {
    now: () => time,
    readCapturedRelease: vi.fn<NativeTargetOnboardingRuntimePorts["readCapturedRelease"]>(() =>
      Promise.resolve({
        release: plan.origin.release,
        description: {
          version: 1,
          app: { id: plan.appId, routes: [], workspacePath: "apps/invoice-review" },
          backend: {
            kind: "generated-postgres",
            authorization: "declared-policy",
            roles: [],
            release: {
              id: "release-1",
              artifactHash: `sha256:${"c".repeat(64)}`,
              directory: ".release",
            },
            runtime: { databaseEnvironment: "DATABASE_URL" },
            schemaReceipt: null,
          },
          validation: {
            browser: null,
            check: { task: "check" },
            test: { task: "test", shards: 1 },
          },
        },
      }),
    ),
    resolvePlan: vi.fn(() => Promise.resolve(plan)),
    readSettledApproval: vi.fn(async () => {
      await authorize();
      return receipt;
    }),
    authorizeApprovalResponse: vi.fn(async () => {
      await authorize();
    }),
    journal: {
      ...registry,
      authorizeAttempt: async (invocation, appId, attemptId, leaseId) => {
        await registry.authorizeAttempt(invocation, appId, attemptId, leaseId);
      },
    },
    createProject,
    observeProject,
  };
  const runtime = createNativeTargetOnboardingRuntime(ports);
  const proposal = {
    appId: plan.appId,
    project: {
      name: plan.project.name,
      teamId: plan.project.teamId,
      installationId: plan.project.installationId,
      projectSettings: plan.project.projectSettings,
    },
    branch: plan.branch,
    conflictPolicy: plan.conflictPolicy,
  };
  const planned = async () => {
    const result = await runtime.plan(proposal, ctx, state);
    return nativeTargetPreparationRequestSchema.parse({
      appId: result.appId,
      operationRef: result.operationRef,
      planDigest: result.planDigest,
      plan: result.plan,
    });
  };
  const approve = (input: NativeTargetPreparationRequest, requestId = "approval-request") => {
    receipt = {
      requestId,
      callId: requestId === "approval-request" ? ctx.callId : `${ctx.callId}-${requestId}`,
      planDigest: input.planDigest,
      responderPrincipalId: authority.ownerUserId,
      publicSessionId: owner.publicSessionId,
      outcome: "approved",
      observedAt: time.toISOString(),
    };
  };
  return {
    plan,
    state,
    ctx,
    ports,
    runtime,
    proposal,
    planned,
    approve,
    read,
    cancel: () => {
      if (receipt === null) {
        throw new Error("missing receipt");
      }
      receipt = { ...receipt, outcome: "cancelled" };
    },
    revoke: () => {
      allowed = false;
    },
  };
};

describe("native target workflow runtime", () => {
  it("plans before project allocation using captured empty roles without defaults", async () => {
    const f = fixture();
    const input = await f.planned();
    expect(input.plan.productRoles).toEqual([]);
    expect((await f.read())?.record.stage).toBe("planned");
    expect(f.ports.createProject).not.toHaveBeenCalled();
    expect(f.ports.readCapturedRelease).toHaveBeenCalled();
  });
  it("rejects invented approval/owner facts and model role defaults", () => {
    const f = fixture();
    expect(
      nativeTargetPlanRequestSchema.safeParse({
        ...f.proposal,
        ownerUserId: "other",
        productRoles: ["admin"],
      }).success,
    ).toBe(false);
    expect(
      nativeTargetPreparationRequestSchema.safeParse({ appId: f.plan.appId, approval: true })
        .success,
    ).toBe(false);
  });
  it("rejects the wrong selected app and captured product role substitution", async () => {
    const f = fixture();
    await expect(
      f.runtime.plan({ ...f.proposal, appId: "other-app" }, f.ctx, f.state),
    ).rejects.toThrow();
    f.plan.productRoles = ["administrator"];
    await expect(f.planned()).rejects.toThrow();
    expect(await f.read()).toBeUndefined();
  });
  it("does not treat an authorized approval candidate as settled human approval", async () => {
    const f = fixture();
    const input = await f.planned();
    const response: ApprovalResponseContext<NativeTargetPreparationRequest> = {
      request: {
        toolName: "prepare-app-native-target",
        toolInput: input,
        requestId: "request",
        callId: "call",
      },
      responder: {
        principalId: "owner",
        authenticator: "test",
        principalType: "user",
        attributes: {},
      },
      session: { id: "adapter", initiator: null, turn: { id: "turn", sequence: 0 } },
      response: { decision: "approve" },
      auth: {
        getToken: () => Promise.reject(new Error("unused")),
        requireAuth: () => {
          throw new Error("unused");
        },
      },
    };
    await f.runtime.authorizeApprovalResponse(response);
    expect(await f.runtime.hasApproval(input, f.ctx)).toBe(false);
    expect((await f.runtime.prepare(input, f.ctx)).status).toBe("approval-pending");
    expect(f.ports.createProject).not.toHaveBeenCalled();
  });
  it("persists approval and attempt before one POST and retains the accepted ID", async () => {
    const f = fixture();
    const input = await f.planned();
    f.approve(input);
    const realCreate = f.ports.createProject;
    f.ports.createProject = vi.fn<NativeTargetOnboardingRuntimePorts["createProject"]>(
      async (ctx, request) => {
        const row = await f.read();
        expect(row?.record.stage).toBe("creating");
        expect(row !== undefined && "approval" in row.record && row.record.approval.outcome).toBe(
          "approved",
        );
        return await realCreate(ctx, request);
      },
    );
    expect((await f.runtime.prepare(input, f.ctx)).status).toBe("ready");
    expect((await f.runtime.prepare(input, f.ctx)).status).toBe("ready");
    expect(f.ports.createProject).toHaveBeenCalledTimes(1);
    expect((await f.read())?.record.stage).toBe("ready");
  });
  it("retains an unknown create and never repeats or adopts it from a name lookup", async () => {
    const f = fixture();
    const input = await f.planned();
    f.approve(input);
    f.ports.createProject = vi.fn<NativeTargetOnboardingRuntimePorts["createProject"]>(
      async (_ctx, request) => {
        await request.authorizeAttempt();
        throw new Error("transport lost");
      },
    );
    expect((await f.runtime.prepare(input, f.ctx)).status).toBe("pending");
    expect((await f.runtime.prepare(input, f.ctx)).status).toBe("pending");
    expect(f.ports.createProject).toHaveBeenCalledTimes(1);
    expect(f.ports.observeProject).not.toHaveBeenCalled();
    expect((await f.read())?.record.stage).toBe("unknown");
  });
  it("recovers an independently accepted project with GET only", async () => {
    const f = fixture();
    const input = await f.planned();
    f.approve(input);
    f.ports.createProject = vi.fn<NativeTargetOnboardingRuntimePorts["createProject"]>(
      async (_ctx, request) => {
        await request.authorizeAttempt();
        await request.acceptProjectId("retained-project");
        return {
          status: "uncertain",
          projectId: "retained-project",
          reason: "provider_unavailable",
        };
      },
    );
    await f.runtime.prepare(input, f.ctx);
    expect((await f.runtime.prepare(input, f.ctx)).status).toBe("ready");
    expect(f.ports.createProject).toHaveBeenCalledTimes(1);
    expect(f.ports.observeProject).toHaveBeenCalledWith(
      f.ctx,
      expect.objectContaining({ projectId: "retained-project" }),
    );
  });
  it("requires current authority again at the provider attempt boundary", async () => {
    const f = fixture();
    const input = await f.planned();
    f.approve(input);
    let posts = 0;
    f.ports.createProject = vi.fn<NativeTargetOnboardingRuntimePorts["createProject"]>(
      async (_ctx, request) => {
        f.revoke();
        await request.authorizeAttempt();
        posts += 1;
        return { status: "uncertain", reason: "unknown_write" };
      },
    );
    await expect(f.runtime.prepare(input, f.ctx)).rejects.toThrow();
    expect(posts).toBe(0);
  });
  it("does not accept a changed plan or a different operation", async () => {
    const f = fixture();
    const input = await f.planned();
    f.approve(input);
    await expect(
      f.runtime.prepare({ ...input, plan: { ...input.plan, branch: "other" } }, f.ctx),
    ).rejects.toThrow();
    await expect(
      f.runtime.prepare({ ...input, operationRef: "00000000-0000-4000-8000-000000000000" }, f.ctx),
    ).rejects.toThrow();
    expect(f.ports.createProject).not.toHaveBeenCalled();
  });
  it("allows ordinary later source changes to reuse the same ready target", async () => {
    const f = fixture();
    const input = await f.planned();
    f.approve(input);
    await f.runtime.prepare(input, f.ctx);
    const changed: NativeTargetSelectedAppState = {
      ...f.state,
      appSpec: { appId: f.plan.appId, digest: "e".repeat(64) },
    };
    expect((await f.runtime.plan(f.proposal, f.ctx, changed)).operationRef).toBe(
      input.operationRef,
    );
    expect(f.ports.readCapturedRelease).toHaveBeenCalledTimes(1);
    expect(f.ports.createProject).toHaveBeenCalledTimes(1);
  });
  it("serializes concurrent mutating continuations through the attempt CAS", async () => {
    const f = fixture();
    const input = await f.planned();
    f.approve(input);
    await Promise.allSettled([f.runtime.prepare(input, f.ctx), f.runtime.prepare(input, f.ctx)]);
    expect(f.ports.createProject).toHaveBeenCalledTimes(1);
    expect((await f.read())?.record.stage).toBe("ready");
  });
  it("returns a definite provider conflict without looping another create", async () => {
    const f = fixture();
    const input = await f.planned();
    f.approve(input);
    f.ports.createProject = vi.fn<NativeTargetOnboardingRuntimePorts["createProject"]>(
      async (_ctx, request) => {
        await request.authorizeAttempt();
        return { status: "rejected", reason: "collision" };
      },
    );
    const result = await f.runtime.prepare(input, f.ctx);
    expect(result.status).toBe("blocked");
    expect(f.ports.createProject).toHaveBeenCalledTimes(1);
    expect((await f.read())?.record.previousAttempts).toHaveLength(1);
    expect((await f.runtime.prepare(input, f.ctx)).status).toBe("blocked");
    expect(f.ports.createProject).toHaveBeenCalledTimes(1);
  });
  it("records terminal cancellation and prevents another approval or dispatch", async () => {
    const f = fixture();
    const input = await f.planned();
    f.approve(input);
    f.cancel();
    expect((await f.runtime.prepare(input, f.ctx)).status).toBe("cancelled");
    await expect(f.runtime.hasApproval(input, f.ctx)).rejects.toThrow();
    expect(f.ports.createProject).not.toHaveBeenCalled();
  });
  it("uses a suffix only after a confirmed collision in this continuation", async () => {
    const f = fixture();
    f.plan.conflictPolicy = "suffix-on-confirmed-conflict";
    f.proposal.conflictPolicy = "suffix-on-confirmed-conflict";
    const input = await f.planned();
    f.approve(input);
    const realCreate = f.ports.createProject;
    const names: string[] = [];
    f.ports.createProject = vi.fn<NativeTargetOnboardingRuntimePorts["createProject"]>(
      async (ctx, request) => {
        names.push(request.candidateName);
        if (names.length === 1) {
          await request.authorizeAttempt();
          return { status: "rejected", reason: "collision" };
        }
        return await realCreate(ctx, request);
      },
    );
    expect((await f.runtime.prepare(input, f.ctx)).status).toBe("ready");
    expect(names[0]).toBe(f.plan.project.name);
    expect(names[1]).toMatch(new RegExp(`^${f.plan.project.name}-[a-z0-9]{6}$`, "u"));
  });
  it("does not infer a name collision from a prior rate limit", async () => {
    const f = fixture();
    f.plan.conflictPolicy = "suffix-on-confirmed-conflict";
    f.proposal.conflictPolicy = "suffix-on-confirmed-conflict";
    const input = await f.planned();
    f.approve(input);
    const names: string[] = [];
    f.ports.createProject = vi.fn<NativeTargetOnboardingRuntimePorts["createProject"]>(
      async (_ctx, request) => {
        await request.authorizeAttempt();
        names.push(request.candidateName);
        return { status: "rejected", reason: "rate_limited" };
      },
    );
    await f.runtime.prepare(input, f.ctx);
    await f.runtime.prepare(input, f.ctx);
    expect(names).toEqual([f.plan.project.name, f.plan.project.name]);
  });
  it("retains the same suffixed candidate after a technical provider rejection", async () => {
    const f = fixture();
    f.plan.conflictPolicy = "suffix-on-confirmed-conflict";
    f.proposal.conflictPolicy = "suffix-on-confirmed-conflict";
    const input = await f.planned();
    f.approve(input);
    const names: string[] = [];
    f.ports.createProject = vi.fn<NativeTargetOnboardingRuntimePorts["createProject"]>(
      async (_ctx, request) => {
        await request.authorizeAttempt();
        names.push(request.candidateName);
        return names.length === 1
          ? { status: "rejected", reason: "collision" }
          : { status: "rejected", reason: "rate_limited" };
      },
    );
    await f.runtime.prepare(input, f.ctx);
    await f.runtime.prepare(input, f.ctx);
    expect(names).toHaveLength(3);
    expect(names[0]).toBe(f.plan.project.name);
    expect(names[1]).not.toBe(names[0]);
    expect(names[2]).toBe(names[1]);
  });
  it("replans an undispatched cancellation with a new human approval identity", async () => {
    const f = fixture();
    const original = await f.planned();
    f.approve(original);
    f.cancel();
    await f.runtime.prepare(original, f.ctx);
    const replanned = await f.planned();
    expect((await f.read())?.record.stage).toBe("planned");
    expect((await f.read())?.record.priorCancellations).toHaveLength(1);
    expect(await f.runtime.hasApproval(replanned, f.ctx)).toBe(false);
    f.approve(replanned, "new-request");
    expect((await f.runtime.prepare(replanned, f.ctx)).status).toBe("ready");
    expect(f.ports.createProject).toHaveBeenCalledTimes(1);
  });
});
