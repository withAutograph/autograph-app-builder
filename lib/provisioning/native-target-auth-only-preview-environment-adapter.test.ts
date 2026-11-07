import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import type { createNativeTargetAuthOnlyPreviewDelivery } from "./native-target-auth-only-preview-delivery";
import { nativeTargetAuthOnlyTestPlan } from "./native-target-auth-only-plan-schema.test";
import { nativeTargetAuthOnlyPlanDigest } from "./native-target-auth-only-plan-schema";
import {
  nativeTargetAuthOnlyDeliveryPlanSchema,
  nativeTargetAuthOnlyDeliveryPlanDigest,
} from "./native-target-auth-only-delivery-plan";
import { createNativeTargetAuthOnlyPreviewEnvironmentAdapter } from "./native-target-auth-only-preview-environment-adapter";
import type { NativeTargetAuthOnlyPreviewEnvironmentApplyInput } from "./native-target-auth-only-preview-environment-adapter";
import { createNativeTargetAuthOnlyGatewayProjection } from "./native-target-auth-only-gateway-projection";
import type { NativeTargetAuthOnlyGatewayProjectionIntent } from "./native-target-auth-only-gateway-projection";
import { trustedGatewayProjectProjectionSchema } from "./trusted-gateway-project-projection";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const plan = nativeTargetAuthOnlyTestPlan();
const target = {
  appId: plan.appId,
  branch: plan.branch,
  environment: "preview" as const,
  installationId: plan.project.installationId,
  projectId: "app-project",
  scopeId: plan.project.teamId,
  scopeType: "team" as const,
  sessionId: plan.origin.publicSessionId,
};
const deliveryPlan = nativeTargetAuthOnlyDeliveryPlanSchema.parse({
  authOnlyPlanDigest: nativeTargetAuthOnlyPlanDigest(plan),
  delivery: {
    action: "prepare",
    delivery: {
      branch: plan.branch,
      gitSha: plan.publishedSource.gitSha,
      projectId: target.projectId,
      projectSettings: plan.project.projectSettings,
      repoId: plan.publishedSource.repositoryId,
    },
    effects: [
      { id: "auth-only-gateway-preview", kind: "gateway-delivery" },
      { id: "auth-only-app-preview", kind: "delivery" },
    ],
    gatewayDelivery: {
      branch: "gateway-preview",
      gitRef: "gateway-preview",
      gitSha: "c".repeat(40),
      projectId: "gateway-project",
      repoId: "gateway-repo",
    },
    publicGateway: {
      authBrowserOrigin: "https://pilot.example",
      branch: "gateway-preview",
      gatewayOrigin: "https://gateway-native.example",
      origin: "https://pilot.example",
      projectId: "gateway-project",
    },
    stage: "app",
  },
  effects: [
    { id: "auth-only-gateway-preview", kind: "gateway-delivery" },
    { id: "auth-only-app-preview", kind: "delivery" },
  ],
  kind: "native-target-auth-only-delivery",
  resourcePlanDigest: "b".repeat(64),
  source: {
    branch: plan.branch,
    gitSha: plan.publishedSource.gitSha,
    repositoryId: plan.publishedSource.repositoryId,
  },
  target,
  version: 1,
});
const approvedDeliveryDigest = nativeTargetAuthOnlyDeliveryPlanDigest(
  Buffer.from(JSON.stringify(deliveryPlan)),
);
const operationRef = "11111111-1111-4111-a111-111111111111";
const senderKeys = ["AUTH_RECOVERY_RESEND_API_KEY", "AUTH_RECOVERY_EMAIL_FROM"];
const gatewayValues = {
  AUTH_DATABASE_RESOURCE: '{"environment":"preview"}',
  AUTH_RECOVERY_EMAIL_FROM: "pilot@example.test",
  AUTH_REQUIRE_EMAIL_VERIFICATION: "true",
  PLATFORM_AUTH_DATABASE_URL:
    "postgresql://runtime:fixture@auth-preview.neon.tech/auth?sslmode=verify-full",
  PLATFORM_GATEWAY_PROJECT_BINDINGS: "{}",
  PLATFORM_GATEWAY_PROTECTED_APPLICATIONS: '["pilot"]',
  PLATFORM_REALM_OPERATOR_LINK_CONFIG: "{}",
};
const appValues = {
  PLATFORM_JWKS_URL: "https://gateway.example/_platform/jwks.json",
  PLATFORM_ORIGIN: "https://gateway.example",
  PLATFORM_PUBLIC_ORIGIN: "https://pilot.example",
};
const environmentWriteSchema = z.object({
  key: z.string(),
  value: z.string(),
  target: z.array(z.string()),
  gitBranch: z.string().nullable().optional(),
  comment: z.string().optional(),
  type: z.string().optional(),
});
interface Row {
  id: string;
  key: string;
  value?: string;
  target: string[];
  gitBranch?: string | null;
  comment?: string;
  configurationId?: string;
  type?: string;
  visibility?: string;
  updatedAt?: number;
  createdAt?: number;
  system?: boolean;
  customEnvironmentIds?: string[];
}
const fixture = (
  effect: "gateway" | "app" = "gateway",
  physicalBranch: string | null = effect === "gateway" ? "gateway-preview" : target.branch,
) => {
  const controller = new AbortController();
  const assertCurrent = vi.fn(async () => {});
  const scope = (projectId: string) =>
    `auth-only-preview:${operationRef}:${approvedDeliveryDigest}:${projectId}`;
  const rows: Record<"app-project" | "gateway-project", Row[]> = {
    "app-project": [],
    "gateway-project": senderKeys.map((key, index) => ({
      id: `sender-${index}`,
      key,
      value:
        key === "AUTH_RECOVERY_EMAIL_FROM" ? gatewayValues.AUTH_RECOVERY_EMAIL_FROM : undefined,
      type: index === 0 ? "sensitive" : "encrypted",
      updatedAt: 1_793_966_400_000,
      target: ["preview"],
      gitBranch: effect === "gateway" ? physicalBranch : "gateway-preview",
      comment: "operator owned",
    })),
  };
  const projects = {
    "app-project": {
      id: "app-project",
      accountId: target.scopeId,
      ...plan.project.projectSettings,
      link:
        physicalBranch === null && effect === "app"
          ? null
          : {
              type: "github",
              repoId: plan.publishedSource.repositoryId,
              productionBranch: "production",
            },
    },
    "gateway-project": {
      accountId: target.scopeId,
      framework: "services",
      id: "gateway-project",
      link: {
        productionBranch:
          effect === "gateway" && physicalBranch === null ? "gateway-preview" : "main",
        repoId: "gateway-repo",
        type: "github",
      },
      rootDirectory: ".",
    },
  };
  const writes: {
    keys: string[];
    target: string[];
    gitBranch?: string | null;
    upsert: string | null;
  }[] = [];
  const calls: { method: string; path: string }[] = [];
  let beforeRequest: ((method: string, path: string) => void) | undefined;
  let afterWrite: (() => void) | undefined;
  let rejectStatus: number | undefined;
  const readResponse = (projectId: keyof typeof projects, parts: string[], url: URL) => {
    if (parts.length === 4) {
      return Response.json({
        ...projects[projectId],
        env: [{ value: "discarded provider field" }],
      });
    }
    if (parts.length === 5) {
      expect(url.searchParams.get("decrypt")).toBe("false");
      return Response.json({
        envs: rows[projectId].map(({ value: _value, ...metadata }) => metadata),
      });
    }
    if (parts.length === 6) {
      const row = rows[projectId].find((entry) => entry.id === decodeURIComponent(parts[5]));
      expect(row?.key).not.toBe("AUTH_RECOVERY_RESEND_API_KEY");
      return row === undefined ? new Response(null, { status: 404 }) : Response.json(row);
    }
    throw new Error("Unexpected fixture read route");
  };
  const respond = (raw: Parameters<typeof fetch>[0], init: RequestInit | undefined) => {
    const url = new URL(raw instanceof Request ? raw.url : String(raw));
    const method = init?.method ?? "GET";
    const path = url.pathname;
    calls.push({ method, path });
    beforeRequest?.(method, path);
    if (rejectStatus !== undefined) {
      return new Response(null, { status: rejectStatus });
    }
    expect(url.searchParams.get("teamId")).toBe(target.scopeId);
    const parts = path.split("/");
    const projectId = decodeURIComponent(parts[3]);
    if (projectId !== "app-project" && projectId !== "gateway-project") {
      throw new Error("Unexpected fixture project");
    }
    if (method === "GET") {
      return readResponse(projectId, parts, url);
    }
    if (method === "PATCH" && parts.length === 6) {
      const row = rows[projectId]?.find((entry) => entry.id === decodeURIComponent(parts[5] ?? ""));
      if (row === undefined) {
        return new Response(null, { status: 404 });
      }
      const input = z
        .strictObject({ type: z.string(), value: z.string() })
        .parse(JSON.parse(z.string().parse(init?.body)));
      expect(Object.keys(input).toSorted()).toEqual(["type", "value"]);
      expect(input.type).toBe("encrypted");
      row.value = input.value;
      afterWrite?.();
      return Response.json({});
    }
    if (method === "POST" && parts.length === 5) {
      const input = environmentWriteSchema.array().parse(JSON.parse(z.string().parse(init?.body)));
      writes.push({
        gitBranch: input[0].gitBranch,
        keys: input.map((row) => row.key),
        target: input[0].target,
        upsert: url.searchParams.get("upsert"),
      });
      for (const row of input) {
        rows[projectId].push({ ...row, id: `managed-${projectId}-${row.key}` });
      }
      afterWrite?.();
      return Response.json({ envs: [] });
    }
    throw new Error("unexpected fixture route");
  };
  const fetcher: typeof fetch = (raw, init) => {
    try {
      return Promise.resolve(respond(raw, init));
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error("Fixture request failed", { cause: error }),
      );
    }
  };
  const readCredential = vi.fn<
    Parameters<typeof createNativeTargetAuthOnlyPreviewEnvironmentAdapter>[0]["readCredential"]
  >(() =>
    Promise.resolve({
      binding: {
        active: true,
        displayName: "Fixture",
        installationId: target.installationId,
        plan: "pro",
        scopeId: target.scopeId,
        scopeType: "team" as const,
        slug: "fixture",
        updatedAt: new Date("2026-11-06T00:00:00Z"),
      },
      token: "private-installation-fixture",
    }),
  );
  const adapter = createNativeTargetAuthOnlyPreviewEnvironmentAdapter({
    fetch: fetcher,
    readCredential,
  });
  const manifest = {
    app: {
      branch: target.branch,
      physicalBranch: effect === "app" ? physicalBranch : target.branch,
      projectId: target.projectId,
      values: Object.entries(appValues).map(([key, value]) => ({
        key: z.enum(["PLATFORM_JWKS_URL", "PLATFORM_ORIGIN", "PLATFORM_PUBLIC_ORIGIN"]).parse(key),
        sha256: hash(value),
      })),
    },
    authOnlyPlanDigest: nativeTargetAuthOnlyPlanDigest(plan),
    deliveryPlanDigest: approvedDeliveryDigest,
    gateway: {
      branch: "gateway-preview",
      physicalBranch: effect === "gateway" ? physicalBranch : "gateway-preview",
      projectId: "gateway-project",
      recoverySecret: {
        id: "sender-0",
        key: "AUTH_RECOVERY_RESEND_API_KEY" as const,
        physicalBranch: effect === "gateway" ? physicalBranch : "gateway-preview",
        projectId: "gateway-project",
        target: "preview" as const,
        type: "sensitive",
        updatedAt: 1_793_966_400_000,
      },
      values: Object.entries(gatewayValues).map(([key, value]) => ({ key, sha256: hash(value) })),
    },
    kind: "native-target-auth-only-preview-environment" as const,
    resourcePlanDigest: deliveryPlan.resourcePlanDigest,
    source: deliveryPlan.source,
    version: 1 as const,
  };
  const input: NativeTargetAuthOnlyPreviewEnvironmentApplyInput = {
    approvedDeliveryDigest,
    assertCurrent,
    authority: plan.origin.authority,
    branch: manifest[effect].branch,
    effect,
    fenceGeneration: 2,
    manifest,
    operationRef,
    physicalBranch,
    projectId: manifest[effect].projectId,
    signal: controller.signal,
    target,
    values: effect === "gateway" ? gatewayValues : appValues,
  };
  const metadataInput = {
    approval: {
      callId: "call",
      observedAt: "2026-11-06T00:00:00Z",
      outcome: "approved" as const,
      planDigest: approvedDeliveryDigest,
      publicSessionId: target.sessionId,
      requestId: "approval",
      responderPrincipalId: plan.origin.authority.ownerUserId,
      sourceDigest: approvedDeliveryDigest,
    },
    assertCurrent,
    authority: plan.origin.authority,
    deliveryPlan,
    effect,
    fenceGeneration: 2,
    operationRef,
    plan,
    signal: controller.signal,
    target,
  };
  return {
    adapter,
    assertCurrent,
    calls,
    controller,
    input,
    metadataInput,
    projects,
    readCredential,
    readEnvironmentValues: (keys: readonly string[]) =>
      adapter.readProjectEnvironmentValues(
        metadataInput,
        {
          ...target,
          projectId: "gateway-project",
          branch: "gateway-preview",
        },
        keys,
      ),
    readSender: () => adapter.readRecoverySender(metadataInput),
    rows,
    scope,
    setAfterWrite: (hook: typeof afterWrite) => (afterWrite = hook),
    setBeforeRequest: (hook: typeof beforeRequest) => (beforeRequest = hook),
    setRejectStatus: (status: number) => (rejectStatus = status),
    writes,
  };
};

