/* oxlint-disable typescript/no-non-null-assertion, eslint/require-await, eslint/no-use-before-define, eslint/no-nested-ternary, sonarjs/no-nested-conditional -- Closed fixture arrays/plans have known members; async mocks implement production callbacks and install their input before invocation. */
import { z } from "zod";
import { expect, it, vi } from "vitest";
import {
  hostedOperatorPlanSchema,
  restrictedOperatorEnvironment,
} from "./hosted-operator-contract";
import type { ManagedOperatorEnvironmentRow } from "./hosted-operator-contract";
import type { HostedOperatorManagedEnvironmentContext } from "./hosted-operator-service";
import { createHostedOperatorEnvironmentBindings } from "./hosted-operator-environment-bindings";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const selection = {
  appId: "spend-review",
  branch: "preview",
  environment: "preview" as const,
  projectId: "prj_fixture",
  sessionId: "session_fixture",
};
const ownerContext = {
  adapterGeneration: 1,
  adapterSessionId: "adapter-session",
  authority,
  kind: "direct" as const,
  principal: { ...authority, scopes: ["autograph:send"] },
  sessionId: selection.sessionId,
};
const target = {
  ...selection,
  installationId: "icfg_fixture",
  scopeId: "team_fixture",
  scopeType: "team" as const,
};
const plan = hostedOperatorPlanSchema.parse({
  access: [{ actorId: "synthetic-reviewer", organizationId: "synthetic-org", roles: ["reviewer"] }],
  action: "prepare",
  appDatabase: {
    database: "spend",
    migratorRole: "spend_owner",
    resourceId: "app-resource",
    runtimeRole: "spend_runtime",
  },
  authDatabase: {
    database: "shared_auth",
    migratorRole: "shared_auth_owner",
    resourceId: "auth-resource",
    runtimeRole: "shared_auth_runtime",
  },
  contextId: "synthetic-context",
  cost: {
    class: "shared-recovery-group",
    description: "Approved disposable compute",
    owner: "Fixture owner",
  },
  deploymentBoundary: {
    app: {
      branch: selection.branch,
      deploymentId: "dpl_app",
      environment: "preview",
      projectId: selection.projectId,
    },
    authority,
    gateway: {
      branch: selection.branch,
      deploymentId: "dpl_gateway",
      environment: "preview",
      projectId: "prj_gateway",
    },
    operator: {
      deploymentId: "dpl_operator",
      environment: "production",
      projectId: "prj_operator",
    },
    teamId: "team_fixture",
    verification: {
      gatewayOrigin: "https://gateway-preview.example.test",
      jwksUrl: "https://gateway-preview.example.test/_platform/jwks.json",
      publicOrigin: "https://apps-preview.example.test",
    },
  },
  effects: [
    {
      description: "Verify selected resources and their roles",
      id: "resources",
      kind: "resources",
    },

    { description: "Install the selected checked release", id: "install", kind: "install" },
    { description: "Grant approved Auth app access after install", id: "access", kind: "access" },
    {
      description: "Bind restricted app and shared Auth credentials",
      id: "bind",
      kind: "bindings",
    },
  ],
  installer: { reference: "trusted-toolchain", sha256: "a".repeat(64) },
  neon: {
    branchId: "br_synthetic",
    connectionRef: "explicit-owner-connection",
    endpoint: "ep-fixture.us-east-1.aws.neon.tech",
    projectId: "synthetic-project",
    source: "synthetic-only",
  },
  publicGateway: {
    branch: selection.branch,
    origin: "https://apps-preview.example.test",
    projectId: "prj_gateway",
  },
  release: { artifactRef: "verified-artifact", id: "release_fixture", sha256: "b".repeat(64) },
  retention: {
    expiresAt: "2027-01-01T00:00:00.000Z",
    policy: "Retain while context consumers exist",
  },
  selection,
  version: 1,
});

