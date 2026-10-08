/* oxlint-disable typescript/no-non-null-assertion, eslint/no-use-before-define, eslint/sort-keys, eslint/require-await, eslint/prefer-const -- Provider fixtures deliberately preserve source-shaped rows and async callbacks. */
import { z } from "zod";
import { expect, it, vi } from "vitest";
import { hostedOperatorPlanSchema } from "./hosted-operator-contract";
import type { ManagedOperatorEnvironmentRow } from "./hosted-operator-contract";
import type { GatewayManagedEnvironmentContext } from "./hosted-operator-service";
import { createHostedOperatorGatewayBindings } from "./hosted-operator-gateway-bindings";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const selection = {
  appId: "spend-review",
  branch: "spend-review-preview",
  environment: "preview" as const,
  projectId: "prj_app",
  sessionId: "session_fixture",
};
const target = {
  ...selection,
  installationId: "icfg_fixture",
  scopeId: "team_fixture",
  scopeType: "team" as const,
};
const gateway = {
  branch: selection.branch,
  builderCallbackOrigin: "https://builder-preview.example.test",
  catalogAppIds: ["spend-review", "inventory"],
  gatewayOrigin: "https://gateway-preview.example.test",
  operatorOrigin: "https://operator-preview.example.test",
  projectId: "prj_gateway",
  publicOrigin: "https://apps-preview.example.test",
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
      projectId: gateway.projectId,
    },
    operator: { deploymentId: "dpl_operator", environment: "preview", projectId: "prj_operator" },
    teamId: target.scopeId,
    verification: {
      gatewayOrigin: gateway.gatewayOrigin,
      jwksUrl: `${gateway.gatewayOrigin}/_platform/jwks.json`,
      publicOrigin: gateway.publicOrigin,
    },
  },
  effects: [
    { description: "Verify resources", id: "resources", kind: "resources" },
    { description: "Install release", id: "install", kind: "install" },
    { description: "Grant access", id: "access", kind: "access" },
    { description: "Bind app", id: "app-bindings", kind: "bindings" },
    { description: "Bind Gateway Auth", id: "gateway-bindings", kind: "gateway-bindings" },
  ],
  gatewayBindings: {
    builderCallbackOrigin: gateway.builderCallbackOrigin,
    catalogAppIds: gateway.catalogAppIds,
    operatorOrigin: gateway.operatorOrigin,
  },
  installer: { reference: "trusted-toolchain", sha256: "a".repeat(64) },
  neon: {
    branchId: "br_preview",
    connectionRef: "explicit-owner-connection",
    endpoint: "ep-fixture.us-east-1.aws.neon.tech",
    projectId: "neon_fixture",
    source: "synthetic-only",
  },
  publicGateway: {
    branch: selection.branch,
    origin: gateway.publicOrigin,
    projectId: gateway.projectId,
  },
  release: { artifactRef: "verified-artifact", id: "release_fixture", sha256: "b".repeat(64) },
  retention: {
    expiresAt: "2027-01-01T00:00:00.000Z",
    policy: "Retain while context consumers exist",
  },
  selection,
  version: 1,
});
const privateAuthUrl =
  "postgresql://shared_auth_runtime:fixture-private-password@ep-fixture.us-east-1.aws.neon.tech/shared_auth?sslmode=verify-full";
interface RecordedRequest {
  method: string;
  path: string;
  body?: Record<string, z.infer<typeof z.json>>;
}

