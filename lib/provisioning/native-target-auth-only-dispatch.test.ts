import { createNativeTargetOnboardingClient } from "../agent/native-target-onboarding-client";
import { nativeTargetAuthOnlyResourcePreparationInputSchema } from "../eve/private-native-target-auth-only-resource-approval";
import { HostedOperatorError, operatorPublicResultSchema } from "./hosted-operator-contract";
import { createHostedOperatorNativeHandler } from "./hosted-operator-native";
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

const ingressOwner = {
  adapterGeneration: plan.origin.adapterGeneration,
  adapterSessionId: plan.origin.adapterSessionId,
  authority: plan.origin.authority,
  kind: "direct" as const,
  principal: { ...plan.origin.authority, scopes: ["autograph:operate"] },
  sessionId: plan.origin.publicSessionId,
};
const ingressContext = {
  abortSignal: new AbortController().signal,
  callId: "ingress-call",
  session: { auth: null, id: ingressOwner.adapterSessionId },
};
const ingressOperation = "11111111-1111-4111-a111-111111111111";
const ingressDigest = "9".repeat(64);
const resourceInput = nativeTargetAuthOnlyResourcePreparationInputSchema.parse({
  appId: plan.appId,
  operationRef: ingressOperation,
  planDigest: nativeTargetAuthOnlyPlanDigest(plan),
  resourcePlanDigest: ingressDigest,
  resourcePlan: {
    action: "prepare",
    authDatabase: {
      database: plan.authResource.database,
      migratorRole: "pilot_migrator",
      resourceId: plan.authResource.resourceId,
      runtimeRole: "pilot_runtime",
    },
    authOnlyPlanDigest: nativeTargetAuthOnlyPlanDigest(plan),
    bootstrap: {
      endpointId: plan.authResource.endpointId,
      maintenanceDatabase: "neondb",
      role: "bootstrap_owner",
    },
    effects: [
      { id: "auth-resources", kind: "resources", resourceId: plan.authResource.resourceId },
    ],
    nativeNeonConfiguration: {
      connector: "neon-fixture",
      nativeStore: {
        configurationId: "configuration",
        resourceId: "store",
        sourceProjectId: "anchor",
      },
      operator: {
        audience: "https://vercel.com/fixture",
        environment: "preview",
        issuer: "https://oidc.vercel.com/fixture",
        ownerId: plan.project.teamId,
        projectId: "operator",
      },
    },
    neon: {
      branchId: "pilot-branch",
      endpoint: plan.authResource.hostname,
      projectId: "pilot-project",
    },
    resourcesInstaller: { reference: "neon-resource-bootstrap-v1", sha256: ingressDigest },
    target: {
      appId: plan.appId,
      branch: plan.branch,
      environment: "preview",
      installationId: plan.project.installationId,
      projectId: "pilot-project",
      scopeId: plan.project.teamId,
      scopeType: "team",
      sessionId: ingressOwner.sessionId,
    },
    version: 1,
  },
});

const nativeIngress = () => {
  // The real native route owns canonical owner checks; this injected denial proves
  // ingress reaches that boundary and preserves its result without running effects.
  const nativeTargetRequest = vi.fn<
    NonNullable<ProtectedHostedOperatorDependencies["nativeTargetRequest"]>
  >(() => Promise.reject(new HostedOperatorError("authorization_required")));
  const dependencies: ProtectedHostedOperatorDependencies = {
    assertAuthorized: vi.fn<ProtectedHostedOperatorDependencies["assertAuthorized"]>(),
    authorize: vi.fn<ProtectedHostedOperatorDependencies["authorize"]>(),
    bindings: vi.fn<ProtectedHostedOperatorDependencies["bindings"]>(),
    executeEffect: vi.fn<ProtectedHostedOperatorDependencies["executeEffect"]>(),
    nativeTargetRequest,
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
    withResourceLease: vi.fn(() =>
      Promise.reject(new Error("Native ingress must not acquire a protected resource lease")),
    ),
  };
  const handler = createHostedOperatorNativeHandler({
    createDependencies: () => Promise.resolve(dependencies),
  });
  const responses: Response[] = [];
  const client = createNativeTargetOnboardingClient({
    endpoint: "https://operator.example",
    fetch: async (url, init) => {
      const response = await handler(new Request(url instanceof Request ? url.url : url, init));
      responses.push(response.clone());
      return response;
    },
    ownerContext: ingressOwner,
    token: () => Promise.resolve("fixture-workload"),
  });
  return { client, dependencies, handler, nativeTargetRequest, responses };
};
type IngressClient = ReturnType<typeof createNativeTargetOnboardingClient>;

