import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
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
  version: 1,
  kind: "native-target-auth-only-delivery",
  authOnlyPlanDigest: nativeTargetAuthOnlyPlanDigest(plan),
  resourcePlanDigest: "b".repeat(64),
  target,
  source: {
    branch: plan.branch,
    gitSha: plan.publishedSource.gitSha,
    repositoryId: plan.publishedSource.repositoryId,
  },
  effects: [
    { id: "auth-only-gateway-preview", kind: "gateway-delivery" },
    { id: "auth-only-app-preview", kind: "delivery" },
  ],
  delivery: {
    action: "prepare",
    stage: "app",
    effects: [
      { id: "auth-only-gateway-preview", kind: "gateway-delivery" },
      { id: "auth-only-app-preview", kind: "delivery" },
    ],
    delivery: {
      branch: plan.branch,
      gitSha: plan.publishedSource.gitSha,
      repoId: plan.publishedSource.repositoryId,
      projectId: target.projectId,
      projectSettings: plan.project.projectSettings,
    },
    gatewayDelivery: {
      branch: "gateway-preview",
      gitRef: "gateway-preview",
      gitSha: "c".repeat(40),
      repoId: "gateway-repo",
      projectId: "gateway-project",
    },
    publicGateway: {
      branch: "gateway-preview",
      origin: "https://pilot.example",
      gatewayOrigin: "https://gateway-native.example",
      authBrowserOrigin: "https://pilot.example",
      projectId: "gateway-project",
    },
  },
});
const approvedDeliveryDigest = nativeTargetAuthOnlyDeliveryPlanDigest(
  Buffer.from(JSON.stringify(deliveryPlan)),
);
const operationRef = "11111111-1111-4111-a111-111111111111";
const senderKeys = ["AUTH_RECOVERY_RESEND_API_KEY", "AUTH_RECOVERY_EMAIL_FROM"];
const gatewayValues: Record<string, string> = {
  AUTH_DATABASE_RESOURCE: '{"environment":"preview"}',
  PLATFORM_AUTH_DATABASE_URL:
    "postgresql://runtime:fixture@auth-preview.neon.tech/auth?sslmode=verify-full",
  PLATFORM_GATEWAY_PROJECT_BINDINGS: "{}",
  PLATFORM_GATEWAY_PROTECTED_APPLICATIONS: '["pilot"]',
  PLATFORM_REALM_OPERATOR_LINK_CONFIG: "{}",
  AUTH_REQUIRE_EMAIL_VERIFICATION: "true",
  AUTH_RECOVERY_EMAIL_FROM: "pilot@example.test",
};
const appValues = {
  PLATFORM_JWKS_URL: "https://gateway.example/_platform/jwks.json",
  PLATFORM_ORIGIN: "https://gateway.example",
  PLATFORM_PUBLIC_ORIGIN: "https://pilot.example",
};
type Row = {
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
};
const fixture = (
  effect: "gateway" | "app" = "gateway",
  physicalBranch: string | null = effect === "gateway" ? "gateway-preview" : target.branch,
) => {
  const controller = new AbortController();
  const assertCurrent = vi.fn(async () => {});
  const scope = (projectId: string) =>
    `auth-only-preview:${operationRef}:${approvedDeliveryDigest}:${projectId}`;
  const rows: Record<string, Row[]> = {
    "gateway-project": senderKeys.map((key, index) => ({
      id: `sender-${index}`,
      key,
      value: gatewayValues[key],
      type: index === 0 ? "sensitive" : "encrypted",
      updatedAt: 1793966400000,
      target: ["preview"],
      gitBranch: effect === "gateway" ? physicalBranch : "gateway-preview",
      comment: "operator owned",
    })),
    "app-project": [],
  };
  const projects: Record<string, unknown> = {
    "gateway-project": {
      id: "gateway-project",
      accountId: target.scopeId,
      framework: "services",
      rootDirectory: ".",
      link: {
        type: "github",
        repoId: "gateway-repo",
        productionBranch:
          effect === "gateway" && physicalBranch === null ? "gateway-preview" : "main",
      },
    },
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
  };
  const writes: { keys: string[]; target: string[]; gitBranch?: string; upsert: string | null }[] =
    [];
  const calls: { method: string; path: string }[] = [];
  let beforeRequest: ((method: string, path: string) => void) | undefined;
  let afterWrite: (() => void) | undefined;
  let rejectStatus: number | undefined;
  const fetcher: typeof fetch = async (raw, init) => {
    const url = new URL(raw instanceof Request ? raw.url : String(raw));
    const method = init?.method ?? "GET";
    const path = url.pathname;
    calls.push({ method, path });
    beforeRequest?.(method, path);
    if (rejectStatus !== undefined) return new Response(null, { status: rejectStatus });
    expect(url.searchParams.get("teamId")).toBe(target.scopeId);
    const parts = path.split("/");
    const projectId = decodeURIComponent(parts[3]!);
    if (method === "GET" && parts.length === 4)
      return Response.json({
        ...(projects[projectId] as object),
        env: [{ value: "discarded provider field" }],
      });
    if (method === "GET" && parts.length === 5) {
      expect(url.searchParams.get("decrypt")).toBe("false");
      return Response.json({ envs: rows[projectId]!.map(({ value, ...metadata }) => metadata) });
    }
    if (method === "GET" && parts.length === 6) {
      const row = rows[projectId]!.find((row) => row.id === decodeURIComponent(parts[5]!));
      expect(row?.key).not.toBe("AUTH_RECOVERY_RESEND_API_KEY");
      return row === undefined ? new Response(null, { status: 404 }) : Response.json(row);
    }
    if (method === "PATCH" && parts.length === 6) {
      const row = rows[projectId]?.find((entry) => entry.id === decodeURIComponent(parts[5] ?? ""));
      if (row === undefined) return new Response(null, { status: 404 });
      const input = JSON.parse(String(init?.body)) as { type: string; value: string };
      expect(Object.keys(input).toSorted()).toEqual(["type", "value"]);
      expect(input.type).toBe("encrypted");
      row.value = input.value;
      afterWrite?.();
      return Response.json({});
    }
    if (method === "POST" && parts.length === 5) {
      const input = JSON.parse(String(init?.body)) as Row[];
      writes.push({
        keys: input.map((row) => row.key),
        target: input[0]!.target,
        gitBranch: input[0]!.gitBranch as string | undefined,
        upsert: url.searchParams.get("upsert"),
      });
      for (const row of input)
        rows[projectId]!.push({ ...row, id: `managed-${projectId}-${row.key}` });
      afterWrite?.();
      return Response.json({ envs: [] });
    }
    throw new Error("unexpected fixture route");
  };
  const readCredential = vi.fn(async () => ({
    token: "private-installation-fixture",
    binding: {
      active: true,
      installationId: target.installationId,
      scopeId: target.scopeId,
      scopeType: "team" as const,
      displayName: "Fixture",
      plan: "pro",
      slug: "fixture",
      updatedAt: new Date("2026-11-06T00:00:00Z"),
    },
  }));
  const adapter = createNativeTargetAuthOnlyPreviewEnvironmentAdapter({
    readCredential,
    fetch: fetcher,
  });
  const manifest = {
    version: 1 as const,
    kind: "native-target-auth-only-preview-environment" as const,
    authOnlyPlanDigest: nativeTargetAuthOnlyPlanDigest(plan),
    deliveryPlanDigest: approvedDeliveryDigest,
    resourcePlanDigest: deliveryPlan.resourcePlanDigest,
    source: deliveryPlan.source,
    gateway: {
      projectId: "gateway-project",
      branch: "gateway-preview",
      physicalBranch: effect === "gateway" ? physicalBranch : "gateway-preview",
      recoverySecret: {
        id: "sender-0",
        key: "AUTH_RECOVERY_RESEND_API_KEY" as const,
        projectId: "gateway-project",
        target: "preview" as const,
        physicalBranch: effect === "gateway" ? physicalBranch : "gateway-preview",
        type: "sensitive",
        updatedAt: 1793966400000,
      },
      values: Object.entries(gatewayValues).map(([key, value]) => ({ key, sha256: hash(value) })),
    },
    app: {
      projectId: target.projectId,
      branch: target.branch,
      physicalBranch: effect === "app" ? physicalBranch : target.branch,
      values: Object.entries(appValues).map(([key, value]) => ({
        key: key as keyof typeof appValues,
        sha256: hash(value),
      })),
    },
  };
  const input: NativeTargetAuthOnlyPreviewEnvironmentApplyInput = {
    authority: plan.origin.authority,
    target,
    operationRef,
    fenceGeneration: 2,
    approvedDeliveryDigest,
    effect,
    projectId: manifest[effect].projectId,
    branch: manifest[effect].branch,
    physicalBranch,
    values: effect === "gateway" ? gatewayValues : appValues,
    manifest,
    assertCurrent,
    signal: controller.signal,
  };
  const metadataInput = {
    authority: plan.origin.authority,
    target,
    plan,
    deliveryPlan,
    operationRef,
    fenceGeneration: 2,
    effect,
    approval: {
      requestId: "approval",
      callId: "call",
      planDigest: approvedDeliveryDigest,
      sourceDigest: approvedDeliveryDigest,
      responderPrincipalId: plan.origin.authority.ownerUserId,
      publicSessionId: target.sessionId,
      outcome: "approved" as const,
      observedAt: "2026-11-06T00:00:00Z",
    },
    assertCurrent,
    signal: controller.signal,
  };
  return {
    adapter,
    input,
    metadataInput,
    readSender: () => adapter.readRecoverySender(metadataInput),
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
    rows,
    projects,
    writes,
    calls,
    controller,
    assertCurrent,
    readCredential,
    scope,
    setBeforeRequest: (hook: typeof beforeRequest) => (beforeRequest = hook),
    setAfterWrite: (hook: typeof afterWrite) => (afterWrite = hook),
    setRejectStatus: (status: number) => (rejectStatus = status),
  };
};

