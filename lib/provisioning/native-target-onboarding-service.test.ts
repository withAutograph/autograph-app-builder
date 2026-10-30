import { describe, expect, it, vi } from "vitest";
import type { PrivateNativeTargetApprovalObservation } from "../eve/private-native-target-approval";
import type { MessageStreamEvent } from "eve/client";
import { HostedSessionReadTimeoutError } from "../eve/hosted-session-read-timeout-error";
import { HostedOperatorError } from "./hosted-operator-contract";
import {
  createPrivateNativeTargetApprovalCapture,
  readPrivateNativeTargetApproval,
} from "../eve/private-native-target-approval";
import {
  createInMemoryNativeTargetOnboardingStore,
  createNativeTargetOnboardingRegistry,
} from "./native-target-onboarding-store";
import {
  nativeTargetOnboardingPlanDigest,
  nativeTargetOnboardingPlanSchema,
  nativeTargetRequiredProjectProtection,
} from "./native-target-onboarding-contract";
import {
  nativeTargetTerminalApprovalResultSchema,
  nativeTargetTransportRequestSchema,
  nativeTargetTransportResponseSchemas,
} from "./native-target-onboarding-transport";
import type { NativeTargetTransportRequest } from "./native-target-onboarding-transport";
import {
  createNativeTargetOnboardingService,
  NativeTargetExistingConfiguredTargetError,
} from "./native-target-onboarding-service";
import type { NativeTargetOnboardingServiceDependencies } from "./native-target-onboarding-service";

const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace",
  ownerUserId: "owner",
};
const principal = { ...authority, scopes: ["autograph:session"] };
const historyOwner = {
  authority,
  principal,
  kind: "direct" as const,
  sessionId: "public-one",
  adapterSessionId: "adapter-one",
  adapterGeneration: 1,
};
const current = {
  authority,
  historyOwner,
  publicSessionId: historyOwner.sessionId,
  adapterSessionId: historyOwner.adapterSessionId,
  adapterGeneration: 1,
};
const plan = nativeTargetOnboardingPlanSchema.parse({
  version: 1,
  appId: "requests-app",
  origin: {
    publicSessionId: current.publicSessionId,
    adapterSessionId: current.adapterSessionId,
    adapterGeneration: 1,
    appSpecDigest: "a".repeat(64),
    release: {
      id: "release",
      artifactRef: "captured-artifact",
      manifestSha256: "b".repeat(64),
      schemaSha256: "c".repeat(64),
    },
  },
  project: {
    name: "requests-app",
    teamId: "team",
    installationId: "installation",
    projectSettings: {
      framework: null,
      rootDirectory: "apps/requests",
      sourceFilesOutsideRootDirectory: true,
    },
    protection: nativeTargetRequiredProjectProtection,
  },
  branch: "main",
  appDatabase: {
    resourceId: "resource",
    database: "requests_data",
    migratorRole: "requests_migrator",
    runtimeRole: "requests_runtime",
  },
  productRoles: ["viewer"],
  nativeNeon: {
    nativeStore: { configurationId: "config", resourceId: "resource", sourceProjectId: "source" },
    scope: {
      projectId: "neon",
      branchId: "branch",
      endpointId: "endpoint",
      hostname: "ep-test.neon.tech",
      maintenanceDatabase: "maintenance",
      maintenanceRole: "installer",
    },
  },
  worker: {
    id: "generic",
    executablePath: "/trusted/installer",
    sha256: "d".repeat(64),
    operationScope: "generated-app-release-install-v1",
    subcommand: "protected-generated-app-install",
  },
  cost: { ownership: "current-owner", description: "Owner team billing" },
  retention: { policy: "Until approved deletion" },
  conflictPolicy: "stop-on-conflict",
});
const request = () =>
  new Request("https://operator.example/v1/runtime", {
    method: "POST",
    headers: { authorization: "Bearer verified-builder-token" },
  });
