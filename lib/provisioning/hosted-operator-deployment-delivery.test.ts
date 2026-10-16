import { hasFailedGatewayDelivery } from "./hosted-operator-gateway-delivery-failure";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
  hostedOperatorPlanSchema,
  operatorPlanDigest,
  operatorDeploymentCandidatesSchema,
} from "./hosted-operator-contract";
import { createHostedOperatorDeploymentDelivery } from "./hosted-operator-deployment-delivery";
import type { HostedOperatorDeploymentContext } from "./hosted-operator-service";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const selection = {
  appId: "spend-review",
  branch: "feature",
  environment: "preview" as const,
  projectId: "prj_app",
  sessionId: "session",
};
const target = {
  ...selection,
  installationId: "installation",
  scopeId: "team",
  scopeType: "team" as const,
};
const sha = "a".repeat(40);
const appProjectSettings = {
  framework: "nextjs",
  rootDirectory: ".",
  sourceFilesOutsideRootDirectory: true,
} as const;
type FixtureJsonValue =
  | string
  | number
  | boolean
  | null
  | FixtureJsonValue[]
  | { [key: string]: FixtureJsonValue };
interface FixtureJsonObject {
  [key: string]: FixtureJsonValue;
}
const plan = hostedOperatorPlanSchema.parse({
  access: [{ actorId: "actor", organizationId: "org", roles: ["reviewer"] }],
  action: "prepare",
  appDatabase: {
    database: "app",
    migratorRole: "app_owner",
    resourceId: "app",
    runtimeRole: "app_runtime",
  },
  authDatabase: {
    database: "auth",
    migratorRole: "auth_owner",
    resourceId: "auth",
    runtimeRole: "auth_runtime",
  },
  contextId: "accepted-spec",
  cost: {
    class: "shared-recovery-group",
    description: "Explicit Preview delivery may create duplicate deployments and usage costs.",
    owner: "owner",
  },
  delivery: {
    branch: "feature",
    gitSha: sha,
    projectId: "prj_app",
    projectSettings: appProjectSettings,
    repoId: "repo",
  },
  effects: [
    { description: "resource", id: "resource", kind: "resources" },
    { description: "install", id: "install", kind: "install" },
    { description: "access", id: "access", kind: "access" },
    { description: "bind", id: "bind", kind: "bindings" },
    { description: "deliver", id: "deliver", kind: "delivery" },
  ],
  installer: { reference: "worker", sha256: "b".repeat(64) },
  neon: {
    branchId: "branch",
    connectionRef: "private",
    endpoint: "ep-fixture.neon.tech",
    projectId: "project",
    source: "synthetic-only",
  },
  release: { artifactRef: "private-release", id: "release", sha256: "c".repeat(64) },
  retention: { expiresAt: "2027-01-01T00:00:00Z", policy: "owned Preview cleanup" },
  selection,
  version: 1,
});
const gatewayPlan = hostedOperatorPlanSchema.parse({
  ...plan,
  publicGateway: {
    projectId: "prj_gateway",
    branch: "gateway-main",
    origin: "https://approved-gateway.example.test",
  },
  gatewayDelivery: {
    projectId: "prj_gateway",
    branch: "gateway-main",
    repoId: "gateway-repo",
    gitSha: sha,
  },
  deploymentBoundary: {
    authority,
    teamId: "team",
    app: { projectId: "prj_app", branch: selection.branch, environment: "preview" },
    gateway: { projectId: "prj_gateway", branch: "gateway-main", environment: "preview" },
    operator: { projectId: "prj_operator", deploymentId: "dpl_operator", environment: "preview" },
    verification: {
      gatewayOrigin: "https://approved-gateway.example.test",
      publicOrigin: "https://approved-gateway.example.test",
      jwksUrl: "https://approved-gateway.example.test/_platform/jwks.json",
    },
  },
  effects: [
    ...plan.effects,
    {
      id: "gateway-delivery",
      kind: "gateway-delivery",
      description: "Deliver and pin the exact approved Gateway Preview",
    },
  ],
});

interface DeliveryProjectFixture {
  accountId: string;
  framework?: string | null;
  id: string;
  link?: { repoId: string; type: string } | null;
  name: string;
}

