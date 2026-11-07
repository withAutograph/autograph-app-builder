import { describe, expect, it, vi } from "vitest";

import {
  capturedStaticDescriptionProvenance,
  nativeTargetAuthOnlyPlanDigest,
  nativeTargetAuthOnlyPlanSchema,
  nativeTargetAuthOnlySchemaEffectDigest,
} from "./native-target-auth-only-plan-schema";
import { nativeTargetRequiredProjectProtection } from "./native-target-onboarding-plan-schema";
import { createNativeTargetAuthOnlyDispatch } from "./native-target-auth-only-dispatch";
import type {
  NativeTargetAuthOnlyDispatchState,
  NativeTargetAuthOnlyDispatchStore,
} from "./native-target-auth-only-dispatch";
import { createProtectedHostedOperatorHandler } from "./hosted-operator-service";
import type { ProtectedHostedOperatorDependencies } from "./hosted-operator-service";

const description = {
  app: { id: "signup-reset-pilot", routes: ["/"], workspacePath: "apps/signup-reset-pilot" },
  backend: { kind: "static" },
  deployment: { framework: "nextjs", sourceFilesOutsideRootDirectory: true },
  validation: {
    browser: null,
    check: { task: "mise run app:check signup-reset-pilot" },
    test: null,
  },
  version: 1,
};
const plan = nativeTargetAuthOnlyPlanSchema.parse({
  appId: "signup-reset-pilot",
  appRole: "pilot_user",
  authResource: {
    authorityDigest: "b".repeat(64),
    database: "auth_identity",
    endpointId: "endpoint_fixture",
    hostname: "auth-preview.neon.tech",
    profileId: "preview-auth",
    resourceId: "isolated-auth",
  },
  authSchema: {
    artifactRef: "auth-artifact",
    installer: { reference: "auth-worker", sha256: "3".repeat(64) },
    planDigest: "1".repeat(64),
    targetDigest: "2".repeat(64),
  },
  branch: "main",
  cost: { description: "Auth only", ownership: "current-owner" },
  kind: "native-target-auth-only",
  origin: {
    adapterGeneration: 1,
    adapterSessionId: "native_original",
    appSpecDigest: "a".repeat(64),
    authority: {
      audience: "https://builder.example/mcp",
      issuer: "https://builder.example/api/auth",
      ownerUserId: "owner_fixture",
      workspaceId: "workspace_fixture",
    },
    capturedDescription: capturedStaticDescriptionProvenance(description),
    publicSessionId: "public_original",
  },
  project: {
    installationId: "install_fixture",
    name: "signup-reset-pilot",
    projectSettings: {
      framework: "nextjs",
      rootDirectory: "apps/signup-reset-pilot",
      sourceFilesOutsideRootDirectory: true,
    },
    protection: nativeTargetRequiredProjectProtection,
    teamId: "team_fixture",
  },
  publishedSource: {
    branch: "main",
    changeSetDigest: "c".repeat(64),
    gitSha: "d".repeat(40),
    gitTree: "e".repeat(40),
    repositoryId: "repo_fixture",
    reviewDigest: "f".repeat(64),
  },
  retention: { policy: "Retain until explicit cleanup" },
  signupPolicy: { eligibility: "approved-email-list", requireVerifiedEmail: true },
  version: 1,
});

const fixture = () => {
  let row: { revision: number; state: NativeTargetAuthOnlyDispatchState } | undefined;
  const store: NativeTargetAuthOnlyDispatchStore = {
    compareAndSet: (_key, expected, state) => {
      if (row?.revision !== expected) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- CAS conflicts resolve an absent row; resolve() would infer void outside the store contract.
        return Promise.resolve(undefined);
      }
      row = { revision: expected + 1, state };
      return Promise.resolve(row);
    },
    read: () => Promise.resolve(row),
    reserve: (_key, state) => {
      if (row !== undefined) {
        return Promise.reject(new Error("occupied"));
      }
      row = { revision: 1, state };
      return Promise.resolve(row);
    },
  };
  const approval = {
    callId: "call_fixture",
    observedAt: "2026-11-06T12:00:00.000Z",
    outcome: "approved" as const,
    planDigest: nativeTargetAuthOnlyPlanDigest(plan),
    publicSessionId: "public_original",
    requestId: "approval_fixture",
    responderPrincipalId: "owner_fixture",
    sourceDigest: nativeTargetAuthOnlySchemaEffectDigest(plan, plan.publishedSource),
  };
  let uncertain = false;
  const createProject = vi.fn(
    async ({
      authorizeAttempt,
      acceptProjectId,
    }: {
      authorizeAttempt: () => Promise<void>;
      acceptProjectId: (id: string) => Promise<void>;
    }): Promise<
      { status: "created"; projectId: string } | { status: "uncertain"; projectId?: string }
    > => {
      await authorizeAttempt();
      await acceptProjectId("vercel_project_fixture");
      return uncertain
        ? { projectId: "vercel_project_fixture", status: "uncertain" }
        : { projectId: "vercel_project_fixture", status: "created" };
    },
  );
  const service = createNativeTargetAuthOnlyDispatch({
    authorize: () =>
      Promise.resolve({
        authority: plan.origin.authority,
        ownerUserId: "owner_fixture",
        publicSessionId: "public_original",
      }),
    createProject,
    now: () => new Date("2026-11-06T12:00:00.000Z"),
    observeProject: ({ projectId }) => Promise.resolve({ status: "verified" as const, projectId }),
    readApproval: () => Promise.resolve(approval),
    revalidate: () => Promise.resolve(),
    store,
  });
  return {
    createProject,
    makeUncertain: () => {
      uncertain = true;
    },
    service,
    store,
  };
};