it("reads Secret metadata and only decrypts the bare From address in the exact Preview", async () => {
  const state = fixture();
  const result = await state.readSender();
  expect(result).toEqual({
    apiKey: state.input.manifest.gateway.recoverySecret,
    environment: "preview",
    from: gatewayValues.AUTH_RECOVERY_EMAIL_FROM,
    ownerProjectId: "gateway-project",
    provider: "resend",
  });
  expect(state.calls.filter(({ path }) => path.includes("/env/"))).toEqual([
    { method: "GET", path: "/v1/projects/gateway-project/env/sender-1" },
  ]);
  expect(state.writes).toEqual([]);
  const calls = state.calls.length;
  await expect(state.readEnvironmentValues(senderKeys)).rejects.toMatchObject({
    code: "resource_mismatch",
  });
  expect(state.calls).toHaveLength(calls);
});

it("uses authoritative Secret visibility and allows omitted optional provider timestamps", async () => {
  const f = fixture();
  const row = f.rows["gateway-project"][0];
  row.visibility = "secret";
  row.type = "encrypted";
  delete row.updatedAt;
  const sender = await f.readSender();
  expect(sender.apiKey).toMatchObject({
    id: "sender-0",
    type: "encrypted",
    visibility: "secret",
  });
  row.visibility = "config";
  row.type = "sensitive";
  await expect(f.readSender()).rejects.toMatchObject({ code: "resource_mismatch" });
  expect(f.calls.some(({ path }) => path.endsWith("/sender-0"))).toBe(false);
});

