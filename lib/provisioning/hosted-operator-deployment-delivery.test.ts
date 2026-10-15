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
  delivery: { branch: "feature", gitSha: sha, projectId: "prj_app", repoId: "repo" },
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
  link: { repoId: string; type: string };
  name: string;
}

const fixture = (deliveryPlan = plan, deploymentTarget: string | null = null, gateway = false) => {
  const delivery = gateway ? deliveryPlan.gatewayDelivery : deliveryPlan.delivery;
  if (delivery === undefined) {
    throw new Error("Missing fixture delivery");
  }
  let ready = "BUILDING";
  let count = 0;
  let deny = false;
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
  const project: DeliveryProjectFixture = {
    accountId: "team",
    framework: "nextjs",
    id: delivery.projectId,
    link: { repoId: delivery.repoId, type: "github" },
    name: "app",
  };
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
  const aliasState = {
    name: "approved-gateway.example.test",
    projectId: "prj_gateway",
    deploymentId: "dpl_previous",
    applyWrite: true,
    throwOnWrite: false,
    failReads: false,
    missing: false,
  };
  const aliasWriteResponse = () => {
    if (aliasState.applyWrite) {
      aliasState.deploymentId = "dpl_new";
      aliasState.missing = false;
    }
    if (aliasState.throwOnWrite) {
      throw new Error("Private lost provider response");
    }
    return Response.json({ alias: aliasState.name });
  };
  const fetcher: typeof fetch = async (url, init) => {
    await Promise.resolve();
    const requestUrl = new URL(url instanceof Request ? url.url : url);
    expect(requestUrl.searchParams.get("teamId")).toBe(target.scopeId);
    const path = requestUrl.pathname;
    const method = init?.method ?? "GET";
    let body;
    if (init?.body !== undefined) {
      body = z.json().parse(JSON.parse(z.string().parse(init.body)));
    }
    calls.push({ body, method, path });
    if (path.startsWith("/v4/aliases/")) {
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
      });
    }
    if (path === "/v2/deployments/dpl_new/aliases" && method === "POST") {
      return aliasWriteResponse();
    }
    if (path === "/v7/deployments") {
      return Response.json({
        deployments: count === 0 ? [] : [{ meta, uid: "dpl_new" }],
        pagination: { next: null },
      });
    }
    if (path === `/v9/projects/${project.id}`) {
      return Response.json(project);
    }
    if (path === "/v2/teams/team") {
      return Response.json({ id: "team", slug: "team-slug" });
    }
    if (path === "/v13/deployments" && method === "POST") {
      expect(body).not.toHaveProperty("target");
      count += 1;
      return Response.json({ id: "dpl_new" });
    }
    if (path === "/v13/deployments/dpl_new") {
      return Response.json({ ...deployment, readyState: ready });
    }
    throw new Error("Unexpected native request");
  };
  const writer = createHostedOperatorDeploymentDelivery({
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
    aliasState,
    project,
    deployment,
    checkpoint,
    input,
    revoke: () => {
      deny = true;
    },
    setReady: (value: string) => {
      ready = value;
    },
    writer,
  };
};
it("requests standard Preview delivery from approved Git source and observes readiness", async () => {
  const f = fixture();
  const initial = await f.writer.reconcile(f.input);
  const first = await f.writer.deliver(f.input);
  expect(initial.status).toBe("retryable");
  expect(first.status).toBe("unknown");
  const whileBuilding = await f.writer.deliver(f.input);
  expect(whileBuilding.status).toBe("unknown");
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
  expect(f.checkpoint).toHaveBeenCalled();
  f.setReady("READY");
  const result = await f.writer.reconcile(f.input);
  expect(result.status).toBe("applied");
  expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(1);
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
    const building = await f.writer.deliver(f.input);
    expect(building.status).toBe("unknown");
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
it.each(["owner", "repository"])(
  "rejects an actual wrong project %s before deployment",
  async (mismatch) => {
    const f = fixture();
    f.project.framework = "services";
    if (mismatch === "owner") {
      f.project.accountId = "another-team";
    } else {
      f.project.link.repoId = "another-repo";
    }
    await expect(f.writer.deliver(f.input)).rejects.toMatchObject({ code: "resource_mismatch" });
    expect(f.calls.some((call) => call.method === "POST")).toBe(false);
  },
);
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
  await f.writer.deliver(f.input);
  f.setReady("READY");
  return f;
};
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
  ).toHaveLength(1);
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
    ).toHaveLength(1);
    expect(f.input.deliveryCandidates?.some((candidate) => candidate.gatewayAliasAttempted)).toBe(
      true,
    );
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