const fixture = (deliveryPlan = plan, deploymentTarget: string | null = null, gateway = false) => {
  const delivery = gateway ? deliveryPlan.gatewayDelivery : deliveryPlan.delivery;
  if (delivery === undefined) {
    throw new Error("Missing fixture delivery");
  }
  let ready = "READY";
  let count = 0;
  let deny = false;
  let failCandidateReads = false;
  let oldBlockedProduction = false;
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const checkpoint = vi.fn<HostedOperatorDeploymentContext["checkpointDelivery"]>(async (rows) => {
    await Promise.resolve();
    // oxlint-disable-next-line eslint/no-use-before-define -- This callback runs only after the fixture context is initialized.
    input.deliveryCandidates = operatorDeploymentCandidatesSchema.parse(rows);
  });
  const input: HostedOperatorDeploymentContext = {
    assertCurrent: vi.fn(async () => {
      await Promise.resolve();
      if (deny) {
        throw new Error("revoked");
      }
    }),
    authority,
    checkpoint: vi.fn(async () => {
      await Promise.resolve();
    }),
    checkpointDelivery: checkpoint,
    effect: gateway ? gatewayPlan.effects[5] : plan.effects[4],
    fenceGeneration: 1,
    operationRef: "00000000-0000-4000-8000-000000000001",
    plan: deliveryPlan,
    target,
    workerCheckpoints: [],
  };
  const meta = {
    autograph_operator_effect: input.effect.id,
    autograph_operator_operation: input.operationRef,
    autograph_operator_plan: operatorPlanDigest(deliveryPlan),
  };
  const oldPlan = hostedOperatorPlanSchema.parse({
    ...deliveryPlan,
    delivery: Object.fromEntries(
      Object.entries(deliveryPlan.delivery ?? {}).filter(([key]) => key !== "projectSettings"),
    ),
  });
  const oldMeta = {
    autograph_operator_effect: input.effect.id,
    autograph_operator_operation: input.operationRef,
    autograph_operator_plan: operatorPlanDigest(oldPlan),
  };
  const project: DeliveryProjectFixture = {
    accountId: "team",
    framework: "nextjs",
    id: delivery.projectId,
    link: { repoId: delivery.repoId, type: "github" },
    name: "app",
  };
  const team = { id: "team", slug: "team-slug" };
  const deployment = {
    customEnvironment: null,
    gitSource: { ref: delivery.branch, repoId: delivery.repoId, sha, type: "github" },
    id: "dpl_new",
    meta,
    oidcTokenClaims: { environment: "preview" },
    ownerId: "team",
    projectId: delivery.projectId,
    target: deploymentTarget,
    url: "new-native.vercel.app",
  };
  const oldBlockedDeployment = {
    ...deployment,
    buildSkipped: true,
    builds: [],
    id: "dpl_previous",
    meta: oldMeta,
    oidcTokenClaims: {
      environment: "production",
      owner_id: "team",
      project_id: delivery.projectId,
    },
    readyState: "BLOCKED",
    target: "production",
    url: "old-native.vercel.app",
  };
  const aliasState = {
    name: "approved-gateway.example.test",
    projectId: "prj_gateway",
    deploymentId: "dpl_previous",
    applyWrite: true,
    throwOnWrite: false,
    failReads: false,
    missing: false,
    rejectStatus: 0,
    // SAFETY: Provider fixtures exercise both absent and nonempty redirect metadata.
    redirect: null as string | null,
    failNextRead: false,
    differentDeploymentStatus: 200,
  };
  const differentDeployment = {
    ...deployment,
    gitSource: { ...deployment.gitSource },
    id: "dpl_previous",
    meta: {},
    readyState: "READY",
  };
  const aliasWriteResponse = () => {
    if (aliasState.rejectStatus !== 0) {
      return Response.json(
        { private: "credential/body must never reach diagnostics" },
        { status: aliasState.rejectStatus },
      );
    }
    if (aliasState.applyWrite) {
      aliasState.deploymentId = "dpl_new";
      aliasState.missing = false;
    }
    if (aliasState.throwOnWrite) {
      throw new Error("Private lost provider response");
    }
    return Response.json({ alias: aliasState.name });
  };
  const candidateResponse = () =>
    failCandidateReads
      ? new Response(null, { status: 503 })
      : Response.json({ ...deployment, readyState: ready });
  const deploymentPageResponse = () => {
    const deployments = count === 0 ? [] : [{ meta, uid: "dpl_new" }];
    return Response.json({
      deployments: [
        ...deployments,
        ...(oldBlockedProduction ? [{ meta: oldMeta, uid: "dpl_previous" }] : []),
      ],
      pagination: { next: null },
    });
  };
  const createDeploymentResponse = (body: FixtureJsonObject) => {
    if (gateway) {
      expect(body).not.toHaveProperty("target");
    } else {
      expect(body).toMatchObject({ target: "staging" });
    }
    count += 1;
    return Response.json({ id: "dpl_new" });
  };
  const aliasReadResponse = () => {
    if (aliasState.failNextRead) {
      aliasState.failNextRead = false;
      return new Response(null, { status: 500 });
    }
    if (aliasState.failReads) {
      return new Response(null, { status: 500 });
    }
    if (aliasState.missing) {
      return new Response(null, { status: 404 });
    }
    return Response.json({
      alias: aliasState.name,
      deploymentId: aliasState.deploymentId,
      projectId: aliasState.projectId,
      redirect: aliasState.redirect,
    });
  };
  const fetcher: typeof fetch = async (url, init) => {
    await Promise.resolve();
    const requestUrl = new URL(url instanceof Request ? url.url : url);
    expect(requestUrl.searchParams.get("teamId")).toBe(target.scopeId);
    const path = requestUrl.pathname;
    const method = init?.method ?? "GET";
    let body: FixtureJsonObject | undefined;
    if (init?.body !== undefined) {
      body = z.record(z.string(), z.json()).parse(JSON.parse(z.string().parse(init.body)));
    }
    calls.push({ body, method, path });
    if (path.startsWith("/v4/aliases/")) {
      return aliasReadResponse();
    }
    if (path === "/v2/deployments/dpl_new/aliases" && method === "POST") {
      return aliasWriteResponse();
    }
    if (path === "/v7/deployments") {
      return deploymentPageResponse();
    }
    if (path === `/v9/projects/${project.id}`) {
      return Response.json(project);
    }
    if (path === "/v2/teams/team") {
      return Response.json(team);
    }
    if (path === "/v13/deployments" && method === "POST") {
      return createDeploymentResponse(body ?? {});
    }
    if (path === "/v13/deployments/dpl_new") {
      return candidateResponse();
    }
    if (path === "/v13/deployments/dpl_previous") {
      return Response.json(oldBlockedProduction ? oldBlockedDeployment : differentDeployment, {
        status: aliasState.differentDeploymentStatus,
      });
    }
    throw new Error("Unexpected native request");
  };
  const wait = vi.fn(async (_milliseconds: number, signal?: AbortSignal) => {
    await Promise.resolve();
    signal?.throwIfAborted();
    ready = "READY";
  });
  const observeAlias = vi.fn(async () => {
    await Promise.resolve();
  });
  const writer = createHostedOperatorDeploymentDelivery({
    observeAlias,
    wait,
    assertAuthorized: vi.fn(async () => {
      await Promise.resolve();
    }),
    assertEnvironment: vi.fn(async () => {
      await Promise.resolve();
    }),
    fetch: fetcher,
    ...(gateway ? { target: "gateway" as const } : {}),
    readCredential: async () =>
      await Promise.resolve({
        binding: {
          active: true,
          displayName: "team",
          installationId: "installation",
          plan: "pro",
          scopeId: "team",
          scopeType: "team",
          slug: "team-slug",
          updatedAt: new Date(),
        },
        token: "fixture-only",
      }),
  });
  return {
    calls,
    wait,
    aliasState,
    observeAlias,
    project,
    team,
    deployment,
    differentDeployment,
    checkpoint,
    input,
    failCandidateReads: () => {
      failCandidateReads = true;
    },
    seedCandidate: () => {
      count = 1;
    },
    revoke: () => {
      deny = true;
    },
    setReady: (value: string) => {
      ready = value;
    },
    useOldBlockedProduction: () => {
      oldBlockedProduction = true;
    },
    oldPlan,
    writer,
  };
};
it("requests standard Preview delivery from approved Git source and observes readiness", async () => {
  const f = fixture();
  const initial = await f.writer.reconcile(f.input);
  f.setReady("BUILDING");
  const first = await f.writer.deliver(f.input);
  expect(initial.status).toBe("retryable");
  expect(first.status).toBe("applied");
  expect(f.wait).toHaveBeenCalled();
  const whileBuilding = await f.writer.deliver(f.input);
  expect(whileBuilding.status).toBe("applied");
  expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  expect(f.calls.find((call) => call.method === "POST")?.body).toMatchObject({
    gitSource: { ref: "feature", repoId: "repo", sha, type: "github" },
    project: "prj_app",
    meta: {
      autograph_operator_effect: "deliver",
      autograph_operator_operation: f.input.operationRef,
      autograph_operator_plan: operatorPlanDigest(plan),
    },
  });
  expect(f.calls.find((call) => call.method === "POST")?.body).toMatchObject({
    projectSettings: appProjectSettings,
  });
  expect(f.calls.find((call) => call.method === "POST")?.body).toMatchObject({ target: "staging" });
  expect(f.calls.find((call) => call.method === "POST")?.body).not.toHaveProperty("buildCommand");
  expect(f.calls.find((call) => call.method === "POST")?.body).not.toHaveProperty("installCommand");
  expect(f.checkpoint).toHaveBeenCalled();
  f.setReady("READY");
  const result = await f.writer.reconcile(f.input);
  expect(result.status).toBe("applied");
  expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(1);
});
it("permits an app profile successor only after exact terminal blocked Production readback", async () => {
  const f = fixture();
  f.useOldBlockedProduction();
  Object.assign(f.input, {
    priorAppDelivery: {
      deliveryCandidates: [
        {
          branch: "feature",
          deploymentId: "dpl_previous",
          operationRef: f.input.operationRef,
          origin: "https://old-native.vercel.app",
          projectId: "prj_app",
          readyState: "BLOCKED",
          repoId: "repo",
        },
      ],
      operationRef: f.input.operationRef,
      plan: f.oldPlan,
      planDigest: operatorPlanDigest(f.oldPlan),
    },
  });

  const result = await f.writer.deliver(f.input);

  expect(result.status).toBe("applied");
  expect(f.calls.find((call) => call.method === "POST")?.body).toMatchObject({
    projectSettings: appProjectSettings,
    target: "staging",
  });
  expect(f.checkpoint.mock.calls.at(-1)?.[0].map((candidate) => candidate.deploymentId)).toEqual([
    "dpl_new",
  ]);
  expect(f.calls.some((call) => call.path === "/v13/deployments/dpl_previous")).toBe(true);
});
it("does not POST a profile successor when prior Production approval identity is invalid", async () => {
  const f = fixture();
  f.useOldBlockedProduction();
  Object.assign(f.input, {
    priorAppDelivery: {
      deliveryCandidates: [],
      operationRef: f.input.operationRef,
      plan: f.oldPlan,
      planDigest: "0".repeat(64),
    },
  });

  const result = await f.writer.deliver(f.input);

  expect(result.status).toBe("unknown");
  expect(
    f.calls.filter((call) => call.method === "POST" && call.path === "/v13/deployments"),
  ).toHaveLength(0);
});
it("does not send app project settings with Gateway delivery", async () => {
  const f = fixture(gatewayPlan, null, true);
  await f.writer.deliver(f.input);
  expect(f.calls.find((call) => call.method === "POST")?.body).not.toHaveProperty(
    "projectSettings",
  );
});
it.each(["absent", "null"] as const)(
  "delivers exact approved Git source to an app project with a %s Git link",
  async (linkState) => {
    const f = fixture();
    if (linkState === "absent") {
      Reflect.deleteProperty(f.project, "link");
    } else {
      f.project.link = null;
    }
    const delivered = await f.writer.deliver(f.input);
    expect(delivered.status).toBe("applied");
    expect(f.calls.find((call) => call.method === "POST")?.body).toMatchObject({
      gitSource: { ref: plan.delivery?.branch, repoId: plan.delivery?.repoId, sha, type: "github" },
      project: plan.delivery?.projectId,
    });
    f.setReady("READY");
    const reconciled = await f.writer.reconcile(f.input);
    expect(reconciled.status).toBe("applied");
  },
);
it("still requires a linked project for Gateway delivery", async () => {
  const f = fixture(gatewayPlan, null, true);
  Reflect.deleteProperty(f.project, "link");
  await expect(f.writer.deliver(f.input)).rejects.toMatchObject({ code: "resource_mismatch" });
  expect(f.calls.some((call) => call.method === "POST")).toBe(false);
});
it("delivers the approved published ref while retaining the resource branch", async () => {
  const branch = "codex/generated-app";
  const publishedPlan = hostedOperatorPlanSchema.parse({
    ...plan,
    delivery: { ...plan.delivery, branch },
    publicGateway: {
      branch: "main",
      projectId: "prj_gateway",
      origin: "https://public.example.test",
    },
    deploymentBoundary: {
      app: { branch, deploymentId: "dpl_previous", environment: "preview", projectId: "prj_app" },
      gateway: {
        branch: "main",
        deploymentId: "dpl_gateway",
        environment: "preview",
        projectId: "prj_gateway",
      },
      operator: { deploymentId: "dpl_operator", environment: "preview", projectId: "prj_operator" },
      authority,
      teamId: "team",
      verification: {
        gatewayOrigin: "https://gateway.example.test",
        publicOrigin: "https://public.example.test",
        jwksUrl: "https://gateway.example.test/_platform/jwks.json",
      },
    },
  });
  const f = fixture(publishedPlan);
  await f.writer.deliver(f.input);
  expect(f.input.target.branch).toBe(selection.branch);
  expect(f.calls.find((call) => call.method === "POST")?.body).toMatchObject({
    gitSource: { ref: branch, sha },
  });
  f.setReady("READY");
  const observed = await f.writer.reconcile(f.input);
  expect(observed.status).toBe("applied");
});
it("denies after current authority is revoked before POST", async () => {
  const f = fixture();
  f.revoke();
  await expect(f.writer.deliver(f.input)).rejects.toThrow();
  expect(f.calls.some((call) => call.method === "POST")).toBe(false);
});

