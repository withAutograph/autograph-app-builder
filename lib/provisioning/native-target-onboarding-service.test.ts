import { describe, expect, it, vi } from "vitest";
import { createInMemoryNativeTargetOnboardingStore } from "./native-target-onboarding-store";
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
const digest = nativeTargetOnboardingPlanDigest(plan);
const request = () =>
  new Request("https://operator.example/v1/runtime", {
    method: "POST",
    headers: { authorization: "Bearer verified-builder-token" },
  });
const fixture = (workloadAuthorized = true) => {
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
        name: plan.project.name,
        settings: plan.project.projectSettings,
        protection: plan.project.protection,
        scopeId: plan.project.teamId,
      };
    },
  );
  const approvals: Array<{ authorization: string | null; signal: AbortSignal }> = [];
  const service = createNativeTargetOnboardingService({
    store,
    verifyWorkload: () => {
      events.push("workload");
      return workloadAuthorized ? Promise.resolve() : Promise.reject(new Error("unauthorized"));
    },
    authorize,
    readCapturedRelease: () =>
      Promise.resolve({
        release: plan.origin.release,
        description: {
          version: 1,
          app: { id: plan.appId, routes: [], workspacePath: "apps/requests" },
          backend: {
            kind: "generated-postgres",
            authorization: "declared-policy",
            roles: ["viewer"],
            runtime: { databaseEnvironment: "DATABASE_URL" },
            schemaReceipt: null,
            release: {
              id: plan.origin.release.id,
              artifactHash: `sha256:${plan.origin.release.schemaSha256}`,
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
        : Promise.resolve(plan),
    readApproval: (_owner, _record, _callId, workload) => {
      approvals.push(workload);
      return Promise.resolve(
        approved
          ? {
              requestId: "approval",
              callId: "call-one",
              planDigest: digest,
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
  });
  const common = {
    ownerContext: historyOwner,
    adapterSessionId: current.adapterSessionId,
    callId: "call-one",
  };
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
  const prepared = { appId: plan.appId, plan, planDigest: digest, operationRef: "" };
  const send = async (body: NativeTargetTransportRequest) =>
    await service(request(), nativeTargetTransportRequestSchema.parse(body));
  const planOnce = async () => {
    const response = await send({
      ...common,
      action: "native-target-plan",
      input: proposal,
      selectedApp: { appId: plan.appId, appSpecDigest: plan.origin.appSpecDigest },
    });
    return nativeTargetTransportResponseSchemas["native-target-plan"].parse(await response.json());
  };
  return {
    authorize,
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
});