const values = restrictedOperatorEnvironment(
  plan,
  {
    PLATFORM_JWKS_URL: plan.deploymentBoundary!.verification.jwksUrl,
    PLATFORM_ORIGIN: plan.deploymentBoundary!.verification.gatewayOrigin,
    PLATFORM_PUBLIC_ORIGIN: plan.deploymentBoundary!.verification.publicOrigin,
    SPEND_REVIEW_DATABASE_URL:
      "postgresql://spend_runtime:private-password@ep-fixture.us-east-1.aws.neon.tech/spend?sslmode=verify-full",
  },
  authority,
);
const fixture = (configurationId?: string | null) => {
  const rows: Record<string, z.infer<typeof z.json>>[] = [
    { id: "unrelated", key: "APP_TITLE", target: ["production"], type: "plain", value: "existing" },
  ];
  const requests: {
    path: string;
    method: string;
    body?: Record<string, z.infer<typeof z.json>>;
  }[] = [];
  let journal: ManagedOperatorEnvironmentRow[] = [];
  let unknownPost = false;
  let failedRead = false;
  let failedDeleteId: string | undefined;
  const assertCurrent = vi.fn(async () => {});
  const checkpointManagedEnvironment = vi.fn(
    async (next: readonly ManagedOperatorEnvironmentRow[]) => {
      journal = structuredClone([...next]);
      input.managedEnvironment = journal;
    },
  );
  const input: HostedOperatorManagedEnvironmentContext = {
    assertCurrent,
    authority,
    checkpoint: vi.fn(async () => {}),
    checkpointManagedEnvironment,
    effect: plan.effects.find((item) => item.kind === "bindings")!,
    fenceGeneration: 1,
    operationRef: "prepare-operation",
    ownerContext,
    plan,
    target,
    workerCheckpoints: [],
  };
  const fetcher = vi.fn(async (url: URL | string | Request, init?: RequestInit) => {
    const parsed = new URL(url instanceof Request ? url.url : url.toString());
    const method = init?.method ?? "GET";
    const bodyText = z.string().optional().parse(init?.body);
    const body =
      bodyText === undefined
        ? undefined
        : z.record(z.string(), z.json()).parse(JSON.parse(bodyText));
    interface FixtureRequest {
      method: string;
      path: string;
      body?: Record<string, z.infer<typeof z.json>>;
    }
    const recorded: FixtureRequest = { method, path: parsed.pathname };
    if (body !== undefined) {
      recorded.body = body;
    }
    requests.push(recorded);
    expect(parsed.origin).toBe("https://api.vercel.com");
    expect(parsed.searchParams.get("teamId")).toBe(target.scopeId);
    if (failedRead && method === "GET") {
      return new Response("private provider failure", { status: 500 });
    }
    if (method === "GET" && parsed.pathname.startsWith("/v1/")) {
      return Response.json({
        value: rows.find((row) => row.id === parsed.pathname.split("/").at(-1))?.value,
      });
    }
    if (method === "GET") {
      return Response.json({ envs: rows.map((item) => ({ ...item, value: null })) });
    }
    if (method === "POST") {
      const row: (typeof rows)[number] = {
        ...body,
        id: `env-${rows.length}`,
      };
      if (configurationId !== undefined) {
        row.configurationId = configurationId;
      }
      rows.push(row);
      if (unknownPost) {
        throw new Error("private unknown outcome");
      }
      return Response.json(row);
    }
    const index = rows.findIndex((row) => row.id === parsed.pathname.split("/").at(-1));
    if (method === "PATCH") {
      Object.assign(rows[index], body);
      return Response.json(rows[index]);
    }
    if (method === "DELETE") {
      if (rows[index]?.id === failedDeleteId) {
        throw new Error("private unknown deletion");
      }
      rows.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    throw new Error("Unexpected request");
  });
  const readCredential = vi.fn(async () => ({
    binding: {
      active: true,
      displayName: "Owner",
      installationId: target.installationId,
      plan: "pro",
      scopeId: target.scopeId,
      scopeType: target.scopeType,
      slug: "fixture",
      updatedAt: new Date(),
    },
    token: "private-oauth",
  }));
  const assertAuthorized = vi.fn(async () => {});
  const writer = createHostedOperatorEnvironmentBindings({
    assertAuthorized,
    fetch: fetcher,
    readCredential,
  });
  return {
    assertAuthorized,
    assertCurrent,
    checkpointManagedEnvironment,
    input,
    readCredential,
    requests,
    rows,
    setFailedDelete: (id: string) => {
      failedDeleteId = id;
    },
    setFailedRead: () => {
      failedRead = true;
    },
    setUnknownPost: (next: boolean) => {
      unknownPost = next;
    },
    writer,
  };
};
it.each([undefined, null, "", target.installationId])(
  "writes and replays exact encrypted app rows with configurationId %s",
  async (configurationId) => {
    const f = fixture(configurationId);
    const result = await f.writer.bind(f.input, values);
    expect(result.rows).toHaveLength(5);
    expect(f.rows[0]).toEqual({
      id: "unrelated",
      key: "APP_TITLE",
      target: ["production"],
      type: "plain",
      value: "existing",
    });
    for (const request of f.requests.filter((row) => row.method === "POST")) {
      expect(request.body).toMatchObject({
        comment: `App Builder protected operator ${f.input.operationRef}`,
        gitBranch: target.branch,
        target: ["preview"],
        type: "encrypted",
      });
    }
    expect(f.checkpointManagedEnvironment).toHaveBeenCalledTimes(6);
    expect(f.readCredential).toHaveBeenCalledWith(authority, target.installationId);
    expect(await f.writer.reconcile(f.input, values)).toMatchObject({ status: "applied" });
    expect(JSON.stringify(result)).not.toContain("private-password");
    await f.writer.bind(f.input, values);
    expect(f.requests.filter((row) => row.method === "POST")).toHaveLength(5);
  },
);
it.each([undefined, target.installationId])(
  "recovers a lost app POST response with configurationId %s without duplicate creation",
  async (configurationId) => {
    const f = fixture(configurationId);
    f.setUnknownPost(true);
    await expect(f.writer.bind(f.input, values)).rejects.toThrow("operator_unavailable");
    f.setUnknownPost(false);
    expect(await f.writer.reconcile(f.input, values)).toEqual({ status: "unknown" });
    await f.writer.bind(f.input, values);
    expect(f.requests.filter((row) => row.method === "POST")).toHaveLength(5);
  },
);
it("does not reconcile a complete set of owned rows with a stale encrypted value as applied", async () => {
  const f = fixture();
  await f.writer.bind(f.input, values);
  const owned = f.rows.find((row) => row.key === "PLATFORM_ORIGIN");
  if (!owned) {
    throw new Error("Missing owned fixture row");
  }
  owned.value = "https://stale.example.test";
  f.checkpointManagedEnvironment.mockClear();
  expect(await f.writer.reconcile(f.input, values)).toEqual({ status: "unknown" });
  expect(f.checkpointManagedEnvironment).not.toHaveBeenCalled();
});
it("keeps provider failures unknown and does not write", async () => {
  const f = fixture();
  f.setFailedRead();
  expect(await f.writer.reconcile(f.input, values)).toEqual({ status: "unknown" });
  expect(f.requests.every((request) => request.method === "GET")).toBe(true);
});
it.each(["integration", "foreign", "duplicate"])(
  "denies %s rows without mutation",
  async (kind) => {
    const f = fixture();
    const [key] = Object.keys(values);
    const row = {
      comment: `App Builder protected operator ${f.input.operationRef}`,
      gitBranch: target.branch,
      id: "foreign",
      key,
      target: ["preview"],
      type: "encrypted",
      value: values[key],
    };
    f.rows.push({
      ...row,
      ...(kind === "integration"
        ? { configurationId: "icfg_neon" }
        : kind === "foreign"
          ? { comment: "Other owner" }
          : {}),
    });
    if (kind === "duplicate") {
      f.rows.push({ ...row, id: "duplicate" });
    }
    expect(await f.writer.reconcile(f.input, values)).toEqual({ status: "unknown" });
    await expect(f.writer.bind(f.input, values)).rejects.toThrow();
    expect(f.requests.every((request) => request.method === "GET")).toBe(true);
  },
);
it("updates only exact previously journaled installation-attributed IDs across ordinary replan", async () => {
  const f = fixture(target.installationId);
  await f.writer.bind(f.input, values);
  f.input.operationRef = "new-operation";
  const next = {
    ...values,
    PLATFORM_JWKS_URL: "https://new-gateway.example.test/_platform/jwks.json",
    PLATFORM_ORIGIN: "https://new-gateway.example.test",
  };
  // SAFETY: This private fixture omits the derived public configuration so the writer recomputes it for the new approved plan.
  delete (next as Partial<typeof values>).PLATFORM_APP_BOUNDARY;
  f.input.plan = structuredClone(plan);
  f.input.plan.deploymentBoundary!.verification.gatewayOrigin = next.PLATFORM_ORIGIN;
  f.input.plan.deploymentBoundary!.verification.jwksUrl = next.PLATFORM_JWKS_URL;
  await f.writer.bind(f.input, next);
  expect(f.requests.filter((row) => row.method === "PATCH")).toHaveLength(3);
  expect(f.requests.filter((row) => row.method === "POST")).toHaveLength(5);
});
it("binds and cleans the approved publication branch without changing the resource target", async () => {
  const f = fixture();
  const boundary = f.input.plan.deploymentBoundary!;
  const publicationBranch = "codex/generated-spend-review";
  f.input.plan = hostedOperatorPlanSchema.parse({
    ...f.input.plan,
    deploymentBoundary: { ...boundary, app: { ...boundary.app, branch: publicationBranch } },
    delivery: {
      branch: publicationBranch,
      gitSha: "c".repeat(40),
      projectId: target.projectId,
      repoId: "12345",
    },
    effects: [
      ...f.input.plan.effects,
      { description: "Deliver published source", id: "delivery", kind: "delivery" },
    ],
  });
  const result = await f.writer.bind(f.input, values);
  expect(f.input.target.branch).toBe(selection.branch);
  expect(result.rows.every((row) => row.branch === publicationBranch)).toBe(true);
  expect(
    f.requests
      .filter((request) => request.method === "POST")
      .every((request) => request.body?.gitBranch === publicationBranch),
  ).toBe(true);
  const { delivery, ...retained } = f.input.plan;
  void delivery;
  f.input.plan = hostedOperatorPlanSchema.parse({
    ...retained,
    action: "cleanup",
    effects: [
      { description: "Revoke", id: "revoke", kind: "revoke" },
      { description: "Remove", id: "remove", kind: "remove-bindings" },
      { description: "Retire", id: "retire", kind: "retire" },
    ],
  });
  f.input.effect = f.input.plan.effects[1]!;
  expect(await f.writer.remove(f.input, values)).toEqual({ rows: [] });
  expect(f.rows.map((row) => row.id)).toEqual(["unrelated"]);
});
it("removes only journaled IDs under cleanup while preserving foreign rows", async () => {
  const f = fixture();
  await f.writer.bind(f.input, values);
  f.input.operationRef = "cleanup-operation";
  f.input.plan = {
    ...f.input.plan,
    action: "cleanup",
    effects: [
      { description: "Revoke", id: "revoke", kind: "revoke" },
      { description: "Remove", id: "remove", kind: "remove-bindings" },
      { description: "Retire", id: "retire", kind: "retire" },
    ],
  };
  f.input.effect = { description: "Approved remove", id: "remove", kind: "remove-bindings" };
  expect(await f.writer.remove(f.input, values)).toEqual({ rows: [] });
  expect(f.rows).toHaveLength(1);
  expect(f.rows[0].id).toBe("unrelated");
});
it("denies forbidden credentials and stale ownership before provider writes", async () => {
  const f = fixture();
  await expect(
    f.writer.bind(f.input, { ...values, BETTER_AUTH_SECRET: "private" }),
  ).rejects.toThrow();
  expect(f.requests).toHaveLength(0);
  f.assertCurrent.mockRejectedValue(new Error("expired owner"));
  await expect(f.writer.bind(f.input, values)).rejects.toThrow();
  expect(f.requests).toHaveLength(0);
});

it("does not allocate when durable checkpoint fails", async () => {
  const f = fixture();
  f.checkpointManagedEnvironment.mockRejectedValue(new Error("CAS conflict"));
  await expect(f.writer.bind(f.input, values)).rejects.toThrow("operator_unavailable");
  expect(f.requests.every((request) => request.method === "GET")).toBe(true);
});
it("cannot delete unjournaled current-operation rows", async () => {
  const f = fixture();
  await f.writer.bind(f.input, values);
  f.input.managedEnvironment = [];
  f.input.plan = {
    ...f.input.plan,
    action: "cleanup",
    effects: [
      { description: "Revoke", id: "revoke", kind: "revoke" },
      { description: "Remove", id: "remove", kind: "remove-bindings" },
      { description: "Retire", id: "retire", kind: "retire" },
    ],
  };
  f.input.effect = f.input.plan.effects[1]!;
  await expect(f.writer.remove(f.input, values)).rejects.toThrow("operator_unavailable");
  expect(f.requests.some((row) => row.method === "DELETE")).toBe(false);
});

it("does not depend on checkpoint mutating the copied effect context", async () => {
  const f = fixture();
  f.input.checkpointManagedEnvironment = vi.fn(async () => {});
  const result = await f.writer.bind(f.input, values);
  expect(result.rows).toHaveLength(5);
  expect(f.input.managedEnvironment).toBeUndefined();
  expect(await f.writer.reconcile(f.input, values)).toMatchObject({ status: "applied" });
});

it.each([false, true])(
  "rejects foreign installation attribution even with matching operation ownership (journaled: %s)",
  async (journaled) => {
    const f = fixture(target.installationId);
    await f.writer.bind(f.input, values);
    const row = f.rows.find((item) => item.key === "PLATFORM_ORIGIN")!;
    row.configurationId = "icfg_foreign";
    if (!journaled) {
      f.input.managedEnvironment = [];
    }
    f.requests.length = 0;
    expect(await f.writer.reconcile(f.input, values)).toEqual({ status: "unknown" });
    await expect(f.writer.bind(f.input, values)).rejects.toThrow("operator_unavailable");
    expect(f.requests.every((request) => request.method === "GET")).toBe(true);
  },
);

it.each([
  { comment: "App Builder protected operator unrelated-operation" },
  { gitBranch: null },
  { target: ["preview", "production"] },
  { type: "plain" },
  { id: "replacement-provider-row" },
])(
  "retains exact operation, branch, target, type and saved ID guards for installation attribution %j",
  async (change) => {
    const f = fixture(target.installationId);
    await f.writer.bind(f.input, values);
    const row = f.rows.find((item) => item.key === "PLATFORM_ORIGIN")!;
    Object.assign(row, change);
    f.requests.length = 0;
    expect(await f.writer.reconcile(f.input, values)).toEqual({ status: "unknown" });
    await expect(f.writer.bind(f.input, values)).rejects.toThrow("operator_unavailable");
    expect(f.requests.every((request) => request.method === "GET")).toBe(true);
  },
);

const historicalCleanupFixture = () => {
  const f = fixture();
  const operationRef = "00000000-0000-4000-8000-000000000001";
  const saved = ["codex/old", "codex/new"].map((branch, index) => ({
    branch,
    comment: `App Builder protected operator ${operationRef}`,
    id: `historical-${index}`,
    key: "SPEND_REVIEW_DATABASE_URL",
    operationRef,
    projectId: target.projectId,
  }));
  f.rows.push(
    ...saved.map((row) => ({
      id: row.id,
      key: row.key,
      gitBranch: row.branch,
      comment: row.comment,
      target: ["preview"],
      type: "encrypted",
    })),
    {
      id: "other-branch",
      key: saved[0].key,
      gitBranch: "codex/unrelated",
      comment: "another owner",
      target: ["preview"],
      type: "encrypted",
    },
  );
  f.input.plan = hostedOperatorPlanSchema.parse({
    ...plan,
    action: "cleanup",
    appEnvironmentCleanup: saved,
    effects: [
      { id: "revoke", kind: "revoke", description: "Revoke access" },
      { id: "remove", kind: "remove-bindings", description: "Remove exact saved rows" },
      {
        id: "retire",
        kind: "retire",
        description: "Retire owned resources",
      },
    ],
  });
  f.input.effect = f.input.plan.effects.find((effect) => effect.kind === "remove-bindings")!;
  f.input.managedEnvironment = saved;
  return { ...f, saved };
};
it("cleans exact approved historical IDs across branches without touching unrelated rows", async () => {
  const f = historicalCleanupFixture();
  expect(await f.writer.remove(f.input, values)).toEqual({ rows: [] });
  expect(f.rows.map((row) => row.id)).toEqual(["unrelated", "other-branch"]);
  expect(f.input.managedEnvironment).toEqual([]);
});
it("retains unknown deletion facts after checkpointing only confirmed earlier removals", async () => {
  const f = historicalCleanupFixture();
  f.setFailedDelete(f.saved[1].id);
  await expect(f.writer.remove(f.input, values)).rejects.toMatchObject({
    code: "operator_unavailable",
  });
  expect(f.input.managedEnvironment).toEqual([f.saved[1]]);
  expect(f.rows.some((row) => row.id === f.saved[1].id)).toBe(true);
});
it("refuses a changed provider ownership tag before historical deletion", async () => {
  const f = historicalCleanupFixture();
  f.rows.find((row) => row.id === f.saved[0].id)!.comment = "another owner";
  await expect(f.writer.remove(f.input, values)).rejects.toMatchObject({
    code: "operator_unavailable",
  });
  expect(f.requests.some((request) => request.method === "DELETE")).toBe(false);
  expect(f.input.managedEnvironment).toEqual(f.saved);
});

it("accepts semantically identical approved row references with reordered fields", async () => {
  const f = historicalCleanupFixture();
  f.input.managedEnvironment = f.saved.map((row) => ({
    projectId: row.projectId,
    operationRef: row.operationRef,
    key: row.key,
    id: row.id,
    comment: row.comment,
    branch: row.branch,
  }));
  expect(await f.writer.remove(f.input, values)).toEqual({ rows: [] });
});