const fixture = (workloadAuthorized = true, selectedPlan = plan) => {
  const fixturePlan = selectedPlan;
  const fixtureDigest = nativeTargetOnboardingPlanDigest(fixturePlan);
  const store = createInMemoryNativeTargetOnboardingStore();
  let approved = false;
  let existingConfiguredTarget = false;
  let currentOwner = structuredClone(current);
  const events: string[] = [];
  const authorize = vi.fn(() => Promise.resolve(structuredClone(currentOwner)));
  const createProject = vi.fn(
    async (input: {
      authorizeAttempt: () => Promise<void>;
      acceptProjectId: (projectId: string) => Promise<void>;
    }) => {
      events.push("create");
      await input.authorizeAttempt();
      events.push("authorized");
      await input.acceptProjectId("project-id");
      events.push("accepted");
      return {
        status: "verified" as const,
        projectId: "project-id",
        name: fixturePlan.project.name,
        settings: fixturePlan.project.projectSettings,
        protection: fixturePlan.project.protection,
        scopeId: fixturePlan.project.teamId,
      };
    },
  );
  const approvals: { authorization: string | null; signal: AbortSignal }[] = [];
  const dependencies: NativeTargetOnboardingServiceDependencies = {
    store,
    verifyWorkload: () => {
      events.push("workload");
      return workloadAuthorized ? Promise.resolve() : Promise.reject(new Error("unauthorized"));
    },
    authorize,
    readCapturedRelease: () =>
      Promise.resolve({
        release: fixturePlan.origin.release,
        description: {
          version: 1,
          app: { id: fixturePlan.appId, routes: [], workspacePath: "apps/requests" },
          backend: {
            kind: "generated-postgres",
            authorization: "declared-policy",
            roles: ["viewer"],
            runtime: { databaseEnvironment: "DATABASE_URL" },
            schemaReceipt: null,
            release: {
              id: fixturePlan.origin.release.id,
              artifactHash: `sha256:${fixturePlan.origin.release.schemaSha256}`,
              directory: "apps/requests",
            },
          },
          validation: {
            browser: null,
            check: { task: "check" },
            test: { shards: 1, task: "test" },
          },
        },
      }),
    resolvePlan: () =>
      existingConfiguredTarget
        ? Promise.reject(new NativeTargetExistingConfiguredTargetError())
        : Promise.resolve(fixturePlan),
    readApproval: (_owner, _record, _callId, workload) => {
      approvals.push(workload);
      return Promise.resolve(
        approved
          ? {
              requestId: "approval",
              callId: "call-one",
              planDigest: fixtureDigest,
              responderPrincipalId: authority.ownerUserId,
              publicSessionId: current.publicSessionId,
              outcome: "approved" as const,
              observedAt: "2026-10-21T15:00:00.000Z",
            }
          : null,
      );
    },
    createProject,
    observeProject: () =>
      Promise.resolve({
        status: "uncertain" as const,
        projectId: "project-id",
        reason: "provider_unavailable" as const,
      }),
  };
  const readCapturedRelease = vi.spyOn(dependencies, "readCapturedRelease");
  const resolvePlan = vi.spyOn(dependencies, "resolvePlan");
  const service = createNativeTargetOnboardingService(dependencies);
  const common = {
    ownerContext: historyOwner,
    adapterSessionId: current.adapterSessionId,
    callId: "call-one",
  };
  const proposal = {
    appId: fixturePlan.appId,
    project: {
      name: fixturePlan.project.name,
      teamId: fixturePlan.project.teamId,
      installationId: fixturePlan.project.installationId,
      projectSettings: fixturePlan.project.projectSettings,
    },
    branch: fixturePlan.branch,
    conflictPolicy: fixturePlan.conflictPolicy,
  };
  const prepared = {
    appId: fixturePlan.appId,
    plan: fixturePlan,
    planDigest: fixtureDigest,
    operationRef: "",
  };
  const send = async (body: NativeTargetTransportRequest, incoming = request()) =>
    await service(incoming, nativeTargetTransportRequestSchema.parse(body));
  const planOnce = async () => {
    const response = await send({
      ...common,
      action: "native-target-plan",
      input: proposal,
      selectedApp: { appId: fixturePlan.appId, appSpecDigest: fixturePlan.origin.appSpecDigest },
    });
    return nativeTargetTransportResponseSchemas["native-target-plan"].parse(await response.json());
  };
  return {
    authorize,
    dependencies,
    store,
    readCapturedRelease,
    resolvePlan,
    approvals,
    common,
    createProject,
    events,
    planOnce,
    proposal,
    prepared,
    send,
    approve: () => {
      approved = true;
    },
    changeOwner: () => {
      currentOwner = { ...currentOwner, adapterGeneration: 2 };
    },
    configureExistingTarget: () => {
      existingConfiguredTarget = true;
    },
  };
};