it("rejects a From row stored as a legacy Secret before attempting a detail read", async () => {
  const f = fixture();
  const row = f.rows["gateway-project"][1];
  row.type = "sensitive";
  row.visibility = "config";
  await expect(f.readSender()).rejects.toMatchObject({ code: "resource_mismatch" });
  expect(f.calls.some(({ path }) => path.includes("/env/"))).toBe(false);
});

it("fails closed when the operator-owned sender is absent or scoped to a different physical Preview", async () => {
  const absent = fixture();
  absent.rows["gateway-project"] = [];
  await expect(absent.readSender()).rejects.toMatchObject({ code: "resource_mismatch" });
  const wrongBranch = fixture();
  wrongBranch.rows["gateway-project"] = wrongBranch.rows["gateway-project"].map((row) => ({
    ...row,
    gitBranch: "another-preview",
  }));
  await expect(wrongBranch.readSender()).rejects.toMatchObject({ code: "resource_mismatch" });
  expect(absent.writes).toEqual([]);
  expect(wrongBranch.writes).toEqual([]);
});

it("reads authenticated source-bound metadata without exposing unrelated provider fields", async () => {
  const f = fixture();
  const result = await f.adapter.readProjectMetadata(f.metadataInput);
  expect(result.gatewayProjectMetadata.id).toBe("gateway-project");
  expect(result.appProjectMetadata.id).toBe("app-project");
  expect(result.gatewayProjectMetadata).not.toHaveProperty("env");
  expect(f.writes).toHaveLength(0);
  expect(f.assertCurrent).toHaveBeenCalled();
});
it("creates only missing managed Gateway Preview rows and verifies operator-owned sender without rewriting it", async () => {
  const f = fixture();
  await f.adapter.applyAndVerify(f.input);
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0].keys).toHaveLength(6);
  expect(f.writes[0].keys.some((key) => senderKeys.includes(key))).toBe(false);
  expect(f.writes[0]).toMatchObject({
    gitBranch: "gateway-preview",
    target: ["preview"],
    upsert: "false",
  });
  await f.adapter.applyAndVerify(f.input);
  expect(f.writes).toHaveLength(1);
});
it.each([target.branch, null])(
  "binds static app to the exact physical Preview scope %s without sender material",
  async (branch) => {
    const f = fixture("app", branch);
    expect(Object.keys(f.input.values).some((key) => senderKeys.includes(key))).toBe(false);
    await f.adapter.applyAndVerify(f.input);
    expect(f.writes[0].keys.toSorted()).toEqual(Object.keys(appValues).toSorted());
    expect(f.writes[0].gitBranch ?? null).toBe(branch);
    expect(f.writes[0].target).toEqual(["preview"]);
  },
);
it.each([
  "missing",
  "value",
  "mixed-target",
  "other-branch",
  "masked",
  "integration",
  "config",
  "updated",
  "custom",
  "system",
  "duplicate",
])("rejects %s sender readback before writing any managed key", async (kind) => {
  const f = fixture();
  const row = f.rows["gateway-project"][0];
  if (kind === "missing") {
    f.rows["gateway-project"].shift();
  }
  if (kind === "value") {
    f.rows["gateway-project"][1].value = "changed@example.test";
  }
  if (kind === "mixed-target") {
    row.target.push("production");
  }
  if (kind === "other-branch") {
    row.gitBranch = "other";
  }
  if (kind === "masked") {
    delete f.rows["gateway-project"][1].value;
  }
  if (kind === "integration") {
    row.configurationId = "foreign";
  }
  if (kind === "config") {
    row.visibility = "config";
  }
  if (kind === "updated") {
    row.updatedAt = 1_793_966_500_000;
  }
  if (kind === "custom") {
    row.customEnvironmentIds = ["custom-scope"];
  }
  if (kind === "system") {
    row.system = true;
  }
  if (kind === "duplicate") {
    f.rows["gateway-project"].push({ ...row, id: "different" });
  }
  await expect(f.adapter.applyAndVerify(f.input)).rejects.toThrow("resource_mismatch");
  expect(f.writes).toHaveLength(0);
});
it.each(["foreign", "value", "duplicate", "integration"])(
  "does not overwrite a %s existing managed row",
  async (kind) => {
    const f = fixture();
    const row: Row = {
      comment: `App Builder runtime ${f.scope("gateway-project")}`,
      gitBranch: "gateway-preview",
      id: "existing",
      key: "AUTH_REQUIRE_EMAIL_VERIFICATION",
      target: ["preview"],
      value: "true",
    };
    if (kind === "foreign") {
      row.comment = "other owner";
    }
    if (kind === "value") {
      row.value = "false";
    }
    if (kind === "integration") {
      row.configurationId = "foreign";
    }
    f.rows["gateway-project"].push(row);
    if (kind === "duplicate") {
      f.rows["gateway-project"].push({ ...row, id: "duplicate" });
    }
    await expect(f.adapter.applyAndVerify(f.input)).rejects.toThrow("resource_mismatch");
    expect(f.writes).toHaveLength(0);
  },
);
it.each([401, 403, 404])(
  "never treats provider HTTP %s as an absent environment",
  async (status) => {
    const f = fixture();
    f.setRejectStatus(status);
    await expect(f.adapter.applyAndVerify(f.input)).rejects.toThrow(
      status === 404 ? "provider_unavailable" : "authorization_required",
    );
    expect(f.writes).toHaveLength(0);
  },
);
it("stops cancellation between preflight reads and write", async () => {
  const f = fixture();
  f.setBeforeRequest((method, path) => {
    if (method === "GET" && path.includes("/env/sender-1")) {
      f.controller.abort();
    }
  });
  await expect(f.adapter.applyAndVerify(f.input)).rejects.toThrow();
  expect(f.writes).toHaveLength(0);
});
it("rechecks physical branch mapping immediately before POST", async () => {
  const f = fixture();
  let lists = 0;
  f.setBeforeRequest((method, path) => {
    if (method === "GET" && path.endsWith("/env")) {
      lists += 1;
    }
    if (method === "GET" && path.endsWith("/env") && lists === 2) {
      f.projects["gateway-project"].link.productionBranch = "gateway-preview";
    }
  });
  await expect(f.adapter.applyAndVerify(f.input)).rejects.toThrow();
  expect(f.writes).toHaveLength(0);
});
it("does not upsert a concurrently created key and rejects mismatched post-write readback", async () => {
  const f = fixture();
  let lists = 0;
  f.setBeforeRequest((method, path) => {
    if (method === "GET" && path.endsWith("/env")) {
      lists += 1;
    }
    if (method === "GET" && path.endsWith("/env") && lists === 2) {
      f.rows["gateway-project"].push({
        id: "racing",
        key: "AUTH_REQUIRE_EMAIL_VERIFICATION",
        value: "false",
        target: ["preview"],
        gitBranch: "gateway-preview",
        comment: `App Builder runtime ${f.scope("gateway-project")}`,
      });
    }
  });
  await expect(f.adapter.applyAndVerify(f.input)).rejects.toThrow();
  expect(f.writes).toHaveLength(0);
  const g = fixture();
  g.setAfterWrite(() => {
    const written = g.rows["gateway-project"].find(
      (entry) => entry.key === "AUTH_REQUIRE_EMAIL_VERIFICATION",
    );
    if (written === undefined) {
      throw new Error("Expected the newly created verification setting");
    }
    written.value = "false";
  });
  await expect(g.adapter.applyAndVerify(g.input)).rejects.toThrow("resource_mismatch");
  expect(g.writes).toHaveLength(1);
});
it.each(["production", "digest", "sender", "installation"])(
  "fails %s before requests",
  async (kind) => {
    const f = fixture("app");
    if (kind === "production") {
      f.input.target = { ...f.input.target };
      Object.assign(f.input.target, { environment: "production" });
    }
    if (kind === "digest") {
      f.input.approvedDeliveryDigest = "f".repeat(64);
    }
    if (kind === "sender") {
      f.input.values = { ...f.input.values, AUTH_RECOVERY_RESEND_API_KEY: "fixture" };
    }
    if (kind === "installation") {
      const revokedCredential = undefined;
      f.readCredential.mockResolvedValue(revokedCredential);
    }
    await expect(f.adapter.applyAndVerify(f.input)).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  },
);
it.each(["team", "repository"])("rejects metadata from another %s", async (kind) => {
  const f = fixture();
  const project = f.projects["gateway-project"];
  if (kind === "team") {
    project.accountId = "other-team";
  } else {
    project.link.repoId = "other-repo";
  }
  await expect(f.adapter.readProjectMetadata(f.metadataInput)).rejects.toThrow("resource_mismatch");
  expect(f.writes).toHaveLength(0);
});