describe("Auth-only fenced dispatch", () => {
  it("requires exact owner approval, fences the provider callbacks, and rejects replay", async () => {
    const f = fixture();
    await f.service.approve("request", plan);
    await expect(f.service.dispatch("request", plan)).resolves.toEqual({
      projectId: "vercel_project_fixture",
      status: "created",
    });
    expect(f.createProject).toHaveBeenCalledTimes(1);
    await expect(f.service.dispatch("request", plan)).resolves.toEqual({
      projectId: "vercel_project_fixture",
      status: "created",
    });
    expect(f.createProject).toHaveBeenCalledTimes(1);
    await expect(f.service.dispatch("request", plan)).resolves.toEqual({
      projectId: "vercel_project_fixture",
      status: "created",
    });
    const created = await f.store.read({ appId: plan.appId, authority: plan.origin.authority });
    expect(created?.state.stage).toBe("created");
  });

  it("does not reserve approval for another plan digest", async () => {
    const f = fixture();
    await f.service.approve("request", plan);
    const changed = nativeTargetAuthOnlyPlanSchema.parse({ ...plan, branch: "release" });
    await expect(f.service.dispatch("request", changed)).rejects.toThrow(
      "native_target_auth_only_conflict",
    );
    expect(f.createProject).not.toHaveBeenCalled();
  });

  it("reconciles an accepted project after uncertain readback without repeating create", async () => {
    const f = fixture();
    await f.service.approve("request", plan);
    f.makeUncertain();
    await expect(f.service.dispatch("request", plan)).resolves.toEqual({
      projectId: "vercel_project_fixture",
      status: "unknown",
    });
    await expect(f.service.dispatch("request", plan)).resolves.toEqual({
      projectId: "vercel_project_fixture",
      status: "created",
    });
    expect(f.createProject).toHaveBeenCalledTimes(1);
  });

  it("routes the hosted prepare action through owner approval and fenced dispatch", async () => {
    const f = fixture();
    const { authority } = plan.origin;
    const ownerContext = {
      adapterGeneration: 1,
      adapterSessionId: "native_original",
      authority,
      kind: "direct" as const,
      principal: {
        audience: authority.audience,
        issuer: authority.issuer,
        ownerUserId: authority.ownerUserId,
        scopes: ["autograph:operate"],
        workspaceId: authority.workspaceId,
      },
      sessionId: "public_original",
    };
    const hostedDependencies: ProtectedHostedOperatorDependencies = {
      assertAuthorized: vi.fn<ProtectedHostedOperatorDependencies["assertAuthorized"]>(),
      authorize: vi.fn<ProtectedHostedOperatorDependencies["authorize"]>(),
      bindings: vi.fn<ProtectedHostedOperatorDependencies["bindings"]>(),
      executeEffect: vi.fn<ProtectedHostedOperatorDependencies["executeEffect"]>(),
      nativeTargetRequest: async (_request, request) => {
        if (request.action !== "native-target-auth-only-prepare") {
          throw new Error(`Unexpected native target action: ${request.action}`);
        }
        await f.service.approve("request", request.input.plan);
        const result = await f.service.dispatch("request", request.input.plan);
        return Response.json(result);
      },
      plan: vi.fn<ProtectedHostedOperatorDependencies["plan"]>(),
      readApproval: vi.fn<ProtectedHostedOperatorDependencies["readApproval"]>(),
      reconcile: vi.fn<ProtectedHostedOperatorDependencies["reconcile"]>(),
      store: {
        compareAndSet: vi.fn<ProtectedHostedOperatorDependencies["store"]["compareAndSet"]>(),
        read: vi.fn<ProtectedHostedOperatorDependencies["store"]["read"]>(),
        reserve: vi.fn<ProtectedHostedOperatorDependencies["store"]["reserve"]>(),
        reserveFenceGeneration:
          vi.fn<ProtectedHostedOperatorDependencies["store"]["reserveFenceGeneration"]>(),
      },
      verify: vi.fn<ProtectedHostedOperatorDependencies["verify"]>(),
      withResourceLease: () =>
        Promise.reject(new Error("Auth-only dispatch must not enter a protected resource lease")),
    };
    const handler = createProtectedHostedOperatorHandler(hostedDependencies);
    const response = await handler(
      new Request("https://builder.example/v1/runtime", {
        body: JSON.stringify({
          action: "native-target-auth-only-prepare",
          ownerContext,
          adapterSessionId: "native_original",
          callId: "prepare_call",
          input: {
            appId: plan.appId,
            operationRef: nativeTargetAuthOnlyPlanDigest(plan),
            planDigest: nativeTargetAuthOnlyPlanDigest(plan),
            plan,
          },
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    expect(response.status).toBe(200);
    expect(hostedDependencies.authorize).not.toHaveBeenCalled();
    expect(hostedDependencies.store.reserve).not.toHaveBeenCalled();
    expect(hostedDependencies.executeEffect).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      projectId: "vercel_project_fixture",
      status: "created",
    });
    expect(f.createProject).toHaveBeenCalledTimes(1);
  });
});