it.each(["services", "nextjs", null, "future-provider-framework", undefined])(
  "delivers the approved source through BUILDING to READY with framework metadata %s",
  async (framework) => {
    const f = fixture();
    f.project.framework = framework;
    f.setReady("BUILDING");
    const building = await f.writer.deliver(f.input);
    expect(building.status).toBe("applied");
    expect(f.calls.find((call) => call.method === "POST")?.body).toMatchObject({
      project: plan.selection.projectId,
      gitSource: { repoId: plan.delivery?.repoId, ref: plan.delivery?.branch, sha },
    });
    f.setReady("READY");
    const result = await f.writer.reconcile(f.input);
    expect(result.status).toBe("applied");
    if (result.status === "applied") {
      expect(result.selected).toMatchObject({
        projectId: plan.selection.projectId,
        repoId: plan.delivery?.repoId,
        branch: plan.delivery?.branch,
        readyState: "READY",
      });
    }
  },
);
it("retains an actual provider build failure as retryable delivery", async () => {
  const f = fixture();
  f.project.framework = "services";
  f.setReady("ERROR");
  const delivered = await f.writer.deliver(f.input);
  const reconciled = await f.writer.reconcile(f.input);
  expect(delivered.status).toBe("retryable");
  expect(reconciled.status).toBe("retryable");
});
it("guides source recovery only after actual failed readback when repaired trusted source is available", async () => {
  const f = fixture(gatewayPlan, null, true);
  const repairedSha = "e".repeat(40);
  f.setReady("ERROR");
  const delivered = await f.writer.deliver(f.input);
  const observed = await f.writer.reconcile(f.input);
  expect(hasFailedGatewayDelivery(f.input, delivered, repairedSha)).toBe(true);
  expect(hasFailedGatewayDelivery(f.input, observed, repairedSha)).toBe(true);
  // The native result remains retryable: same-source explicit retries are not fenced by this guidance.
  expect(observed.status).toBe("retryable");
  expect(hasFailedGatewayDelivery(f.input, observed, sha)).toBe(false);
  expect(hasFailedGatewayDelivery(f.input, { ...observed, status: "unknown" }, repairedSha)).toBe(
    false,
  );
  expect(
    hasFailedGatewayDelivery(
      f.input,
      {
        ...observed,
        candidates: observed.candidates?.map((candidate) => ({
          ...candidate,
          gatewayAliasAttempted: true,
        })),
      },
      repairedSha,
    ),
  ).toBe(false);
  expect(
    hasFailedGatewayDelivery(
      f.input,
      {
        ...observed,
        candidates: observed.candidates?.map((candidate) => ({
          ...candidate,
          operationRef: "00000000-0000-4000-8000-000000000002",
        })),
      },
      repairedSha,
    ),
  ).toBe(false);
  f.setReady("BUILDING");
  expect(hasFailedGatewayDelivery(f.input, await f.writer.reconcile(f.input), repairedSha)).toBe(
    false,
  );
});
it.each(["owner", "repository"])(
  "rejects an actual wrong project %s before deployment",
  async (mismatch) => {
    const f = fixture();
    f.project.framework = "services";
    if (mismatch === "owner") {
      f.project.accountId = "another-team";
    } else {
      f.project.link = { repoId: "another-repo", type: "github" };
    }
    await expect(f.writer.deliver(f.input)).rejects.toMatchObject({ code: "resource_mismatch" });
    expect(f.calls.some((call) => call.method === "POST")).toBe(false);
  },
);
it("rejects a linked app project that uses an unsupported Git provider", async () => {
  const f = fixture();
  Object.assign(f.project, { link: { repoId: "repo", type: "gitlab" } });
  await expect(f.writer.deliver(f.input)).rejects.toThrow();
  expect(f.calls.some((call) => call.method === "POST")).toBe(false);
});
it.each(["owner", "repository", "branch", "commit"])(
  "rejects actual deployment %s mismatch",
  async (mismatch) => {
    const f = fixture();
    f.project.framework = null;
    if (mismatch === "owner") {
      f.deployment.ownerId = "another-team";
    }
    if (mismatch === "repository") {
      f.deployment.gitSource.repoId = "another-repo";
    }
    if (mismatch === "branch") {
      f.deployment.gitSource.ref = "another-branch";
    }
    if (mismatch === "commit") {
      f.deployment.gitSource.sha = "d".repeat(40);
    }
    f.setReady("READY");
    await expect(f.writer.deliver(f.input)).rejects.toMatchObject({ code: "resource_mismatch" });
    expect(f.checkpoint).not.toHaveBeenCalled();
  },
);