const projectionFixture = () => {
  const state = fixture();
  const source = {
    audience: "https://vercel.com/team",
    environment: "preview" as const,
    issuer: "https://oidc.vercel.com/team",
    ownerId: target.scopeId,
    projectId: "gateway-project",
    publicOrigin: "https://pilot.example",
    subject: "owner:team:project:gateway:environment:preview",
  };
  const siblingScope = {
    deploymentId: "dpl-sibling",
    deploymentUrl: "https://sibling-immutable.vercel.app",
    environment: "preview",
    ownerId: target.scopeId,
    projectId: "sibling-project",
    projectName: "sibling",
    scopeSlug: "team",
  };
  const sibling = {
    appId: "sibling",
    approved: siblingScope,
    observation: { ...siblingScope, readyState: "READY" },
  };
  const row = {
    comment: `App Builder runtime ${state.scope("gateway-project")}`,
    gitBranch: "gateway-preview",
    id: "projection",
    key: "PLATFORM_GATEWAY_PROJECT_BINDINGS",
    target: ["preview"],
    type: "encrypted",
    value: JSON.stringify({
      version: 1,
      provenance: "trusted-operator-published-provider-projection",
      source,
      bindings: [sibling],
    }),
  };
  state.rows["gateway-project"]?.push(row);
  const appReceipt = {
    branch: target.branch,
    deploymentId: "dpl-pilot",
    operationRef,
    origin: "https://pilot-immutable.vercel.app",
    projectId: target.projectId,
    projectName: plan.project.name,
    readyState: "READY",
    repoId: plan.publishedSource.repositoryId,
    scopeSlug: "team",
  };
  const assertAuthorized = vi.fn(async () => {});
  const assertCatalogApp = vi.fn(async () => {});
  type ReconcileApp = ReturnType<typeof createNativeTargetAuthOnlyPreviewDelivery>["reconcile"];
  const reconcileApp = vi.fn<ReconcileApp>().mockResolvedValue({
    candidates: [appReceipt],
    selected: appReceipt,
    status: "applied",
  });
  let intent: NativeTargetAuthOnlyGatewayProjectionIntent | undefined;
  const claim = vi.fn((next: NativeTargetAuthOnlyGatewayProjectionIntent) => {
    if (intent !== undefined) {
      return Promise.resolve(false);
    }
    intent = next;
    return Promise.resolve(true);
  });
  const execute = createNativeTargetAuthOnlyGatewayProjection(
    {
      assertAuthorized,
      assertCatalogApp,
      journal: { claim, read: () => Promise.resolve(intent) },
      readCredential: state.readCredential,
    },
    {
      openProjection: (input) => state.adapter.openGatewayProjection(input),
      reconcileApp,
    },
  );
  const run = () => execute({ appReceipt, environment: state.metadataInput, source });
  const patches = () => state.calls.filter(({ method }) => method === "PATCH");
  return {
    appReceipt,
    assertAuthorized,
    assertCatalogApp,
    claim,
    patches,
    reconcileApp,
    row,
    run,
    sibling,
    source,
    state,
  };
};