describe("protected native target onboarding service", () => {
  const permissionRejected = async () => {
    const f = fixture();
    const planned = await f.planOnce();
    f.approve();
    const create = vi.fn(
      async (input: Parameters<NativeTargetOnboardingServiceDependencies["createProject"]>[0]) => {
        await input.authorizeAttempt();
        return { status: "rejected" as const, reason: "permission_denied" as const };
      },
    );
    f.dependencies.createProject = create;
    const denied = await f.send({
      ...f.common,
      action: "native-target-prepare",
      input: { ...f.prepared, operationRef: planned.operationRef },
    });
    expect(await denied.json()).toMatchObject({ status: "blocked", reason: "permission_denied" });
    const retained = await f.store.read({ authority, appId: plan.appId });
    expect(retained?.record.stage).toBe("approved");
    expect(retained?.record.previousAttempts.at(-1)?.reason).toBe("provider_permission_denied");
    return { f, create, retained, planned };
  };

  it("reads same-credential authorization evidence after a retired permission failure without another attempt or journal write", async () => {
    const { f, create, retained, planned } = await permissionRejected();
    const observation = {
      status: "observed" as const,
      statusCode: 200,
      installationMatches: true,
      teamMatches: true,
      ownerMatches: true,
      projectWriteConfigured: true,
      allProjectsConfigured: true,
      disabled: false,
    };
    const inspect = vi.fn(
      (
        _input: Parameters<
          NonNullable<NativeTargetOnboardingServiceDependencies["inspectProviderAuthorization"]>
        >[0],
      ) => Promise.resolve(observation),
    );
    f.dependencies.inspectProviderAuthorization = inspect;
    expect(await f.planOnce()).toMatchObject({
      operationRef: planned.operationRef,
      planDigest: planned.planDigest,
      providerAuthorization: observation,
    });
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(inspect.mock.calls[0]?.[0]).toMatchObject({ owner: current, plan });
    expect(create).toHaveBeenCalledTimes(1);
    expect(await f.store.read({ authority, appId: plan.appId })).toEqual(retained);
  });

  it("does not inspect provider authorization during new planning or approval-history reads", async () => {
    const f = fixture();
    const inspect = vi.fn(() =>
      Promise.resolve({
        status: "unavailable" as const,
        failure: "request_failed" as const,
      }),
    );
    f.dependencies.inspectProviderAuthorization = inspect;
    const planned = await f.planOnce();
    await f.send({
      ...f.common,
      action: "native-target-approval-read",
      input: { ...f.prepared, operationRef: planned.operationRef },
    });
    expect(inspect).not.toHaveBeenCalled();
    expect(f.createProject).not.toHaveBeenCalled();
  });

  it("discards authorization observations if current owner changes during the GET", async () => {
    const { f, create, retained } = await permissionRejected();
    f.dependencies.inspectProviderAuthorization = () => {
      f.changeOwner();
      return Promise.resolve({ status: "observed", statusCode: 200 });
    };
    await expect(f.planOnce()).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(1);
    expect(await f.store.read({ authority, appId: plan.appId })).toEqual(retained);
  });

  it("does not return advisory evidence after caller cancellation", async () => {
    const { f, create, retained } = await permissionRejected();
    const controller = new AbortController();
    f.dependencies.inspectProviderAuthorization = () => {
      controller.abort(new Error("cancelled"));
      return Promise.resolve({ status: "unavailable", failure: "cancelled" });
    };
    await expect(
      f.send(
        { ...f.common, action: "native-target-plan", input: f.proposal },
        new Request("https://operator.example/v1/runtime", {
          method: "POST",
          signal: controller.signal,
        }),
      ),
    ).rejects.toThrow("cancelled");
    expect(create).toHaveBeenCalledTimes(1);
    expect(await f.store.read({ authority, appId: plan.appId })).toEqual(retained);
  });

  it("discards observations when cancellation arrives during the final owner recheck", async () => {
    const { f, create, retained } = await permissionRejected();
    const controller = new AbortController();
    f.dependencies.inspectProviderAuthorization = () => {
      f.authorize.mockImplementation(() => {
        controller.abort(new Error("cancelled during owner recheck"));
        return Promise.resolve(structuredClone(current));
      });
      return Promise.resolve({ status: "observed", statusCode: 200 });
    };
    await expect(
      f.send(
        { ...f.common, action: "native-target-plan", input: f.proposal },
        new Request("https://operator.example/v1/runtime", {
          method: "POST",
          signal: controller.signal,
        }),
      ),
    ).rejects.toThrow("cancelled during owner recheck");
    expect(create).toHaveBeenCalledTimes(1);
    expect(await f.store.read({ authority, appId: plan.appId })).toEqual(retained);
  });

  it("never reads approval history when workload verification fails", async () => {
    const f = fixture(false);
    await expect(f.planOnce()).rejects.toThrow("unauthorized");
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.approvals).toEqual([]);
    expect(f.createProject).not.toHaveBeenCalled();
  });

  it("requires current workload and owner, terminal native approval, then journals one accepted project ID", async () => {
    const f = fixture();
    const planned = await f.planOnce();
    expect(planned.status).toBe("planned");
    const prepared = { ...f.prepared, operationRef: planned.operationRef };
    const pending = await f.send({ ...f.common, action: "native-target-prepare", input: prepared });
    expect(
      nativeTargetTransportResponseSchemas["native-target-prepare"].parse(await pending.json())
        .status,
    ).toBe("approval-pending");
    expect(f.createProject).not.toHaveBeenCalled();
    f.approve();
    const ready = await f.send({ ...f.common, action: "native-target-prepare", input: prepared });
    expect(
      nativeTargetTransportResponseSchemas["native-target-prepare"].parse(await ready.json()),
    ).toMatchObject({ status: "ready", projectId: "project-id" });
    expect(f.createProject).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual([
      "workload",
      "workload",
      "workload",
      "create",
      "authorized",
      "accepted",
    ]);
    const retry = await f.send({ ...f.common, action: "native-target-prepare", input: prepared });
    expect(
      nativeTargetTransportResponseSchemas["native-target-prepare"].parse(await retry.json())
        .status,
    ).toBe("ready");
    expect(f.createProject).toHaveBeenCalledTimes(1);
  });

  it("a candidate response remains pending and cannot become terminal approval", async () => {
    const f = fixture();
    const planned = await f.planOnce();
    const prepared = { ...f.prepared, operationRef: planned.operationRef };
    const candidate = await f.send({
      ...f.common,
      action: "native-target-approval-candidate",
      input: prepared,
      candidate: {
        requestId: "approval",
        callId: "call-one",
        toolName: "prepare-app-native-target",
        responder: {
          authenticator: "native",
          principalId: authority.ownerUserId,
          principalType: "user",
        },
      },
    });
    expect(await candidate.json()).toEqual({ status: "allowed" });
    const pending = await f.send({
      ...f.common,
      action: "native-target-approval-read",
      input: prepared,
    });
    expect(nativeTargetTerminalApprovalResultSchema.parse(await pending.json())).toEqual({
      status: "pending",
    });
    expect(f.createProject).not.toHaveBeenCalled();
    expect(f.approvals.at(-1)?.authorization).toBe("Bearer verified-builder-token");
    expect(f.approvals.at(-1)?.signal).toBeInstanceOf(AbortSignal);
  });

  it("stale current owner blocks work before another provider attempt", async () => {
    const f = fixture();
    await f.planOnce();
    f.changeOwner();
    await expect(f.planOnce()).rejects.toThrow();
    expect(f.createProject).not.toHaveBeenCalled();
  });

  it("returns the existing-target instruction and never creates a second project", async () => {
    const f = fixture();
    f.configureExistingTarget();
    const response = await f.send({
      ...f.common,
      action: "native-target-plan",
      input: {
        appId: plan.appId,
        project: f.proposal.project,
        branch: plan.branch,
        conflictPolicy: plan.conflictPolicy,
      },
      selectedApp: { appId: plan.appId, appSpecDigest: plan.origin.appSpecDigest },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "native_target_existing_configured_target",
      nextAction: "resolve-preview-target",
    });
    expect(f.createProject).not.toHaveBeenCalled();
  });
  it("returns the exact retained plan through the service when selectedApp is absent", async () => {
    const f = fixture();
    const retained = await f.planOnce();
    const response = await f.send({ ...f.common, action: "native-target-plan", input: f.proposal });
    const result = nativeTargetTransportResponseSchemas["native-target-plan"].parse(
      await response.json(),
    );
    expect(result.operationRef).toBe(retained.operationRef);
    expect(result.planDigest).toBe(retained.planDigest);
    expect(f.createProject).not.toHaveBeenCalled();
    expect(f.events).not.toContain("create");
  });
  it("does not create a missing plan or expose a retained plan after owner changes", async () => {
    const empty = fixture();
    await expect(
      empty.send({ ...empty.common, action: "native-target-plan", input: empty.proposal }),
    ).rejects.toThrow();
    expect(empty.createProject).not.toHaveBeenCalled();
    const retained = fixture();
    await retained.planOnce();
    retained.changeOwner();
    await expect(
      retained.send({ ...retained.common, action: "native-target-plan", input: retained.proposal }),
    ).rejects.toThrow();
    expect(retained.createProject).not.toHaveBeenCalled();
  });
});