it("reconciles historical staging delivery with Preview claims without changing the approved source", async () => {
  const f = fixture();
  await f.writer.deliver(f.input);
  f.deployment.target = "staging";
  f.setReady("READY");
  const observed = await f.writer.reconcile(f.input);
  expect(observed.status).toBe("applied");
  if (observed.status === "applied") {
    expect(observed.selected).toMatchObject({
      projectId: plan.selection.projectId,
      repoId: plan.delivery?.repoId,
      branch: plan.delivery?.branch,
      operationRef: f.input.operationRef,
    });
  }
});

const readyGateway = async () => {
  const f = fixture(gatewayPlan, null, true);
  f.seedCandidate();
  await f.writer.reconcile(f.input);
  return f;
};

const narrowedGateway = async () => {
  const original = hostedOperatorPlanSchema.parse({
    ...gatewayPlan,
    access: [],
    stage: "auth-bootstrap",
    resourcesInstaller: { reference: "neon-resource-bootstrap-v1", sha256: "c".repeat(64) },
    authSchema: {
      artifactRef: "auth-plan",
      installer: plan.installer,
      planDigest: "a".repeat(64),
      targetDigest: "b".repeat(64),
    },
    bootstrap: { endpointId: "ep-fixture", maintenanceDatabase: "neondb", role: "neondb_owner" },
    effects: [
      {
        id: "auth-resources",
        kind: "resources",
        resourceId: plan.authDatabase.resourceId,
        description: "Prepare Auth",
      },
      {
        id: "app-resources",
        kind: "resources",
        resourceId: plan.appDatabase.resourceId,
        description: "Prepare app",
      },
      { id: "install", kind: "install", description: "Install Auth" },
      { id: "gateway-bindings", kind: "gateway-bindings", description: "Bind approved protection" },
      { id: "gateway-delivery", kind: "gateway-delivery", description: "Deliver Gateway" },
    ],
    gatewayBindings: {
      authBrowserOrigin: "https://auth-preview.example.test",
      builderCallbackOrigin: "https://builder.example",
      catalogAppIds: [selection.appId],
      operatorOrigin: "https://operator.example",
      sourceWorkload: {
        audience: "https://vercel.com",
        environment: "preview",
        issuer: "https://oidc.vercel.com/team",
        ownerId: "team",
        projectId: "prj_gateway",
        subject: "fixture-gateway",
      },
      trustedSources: {
        builderProduction: { projectId: "builder", from: "production", to: "preview" },
        operatorPreview: { projectId: "operator", from: "preview", to: "preview" },
      },
    },
  });
  const current = hostedOperatorPlanSchema.parse({
    ...original,
    gatewayBindings: { ...original.gatewayBindings, trustedSources: undefined },
  });
  const f = fixture(current, null, true);
  f.input.gatewayDeliveryProvenance = [
    {
      operationRef: f.input.operationRef,
      plan: original,
      planDigest: operatorPlanDigest(original),
      approvalId: "original-approval",
      approvedByCallId: "original-approved-call",
    },
  ];
  f.deployment.meta.autograph_operator_plan = operatorPlanDigest(original);
  f.seedCandidate();
  await f.writer.reconcile(f.input);
  f.input.deliveryCandidates = operatorDeploymentCandidatesSchema.parse(
    f.input.deliveryCandidates?.map((candidate) => ({ ...candidate, gatewayAliasAttempted: true })),
  );
  return f;
};