it("merges exactly the current READY app into the owned projection and retains siblings, source and sender rows", async () => {
  const f = projectionFixture();
  const before = f.row.value;
  const result = await f.run();
  const current = trustedGatewayProjectProjectionSchema.parse(JSON.parse(f.row.value));
  expect(current.source).toEqual(f.source);
  expect(current.bindings[0]).toEqual(f.sibling);
  expect(current.bindings[1]).toMatchObject({
    appId: target.appId,
    approved: { deploymentId: f.appReceipt.deploymentId, deploymentUrl: f.appReceipt.origin },
    observation: { readyState: "READY" },
  });
  expect(f.patches()).toEqual([
    { method: "PATCH", path: "/v9/projects/gateway-project/env/projection" },
  ]);
  expect(f.claim).toHaveBeenCalledWith(
    expect.objectContaining({ nextSha256: result.projectionDigest, priorSha256: hash(before) }),
  );
  expect(
    f.state.rows["gateway-project"]
      ?.filter(({ key }) => senderKeys.includes(key))
      .map(({ value }) => value),
  ).toEqual(
    senderKeys.map((key) =>
      key === "AUTH_RECOVERY_EMAIL_FROM" ? gatewayValues.AUTH_RECOVERY_EMAIL_FROM : undefined,
    ),
  );
  expect(f.state.writes).toEqual([]);
  expect(await f.run()).toEqual(result);
  expect(f.patches()).toHaveLength(1);
});

