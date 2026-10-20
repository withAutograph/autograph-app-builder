/* oxlint-disable eslint/no-await-in-loop -- Independent controlled faults are intentionally observed sequentially so each rejection precedes its mutation assertions. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { z } from "zod";
import { createHostedManagedRuntimeProjection } from "./hosted-operator-managed-runtime-projection";
import { hostedOperatorPlanSchema } from "./hosted-operator-contract";
import {
  continuityPlanDigest,
  continuityRecordSchema,
  hostedContinuityPlanSchema,
} from "./hosted-operator-continuity-contract";
import type { ContinuityRecord } from "./hosted-operator-continuity-contract";
import type { HostedOperatorContext } from "./hosted-operator-service";

const required = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("Missing controlled fixture value");
  }
  return value;
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const authority = {
  issuer: "https://builder.fixture.test/api/auth",
  audience: "https://builder.fixture.test/mcp",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const target = {
  appId: "orchard",
  sessionId: "session",
  branch: "feature",
  environment: "preview" as const,
  projectId: "prj_app",
  installationId: "installation",
  scopeId: "team",
  scopeType: "team" as const,
};
const context: HostedOperatorContext = { authority, target };
const gateway = {
  projectId: "prj_gateway",
  ownerId: "team",
  environment: "preview" as const,
  publicOrigin: "https://gateway.fixture.test",
};
const sha = "a".repeat(40);
const preparedPlan = hostedOperatorPlanSchema.parse({
  version: 1,
  action: "prepare",
  contextId: "accepted-spec",
  selection: {
    appId: target.appId,
    sessionId: target.sessionId,
    branch: target.branch,
    environment: target.environment,
    projectId: target.projectId,
  },
  access: [{ actorId: "actor", organizationId: "org", roles: ["ordinary_role"] }],
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
  cost: { class: "shared-recovery-group", description: "Approved managed journey", owner: "owner" },
  installer: { reference: "worker", sha256: "b".repeat(64) },
  neon: {
    branchId: "branch",
    connectionRef: "private",
    endpoint: "ep-fixture.neon.tech",
    projectId: "project",
    source: "synthetic-only",
  },
  release: { artifactRef: "private-release", id: "release", sha256: "c".repeat(64) },
  retention: { expiresAt: "2099-01-01T00:00:00Z", policy: "owned cleanup" },
  publicGateway: {
    projectId: gateway.projectId,
    branch: "gateway-main",
    origin: gateway.publicOrigin,
  },
  gatewayDelivery: {
    projectId: gateway.projectId,
    branch: "gateway-main",
    repoId: "gateway-repo",
    gitSha: sha,
  },
  delivery: { projectId: target.projectId, branch: target.branch, repoId: "app-repo", gitSha: sha },
  deploymentBoundary: {
    authority,
    teamId: "team",
    app: { projectId: target.projectId, branch: target.branch, environment: "preview" },
    gateway: { projectId: gateway.projectId, branch: "gateway-main", environment: "preview" },
    operator: { projectId: "prj_operator", deploymentId: "dpl_operator", environment: "preview" },
    verification: {
      gatewayOrigin: gateway.publicOrigin,
      publicOrigin: gateway.publicOrigin,
      jwksUrl: `${gateway.publicOrigin}/_platform/jwks.json`,
    },
  },
  effects: [
    { id: "resources", kind: "resources", description: "resources" },
    { id: "install", kind: "install", description: "install" },
    { id: "access", kind: "access", description: "access" },
    { id: "bindings", kind: "bindings", description: "bindings" },
    { id: "delivery", kind: "delivery", description: "delivery" },
    {
      id: "gateway-delivery",
      kind: "gateway-delivery",
      description: "Deliver approved managed route",
    },
  ],
});
const wire = z.strictObject({
  key: z.string(),
  value: z.string(),
  type: z.literal("encrypted"),
  target: z.array(z.string()),
  gitBranch: z.string().optional(),
  comment: z.string(),
});
type Row = z.infer<typeof wire> & { id: string };
const deploymentWire = z.object({
  gitSource: z.object({
    ref: z.string(),
    repoId: z.string(),
    sha: z.string(),
    type: z.literal("github"),
  }),
  meta: z.record(z.string(), z.string()),
  name: z.string(),
  project: z.string(),
});
type Deployment = z.infer<typeof deploymentWire> & {
  id: string;
  projectId: string;
  ownerId: string;
  target: null;
  url: string;
  readyState: string;
};

const fixture = () => {
  const intentId = randomUUID();
  const attemptId = randomUUID();
  const capabilities = {
    suiteSelector: randomBytes(32).toString("base64url"),
    transport: randomBytes(32).toString("base64url"),
    lifecycle: randomBytes(32).toString("base64url"),
  };
  const plan = hostedContinuityPlanSchema.parse({
    version: 1,
    kind: "app-continuity-plan",
    intentId,
    planRef: `_protected-operator/continuity-plans/${intentId}`,
    authority,
    target,
    originalSetup: {
      operationRef: randomUUID(),
      planDigest: "d".repeat(64),
      approvalId: "original-approval",
      approvedByCallId: "original-call",
    },
    preparedPlan,
    runtime: {
      sandboxId: "sandbox",
      root: "/owned/source",
      projectId: "prj_builder",
      ownerId: "team",
      appPort: 3000,
      bridgePort: 3443,
    },
    gateway,
    actors: [{ actorId: "actor", organizationId: "org" }],
  });
  const approval = {
    action: "continuity" as const,
    planRef: plan.planRef,
    planDigest: continuityPlanDigest(plan),
    idempotencyKey: "journey",
    approvalId: "routing-approval",
    approvedByCallId: "routing-call",
  };
  const owner = { ...authority, sessionId: target.sessionId };
  const provider = {
    projectId: "prj_builder",
    ownerId: "team",
    sandboxId: plan.runtime.sandboxId,
    providerSessionId: "provider-session",
    origin: "https://managed.fixture.test",
    bridgePort: 3443,
  };
  const identity = {
    intentId,
    approvalRef: approval.approvalId,
    owner,
    appId: target.appId,
    runtimeAttemptId: attemptId,
    fence: 3,
    sandboxId: provider.sandboxId,
    providerSessionId: provider.providerSessionId,
  };
  const projection = {
    version: 1,
    provenance: "trusted-operator-published-managed-target",
    intentId,
    approvalRef: approval.approvalId,
    owner,
    appId: target.appId,
    preparedOperationRef: plan.originalSetup.operationRef,
    gateway,
    approvedTarget: provider,
    observation: { ...provider, expiresAt: "2099-01-01T00:00:00Z" },
    runtimeAttemptId: attemptId,
    fence: 3,
    leaseExpiresAt: "2099-01-01T00:00:00Z",
    state: "ready",
    actors: plan.actors,
    suiteSelectorSha256: hash(capabilities.suiteSelector),
    transportSha256: hash(capabilities.transport),
  };
  let record = continuityRecordSchema.parse({
    kind: "app-continuity",
    requestId: intentId,
    revision: 2,
    idempotencyKey: "journey",
    plan,
    planDigest: continuityPlanDigest(plan),
    approval,
    state: "publishing",
    fence: 3,
    attemptId,
    current: { ...identity, state: "ready", leaseExpiresAt: "2099-01-01T00:00:00Z" },
    projection,
    locator: {
      sandboxId: plan.runtime.sandboxId,
      root: plan.runtime.root,
      providerSessionId: provider.providerSessionId,
      commandId: "owned-command",
      attemptId,
      rootDirectory: "/private/attempt",
      worker: {
        id: "managed-app-runtime-v1",
        executablePath: "/opt/worker",
        sha256: "e".repeat(64),
        operationScope: "managed-app-runtime-v1",
        subcommand: "protected-managed-app-runtime",
      },
    },
    environmentRows: [],
    environmentWrites: [],
    deliveryCandidates: [],
  });
  const rows: Row[] = [
    {
      id: "native",
      key: "PLATFORM_GATEWAY_PROJECT_BINDINGS",
      value: "native-private-config",
      type: "encrypted",
      target: ["preview"],
      comment: "native",
    },
    {
      id: "sibling",
      key: `PLATFORM_GATEWAY_MANAGED_TARGET_${randomUUID().replaceAll("-", "").toUpperCase()}`,
      value: "sibling",
      type: "encrypted",
      target: ["preview"],
      comment: "another intent",
    },
  ];
  const deployments: Deployment[] = [];
  const calls: { method: string; path: string }[] = [];
  const checkpoints: Partial<ContinuityRecord>[] = [];
  const faults = {
    losePost: false,
    rejectPost: false,
    loseDeployment: false,
    hideDeployment: false,
    loseDelete: false,
    rejectDelete: false,
    hideRows: false,
    wrongTeam: false,
    wrongScope: false,
    denied: false,
    denyAfterPost: false,
    failCheckpoint: false,
    productionBranch: "gateway-main",
  };
  let alias: string | null = null;
  const assertCurrent = async () => {
    await Promise.resolve();
    if (faults.denied) {
      throw new Error("revoked owned fixture");
    }
  };
  const save = async (patch: Partial<ContinuityRecord>) => {
    await assertCurrent();
    if (faults.failCheckpoint) {
      throw new Error("checkpoint unavailable");
    }
    record = continuityRecordSchema.parse({
      ...record,
      ...structuredClone(patch),
      revision: record.revision + 1,
    });
    checkpoints.push(structuredClone(patch));
  };
  // oxlint-disable-next-line eslint/complexity, sonarjs/cognitive-complexity -- Closed provider fixture models the real row, deployment and alias protocol plus fault outcomes.
  const fetcher: typeof fetch = async (input, init) => {
    await Promise.resolve();
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const path = url.pathname;
    expect(url.origin).toBe("https://api.vercel.com");
    expect(url.searchParams.get("teamId")).toBe(target.scopeId);
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer synthetic-installation-token",
    );
    calls.push({ method, path });
    if (path === `/v9/projects/${gateway.projectId}` && method === "GET") {
      return Response.json({
        id: gateway.projectId,
        accountId: faults.wrongTeam ? "other-team" : "team",
        name: "gateway",
        link: { type: "github", repoId: "gateway-repo", productionBranch: faults.productionBranch },
      });
    }
    if (path === `/v10/projects/${gateway.projectId}/env` && method === "GET") {
      return Response.json({
        envs: (faults.hideRows
          ? rows.filter((r) => !r.key.endsWith(intentId.replaceAll("-", "").toUpperCase()))
          : rows
        ).map(({ value: _value, ...row }) => row),
      });
    }
    if (path.startsWith(`/v1/projects/${gateway.projectId}/env/`) && method === "GET") {
      const row = rows.find((r) => r.id === path.split("/").at(-1));
      return row ? Response.json({ value: row.value }) : new Response(null, { status: 404 });
    }
    if (path === `/v10/projects/${gateway.projectId}/env` && method === "POST") {
      const body = wire.parse(JSON.parse(z.string().parse(init?.body)));
      expect(record.environmentWrites).toContainEqual({ key: body.key, sha256: hash(body.value) });
      if (faults.rejectPost) {
        throw new Error("fixture response unknown before apply");
      }
      rows.push({ ...body, id: `env-${rows.length}` });
      if (faults.denyAfterPost) {
        faults.denied = true;
      }
      if (faults.losePost) {
        faults.losePost = false;
        throw new Error("fixture response lost after apply");
      }
      return Response.json({ id: required(rows.at(-1)).id });
    }
    if (path.startsWith(`/v9/projects/${gateway.projectId}/env/`) && method === "DELETE") {
      if (faults.rejectDelete) {
        faults.rejectDelete = false;
        throw new Error("fixture delete response unknown before apply");
      }
      const index = rows.findIndex((r) => r.id === path.split("/").at(-1));
      if (index === -1) {
        return new Response(null, { status: 404 });
      }
      rows.splice(index, 1);
      if (faults.loseDelete) {
        faults.loseDelete = false;
        throw new Error("fixture delete response lost");
      }
      return new Response(null, { status: 204 });
    }
    if (path === "/v7/deployments") {
      return Response.json({
        deployments: (faults.hideDeployment ? [] : deployments).map((d) => ({
          uid: d.id,
          meta: d.meta,
        })),
        pagination: { next: null },
      });
    }
    if (path === "/v2/teams/team") {
      return Response.json({ id: "team", slug: "fixture-team" });
    }
    if (path === "/v13/deployments" && method === "POST") {
      expect(record.deliveryAttempted).toBe(true);
      const body = deploymentWire.parse(JSON.parse(z.string().parse(init?.body)));
      const value: Deployment = {
        ...body,
        id: `dpl-${deployments.length}`,
        projectId: body.project,
        ownerId: "team",
        target: null,
        url: "gateway-abc123def-fixture-team.vercel.app",
        readyState: "READY",
      };
      deployments.push(value);
      if (faults.loseDeployment) {
        faults.loseDeployment = false;
        throw new Error("fixture accepted deployment lost response");
      }
      return Response.json({ id: value.id });
    }
    if (path.startsWith("/v13/deployments/")) {
      const found = deployments.find((d) => d.id === path.split("/").at(-1));
      return found ? Response.json(found) : new Response(null, { status: 404 });
    }
    if (path.startsWith("/v4/aliases/")) {
      return alias === null
        ? new Response(null, { status: 404 })
        : Response.json({
            alias: new URL(gateway.publicOrigin).hostname,
            deploymentId: alias,
            projectId: gateway.projectId,
          });
    }
    if (path.startsWith("/v2/deployments/") && path.endsWith("/aliases") && method === "POST") {
      alias = path.split("/")[3] ?? null;
      return Response.json({ alias: new URL(gateway.publicOrigin).hostname });
    }
    throw new Error("Unexpected controlled provider request");
  };
  const publisher = createHostedManagedRuntimeProjection({
    assertOwner: assertCurrent,
    fetch: fetcher,
    readCredential: async () =>
      await Promise.resolve({
        binding: {
          active: true,
          installationId: "installation",
          scopeId: faults.wrongScope ? "other-team" : "team",
          scopeType: "team",
          displayName: "fixture",
          plan: "pro",
          slug: "fixture-team",
          updatedAt: new Date(),
        },
        token: "synthetic-installation-token",
      }),
  });
  return {
    get record() {
      return record;
    },
    setRecord(change: (r: ContinuityRecord) => void) {
      change(record);
    },
    rows,
    deployments,
    calls,
    checkpoints,
    faults,
    capabilities,
    publish: () => publisher.publish(context, record, capabilities, assertCurrent, save),
    revoke: () =>
      publisher.revoke(context, record, assertCurrent, async (environmentRows) => {
        await save({ environmentRows });
      }),
    get alias() {
      return alias;
    },
  };
};

it("publishes the exact per-intent pair privately and refreshes the normal Gateway with retained READY/alias readback", async () => {
  const f = fixture();
  await f.publish();
  const suffix = f.record.requestId.replaceAll("-", "").toUpperCase();
  const targetRow = required(
    f.rows.find((r) => r.key === `PLATFORM_GATEWAY_MANAGED_TARGET_${suffix}`),
  );
  expect(JSON.parse(targetRow.value)).toEqual({
    projection: f.record.projection,
    current: f.record.current,
  });
  expect(f.rows.find((r) => r.key === `PLATFORM_GATEWAY_MANAGED_TRANSPORT_${suffix}`)?.value).toBe(
    f.capabilities.transport,
  );
  expect(
    f.record.environmentRows.every(
      (r) => r.gitBranch === null && r.operationRef === f.record.requestId,
    ),
  ).toBe(true);
  expect(
    f.record.deliveryCandidates.some((c) => c.readyState === "READY" && c.deploymentId === f.alias),
  ).toBe(true);
  const journal = JSON.stringify(f.checkpoints);
  for (const value of Object.values(f.capabilities)) {
    expect(journal).not.toContain(value);
  }
  const writes = f.calls.filter((c) => c.method === "POST").length;
  await f.publish();
  expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(writes);
  expect(f.rows.find((r) => r.id === "native")?.value).toBe("native-private-config");
  expect(f.rows.find((r) => r.id === "sibling")?.value).toBe("sibling");
});

it("maps physical generic or branch-specific Preview using actual project metadata", async () => {
  const f = fixture();
  f.faults.productionBranch = "production";
  await f.publish();
  expect(f.record.environmentRows.every((r) => r.gitBranch === "gateway-main")).toBe(true);
});

it("recovers an accepted environment POST with lost response by exact private digest without repeating it", async () => {
  const f = fixture();
  f.faults.losePost = true;
  await expect(f.publish()).rejects.toMatchObject({ code: "reconciliation_required" });
  expect(f.record.environmentWrites).toHaveLength(1);
  expect(f.record.environmentRows).toHaveLength(0);
  await f.publish();
  expect(f.calls.filter((c) => c.path.endsWith("/env") && c.method === "POST")).toHaveLength(2);
});

it("does not repeat an unknown unobserved environment POST or adopt a foreign value/comments-only row", async () => {
  const f = fixture();
  f.faults.rejectPost = true;
  await expect(f.publish()).rejects.toMatchObject({ code: "reconciliation_required" });
  f.faults.rejectPost = false;
  await expect(f.publish()).rejects.toMatchObject({ code: "reconciliation_required" });
  expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  const key = f.record.environmentWrites[0].key;
  f.rows.push({
    id: "foreign",
    key,
    value: "foreign",
    type: "encrypted",
    target: ["preview"],
    comment: `App Builder managed runtime ${f.record.requestId}`,
  });
  await expect(f.publish()).rejects.toMatchObject({ code: "reconciliation_required" });
  expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(1);
});

it("reconciles an accepted deployment lost response and never blindly recreates an unobserved deployment", async () => {
  const f = fixture();
  f.faults.loseDeployment = true;
  await expect(f.publish()).rejects.toMatchObject({ code: "reconciliation_required" });
  expect(f.record.deliveryAttempted).toBe(true);
  expect(f.deployments).toHaveLength(1);
  f.faults.hideDeployment = true;
  await expect(f.publish()).rejects.toMatchObject({ code: "reconciliation_required" });
  expect(f.deployments).toHaveLength(1);
  f.faults.hideDeployment = false;
  await f.publish();
  expect(f.deployments).toHaveLength(1);
  expect(f.alias).toBe(f.deployments[0].id);
});

it("refuses changed owner/provider scope, revoked fence and failed durable checkpoint before writes", async () => {
  for (const field of ["wrongTeam", "wrongScope", "denied", "failCheckpoint"] as const) {
    const f = fixture();
    f.faults[field] = true;
    await expect(f.publish()).rejects.toBeDefined();
    expect(f.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  }
  const f = fixture();
  f.setRecord((r) => {
    if (r.current) {
      r.current.fence += 1;
    }
  });
  await expect(f.publish()).rejects.toMatchObject({ code: "resource_mismatch" });
  expect(f.calls).toHaveLength(0);
});

it("refuses substituted rows, duplicate selected keys and altered values without modifying siblings", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      required(f.rows.find((r) => r.id === required(f.record.environmentRows[0]).id)).value =
        "changed";
    },
    (f: ReturnType<typeof fixture>) => {
      f.rows.push({
        ...required(f.rows.find((r) => r.id === required(f.record.environmentRows[0]).id)),
        id: "duplicate",
      });
    },
    (f: ReturnType<typeof fixture>) => {
      required(f.rows.find((r) => r.id === required(f.record.environmentRows[0]).id)).id =
        "replacement";
    },
    (f: ReturnType<typeof fixture>) => {
      required(f.rows.find((r) => r.id === required(f.record.environmentRows[0]).id)).gitBranch =
        "other-branch";
    },
    (f: ReturnType<typeof fixture>) => {
      required(f.rows.find((r) => r.id === required(f.record.environmentRows[0]).id)).target = [
        "production",
      ];
    },
  ]) {
    const f = fixture();
    await f.publish();
    const before = f.calls.filter((c) => c.method !== "GET").length;
    change(f);
    await expect(f.publish()).rejects.toMatchObject({ code: "reconciliation_required" });
    await expect(f.revoke()).rejects.toMatchObject({ code: "reconciliation_required" });
    expect(f.calls.filter((c) => c.method !== "GET")).toHaveLength(before);
  }
});

it("revokes only its exact pair, reconciles a lost DELETE and never refreshes or claims old deployment removal", async () => {
  const f = fixture();
  await f.publish();
  const deployments = f.deployments.length;
  f.faults.loseDelete = true;
  await expect(f.revoke()).rejects.toMatchObject({ code: "reconciliation_required" });
  await f.revoke();
  expect(f.record.environmentRows).toHaveLength(0);
  expect(f.rows.map((r) => r.id)).toEqual(["native", "sibling"]);
  expect(f.deployments).toHaveLength(deployments);
  expect(f.alias).toBe(f.deployments[0].id);
  const deletes = f.calls.filter((c) => c.method === "DELETE").length;
  await f.revoke();
  expect(f.calls.filter((c) => c.method === "DELETE")).toHaveLength(deletes);
});

it("can revoke exact pending rows after lost create without deleting an unrelated same-key row", async () => {
  const f = fixture();
  f.faults.losePost = true;
  await expect(f.publish()).rejects.toMatchObject({ code: "reconciliation_required" });
  await f.revoke();
  expect(f.rows.map((r) => r.id)).toEqual(["native", "sibling"]);
});

it("rechecks the owner after an accepted provider write before any subsequent outward effect", async () => {
  const f = fixture();
  f.faults.denyAfterPost = true;
  await expect(f.publish()).rejects.toMatchObject({ code: "reconciliation_required" });
  expect(f.calls.filter((call) => call.method !== "GET")).toHaveLength(1);
  expect(f.record.environmentWrites).toHaveLength(1);
  expect(f.record.environmentRows).toHaveLength(0);
  expect(f.deployments).toHaveLength(0);
});

it("binds the publication to its exact approved source, actual provider session and original operation", async () => {
  const changes: ((record: ContinuityRecord) => void)[] = [
    (record) => {
      required(record.current).providerSessionId = "other-session";
    },
    (record) => {
      required(record.projection).approvalRef = "different-approval";
    },
    (record) => {
      required(record.projection).preparedOperationRef = randomUUID();
    },
    (record) => {
      required(record.projection).gateway.projectId = "different-project";
    },
    (record) => {
      required(record.projection).approvedTarget.projectId = "other-compute-project";
      required(record.projection).observation.projectId = "other-compute-project";
    },
    (record) => {
      required(record.projection).approvedTarget.ownerId = "other-compute-owner";
      required(record.projection).observation.ownerId = "other-compute-owner";
    },
    (record) => {
      required(record.projection).approvedTarget.bridgePort = 3444;
      required(record.projection).observation.bridgePort = 3444;
    },

    (record) => {
      required(record.approval).planDigest = "f".repeat(64);
    },
  ];
  for (const change of changes) {
    const f = fixture();
    f.setRecord(change);
    await expect(f.publish()).rejects.toMatchObject({ code: "resource_mismatch" });
    expect(f.calls).toHaveLength(0);
  }
});

it("rereads the exact unchanged owned row before retrying idempotent DELETE and refuses uncertain inventory absence", async () => {
  const f = fixture();
  await f.publish();
  f.faults.hideRows = true;
  await expect(f.revoke()).rejects.toMatchObject({ code: "reconciliation_required" });
  expect(f.calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
  f.faults.hideRows = false;
  f.faults.rejectDelete = true;
  await expect(f.revoke()).rejects.toMatchObject({ code: "reconciliation_required" });
  const rejected = f.calls.findLastIndex((call) => call.method === "DELETE");
  await f.revoke();
  const next = f.calls.findIndex((call, index) => index > rejected && call.method === "DELETE");
  expect(f.calls[next]?.path).toBe(f.calls[rejected]?.path);
  expect(
    f.calls
      .slice(rejected + 1, next)
      .some(
        (call) =>
          call.method === "GET" && call.path.startsWith(`/v1/projects/${gateway.projectId}/env/`),
      ),
  ).toBe(true);
  expect(f.rows.map((row) => row.id)).toEqual(["native", "sibling"]);
});