it("reconciles an approved narrowing's retained metadata and reassigns only after fresh same-source negative alias evidence", async () => {
  const f = await narrowedGateway();
  expect(await f.writer.reconcile(f.input)).toMatchObject({ status: "retryable" });
  expect(await f.writer.deliver(f.input)).toMatchObject({
    status: "applied",
    selected: { deploymentId: "dpl_new" },
  });
  expect(f.calls.some((call) => call.path === "/v13/deployments/dpl_previous")).toBe(true);
  expect(
    f.calls.filter((call) => call.path.endsWith("/aliases") && call.method === "POST"),
  ).toHaveLength(1);
  expect(f.calls.some((call) => call.path === "/v13/deployments" && call.method === "POST")).toBe(
    false,
  );
  expect(f.input.deliveryCandidates).toEqual([
    expect.objectContaining({ deploymentId: "dpl_new", gatewayAliasAttempted: true }),
  ]);
});

it.each([
  "missing",
  "failed",
  "redirect",
  "deployment-read",
  "malformed",
  "project",
  "owner",
  "project-account",
  "team",
  "repo",
  "branch",
  "sha",
  "production",
  "custom",
  "not-ready",
])("keeps narrowed alias recovery unknown for %s negative evidence", async (failure) => {
  const f = await narrowedGateway();
  switch (failure) {
    case "missing": {
      f.aliasState.missing = true;
      break;
    }
    case "failed": {
      f.aliasState.failReads = true;
      break;
    }
    case "redirect": {
      f.aliasState.redirect = "https://redirect.example.test";
      break;
    }
    case "deployment-read": {
      f.aliasState.differentDeploymentStatus = 503;
      break;
    }
    case "malformed": {
      f.differentDeployment.url = "invalid/path";
      break;
    }
    case "project": {
      f.differentDeployment.projectId = "another-project";
      break;
    }
    case "owner": {
      f.differentDeployment.ownerId = "another-owner";
      break;
    }
    case "project-account": {
      Object.assign(f.differentDeployment, { ownerId: undefined });
      f.project.accountId = "another-owner";
      break;
    }
    case "team": {
      Object.assign(f.differentDeployment, { ownerId: undefined });
      f.team.id = "another-team";
      break;
    }
    case "repo": {
      f.differentDeployment.gitSource.repoId = "another-repo";
      break;
    }
    case "branch": {
      f.differentDeployment.gitSource.ref = "another-branch";
      break;
    }
    case "sha": {
      f.differentDeployment.gitSource.sha = "f".repeat(40);
      break;
    }
    case "production": {
      f.differentDeployment.target = "production";
      break;
    }
    case "custom": {
      Object.assign(f.differentDeployment, { customEnvironment: "custom" });
      break;
    }
    case "not-ready": {
      f.differentDeployment.readyState = "ERROR";
      break;
    }
    default: {
      throw new Error("Unknown fixture failure");
    }
  }
  expect(await f.writer.deliver(f.input)).toMatchObject({ status: "unknown" });
  expect(f.calls.some((call) => call.method === "POST")).toBe(false);
  expect(f.input.deliveryCandidates?.[0]?.gatewayAliasAttempted).toBe(true);
});