it("reconciles a response lost after the projection write, without repeating the PATCH", async () => {
  const f = projectionFixture();
  f.state.setAfterWrite(() => {
    throw new Error("lost response");
  });
  await expect(f.run()).rejects.toThrow("reconciliation_required");
  await expect(f.run()).resolves.toMatchObject({ projectionDigest: hash(f.row.value) });
  expect(f.patches()).toHaveLength(1);
});

it("does not overwrite an unowned row, a changed source, or a different existing binding", async () => {
  const f = projectionFixture();
  const original = f.row.comment;
  f.row.comment = "operator owned outside this plan";
  await expect(f.run()).rejects.toThrow("resource_mismatch");
  f.row.comment = original;
  const prior = trustedGatewayProjectProjectionSchema.parse(JSON.parse(f.row.value));
  f.row.value = JSON.stringify({
    ...prior,
    source: { ...prior.source, subject: "different-workload" },
  });
  await expect(f.run()).rejects.toThrow("resource_mismatch");
  f.row.value = JSON.stringify({ ...prior, bindings: [{ ...f.sibling, appId: target.appId }] });
  await expect(f.run()).rejects.toThrow("resource_mismatch");
  expect(f.claim).not.toHaveBeenCalled();
  expect(f.patches()).toHaveLength(0);
});