const selectedProfilePlan = () =>
  nativeTargetOnboardingPlanSchema.parse({
    ...plan,
    resourceProfileId: "isolated-development",
    resourceProfileAuthorityDigest: "e".repeat(64),
    appDatabase: { ...plan.appDatabase, resourceId: "isolated-store" },
    nativeNeon: {
      ...plan.nativeNeon,
      nativeStore: { ...plan.nativeNeon.nativeStore, resourceId: "isolated-store" },
      scope: {
        ...plan.nativeNeon.scope,
        projectId: "isolated-neon",
        branchId: "isolated-branch",
        endpointId: "isolated-endpoint",
        hostname: "ep-isolated.neon.tech",
      },
    },
  });

describe("protected retained native resource selection", () => {
  it("reads the frozen captured release for an HTTP rescope without selectedApp, ignoring a later selected digest", async () => {
    const f = fixture();
    const original = await f.planOnce();
    f.readCapturedRelease.mockClear();
    f.resolvePlan.mockImplementation((_owner, proposal, source) => {
      expect(proposal.resourceProfileId).toBe("isolated-development");
      expect(source.appSpecDigest).toBe(plan.origin.appSpecDigest);
      return Promise.resolve(selectedProfilePlan());
    });
    const input = { ...f.proposal, resourceProfileId: "isolated-development" };
    const response = await f.send({ ...f.common, action: "native-target-plan", input });
    const changed = nativeTargetTransportResponseSchemas["native-target-plan"].parse(
      await response.json(),
    );
    expect(changed.planDigest).not.toBe(original.planDigest);
    expect(changed.plan.origin).toEqual(plan.origin);
    expect(changed.plan.project).toEqual(plan.project);
    expect(f.readCapturedRelease).toHaveBeenLastCalledWith(
      current,
      plan.appId,
      plan.origin.appSpecDigest,
    );
    const same = await f.send({
      ...f.common,
      action: "native-target-plan",
      input,
      selectedApp: { appId: plan.appId, appSpecDigest: "f".repeat(64) },
    });
    expect(
      nativeTargetTransportResponseSchemas["native-target-plan"].parse(await same.json())
        .planDigest,
    ).toBe(changed.planDigest);
    expect(f.readCapturedRelease).toHaveBeenLastCalledWith(
      current,
      plan.appId,
      plan.origin.appSpecDigest,
    );
    expect(f.createProject).not.toHaveBeenCalled();
  });

  it("denies a changed owner or unavailable resource profile without altering retained scope", async () => {
    const f = fixture();
    await f.planOnce();
    const key = { authority, appId: plan.appId };
    const before = await f.store.read(key);
    f.resolvePlan.mockRejectedValue(new Error("profile-not-authorized"));
    const message = {
      ...f.common,
      action: "native-target-plan" as const,
      input: { ...f.proposal, resourceProfileId: "isolated-development" },
    };
    await expect(f.send(message)).rejects.toThrow("profile-not-authorized");
    expect(await f.store.read(key)).toEqual(before);
    f.changeOwner();
    f.readCapturedRelease.mockClear();
    await expect(f.send(message)).rejects.toThrow();
    expect(f.readCapturedRelease).not.toHaveBeenCalled();
    expect(await f.store.read(key)).toEqual(before);
    expect(f.createProject).not.toHaveBeenCalled();
  });
});