it("uses independently observed project and team ownership when the different alias deployment omits ownerId", async () => {
  const f = await narrowedGateway();
  Object.assign(f.differentDeployment, { ownerId: undefined });
  expect(await f.writer.deliver(f.input)).toMatchObject({
    status: "applied",
    selected: { deploymentId: "dpl_new" },
  });
  expect(f.calls.some((call) => call.path === "/v9/projects/prj_gateway")).toBe(true);
  expect(f.calls.some((call) => call.path === "/v2/teams/team")).toBe(true);
  expect(f.input.deliveryCandidates).toEqual([
    expect.objectContaining({ deploymentId: "dpl_new", gatewayAliasAttempted: true }),
  ]);
});

it.each(["absent", "operation", "digest", "approval", "call", "changed-source"])(
  "does not use unproved prior metadata for %s lineage",
  async (failure) => {
    const f = await narrowedGateway();
    const provenance = f.input.gatewayDeliveryProvenance?.[0];
    if (provenance === undefined) {
      throw new Error("Missing fixture provenance");
    }
    const changed = { ...provenance };
    switch (failure) {
      case "absent": {
        f.input.gatewayDeliveryProvenance = undefined;
        break;
      }
      case "operation": {
        changed.operationRef = "different-operation";
        break;
      }
      case "digest": {
        changed.planDigest = "f".repeat(64);
        break;
      }
      case "approval": {
        changed.approvalId = "";
        break;
      }
      case "call": {
        changed.approvedByCallId = "operator:unapproved-plan";
        break;
      }
      case "changed-source": {
        changed.plan = hostedOperatorPlanSchema.parse({
          ...changed.plan,
          gatewayDelivery: { ...changed.plan.gatewayDelivery, gitSha: "f".repeat(40) },
        });
        changed.planDigest = operatorPlanDigest(changed.plan);
        break;
      }
      default: {
        throw new Error("Unknown fixture lineage");
      }
    }
    if (failure !== "absent") {
      f.input.gatewayDeliveryProvenance = [changed];
    }
    expect(await f.writer.deliver(f.input)).toMatchObject({ status: "unknown" });
    expect(f.calls.some((call) => call.method === "POST")).toBe(false);
  },
);

it.each(["autograph_operator_effect", "autograph_operator_operation", "autograph_operator_plan"])(
  "rejects a retained candidate with foreign %s metadata",
  async (key) => {
    const f = await narrowedGateway();
    Object.assign(f.deployment.meta, { [key]: "foreign-metadata" });
    expect(await f.writer.deliver(f.input)).toMatchObject({ status: "unknown" });
    expect(f.calls.some((call) => call.method === "POST")).toBe(false);
  },
);
it("assigns only the approved Gateway hostname to its exact READY deployment and independently reads it back", async () => {
  const f = await readyGateway();
  f.deployment.url = "candidate-field-is-not-alias-authority.vercel.app";
  const before = await f.writer.reconcile(f.input);
  expect(before.status).toBe("retryable");
  const result = await f.writer.deliver(f.input);
  expect(result.status).toBe("applied");
  expect(
    f.calls
      .filter((call) => call.path.endsWith("/aliases") && call.method === "POST")
      .map((call) => call.body),
  ).toEqual([{ alias: "approved-gateway.example.test" }]);
  expect(
    f.calls.filter((call) => call.path === "/v13/deployments" && call.method === "POST"),
  ).toHaveLength(0);
  expect(
    f.input.deliveryCandidates?.find((candidate) => candidate.deploymentId === "dpl_new")
      ?.gatewayAliasAttempted,
  ).toBe(true);
  expect(f.aliasState.deploymentId).toBe("dpl_new");
});
it.each([true, false])(
  "does not blindly repeat an alias assignment after a lost response (provider applied: %s)",
  async (applied) => {
    const f = await readyGateway();
    f.aliasState.applyWrite = applied;
    f.aliasState.throwOnWrite = true;
    const first = await f.writer.deliver(f.input);
    expect(first.status).toBe("unknown");
    const savedJournal = JSON.stringify(f.input.deliveryCandidates);
    f.input.deliveryCandidates = operatorDeploymentCandidatesSchema.parse(JSON.parse(savedJournal));
    const replay = await f.writer.deliver(f.input);
    expect(replay.status).toBe(applied ? "applied" : "unknown");
    expect(
      f.calls.filter((call) => call.path.endsWith("/aliases") && call.method === "POST"),
    ).toHaveLength(1);
    expect(
      f.calls.filter((call) => call.path === "/v13/deployments" && call.method === "POST"),
    ).toHaveLength(0);
    expect(
      f.input.deliveryCandidates?.some((candidate) => candidate.gatewayAliasAttempted === true),
    ).toBe(true);
  },
);
it("keeps a saved attempted alias unknown through provider read failures without another write", async () => {
  const f = await readyGateway();
  f.aliasState.applyWrite = false;
  f.aliasState.throwOnWrite = true;
  await f.writer.deliver(f.input);
  f.aliasState.failReads = true;
  const replay = await f.writer.deliver(f.input);
  expect(replay.status).toBe("unknown");
  expect(
    f.calls.filter((call) => call.path.endsWith("/aliases") && call.method === "POST"),
  ).toHaveLength(1);
});
it.each(["foreign-alias", "not-ready", "revoked", "foreign-source"])(
  "does not assign the approved Gateway alias for %s",
  async (failure) => {
    const f = await readyGateway();
    if (failure === "foreign-alias") {
      f.aliasState.projectId = "another-project";
    }
    if (failure === "not-ready") {
      f.setReady("BUILDING");
      f.wait.mockImplementation(async () => {
        await Promise.resolve();
        f.setReady("CANCELED");
      });
    }
    if (failure === "revoked") {
      f.revoke();
    }
    if (failure === "foreign-source") {
      f.deployment.gitSource.repoId = "another-repository";
    }
    try {
      await f.writer.deliver(f.input);
    } catch {
      /* Current authorization may reject before reconciliation. */
    }
    expect(f.calls.some((call) => call.path.endsWith("/aliases") && call.method === "POST")).toBe(
      false,
    );
  },
);
it("does not attempt Gateway alias writes from app delivery", async () => {
  const f = fixture();
  await f.writer.deliver(f.input);
  f.setReady("READY");
  const observed = await f.writer.reconcile(f.input);
  expect(observed.status).toBe("applied");
  expect(f.calls.some((call) => call.path.includes("/aliases"))).toBe(false);
});