it("keeps an uncertain dispatch fenced when the provider row still has its prior bytes", async () => {
  const f = projectionFixture();
  f.state.setBeforeRequest((method) => {
    if (method === "PATCH") {
      throw new Error("lost request");
    }
  });
  await expect(f.run()).rejects.toThrow("reconciliation_required");
  f.state.setBeforeRequest(undefined);
  await expect(f.run()).rejects.toThrow("reconciliation_required");
  expect(f.patches()).toHaveLength(1);
  expect(f.claim).toHaveBeenCalledOnce();
});

it("requires the exact READY provider candidate and reviewed catalog before a projection write", async () => {
  const f = projectionFixture();
  f.reconcileApp.mockResolvedValueOnce({ candidates: [], status: "unknown" });
  await expect(f.run()).rejects.toThrow("reconciliation_required");
  f.assertCatalogApp.mockRejectedValueOnce(new Error("catalog app missing"));
  await expect(f.run()).rejects.toThrow("catalog app missing");
  expect(f.claim).not.toHaveBeenCalled();
  expect(f.patches()).toHaveLength(0);
});

it("rechecks sender Secret metadata after binding the managed Gateway environment", async () => {
  const f = fixture();
  f.setAfterWrite(() => {
    f.rows["gateway-project"][0].updatedAt = 1_793_966_500_000;
  });
  await expect(f.adapter.applyAndVerify(f.input)).rejects.toThrow("resource_mismatch");
  expect(f.writes).toHaveLength(1);
  expect(f.calls.some(({ path }) => path.endsWith("/sender-0"))).toBe(false);
});