it("reads Secret metadata and only decrypts the bare From address in the exact Preview", async () => {
  const state = fixture();
  const result = await state.readSender();
  expect(result).toEqual({
    provider: "resend",
    environment: "preview",
    ownerProjectId: "gateway-project",
    from: gatewayValues.AUTH_RECOVERY_EMAIL_FROM,
    apiKey: state.input.manifest.gateway.recoverySecret,
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
  const row = f.rows["gateway-project"]![0]!;
  row.visibility = "secret";
  row.type = "encrypted";
  delete row.updatedAt;
  expect((await f.readSender()).apiKey).toMatchObject({
    id: "sender-0",
    visibility: "secret",
    type: "encrypted",
  });
  row.visibility = "config";
  row.type = "sensitive";
  await expect(f.readSender()).rejects.toMatchObject({ code: "resource_mismatch" });
  expect(f.calls.some(({ path }) => path.endsWith("/sender-0"))).toBe(false);
});

it("rejects a From row stored as a legacy Secret before attempting a detail read", async () => {
  const f = fixture();
  const row = f.rows["gateway-project"]![1]!;
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
  wrongBranch.rows["gateway-project"] = wrongBranch.rows["gateway-project"]!.map((row) => ({
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
  expect(f.writes[0]!.keys).toHaveLength(6);
  expect(f.writes[0]!.keys.some((key) => senderKeys.includes(key))).toBe(false);
  expect(f.writes[0]).toMatchObject({
    target: ["preview"],
    gitBranch: "gateway-preview",
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
    expect(f.writes[0]!.keys.toSorted()).toEqual(Object.keys(appValues).toSorted());
    expect(f.writes[0]!.gitBranch ?? null).toBe(branch);
    expect(f.writes[0]!.target).toEqual(["preview"]);
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
  const row = f.rows["gateway-project"]![0]!;
  if (kind === "missing") f.rows["gateway-project"]!.shift();
  if (kind === "value") f.rows["gateway-project"]![1]!.value = "changed@example.test";
  if (kind === "mixed-target") row.target.push("production");
  if (kind === "other-branch") row.gitBranch = "other";
  if (kind === "masked") delete f.rows["gateway-project"]![1]!.value;
  if (kind === "integration") row.configurationId = "foreign";
  if (kind === "config") row.visibility = "config";
  if (kind === "updated") row.updatedAt = 1793966500000;
  if (kind === "custom") row.customEnvironmentIds = ["custom-scope"];
  if (kind === "system") row.system = true;
  if (kind === "duplicate") f.rows["gateway-project"]!.push({ ...row, id: "different" });
  await expect(f.adapter.applyAndVerify(f.input)).rejects.toThrow("resource_mismatch");
  expect(f.writes).toHaveLength(0);
});
it.each(["foreign", "value", "duplicate", "integration"])(
  "does not overwrite a %s existing managed row",
  async (kind) => {
    const f = fixture();
    const row: Row = {
      id: "existing",
      key: "AUTH_REQUIRE_EMAIL_VERIFICATION",
      value: "true",
      target: ["preview"],
      gitBranch: "gateway-preview",
      comment: `App Builder runtime ${f.scope("gateway-project")}`,
    };
    if (kind === "foreign") row.comment = "other owner";
    if (kind === "value") row.value = "false";
    if (kind === "integration") row.configurationId = "foreign";
    f.rows["gateway-project"]!.push(row);
    if (kind === "duplicate") f.rows["gateway-project"]!.push({ ...row, id: "duplicate" });
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
    if (method === "GET" && path.includes("/env/sender-1")) f.controller.abort();
  });
  await expect(f.adapter.applyAndVerify(f.input)).rejects.toThrow();
  expect(f.writes).toHaveLength(0);
});
it("rechecks physical branch mapping immediately before POST", async () => {
  const f = fixture();
  let lists = 0;
  f.setBeforeRequest((method, path) => {
    if (method === "GET" && path.endsWith("/env") && ++lists === 2)
      (
        f.projects["gateway-project"] as { link: { productionBranch: string } }
      ).link.productionBranch = "gateway-preview";
  });
  await expect(f.adapter.applyAndVerify(f.input)).rejects.toThrow();
  expect(f.writes).toHaveLength(0);
});
it("does not upsert a concurrently created key and rejects mismatched post-write readback", async () => {
  const f = fixture();
  let lists = 0;
  f.setBeforeRequest((method, path) => {
    if (method === "GET" && path.endsWith("/env") && ++lists === 2)
      f.rows["gateway-project"]!.push({
        id: "racing",
        key: "AUTH_REQUIRE_EMAIL_VERIFICATION",
        value: "false",
        target: ["preview"],
        gitBranch: "gateway-preview",
        comment: `App Builder runtime ${f.scope("gateway-project")}`,
      });
  });
  await expect(f.adapter.applyAndVerify(f.input)).rejects.toThrow();
  expect(f.writes).toHaveLength(0);
  const g = fixture();
  g.setAfterWrite(() => {
    g.rows["gateway-project"]!.find((row) => row.key === "AUTH_REQUIRE_EMAIL_VERIFICATION")!.value =
      "false";
  });
  await expect(g.adapter.applyAndVerify(g.input)).rejects.toThrow("resource_mismatch");
  expect(g.writes).toHaveLength(1);
});
it("fails wrong scope, manifest digest, sender-in-app and revoked installation before requests", async () => {
  for (const kind of ["production", "digest", "sender", "installation"]) {
    const f = fixture("app");
    if (kind === "production")
      f.input.target = { ...f.input.target, environment: "production" } as never;
    if (kind === "digest") f.input.approvedDeliveryDigest = "f".repeat(64);
    if (kind === "sender")
      f.input.values = { ...f.input.values, AUTH_RECOVERY_RESEND_API_KEY: "fixture" };
    if (kind === "installation") f.readCredential.mockResolvedValue(undefined as never);
    await expect(f.adapter.applyAndVerify(f.input)).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  }
});
it("rejects metadata from another team or repository", async () => {
  for (const kind of ["team", "repository"]) {
    const f = fixture();
    const project = f.projects["gateway-project"] as {
      accountId: string;
      link: { repoId: string };
    };
    if (kind === "team") project.accountId = "other-team";
    else project.link.repoId = "other-repo";
    await expect(f.adapter.readProjectMetadata(f.metadataInput)).rejects.toThrow(
      "resource_mismatch",
    );
    expect(f.writes).toHaveLength(0);
  }
});

const projectionFixture = () => {
  const state = fixture();
  const source = {
    projectId: "gateway-project",
    ownerId: target.scopeId,
    environment: "preview" as const,
    publicOrigin: "https://pilot.example",
    issuer: "https://oidc.vercel.com/team",
    audience: "https://vercel.com/team",
    subject: "owner:team:project:gateway:environment:preview",
  };
  const siblingScope = {
    projectId: "sibling-project",
    ownerId: target.scopeId,
    environment: "preview",
    deploymentId: "dpl-sibling",
    deploymentUrl: "https://sibling-immutable.vercel.app",
    projectName: "sibling",
    scopeSlug: "team",
  };
  const sibling = {
    appId: "sibling",
    approved: siblingScope,
    observation: { ...siblingScope, readyState: "READY" },
  };
  const row = {
    id: "projection",
    key: "PLATFORM_GATEWAY_PROJECT_BINDINGS",
    target: ["preview"],
    type: "encrypted",
    gitBranch: "gateway-preview",
    comment: `App Builder runtime ${state.scope("gateway-project")}`,
    value: JSON.stringify({
      version: 1,
      provenance: "trusted-operator-published-provider-projection",
      source,
      bindings: [sibling],
    }),
  };
  state.rows["gateway-project"]?.push(row);
  const appReceipt = {
    readyState: "READY",
    deploymentId: "dpl-pilot",
    origin: "https://pilot-immutable.vercel.app",
    operationRef,
    projectId: target.projectId,
    projectName: plan.project.name,
    scopeSlug: "team",
    branch: target.branch,
    repoId: plan.publishedSource.repositoryId,
  };
  const assertAuthorized = vi.fn(async () => {});
  const assertCatalogApp = vi.fn(async () => {});
  type ReconcileApp = ReturnType<
    typeof import("./native-target-auth-only-preview-delivery").createNativeTargetAuthOnlyPreviewDelivery
  >["reconcile"];
  const reconcileApp = vi.fn<ReconcileApp>().mockResolvedValue({
    status: "applied",
    selected: appReceipt,
    candidates: [appReceipt],
  });
  let intent: NativeTargetAuthOnlyGatewayProjectionIntent | undefined;
  const claim = vi.fn(async (next: NativeTargetAuthOnlyGatewayProjectionIntent) => {
    if (intent !== undefined) return false;
    intent = next;
    return true;
  });
  const execute = createNativeTargetAuthOnlyGatewayProjection(
    {
      assertAuthorized,
      assertCatalogApp,
      readCredential: state.readCredential,
      journal: { read: async () => intent, claim },
    },
    {
      openProjection: async (input) => await state.adapter.openGatewayProjection(input),
      reconcileApp,
    },
  );
  const run = () => execute({ environment: state.metadataInput, appReceipt, source });
  const patches = () => state.calls.filter(({ method }) => method === "PATCH");
  return {
    state,
    source,
    sibling,
    row,
    appReceipt,
    assertAuthorized,
    assertCatalogApp,
    reconcileApp,
    claim,
    run,
    patches,
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
    expect.objectContaining({ priorSha256: hash(before), nextSha256: result.projectionDigest }),
  );
  expect(
    f.state.rows["gateway-project"]
      ?.filter(({ key }) => senderKeys.includes(key))
      .map(({ value }) => value),
  ).toEqual(senderKeys.map((key) => gatewayValues[key]));
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
    if (method === "PATCH") throw new Error("lost request");
  });
  await expect(f.run()).rejects.toThrow("reconciliation_required");
  f.state.setBeforeRequest(undefined);
  await expect(f.run()).rejects.toThrow("reconciliation_required");
  expect(f.patches()).toHaveLength(1);
  expect(f.claim).toHaveBeenCalledOnce();
});

it("requires the exact READY provider candidate and reviewed catalog before a projection write", async () => {
  const f = projectionFixture();
  f.reconcileApp.mockResolvedValueOnce({ status: "unknown", candidates: [] });
  await expect(f.run()).rejects.toThrow("reconciliation_required");
  f.assertCatalogApp.mockRejectedValueOnce(new Error("catalog app missing"));
  await expect(f.run()).rejects.toThrow("catalog app missing");
  expect(f.claim).not.toHaveBeenCalled();
  expect(f.patches()).toHaveLength(0);
});

it("rechecks sender Secret metadata after binding the managed Gateway environment", async () => {
  const f = fixture();
  f.setAfterWrite(() => {
    f.rows["gateway-project"]![0]!.updatedAt = 1793966500000;
  });
  await expect(f.adapter.applyAndVerify(f.input)).rejects.toThrow("resource_mismatch");
  expect(f.writes).toHaveLength(1);
  expect(f.calls.some(({ path }) => path.endsWith("/sender-0"))).toBe(false);
});