describe("native plan diagnostic boundaries", () => {
  it("reports workload and registry-read failures using fixed labels", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(fixture(false).planOnce()).rejects.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"stage":"native_plan_workload"'));
      warn.mockClear();
      const f = fixture();
      vi.spyOn(f.store, "read").mockRejectedValue(new Error("private registry error"));
      await expect(f.planOnce()).rejects.toThrow("private registry error");
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('"stage":"native_plan_registry_read"'),
      );
      expect(warn.mock.calls.flat().join(" ")).not.toContain("private registry error");
    } finally {
      warn.mockRestore();
    }
  });
  it("reports the failing captured-release stage without private error text", async () => {
    const f = fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      f.readCapturedRelease.mockRejectedValue(new Error("private-token-unsafe"));
      await expect(f.planOnce()).rejects.toThrow("private-token-unsafe");
      const messages = warn.mock.calls.map(([value]) => String(value));
      expect(
        messages.some((value) => value.includes('"stage":"native_plan_captured_release"')),
      ).toBe(true);
      expect(messages.join(" ")).not.toContain("private-token-unsafe");
      expect(f.createProject).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
  it("reports the profile boundary and preserves the original failure if logging fails", async () => {
    const f = fixture();
    const error = new Error("profile-private-detail");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("logger failure");
    });
    try {
      f.resolvePlan.mockRejectedValue(error);
      await expect(f.planOnce()).rejects.toBe(error);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('"stage":"native_plan_profile_resolution"'),
      );
      expect(f.createProject).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("exact native preparation invocation approval", () => {
  it.each([true, false])(
    "uses only the current invocation approval (settled=%s) across all consumption reads",
    async (settledCurrent) => {
      const f = fixture();
      const planned = await f.planOnce();
      const prepared = { ...f.prepared, operationRef: planned.operationRef };
      const history: MessageStreamEvent[] = [];
      for (const [requestId, callId, settled] of [
        ["old-request", "old-call", true],
        ["current-request", "current-call", settledCurrent],
      ] as const) {
        history.push({
          type: "input.requested",
          meta: { at: "2026-10-30T20:00:00.000Z", id: `requested-${requestId}` },
          data: {
            sequence: 1,
            stepIndex: 0,
            turnId: "turn",
            requests: [
              {
                kind: "tool-approval",
                requestId,
                prompt: "Approve exact saved target",
                action: {
                  kind: "tool-call",
                  toolName: "prepare-app-native-target",
                  callId,
                  input: prepared,
                },
              },
            ],
          },
        });
        if (settled) {
          history.push({
            type: "approval.settled",
            meta: { at: "2026-10-30T20:00:01.000Z", id: `settled-${requestId}` },
            data: {
              sequence: 2,
              stepIndex: 0,
              turnId: "turn",
              requestId,
              responderPrincipalId: authority.ownerUserId,
              outcome: "approved",
            },
          });
        }
      }
      const approvalCalls: (string | undefined)[] = [];
      f.dependencies.readApproval = async (owner, record, callId) => {
        approvalCalls.push(callId);
        const result = await readPrivateNativeTargetApproval({
          owner,
          record,
          ...(callId === undefined ? {} : { callId }),
          historyOwner: owner.historyOwner,
          assertOwner: async () => {
            await f.authorize();
          },
          readHistory: (startIndex, onEvent) => {
            for (const event of history.slice(startIndex)) {
              onEvent(event);
            }
            return Promise.resolve({
              complete: true,
              nativeTailIndex: history.length,
              nextNativeIndex: history.length,
            });
          },
        });
        return result.status === "pending" ? null : result.proof;
      };
      const invocation = {
        ...f.common,
        callId: "current-call",
        action: "native-target-prepare" as const,
        input: prepared,
      };
      const response = await f.send(invocation);
      const result = nativeTargetTransportResponseSchemas["native-target-prepare"].parse(
        await response.json(),
      );
      expect(approvalCalls.length).toBeGreaterThan(0);
      expect(approvalCalls.every((callId) => callId === "current-call")).toBe(true);
      if (settledCurrent) {
        expect(result.status).toBe("ready");
        expect(f.createProject).toHaveBeenCalledTimes(1);
        const retried = await f.send(invocation);
        expect(
          nativeTargetTransportResponseSchemas["native-target-prepare"].parse(await retried.json())
            .status,
        ).toBe("ready");
        expect(f.createProject).toHaveBeenCalledTimes(1);
      } else {
        expect(result.status).toBe("approval-pending");
        expect(f.createProject).not.toHaveBeenCalled();
      }
    },
  );
});

describe("retired attempt preparation with immutable initial approval", () => {
  it.each(["approved", "pending", "cancelled"] as const)(
    "consumes fresh %s history from the exact revision-seven shape",
    async (outcome) => {
      const rescope = (prior: typeof plan, profile: string) =>
        nativeTargetOnboardingPlanSchema.parse({
          ...prior,
          resourceProfileId: profile,
          resourceProfileAuthorityDigest: (profile === "scope-b" ? "e" : "f").repeat(64),
          resourceSelectionRevision: (prior.resourceSelectionRevision ?? 0) + 1,
          appDatabase: { ...prior.appDatabase, resourceId: `${profile}-resource` },
          nativeNeon: {
            ...prior.nativeNeon,
            scope: {
              ...prior.nativeNeon.scope,
              branchId: `${profile}-branch`,
              endpointId: `${profile}-endpoint`,
              hostname: `${profile}.neon.tech`,
            },
          },
        });
      const first = plan;
      const second = rescope(first, "scope-b");
      const selected = rescope(second, "scope-c");
      const f = fixture(true, selected);
      const history: MessageStreamEvent[] = [];
      const freshHistory: MessageStreamEvent[] = [];
      let operationRef = "";
      const readActualApproval: NativeTargetOnboardingServiceDependencies["readApproval"] = async (
        owner,
        record,
        callId,
        _workload,
      ) => {
        const result = await readPrivateNativeTargetApproval({
          owner,
          record,
          ...(callId === undefined ? {} : { callId }),
          historyOwner: owner.historyOwner,
          assertOwner: async () => {
            await f.authorize();
          },
          readHistory: (start, observe) => {
            for (const event of history.slice(start)) {
              observe(event);
            }
            return Promise.resolve({
              complete: true,
              nativeTailIndex: history.length,
              nextNativeIndex: history.length,
            });
          },
        });
        return result.status === "pending" ? null : result.proof;
      };
      const registry = createNativeTargetOnboardingRegistry({
        store: f.store,
        authorize: () => f.authorize(),
        assertPlanOrigin: () => Promise.resolve(),
        readApproval: async (_owner, record) =>
          await readActualApproval(await f.authorize(), record, "old-call", {
            authorization: "Bearer verified-builder-token",
            signal: new AbortController().signal,
          }),
        now: () => new Date("2026-10-30T20:00:00.000Z"),
      });
      const reserved = await registry.reservePlan("seed", first);
      operationRef = reserved.requestId;
      await registry.supersedePlannedScope("seed", second, nativeTargetOnboardingPlanDigest(first));
      await registry.supersedePlannedScope(
        "seed",
        selected,
        nativeTargetOnboardingPlanDigest(second),
      );
      const prepared = {
        appId: selected.appId,
        plan: selected,
        planDigest: nativeTargetOnboardingPlanDigest(selected),
        operationRef,
      };
      for (const [requestId, callId, result] of [
        ["old-request", "old-call", "approved"],
        ["fresh-request", "fresh-call", outcome],
      ] as const) {
        const events = callId === "old-call" ? history : freshHistory;
        events.push({
          type: "input.requested",
          meta: { id: `request-${requestId}`, at: "2026-10-30T20:00:00.000Z" },
          data: {
            sequence: 1,
            stepIndex: 0,
            turnId: "turn",
            requests: [
              {
                kind: "tool-approval",
                requestId,
                prompt: "Approve saved plan",
                action: {
                  kind: "tool-call",
                  toolName: "prepare-app-native-target",
                  callId,
                  input: prepared,
                },
              },
            ],
          },
        });
        if (result !== "pending") {
          events.push({
            type: "approval.settled",
            meta: { id: `settled-${requestId}`, at: "2026-10-30T20:00:00.000Z" },
            data: {
              sequence: 2,
              stepIndex: 0,
              turnId: "turn",
              requestId,
              responderPrincipalId: authority.ownerUserId,
              outcome: result,
            },
          });
        }
      }
      await registry.recordApproval("seed", selected.appId);
      const oldAttempt = {
        attemptId: "11111111-1111-4111-8111-111111111111",
        leaseId: "22222222-2222-4222-8222-222222222222",
        candidateName: selected.project.name,
        startedAt: "2026-10-30T20:00:00.000Z",
        leaseExpiresAt: "2026-10-30T20:10:00.000Z",
      };
      await registry.claimAttempt("seed", selected.appId, oldAttempt);
      await registry.authorizeAttempt(
        "seed",
        selected.appId,
        oldAttempt.attemptId,
        oldAttempt.leaseId,
      );
      await registry.recordNotCreated(
        "seed",
        selected.appId,
        oldAttempt.attemptId,
        "provider_validation_failed",
      );
      const before = await registry.read("seed", selected.appId);
      expect(before?.revision).toBe(7);
      expect(before?.record.stage).toBe("approved");
      expect(before?.record.priorPlannedScopes).toHaveLength(2);
      expect(before?.record.previousAttempts).toHaveLength(1);
      history.push(...freshHistory);
      f.dependencies.readApproval = readActualApproval;
      const response = await f.send({
        ...f.common,
        callId: "fresh-call",
        action: "native-target-prepare",
        input: prepared,
      });
      const result = nativeTargetTransportResponseSchemas["native-target-prepare"].parse(
        await response.json(),
      );
      const after = await registry.read("seed", selected.appId);
      expect(after?.record.priorPlannedScopes).toEqual(before?.record.priorPlannedScopes);
      expect(after?.record.previousAttempts).toEqual(before?.record.previousAttempts);
      if (outcome === "approved") {
        expect(result.status).toBe("ready");
        expect(f.createProject).toHaveBeenCalledTimes(1);
        expect(after?.record).toMatchObject({
          approval: { requestId: "old-request", callId: "old-call" },
        });
        await f.send({
          ...f.common,
          callId: "fresh-call",
          action: "native-target-prepare",
          input: prepared,
        });
        expect(f.createProject).toHaveBeenCalledTimes(1);
      } else if (outcome === "pending") {
        expect(result.status).toBe("approval-pending");
        expect(f.createProject).not.toHaveBeenCalled();
        expect(after).toEqual(before);
      } else {
        expect(result.status).toBe("cancelled");
        expect(f.createProject).not.toHaveBeenCalled();
      }
    },
  );
});

describe("side-effect-free approval peek with an incomplete durable tail", () => {
  it.each(["approved", "cancelled"] as const)(
    "returns pending without granting stale checkpoint authority before complete %s history",
    async (outcome) => {
      const f = fixture();
      const planned = await f.planOnce();
      const prepared = { ...f.prepared, operationRef: planned.operationRef };
      const row = await f.store.read({ authority, appId: plan.appId });
      if (row === undefined) {
        throw new Error("missing plan");
      }
      const history: MessageStreamEvent[] = [];
      const requested = (requestId: string, callId: string): MessageStreamEvent => ({
        type: "input.requested",
        meta: { id: `request-${requestId}`, at: "2026-10-30T20:00:00.000Z" },
        data: {
          sequence: 1,
          stepIndex: 0,
          turnId: "turn",
          requests: [
            {
              kind: "tool-approval",
              requestId,
              prompt: "Approve exact saved plan",
              action: {
                kind: "tool-call",
                toolName: "prepare-app-native-target",
                callId,
                input: prepared,
              },
            },
          ],
        },
      });
      history.push(requested("old-request", "old-call"), {
        type: "approval.settled",
        meta: { id: "settled-old", at: "2026-10-30T20:00:01.000Z" },
        data: {
          sequence: 2,
          stepIndex: 0,
          turnId: "turn",
          requestId: "old-request",
          responderPrincipalId: authority.ownerUserId,
          outcome: "approved",
        },
      });
      const capture = createPrivateNativeTargetApprovalCapture({
        owner: current,
        record: row.record,
      });
      for (const event of history) {
        capture.observe(event);
      }
      capture.proveComplete();
      let saved: PrivateNativeTargetApprovalObservation = {
        version: 1,
        native: {
          adapterSessionId: current.adapterSessionId,
          adapterGeneration: current.adapterGeneration,
          nextNativeIndex: history.length,
          capture: capture.snapshot(),
        },
        terminals: capture.terminalSnapshot(),
      };
      history.push(requested("fresh-request", "fresh-call"));
      let complete = false;
      let writes = 0;
      f.dependencies.readApproval = async (owner, record, callId) => {
        const result = await readPrivateNativeTargetApproval({
          owner,
          record,
          ...(callId === undefined ? {} : { callId }),
          historyOwner: owner.historyOwner,
          observation: {
            state: saved,
            save: (next) => {
              writes += 1;
              saved = next;
              return Promise.resolve();
            },
          },
          assertOwner: async () => {
            await f.authorize();
          },
          readHistory: (start, onEvent) => {
            for (const event of history.slice(start)) {
              onEvent(event);
            }
            return Promise.resolve({
              complete,
              nativeTailIndex: history.length,
              nextNativeIndex: history.length,
            });
          },
        });
        return result.status === "pending" ? null : result.proof;
      };
      const common = { ...f.common, callId: "fresh-call", input: prepared };
      const peek = await f.send({ ...common, action: "native-target-approval-read" });
      expect(await peek.json()).toEqual({ status: "pending" });
      expect(writes).toBe(1);
      expect(saved.native.nextNativeIndex).toBe(3);
      expect(saved.native.capture.entries).toHaveLength(2);
      expect(saved.terminals).toHaveLength(1);
      expect(await f.store.read({ authority, appId: plan.appId })).toEqual(row);
      await expect(f.send({ ...common, action: "native-target-prepare" })).rejects.toBeInstanceOf(
        HostedSessionReadTimeoutError,
      );
      expect(f.createProject).not.toHaveBeenCalled();
      if (outcome === "cancelled") {
        history.push({
          type: "approval.settled",
          meta: { id: "late-old-cancellation", at: "2026-10-30T20:00:02.000Z" },
          data: {
            sequence: 3,
            stepIndex: 0,
            turnId: "turn",
            requestId: "old-request",
            responderPrincipalId: authority.ownerUserId,
            outcome: "cancelled",
          },
        });
      }
      history.push({
        type: "approval.settled",
        meta: { id: "settled-fresh", at: "2026-10-30T20:00:02.000Z" },
        data: {
          sequence: 3,
          stepIndex: 0,
          turnId: "turn",
          requestId: "fresh-request",
          responderPrincipalId: authority.ownerUserId,
          outcome: "approved",
        },
      });
      complete = true;
      const preparedResponse = await f.send({ ...common, action: "native-target-prepare" });
      expect(
        nativeTargetTransportResponseSchemas["native-target-prepare"].parse(
          await preparedResponse.json(),
        ).status,
      ).toBe(outcome === "approved" ? "ready" : "cancelled");
      expect(f.createProject).toHaveBeenCalledTimes(outcome === "approved" ? 1 : 0);
    },
  );
  it.each([
    new HostedOperatorError("authorization_required"),
    new HostedOperatorError("operator_unavailable"),
    new Error("unknown read failure"),
  ])("does not turn other history failures into pending", async (failure) => {
    const f = fixture();
    const planned = await f.planOnce();
    f.dependencies.readApproval = () => {
      throw failure;
    };
    await expect(
      f.send({
        ...f.common,
        action: "native-target-approval-read",
        input: { ...f.prepared, operationRef: planned.operationRef },
      }),
    ).rejects.toBe(failure);
    expect(f.createProject).not.toHaveBeenCalled();
  });
  it("does not turn a cancelled caller into pending when a typed history timeout arrives", async () => {
    const f = fixture();
    const planned = await f.planOnce();
    const abort = new AbortController();
    const cancelled = new Error("caller cancelled");
    abort.abort(cancelled);
    f.dependencies.readApproval = () => Promise.reject(new HostedSessionReadTimeoutError());
    await expect(
      f.send(
        {
          ...f.common,
          action: "native-target-approval-read",
          input: { ...f.prepared, operationRef: planned.operationRef },
        },
        new Request(request(), { signal: abort.signal }),
      ),
    ).rejects.toBe(cancelled);
    expect(f.createProject).not.toHaveBeenCalled();
  });
  it("keeps owner and exact registry checks outside the incomplete-history fallback", async () => {
    const f = fixture();
    const planned = await f.planOnce();
    const read = vi.fn(() => Promise.reject(new HostedSessionReadTimeoutError()));
    f.dependencies.readApproval = read;
    await expect(
      f.send({
        ...f.common,
        action: "native-target-approval-read",
        input: { ...f.prepared, operationRef: "00000000-0000-5000-a000-000000000099" },
      }),
    ).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    const revoked = new HostedSessionReadTimeoutError();
    f.authorize.mockRejectedValueOnce(revoked);
    await expect(
      f.send({
        ...f.common,
        action: "native-target-approval-read",
        input: { ...f.prepared, operationRef: planned.operationRef },
      }),
    ).rejects.toBe(revoked);
    expect(read).not.toHaveBeenCalled();
    expect(f.createProject).not.toHaveBeenCalled();
  });
});