const fixture = () => {
  const rows: Record<string, z.infer<typeof z.json>>[] = [
    {
      id: "auth-secret",
      key: "BETTER_AUTH_SECRET",
      target: ["preview"],
      gitBranch: selection.branch,
      type: "encrypted",
      value: "fixture-better-auth-secret",
    },
    {
      id: "signer-key",
      key: "PLATFORM_GATEWAY_IDENTITY_PRIVATE_KEY",
      target: ["preview"],
      gitBranch: selection.branch,
      type: "encrypted",
      value: "fixture-private-key",
    },
    {
      id: "signer-kid",
      key: "PLATFORM_GATEWAY_IDENTITY_KEY_ID",
      target: ["preview"],
      gitBranch: selection.branch,
      type: "encrypted",
      value: "fixture-key-id",
    },
    {
      id: "auth-url",
      key: "BETTER_AUTH_URL",
      target: ["preview"],
      gitBranch: selection.branch,
      type: "plain",
      value: `${gateway.gatewayOrigin}/api/auth`,
    },
    {
      id: "auth-app-name",
      key: "BETTER_AUTH_APP_NAME",
      target: ["preview"],
      gitBranch: selection.branch,
      type: "plain",
      value: "apps",
    },
    {
      id: "public-origin",
      key: "PLATFORM_PUBLIC_ORIGIN",
      target: ["preview"],
      gitBranch: selection.branch,
      type: "plain",
      value: gateway.gatewayOrigin,
    },
    { id: "unrelated", key: "APP_TITLE", target: ["production"], type: "plain", value: "keep" },
  ];
  const requests: RecordedRequest[] = [];
  let journal: ManagedOperatorEnvironmentRow[] = [];
  let input: GatewayManagedEnvironmentContext;
  let losePostResponse = false;
  const assertCurrent = vi.fn(async () => {});
  const checkpointGatewayEnvironment = vi.fn(
    async (next: readonly ManagedOperatorEnvironmentRow[]) => {
      journal = structuredClone([...next]);
      input.gatewayEnvironmentRows = journal;
    },
  );
  input = {
    assertCurrent,
    authority,
    checkpoint: vi.fn(async () => {}),
    checkpointGatewayEnvironment,
    effect: plan.effects.find((effect) => effect.kind === "gateway-bindings")!,
    fenceGeneration: 1,
    gateway,
    gatewayEnvironmentRows: journal,
    operationRef: "prepare-operation",
    ownerContext: {
      adapterGeneration: 1,
      adapterSessionId: "adapter-session",
      authority,
      kind: "direct",
      principal: { ...authority, scopes: ["autograph:send"] },
      sessionId: selection.sessionId,
    },
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
    const request: RecordedRequest = { method, path: parsed.pathname };
    if (body !== undefined) {
      request.body = body;
    }
    requests.push(request);
    expect(parsed.origin).toBe("https://api.vercel.com");
    expect(parsed.searchParams.get("teamId")).toBe(target.scopeId);
    if (method === "GET" && parsed.pathname.startsWith("/v1/")) {
      const row = rows.find((item) => item.id === parsed.pathname.split("/").at(-1));
      return Response.json({ value: row?.value });
    }
    if (method === "GET") {
      return Response.json({ envs: rows.map(({ value: _value, ...row }) => row) });
    }
    if (method === "POST") {
      const row = { ...body, id: `env-${rows.length}` };
      rows.push(row);
      if (losePostResponse) {
        throw new Error("fixture lost POST response");
      }
      return Response.json(row);
    }
    const index = rows.findIndex((item) => item.id === parsed.pathname.split("/").at(-1));
    if (method === "PATCH") {
      Object.assign(rows[index], body);
      return Response.json(rows[index]);
    }
    throw new Error(`Unexpected fixture method ${method}`);
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
    token: "fixture-owner-oauth",
  }));
  const assertAuthorized = vi.fn(async () => {});
  const readAuthRuntimeUrl = vi.fn(async () => privateAuthUrl);
  const writer = createHostedOperatorGatewayBindings({
    assertAuthorized,
    fetch: fetcher,
    readAuthRuntimeUrl,
    readCredential,
  });
  return {
    assertAuthorized,
    assertCurrent,
    checkpointGatewayEnvironment,
    input,
    readAuthRuntimeUrl,
    readCredential,
    requests,
    rows,
    setLosePostResponse: (value: boolean) => (losePostResponse = value),
    writer,
  };
};

