/* oxlint-disable typescript/no-non-null-assertion, eslint/no-use-before-define, eslint/sort-keys, eslint/require-await, eslint/prefer-const -- Provider fixtures deliberately preserve source-shaped rows and async callbacks. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { expect, it, vi } from "vitest";
import {
  canonicalGatewayEnvironmentRowsSchema,
  hostedOperatorPlanSchema,
} from "./hosted-operator-contract";
import type {
  CanonicalGatewayEnvironmentRow,
  ManagedOperatorEnvironmentRow,
} from "./hosted-operator-contract";
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
  authBrowserOrigin: "https://auth-preview.example.test",
  branch: selection.branch,
  builderCallbackOrigin: "https://builder-preview.example.test",
  catalogAppIds: ["spend-review", "inventory"],
  gatewayOrigin: "https://gateway-preview.example.test",
  operatorOrigin: "https://operator-preview.example.test",
  projectId: "prj_gateway",
  publicOrigin: "https://apps-preview.example.test",
  sourceWorkload: {
    audience: "https://vercel.com/fixture",
    environment: "preview" as const,
    issuer: "https://oidc.vercel.com/fixture",
    ownerId: target.scopeId,
    projectId: "prj_gateway",
    subject: "provider-observed-fixture",
  },
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
    authBrowserOrigin: gateway.authBrowserOrigin,
    builderCallbackOrigin: gateway.builderCallbackOrigin,
    catalogAppIds: gateway.catalogAppIds,
    operatorOrigin: gateway.operatorOrigin,
    sourceWorkload: gateway.sourceWorkload,
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
      value: `${gateway.publicOrigin}/api/auth`,
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
      value: gateway.publicOrigin,
    },
    {
      id: "trusted-origins",
      key: "PLATFORM_AUTH_TRUSTED_ORIGINS",
      target: ["preview"],
      gitBranch: selection.branch,
      type: "plain",
      value: [
        gateway.gatewayOrigin,
        "https://separately-approved.example.test",
        gateway.publicOrigin,
        gateway.authBrowserOrigin,
      ].join(","),
    },
    { id: "unrelated", key: "APP_TITLE", target: ["production"], type: "plain", value: "keep" },
  ];
  const requests: RecordedRequest[] = [];
  let journal: ManagedOperatorEnvironmentRow[] = [];
  let input: GatewayManagedEnvironmentContext;
  let losePostResponse = false;
  let losePatchResponse = false;
  let emptyMutationResponse = false;
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
    deliveryCandidates: [
      {
        branch: target.branch,
        deploymentId: "dpl_new_app",
        operationRef: "prepare-operation",
        origin: "https://fixture-app.vercel.app",
        projectId: target.projectId,
        projectName: "fixture-app",
        readyState: "READY",
        repoId: "fixture-repo",
        scopeSlug: "fixture",
      },
    ],
    fenceGeneration: 1,
    gateway: structuredClone(gateway),
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
    plan: structuredClone(plan),
    target: structuredClone(target),
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
      return emptyMutationResponse ? new Response(null, { status: 204 }) : Response.json(row);
    }
    const index = rows.findIndex((item) => item.id === parsed.pathname.split("/").at(-1));
    if (method === "PATCH") {
      Object.assign(rows[index], body);
      if (losePatchResponse) {
        throw new Error("fixture lost PATCH response");
      }
      return emptyMutationResponse
        ? new Response(null, { status: 204 })
        : Response.json(rows[index]);
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
  let canonicalRows: CanonicalGatewayEnvironmentRow[] = [];
  const readCanonicalGatewayRows = vi.fn(async () => structuredClone(canonicalRows));
  const writer = createHostedOperatorGatewayBindings({
    assertAuthorized,
    readCanonicalGatewayRows,
    fetch: fetcher,
    readAuthRuntimeUrl,
    readCredential,
  });
  return {
    assertAuthorized,
    assertCurrent,
    checkpointGatewayEnvironment,
    fetcher,
    input,
    readAuthRuntimeUrl,
    readCanonicalGatewayRows,
    readCredential,
    requests,
    setCanonicalRows: (value: CanonicalGatewayEnvironmentRow[]) => {
      canonicalRows = value;
    },
    rows,
    setLosePatchResponse: (value: boolean) => (losePatchResponse = value),
    setEmptyMutationResponse: (value: boolean) => (emptyMutationResponse = value),
    setLosePostResponse: (value: boolean) => (losePostResponse = value),
    writer,
  };
};

it.each([
  ["bind", "credential"],
  ["bind", "provider"],
  ["bind", "checkpoint"],
  ["reconcile", "credential"],
  ["reconcile", "provider"],
  ["reconcile", "checkpoint"],
  ["verifyForDelivery", "credential"],
  ["verifyForDelivery", "provider"],
] as const)(
  "%s retains the authorized context when caller data changes during %s await",
  async (method, boundary) => {
    const f = fixture();
    const approved = structuredClone({
      branch: f.input.gateway.branch,
      operationRef: f.input.operationRef,
      projectId: f.input.gateway.projectId,
    });
    if (method !== "bind") {
      await f.writer.bind(f.input);
      f.requests.length = 0;
      f.checkpointGatewayEnvironment.mockClear();
    }
    if (method === "verifyForDelivery") {
      f.input.effect = {
        description: "Verify Gateway delivery",
        id: "gateway-delivery",
        kind: "gateway-delivery",
      };
    }
    const mutateCaller = () => {
      f.input.gateway.branch = "unapproved-branch";
      f.input.gateway.projectId = "unapproved-project";
      f.input.operationRef = "unapproved-operation";
      f.input.target.scopeId = "unapproved-team";
    };
    if (boundary === "credential") {
      const read = f.readCredential.getMockImplementation()!;
      f.readCredential.mockImplementationOnce(async () => {
        const credential = await read();
        mutateCaller();
        return credential;
      });
    } else if (boundary === "provider") {
      const request = f.fetcher.getMockImplementation()!;
      f.fetcher.mockImplementationOnce(async (...args) => {
        const response = await request(...args);
        mutateCaller();
        return response;
      });
    } else {
      const checkpoint = f.checkpointGatewayEnvironment.getMockImplementation()!;
      f.checkpointGatewayEnvironment.mockImplementationOnce(async (rows) => {
        await checkpoint(rows);
        mutateCaller();
      });
    }
    const result = await f.writer[method](f.input);
    if (!("rows" in result)) {
      throw new Error("Expected independently verified Gateway references");
    }
    expect(result.rows).toHaveLength(5);
    expect(
      result.rows.every(
        (row) =>
          row.branch === approved.branch &&
          row.projectId === approved.projectId &&
          row.operationRef === approved.operationRef,
      ),
    ).toBe(true);
    expect(
      f.requests.every((request) => request.path.includes(`/projects/${approved.projectId}/`)),
    ).toBe(true);
    const posts = f.requests.filter((request) => request.method === "POST");
    expect(posts).toHaveLength(method === "bind" ? 5 : 0);
    expect(posts.every((request) => request.body?.gitBranch === approved.branch)).toBe(true);
    expect(
      f.checkpointGatewayEnvironment.mock.calls.every(([rows]) =>
        rows.every(
          (row) =>
            row.branch === approved.branch &&
            row.projectId === approved.projectId &&
            row.operationRef === approved.operationRef,
        ),
      ),
    ).toBe(true);
  },
);

it("binds only exact encrypted Gateway Preview Auth configuration and retains existing credentials", async () => {
  const f = fixture();
  const result = await f.writer.bind(f.input);
  const created = f.rows.filter((row) => String(row.id).startsWith("env-"));
  expect(
    created.map((row) => z.string().parse(row.key)).toSorted((a, b) => a.localeCompare(b)),
  ).toEqual([
    "AUTH_DATABASE_RESOURCE",
    "PLATFORM_AUTH_DATABASE_URL",
    "PLATFORM_GATEWAY_PROJECT_BINDINGS",
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
  expect(f.rows.find((row) => row.id === "trusted-origins")?.value).toContain(
    "https://separately-approved.example.test",
  );
  expect(f.requests.some((request) => request.path.endsWith("/auth-secret"))).toBe(false);
  expect(f.checkpointGatewayEnvironment).toHaveBeenCalledTimes(6);
  expect(f.readCredential).toHaveBeenCalledWith(authority, target.installationId);
  expect(result.rows).toHaveLength(5);
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
  expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(afterFirstTry + 4);
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

it("requires both approved Gateway and public-app origins while preserving unrelated authorized origins", async () => {
  const f = fixture();
  const trustedOrigins = f.rows.find((row) => row.id === "trusted-origins");
  if (!trustedOrigins) {
    throw new Error("Missing fixture trusted origins");
  }
  trustedOrigins.value = `${gateway.gatewayOrigin},https://separately-approved.example.test`;
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

const adoptionFixture = async () => {
  const f = fixture();
  const priorOperation = "11111111-1111-4111-8111-111111111111";
  f.input.operationRef = priorOperation;
  f.input.deliveryCandidates![0].operationRef = priorOperation;
  const source = await f.writer.bind(f.input);
  const canonical = canonicalGatewayEnvironmentRowsSchema.parse(
    source.rows.map((row) => ({
      ...row,
      target: ["preview"],
      type: "encrypted",
    })),
  );
  f.setCanonicalRows(canonical);
  f.input.gatewayEnvironmentRows = [];
  f.input.operationRef = "22222222-2222-4222-8222-222222222222";
  f.input.target.appId = "inventory";
  f.input.target.projectId = "prj_inventory";
  f.input.plan = structuredClone(f.input.plan);
  f.input.plan.selection = { ...selection, appId: "inventory", projectId: "prj_inventory" };
  f.input.plan.deploymentBoundary!.app.projectId = "prj_inventory";
  f.input.plan.authAdoption = {
    gatewayEnvironment: structuredClone(canonical),
    kind: "owned-journal-auth-v1",
    resource: {
      authDatabase: f.input.plan.authDatabase,
      branchId: f.input.plan.neon.branchId,
      endpoint: f.input.plan.neon.endpoint,
      endpointId: "ep_fixture",
      projectId: f.input.plan.neon.projectId,
    },
    source: {
      checkpointSha256: "c".repeat(64),
      journalDigest: "d".repeat(64),
      operationRef: priorOperation,
      planDigest: "e".repeat(64),
      selection,
    },
  };
  f.input.deliveryCandidates = [
    {
      ...f.input.deliveryCandidates![0],
      operationRef: f.input.operationRef,
      deploymentId: "dpl_inventory",
      projectId: "prj_inventory",
    },
  ];
  f.requests.length = 0;
  f.readAuthRuntimeUrl.mockClear();
  f.checkpointGatewayEnvironment.mockClear();
  return { ...f, canonical };
};

it("proves canonical ownership during the actual Auth resource effect with GET-only access", async () => {
  const f = await adoptionFixture();
  f.input.effect = {
    id: "auth",
    kind: "resources",
    resourceId: f.input.plan.authDatabase.resourceId,
    description: "Adopt Auth",
  };
  f.readAuthRuntimeUrl.mockRejectedValue(new Error("pending credentials must not be opened"));
  f.input.deliveryCandidates = [];
  f.rows.splice(0, f.rows.length, ...f.rows.filter((row) => String(row.id).startsWith("env-")));
  expect(await f.writer.verifyCanonicalOwnership(f.input)).toEqual({ rows: f.canonical });
  expect(f.requests.every((request) => request.method === "GET")).toBe(true);
  expect(f.readAuthRuntimeUrl).not.toHaveBeenCalled();
  expect(f.checkpointGatewayEnvironment).not.toHaveBeenCalled();
  await expect(f.writer.bind(f.input)).rejects.toThrow("operator_unavailable");
});

it("merges approved canonical sibling bindings and checkpoints exact non-secret value hashes for retries", async () => {
  const f = await adoptionFixture();
  const result = await f.writer.bind(f.input);
  const projection = f.rows.find((row) => row.key === "PLATFORM_GATEWAY_PROJECT_BINDINGS")!;
  expect(
    z
      .object({ bindings: z.array(z.object({ appId: z.string() })) })
      .parse(JSON.parse(String(projection.value)))
      .bindings.map((row) => row.appId),
  ).toEqual(["spend-review", "inventory"]);
  expect(f.rows.filter((row) => String(row.id).startsWith("env-"))).toHaveLength(5);
  expect(f.requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
  expect(f.requests.some((request) => request.method === "POST")).toBe(false);
  expect(result.rows.every((row) => row.operationRef === f.canonical[0].operationRef)).toBe(true);
  for (const reference of result.rows) {
    const row = f.rows.find((item) => item.id === reference.id)!;
    expect(reference.valueSha256).toBe(
      createHash("sha256").update(String(row.value)).digest("hex"),
    );
  }
  expect(JSON.stringify(result)).not.toContain("fixture-private-password");
  f.requests.length = 0;
  await f.writer.bind(f.input);
  expect(f.requests.every((request) => request.method === "GET")).toBe(true);
  expect(await f.writer.reconcile(f.input)).toMatchObject({ status: "applied" });
});

it.each(["id", "key", "gitBranch", "comment", "target", "type", "configurationId", "value"])(
  "rejects changed canonical provider %s before a merge or checkpoint",
  async (field) => {
    const f = await adoptionFixture();
    const row = f.rows.find((item) => item.key === "PLATFORM_GATEWAY_PROTECTED_APPLICATIONS")!;
    const changed = {
      id: "replacement-id",
      key: "APP_TITLE",
      gitBranch: "other-preview",
      comment: `App Builder protected operator ${f.input.operationRef}`,
      target: ["preview", "production"],
      type: "plain",
      configurationId: "foreign-integration",
      value: JSON.stringify(["forged-sibling"]),
    };
    row[field] =
      changed[
        z
          .enum(["id", "key", "gitBranch", "comment", "target", "type", "configurationId", "value"])
          .parse(field)
      ];
    await expect(f.writer.bind(f.input)).rejects.toThrow("operator_unavailable");
    expect(f.requests.every((request) => request.method === "GET")).toBe(true);
    expect(f.checkpointGatewayEnvironment).not.toHaveBeenCalled();
  },
);

it.each(["missing", "stale", "operation", "project", "branch", "hash"])(
  "rejects %s canonical source references even with a matching operator comment",
  async (kind) => {
    const f = await adoptionFixture();
    const source = structuredClone(f.canonical);
    if (kind === "missing") {
      source.pop();
    }
    if (kind === "stale") {
      source[0].id = "stale-reference";
    }
    if (kind === "operation") {
      source[0].operationRef = "33333333-3333-4333-8333-333333333333";
    }
    if (kind === "project") {
      source[0].projectId = "foreign-project";
    }
    if (kind === "branch") {
      source[0].branch = "foreign-branch";
    }
    if (kind === "hash") {
      source[0].valueSha256 = "f".repeat(64);
    }
    f.setCanonicalRows(source);
    await expect(f.writer.bind(f.input)).rejects.toThrow("operator_unavailable");
    expect(f.requests.every((request) => request.method === "GET")).toBe(true);
    expect(f.checkpointGatewayEnvironment).not.toHaveBeenCalled();
  },
);

it("fails closed when a legacy adoption plan has no approved canonical rows", async () => {
  const f = await adoptionFixture();
  delete f.input.plan.authAdoption!.gatewayEnvironment;
  await expect(f.writer.bind(f.input)).rejects.toThrow("operator_unavailable");
  expect(f.requests).toHaveLength(0);
});

it("rechecks the source journal after provider awaits and rejects a changed snapshot", async () => {
  const f = await adoptionFixture();
  f.readCanonicalGatewayRows
    .mockResolvedValueOnce(f.canonical)
    .mockRejectedValue(new Error("source approval revoked"));
  await expect(f.writer.verifyCanonicalOwnership(f.input)).rejects.toThrow("operator_unavailable");
  expect(f.requests.every((request) => request.method === "GET")).toBe(true);
  expect(f.checkpointGatewayEnvironment).not.toHaveBeenCalled();
});

it("does not trust a forged current-operation comment without the exact interrupted POST value", async () => {
  const f = fixture();
  f.rows.push({
    id: "forged",
    key: "PLATFORM_GATEWAY_PROTECTED_APPLICATIONS",
    gitBranch: gateway.branch,
    comment: `App Builder protected operator ${f.input.operationRef}`,
    target: ["preview"],
    type: "encrypted",
    value: JSON.stringify(["forged-sibling"]),
  });
  await expect(f.writer.bind(f.input)).rejects.toThrow("operator_unavailable");
  expect(f.requests.every((request) => request.method === "GET")).toBe(true);
});

it("rejects a target journal reference that drops the approved source value hash", async () => {
  const f = await adoptionFixture();
  f.input.gatewayEnvironmentRows = f.canonical.map(
    ({ target: _target, type: _type, valueSha256: _valueSha256, ...row }) => row,
  );
  await expect(f.writer.bind(f.input)).rejects.toThrow("operator_unavailable");
  expect(f.requests).toHaveLength(0);
});

it("keeps the approved canonical snapshot frozen across an awaited source lookup", async () => {
  const f = await adoptionFixture();
  const forged = structuredClone(f.canonical);
  forged[0].valueSha256 = "f".repeat(64);
  f.readCanonicalGatewayRows.mockImplementation(async () => {
    f.input.plan.authAdoption!.gatewayEnvironment = forged;
    return forged;
  });
  await expect(f.writer.verifyCanonicalOwnership(f.input)).rejects.toThrow("operator_unavailable");
  expect(f.requests).toHaveLength(0);
});

it("uses independent provider GET readback when mutation responses are empty", async () => {
  const f = fixture();
  f.setEmptyMutationResponse(true);
  const result = await f.writer.bind(f.input);
  expect(result.rows).toHaveLength(5);
  expect(await f.writer.reconcile(f.input)).toMatchObject({ status: "applied" });
  const adopted = await adoptionFixture();
  adopted.setEmptyMutationResponse(true);
  const adoptedResult = await adopted.writer.bind(adopted.input);
  expect(adoptedResult.rows).toHaveLength(5);
});

it("recovers an ordinary same-journal PATCH after an unknown response using approved desired values", async () => {
  const f = fixture();
  await f.writer.bind(f.input);
  f.input.deliveryCandidates![0].deploymentId = "dpl_updated_app";
  f.setLosePatchResponse(true);
  await expect(f.writer.bind(f.input)).rejects.toThrow("operator_unavailable");
  f.setLosePatchResponse(false);
  expect(await f.writer.reconcile(f.input)).toMatchObject({ status: "applied" });
  f.requests.length = 0;
  await f.writer.bind(f.input);
  expect(f.requests.every((request) => request.method === "GET")).toBe(true);
});

it("recovers an adopted PATCH with a lost response through a durable operation-bound prospective hash", async () => {
  const f = await adoptionFixture();
  f.setLosePatchResponse(true);
  await expect(f.writer.bind(f.input)).rejects.toThrow("operator_unavailable");
  const pending = f.input.gatewayEnvironmentRows!.find(
    (row) => row.pendingValueSha256 !== undefined,
  )!;
  expect(pending.key).toBe("PLATFORM_GATEWAY_PROJECT_BINDINGS");
  expect(pending.pendingOperationRef).toBe(f.input.operationRef);
  expect(pending.pendingValueSha256).not.toBe(pending.valueSha256);
  expect(JSON.stringify(f.input.gatewayEnvironmentRows)).not.toContain("fixture-private-password");
  f.setLosePatchResponse(false);
  expect(await f.writer.reconcile(f.input)).toMatchObject({ status: "applied" });
  expect(
    f.input.gatewayEnvironmentRows!.every(
      (row) => row.pendingValueSha256 === undefined && row.pendingOperationRef === undefined,
    ),
  ).toBe(true);
  f.requests.length = 0;
  await f.writer.bind(f.input);
  expect(f.requests.every((request) => request.method === "GET")).toBe(true);
});

it("rejects a prospective hash from a different operation", async () => {
  const f = await adoptionFixture();
  f.setLosePatchResponse(true);
  await expect(f.writer.bind(f.input)).rejects.toThrow("operator_unavailable");
  const pending = f.input.gatewayEnvironmentRows!.find(
    (row) => row.pendingValueSha256 !== undefined,
  )!;
  pending.pendingOperationRef = "33333333-3333-4333-8333-333333333333";
  f.setLosePatchResponse(false);
  f.requests.length = 0;
  expect(await f.writer.reconcile(f.input)).toEqual({ status: "unknown" });
  await expect(f.writer.bind(f.input)).rejects.toThrow("operator_unavailable");
  expect(f.requests).toHaveLength(0);
});

it("does not rewrite an approved shared Auth credential when the requested runtime URL differs", async () => {
  const f = await adoptionFixture();
  f.readAuthRuntimeUrl.mockResolvedValue(
    privateAuthUrl.replace("fixture-private-password", "unexpected-rotation"),
  );
  await expect(f.writer.bind(f.input)).rejects.toThrow("operator_unavailable");
  expect(f.requests.every((request) => request.method === "GET")).toBe(true);
  expect(f.checkpointGatewayEnvironment).not.toHaveBeenCalled();
});

it("rechecks source authority after the prospective checkpoint and before the adopted PATCH", async () => {
  const f = await adoptionFixture();
  const save = f.checkpointGatewayEnvironment.getMockImplementation()!;
  f.checkpointGatewayEnvironment.mockImplementation(async (rows) => {
    await save(rows);
    if (rows.some((row) => row.pendingValueSha256 !== undefined)) {
      f.readCanonicalGatewayRows.mockRejectedValue(
        new Error("source approval revoked during checkpoint"),
      );
    }
  });
  await expect(f.writer.bind(f.input)).rejects.toThrow("operator_unavailable");
  expect(f.requests.every((request) => request.method === "GET")).toBe(true);
});
