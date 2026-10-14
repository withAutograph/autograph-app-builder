import { expect, it, vi } from "vitest";
import { z } from "zod";
import { hostedOperatorPlanSchema, operatorPlanDigest } from "./hosted-operator-contract";
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
interface DeliveryProjectFixture {
  accountId: string;
  framework?: string | null;
  id: string;
  link: { repoId: string; type: string };
  name: string;
}

const fixture = (deliveryPlan = plan) => {
  let ready = "BUILDING";
  let count = 0;
  let deny = false;
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const checkpoint = vi.fn(async () => {
    await Promise.resolve();
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
    effect: plan.effects[4],
    fenceGeneration: 1,
    operationRef: "00000000-0000-4000-8000-000000000001",
    plan: deliveryPlan,
    target,
    workerCheckpoints: [],
  };
  const meta = {
    autograph_operator_effect: "deliver",
    autograph_operator_operation: input.operationRef,
    autograph_operator_plan: operatorPlanDigest(deliveryPlan),
  };
  const project: DeliveryProjectFixture = {
    accountId: "team",
    framework: "nextjs",
    id: "prj_app",
    link: { repoId: "repo", type: "github" },
    name: "app",
  };
  const deployment = {
    customEnvironment: null,
    gitSource: { ref: deliveryPlan.delivery?.branch, repoId: "repo", sha, type: "github" },
    id: "dpl_new",
    meta,
    oidcTokenClaims: { environment: "preview" },
    ownerId: "team",
    projectId: "prj_app",
    target: "staging",
    url: "new-native.vercel.app",
  };
  const fetcher: typeof fetch = async (url, init) => {
    await Promise.resolve();
    const path = new URL(url instanceof Request ? url.url : url).pathname;
    const method = init?.method ?? "GET";
    let body;
    if (init?.body !== undefined) {
      body = z.json().parse(JSON.parse(z.string().parse(init.body)));
    }
    calls.push({ body, method, path });
    if (path === "/v7/deployments") {
      return Response.json({
        deployments: count === 0 ? [] : [{ meta, uid: "dpl_new" }],
        pagination: { next: null },
      });
    }
    if (path === "/v9/projects/prj_app") {
      return Response.json(project);
    }
    if (path === "/v2/teams/team") {
      return Response.json({ id: "team", slug: "team-slug" });
    }
    if (path === "/v13/deployments" && method === "POST") {
      expect(body).toMatchObject({ target: "staging" });
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
it("does not infer absence from an empty deployment listing and records normal Git delivery", async () => {
  const f = fixture();
  const initial = await f.writer.reconcile(f.input);
  const first = await f.writer.deliver(f.input);
  expect(initial.status).toBe("retryable");
  expect(first.status).toBe("unknown");
  const whileBuilding = await f.writer.deliver(f.input);
  expect(whileBuilding.status).toBe("unknown");
  expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  expect(f.calls.find((call) => call.method === "POST")?.body).toMatchObject({
    gitSource: { ref: "feature", sha, type: "github" },
    project: "prj_app",
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