it("binds only exact encrypted Gateway Preview Auth configuration and retains existing credentials", async () => {
  const f = fixture();
  const result = await f.writer.bind(f.input);
  const created = f.rows.filter((row) => String(row.id).startsWith("env-"));
  expect(
    created.map((row) => z.string().parse(row.key)).toSorted((a, b) => a.localeCompare(b)),
  ).toEqual([
    "AUTH_DATABASE_RESOURCE",
    "PLATFORM_AUTH_DATABASE_URL",
    "PLATFORM_GATEWAY_PROTECTED_APPLICATIONS",
    "PLATFORM_REALM_OPERATOR_LINK_CONFIG",
  ]);
  expect(
    created.every((row) => {
      const targets = z.array(z.string()).parse(row.target);
      return (
        targets[0] === "preview" && row.gitBranch === gateway.branch && row.type === "encrypted"
      );
    }),
  ).toBe(true);
  expect(f.rows.find((row) => row.id === "auth-secret")?.value).toBe("fixture-better-auth-secret");
  expect(f.requests.some((request) => request.path.endsWith("/auth-secret"))).toBe(false);
  expect(f.checkpointGatewayEnvironment).toHaveBeenCalledTimes(5);
  expect(f.readCredential).toHaveBeenCalledWith(authority, target.installationId);
  expect(result.rows).toHaveLength(4);
  expect(JSON.stringify(result)).not.toContain("fixture-private-password");
  expect(JSON.stringify(result)).not.toContain("fixture-private-key");
  expect(await f.writer.reconcile(f.input)).toMatchObject({ status: "applied" });
});

it("preserves sibling protected applications and patches only the previously journaled row", async () => {
  const f = fixture();
  const priorValue = JSON.stringify(["catalog-sibling"]);
  const prior = {
    comment: "App Builder protected operator prior-operation",
    gitBranch: gateway.branch,
    id: "owned-policy",
    key: "PLATFORM_GATEWAY_PROTECTED_APPLICATIONS",
    target: ["preview"],
    type: "encrypted",
    value: priorValue,
  };
  f.rows.push(prior);
  f.input.gatewayEnvironmentRows = [
    {
      branch: gateway.branch,
      comment: prior.comment,
      id: prior.id,
      key: prior.key,
      operationRef: "prior-operation",
      projectId: gateway.projectId,
    },
  ];
  await f.writer.bind(f.input);
  expect(
    f.requests.find(
      (request) => request.method === "PATCH" && request.path.endsWith("/owned-policy"),
    )?.body?.value,
  ).toBe(JSON.stringify(["catalog-sibling", "inventory", "spend-review"]));
  expect(f.rows.filter((row) => row.key === prior.key)).toHaveLength(1);
  expect(f.input.gatewayEnvironmentRows?.find((row) => row.id === prior.id)?.operationRef).toBe(
    "prior-operation",
  );
});

it("recovers a created row after an unknown POST outcome without duplicating it", async () => {
  const f = fixture();
  f.setLosePostResponse(true);
  await expect(f.writer.bind(f.input)).rejects.toThrow("operator_unavailable");
  f.setLosePostResponse(false);
  expect(await f.writer.reconcile(f.input)).toEqual({ status: "unknown" });
  const afterFirstTry = f.requests.filter((request) => request.method === "POST").length;
  await f.writer.bind(f.input);
  expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(afterFirstTry + 3);
  expect(f.rows.filter((row) => row.key === "AUTH_DATABASE_RESOURCE")).toHaveLength(1);
});

it("does not adopt a branchwide or foreign pre-existing Gateway config row", async () => {
  const f = fixture();
  f.rows.push({
    comment: "unowned",
    id: "foreign",
    key: "AUTH_DATABASE_RESOURCE",
    target: ["preview"],
    type: "encrypted",
    value: "foreign-value",
  });
  expect(await f.writer.reconcile(f.input)).toEqual({ status: "unknown" });
  await expect(f.writer.bind(f.input)).rejects.toThrow("operator_unavailable");
  expect(f.requests.every((request) => request.method === "GET")).toBe(true);
});

it("does not treat a credential shared with Production as a Gateway Preview credential", async () => {
  const f = fixture();
  const secret = f.rows.find((row) => row.key === "BETTER_AUTH_SECRET");
  if (!secret) {
    throw new Error("Missing fixture Auth secret");
  }
  secret.target = ["preview", "production"];
  expect(await f.writer.reconcile(f.input)).toEqual({ status: "unknown" });
  await expect(f.writer.bind(f.input)).rejects.toThrow("operator_unavailable");
  expect(f.requests.every((request) => request.method === "GET")).toBe(true);
});

it("checks the fresh execution context before making any provider mutation", async () => {
  const f = fixture();
  f.input.assertCurrent = vi.fn(async () => {
    throw new Error("stale worker");
  });
  await expect(f.writer.bind(f.input)).rejects.toThrow("operator_unavailable");
  expect(f.requests).toHaveLength(0);
});