it("does not allocate another assignment when the approved alias already names the READY candidate", async () => {
  const f = await readyGateway();
  f.aliasState.deploymentId = "dpl_new";
  const observed = await f.writer.deliver(f.input);
  expect(observed.status).toBe("applied");
  expect(f.calls.some((call) => call.path.endsWith("/aliases") && call.method === "POST")).toBe(
    false,
  );
});
it("creates the exact approved missing alias without deriving a new hostname", async () => {
  const f = await readyGateway();
  f.aliasState.missing = true;
  const observed = await f.writer.deliver(f.input);
  expect(observed.status).toBe("applied");
  expect(
    f.calls.find((call) => call.path.endsWith("/aliases") && call.method === "POST")?.body,
  ).toEqual({ alias: new URL(gatewayPlan.publicGateway?.origin ?? "").hostname });
});
it("does not assign when durable intent checkpointing fails", async () => {
  const f = await readyGateway();
  f.checkpoint.mockImplementation(async (rows) => {
    await Promise.resolve();
    if (rows.some((row) => row.gatewayAliasAttempted === true)) {
      throw new Error("Private checkpoint failure");
    }
    f.input.deliveryCandidates = structuredClone([...rows]);
  });
  await expect(f.writer.deliver(f.input)).rejects.toThrow("Private checkpoint failure");
  expect(f.calls.some((call) => call.path.endsWith("/aliases") && call.method === "POST")).toBe(
    false,
  );
});

it("durably records a definite alias rejection and permits a later corrected approved attempt", async () => {
  const f = await readyGateway();
  f.aliasState.rejectStatus = 400;
  const rejected = await f.writer.deliver(f.input);
  expect(rejected.status).toBe("retryable");
  expect(rejected).toHaveProperty("resourceVersion");
  const savedRejectedJournal = JSON.stringify(f.input.deliveryCandidates);
  f.input.deliveryCandidates = operatorDeploymentCandidatesSchema.parse(
    JSON.parse(savedRejectedJournal),
  );
  expect(f.input.deliveryCandidates?.[0]?.gatewayAliasAttempted).toBe(false);
  expect(f.observeAlias).toHaveBeenCalledWith({
    stage: "assignment",
    method: "POST",
    httpStatus: 400,
    category: "rejected",
  });
  expect(JSON.stringify(f.observeAlias.mock.calls)).not.toContain("credential/body");
  f.aliasState.rejectStatus = 0;
  const corrected = await f.writer.deliver(f.input);
  expect(corrected.status).toBe("applied");
  expect(
    f.calls.filter((call) => call.path.endsWith("/aliases") && call.method === "POST"),
  ).toHaveLength(2);
  expect(
    f.calls.filter((call) => call.path === "/v13/deployments" && call.method === "POST"),
  ).toHaveLength(0);
});
it("retains uncertain intent when recording a definite rejection fails", async () => {
  const f = await readyGateway();
  f.aliasState.rejectStatus = 400;
  const persist = f.checkpoint.getMockImplementation();
  f.checkpoint.mockImplementation(async (rows, selected) => {
    if (rows.some((row) => row.gatewayAliasAttempted === false)) {
      throw new Error("private checkpoint failure");
    }
    await persist?.(rows, selected);
  });
  const rejected = await f.writer.deliver(f.input);
  expect(rejected.status).toBe("unknown");
  f.aliasState.rejectStatus = 0;
  const replay = await f.writer.deliver(f.input);
  expect(replay.status).toBe("unknown");
  expect(f.input.deliveryCandidates?.[0]?.gatewayAliasAttempted).toBe(true);
  expect(
    f.calls.filter((call) => call.path.endsWith("/aliases") && call.method === "POST"),
  ).toHaveLength(1);
});
it.each([408, 499, 500])(
  "keeps ambiguous HTTP %s assignment outcomes read-only",
  async (status) => {
    const f = await readyGateway();
    f.aliasState.rejectStatus = status;
    const uncertain = await f.writer.deliver(f.input);
    expect(uncertain.status).toBe("unknown");
    f.aliasState.rejectStatus = 0;
    const replay = await f.writer.deliver(f.input);
    expect(replay.status).toBe("unknown");
    expect(
      f.calls.filter((call) => call.path.endsWith("/aliases") && call.method === "POST"),
    ).toHaveLength(1);
  },
);
it("does not report direct alias binding applied when a redirect overrides that deployment", async () => {
  const f = await readyGateway();
  f.aliasState.deploymentId = "dpl_new";
  f.aliasState.redirect = "https://private-route.example.test";
  const redirected = await f.writer.deliver(f.input);
  expect(redirected.status).toBe("unknown");
  expect(f.calls.some((call) => call.path.endsWith("/aliases") && call.method === "POST")).toBe(
    false,
  );
  expect(f.input.deliveryCandidates?.[0]?.gatewayAliasAttempted).toBeUndefined();
  expect(JSON.stringify(f.observeAlias.mock.calls)).not.toContain("private-route");
});
it("recovers a read failure before assignment without persisting attempted intent", async () => {
  const f = await readyGateway();
  let aliasReads = 0;
  f.observeAlias.mockImplementation(async () => {
    aliasReads += 1;
    if (aliasReads === 1) {
      f.aliasState.failNextRead = true;
    }
    await Promise.resolve();
  });
  const failedRead = await f.writer.deliver(f.input);
  expect(failedRead.status).toBe("unknown");
  expect(f.input.deliveryCandidates?.[0]?.gatewayAliasAttempted).toBeUndefined();
  expect(f.calls.some((call) => call.path.endsWith("/aliases") && call.method === "POST")).toBe(
    false,
  );
  f.observeAlias.mockImplementation(async () => {
    await Promise.resolve();
    throw new Error("private advisory failure");
  });
  const corrected = await f.writer.deliver(f.input);
  expect(corrected.status).toBe("applied");
});