const ingressCases = [
  {
    action: "native-target-auth-only-resource-approval-read",
    invoke: (client: IngressClient) =>
      client.hasAuthOnlyResourceApproval(resourceInput, ingressContext),
  },
  {
    action: "native-target-auth-only-delivery-plan",
    invoke: (client: IngressClient) =>
      client.planAuthOnlyDelivery(
        {
          appId: plan.appId,
          operationRef: ingressOperation,
          planDigest: nativeTargetAuthOnlyPlanDigest(plan),
          resourcePlanDigest: ingressDigest,
        },
        ingressContext,
      ),
  },
  {
    action: "native-target-auth-only-entry-plan",
    invoke: (client: IngressClient) =>
      client.planAuthOnlyEntry(
        {
          appId: plan.appId,
          deliveryOperationRef: ingressOperation,
          deliveryPlanDigest: ingressDigest,
          effect: "signup-policy",
        },
        ingressContext,
      ),
  },
  {
    action: "native-target-auth-only-final-routing-plan",
    invoke: (client: IngressClient) =>
      client.planAuthOnlyFinalRouting(
        {
          appId: plan.appId,
          deliveryPlanDigest: ingressDigest,
          operationRef: ingressOperation,
        },
        ingressContext,
      ),
  },
];

describe("Auth-only native HTTP ingress", () => {
  it.each(ingressCases)(
    "preserves the native owner denial for $action through client and service",
    async ({ action, invoke }) => {
      const f = nativeIngress();
      const [result] = await Promise.allSettled([invoke(f.client)]);
      expect(result?.status).toBe("rejected");
      expect(f.responses).toHaveLength(1);
      const response = f.responses.at(0);
      if (response === undefined) {
        throw new Error("Native client did not reach the HTTP service");
      }
      expect({
        nativeCalls: f.nativeTargetRequest.mock.calls.length,
        response: operatorPublicResultSchema.parse(await response.json()),
        status: response.status,
      }).toMatchObject({
        nativeCalls: 1,
        response: { code: "authorization_required", status: "blocked" },
        status: 200,
      });
      const [request, input] = f.nativeTargetRequest.mock.calls[0] ?? [];
      expect(request?.headers.get("authorization")).toBe("Bearer fixture-workload");
      expect(request?.headers.get("x-vercel-trusted-oidc-idp-token")).toBe("fixture-workload");
      expect(input).toMatchObject({
        action,
        adapterSessionId: ingressOwner.adapterSessionId,
        callId: ingressContext.callId,
        ownerContext: ingressOwner,
      });
      expect(f.dependencies.authorize).not.toHaveBeenCalled();
      expect(f.dependencies.plan).not.toHaveBeenCalled();
      expect(f.dependencies.store.reserve).not.toHaveBeenCalled();
      expect(f.dependencies.executeEffect).not.toHaveBeenCalled();
      expect(f.dependencies.withResourceLease).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      action: "native-target-auth-only-unrecognized",
      adapterSessionId: ingressOwner.adapterSessionId,
    },
    { action: "native-target-auth-only-entry-plan", adapterSessionId: "another-adapter" },
  ])(
    "rejects unknown or mismatched native requests before delegation ($action)",
    async ({ action, adapterSessionId }) => {
      const f = nativeIngress();
      const response = await f.handler(
        new Request("https://operator.example/v1/runtime", {
          body: JSON.stringify({
            action,
            adapterSessionId,
            callId: ingressContext.callId,
            input: {
              appId: plan.appId,
              deliveryOperationRef: ingressOperation,
              deliveryPlanDigest: ingressDigest,
              effect: "signup-policy",
            },
            ownerContext: ingressOwner,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        code: "operator_unavailable",
        status: "blocked",
      });
      expect(f.nativeTargetRequest).not.toHaveBeenCalled();
      expect(f.dependencies.authorize).not.toHaveBeenCalled();
      expect(f.dependencies.executeEffect).not.toHaveBeenCalled();
    },
  );
});