it("does not await an unresolved advisory alias observer", async () => {
  const f = await readyGateway();
  const pendingDiagnostic = Promise.withResolvers<undefined>();
  f.observeAlias.mockImplementation(() => pendingDiagnostic.promise);
  const delivered = await f.writer.deliver(f.input);
  expect(delivered.status).toBe("applied");
});
it("accepts empty redirect metadata as a direct deployment binding", async () => {
  const f = await readyGateway();
  f.aliasState.deploymentId = "dpl_new";
  f.aliasState.redirect = "";
  const direct = await f.writer.deliver(f.input);
  expect(direct.status).toBe("applied");
});

it("waits through a long native Gateway build under the renewed lease and assigns its approved alias", async () => {
  const f = fixture(gatewayPlan, null, true);
  const controller = new AbortController();
  f.input.signal = controller.signal;
  let now = 0;
  let leaseExpiresAt = 60_000;
  f.input.assertCurrent = vi.fn(async () => {
    await Promise.resolve();
    if (now >= leaseExpiresAt) {
      throw new Error("execution lease expired");
    }
    leaseExpiresAt = now + 60_000;
  });
  f.setReady("QUEUED");
  f.wait.mockImplementation(async (milliseconds, signal) => {
    await Promise.resolve();
    signal?.throwIfAborted();
    now += milliseconds;
    let state = "INITIALIZING";
    if (now >= 90_000) {
      state = "READY";
    } else if (now >= 15_000) {
      state = "BUILDING";
    }
    f.setReady(state);
  });
  const observed = await f.writer.deliver(f.input);
  expect(observed.status).toBe("applied");
  expect(now).toBeGreaterThan(60_000);
  expect(leaseExpiresAt).toBeGreaterThan(now);
  expect(
    f.calls.filter((call) => call.path === "/v13/deployments" && call.method === "POST"),
  ).toHaveLength(1);
  expect(
    f.calls.filter((call) => call.path.endsWith("/aliases") && call.method === "POST"),
  ).toHaveLength(1);
  expect(f.calls.filter((call) => call.path === "/v7/deployments").length).toBeLessThan(
    f.wait.mock.calls.length,
  );
  expect(f.calls.filter((call) => call.path.startsWith("/v9/projects/")).length).toBeLessThan(
    f.wait.mock.calls.length,
  );
  expect(f.input.deliveryCandidates?.[0]?.readyState).toBe("READY");
});

it.each(["ERROR", "CANCELED"])(
  "retains a waited %s build without creating another deployment",
  async (state) => {
    const f = fixture(gatewayPlan, null, true);
    f.setReady("BUILDING");
    f.wait.mockImplementation(async () => {
      await Promise.resolve();
      f.setReady(state);
    });
    const observed = await f.writer.deliver(f.input);
    expect(observed.status).toBe("unknown");
    expect(observed).toMatchObject({ candidates: [{ readyState: state }] });
    expect(
      f.calls.filter((call) => call.path === "/v13/deployments" && call.method === "POST"),
    ).toHaveLength(1);
    expect(f.calls.some((call) => call.path.endsWith("/aliases") && call.method === "POST")).toBe(
      false,
    );
  },
);

it("stops a pending build on request cancellation without a replacement or alias write", async () => {
  const f = fixture(gatewayPlan, null, true);
  const controller = new AbortController();
  f.input.signal = controller.signal;
  f.setReady("BUILDING");
  f.wait.mockImplementation(async (_milliseconds, signal) => {
    await Promise.resolve();
    expect(signal).toBe(controller.signal);
    controller.abort();
    signal?.throwIfAborted();
  });
  const observed = await f.writer.deliver(f.input);
  expect(observed.status).toBe("unknown");
  expect(
    f.calls.filter((call) => call.path === "/v13/deployments" && call.method === "POST"),
  ).toHaveLength(1);
  expect(f.calls.some((call) => call.path.endsWith("/aliases") && call.method === "POST")).toBe(
    false,
  );
  expect(f.input.deliveryCandidates?.[0]?.readyState).toBe("BUILDING");
});

it("stops a pending build when current authority is revoked", async () => {
  const f = fixture(gatewayPlan, null, true);
  f.setReady("BUILDING");
  f.wait.mockImplementation(async () => {
    await Promise.resolve();
    f.revoke();
  });
  const observed = await f.writer.deliver(f.input);
  expect(observed.status).toBe("unknown");
  expect(
    f.calls.filter((call) => call.path === "/v13/deployments" && call.method === "POST"),
  ).toHaveLength(1);
  expect(f.calls.some((call) => call.path.endsWith("/aliases") && call.method === "POST")).toBe(
    false,
  );
});

it("does not wait or repeat a write when an alias effect is genuinely uncertain", async () => {
  const f = await readyGateway();
  f.aliasState.applyWrite = false;
  f.aliasState.throwOnWrite = true;
  await f.writer.deliver(f.input);
  f.setReady("BUILDING");
  const observed = await f.writer.deliver(f.input);
  expect(observed.status).toBe("unknown");
  expect(f.wait).not.toHaveBeenCalled();
  expect(
    f.calls.filter((call) => call.path.endsWith("/aliases") && call.method === "POST"),
  ).toHaveLength(1);
});

it("stops on an unknown provider read during a known build without repeating create", async () => {
  const f = fixture(gatewayPlan, null, true);
  f.setReady("BUILDING");
  f.wait.mockImplementation(async () => {
    await Promise.resolve();
    f.failCandidateReads();
  });
  const observed = await f.writer.deliver(f.input);
  expect(observed.status).toBe("unknown");
  expect(f.wait).toHaveBeenCalledTimes(1);
  expect(
    f.calls.filter((call) => call.path === "/v13/deployments" && call.method === "POST"),
  ).toHaveLength(1);
  expect(f.calls.some((call) => call.path.endsWith("/aliases") && call.method === "POST")).toBe(
    false,
  );
});
