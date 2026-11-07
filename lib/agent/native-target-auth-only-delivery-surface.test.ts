/* oxlint-disable eslint/require-await -- Controlled transport and private ports retain asynchronous contracts. */
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import type { ApprovalContext, ApprovalResponseContext, ApprovalStatus } from "eve/tools/approval";
import type { ToolContext, WorkflowToolContext } from "eve/tools";
import planTool from "../../agent/tools/plan-app-native-target-auth-only-delivery";
import prepareTool from "../../agent/tools/prepare-app-native-target-auth-only-delivery";
import { operatorOwnerContextSchema } from "../provisioning/hosted-operator-contract";
import {
  nativeTargetAuthOnlyDeliveryPlanInputSchema,
  nativeTargetAuthOnlyDeliveryResultSchema,
  nativeTargetTransportRequestSchema,
} from "../provisioning/native-target-onboarding-transport";
import {
  nativeTargetAuthOnlyDeliveryPreparationInputSchema,
  nativeTargetAuthOnlyDeliveryApprovalTool,
} from "../eve/private-native-target-auth-only-delivery-approval";
import { createNativeTargetOnboardingClient } from "./native-target-onboarding-client";
import {
  configureNativeTargetOnboardingRuntime,
  createNativeTargetOnboardingRuntime,
} from "./native-target-onboarding-runtime";
import type { NativeTargetOnboardingRuntimePorts } from "./native-target-onboarding-runtime";

type Preparation = z.infer<typeof nativeTargetAuthOnlyDeliveryPreparationInputSchema>;
const fixture = () => {
  const authority = {
    issuer: "https://builder.example/api/auth",
    audience: "https://builder.example/mcp",
    workspaceId: "workspace",
    ownerUserId: "owner",
  };
  const owner = operatorOwnerContextSchema.parse({
    kind: "direct",
    authority,
    principal: { ...authority, scopes: ["autograph:start"] },
    adapterGeneration: 1,
    adapterSessionId: "adapter",
    sessionId: "saved-public-session",
  });
  const actor = {
    authenticator: "mcp-oauth-jwks",
    principalType: "user",
    principalId: "owner",
    subject: "owner",
    issuer: authority.issuer,
    attributes: {},
  };
  const operationRef = "11111111-1111-4111-a111-111111111111";
  const deliveryPlan = {
    version: 1,
    kind: "native-target-auth-only-delivery",
    authOnlyPlanDigest: "a".repeat(64),
    resourcePlanDigest: "b".repeat(64),
    target: {
      appId: "pilot",
      branch: "preview",
      environment: "preview",
      installationId: "installation",
      projectId: "pilot-project",
      scopeId: "team",
      scopeType: "team",
      sessionId: owner.sessionId,
    },
    source: { branch: "preview", gitSha: "c".repeat(40), repositoryId: "repository" },
    delivery: {
      action: "prepare",
      stage: "app",
      delivery: {
        branch: "preview",
        gitSha: "c".repeat(40),
        projectId: "pilot-project",
        repoId: "repository",
      },
      gatewayDelivery: {
        branch: "gateway-preview",
        gitRef: "gateway-preview",
        gitSha: "d".repeat(40),
        projectId: "gateway-project",
        repoId: "gateway-repository",
      },
      publicGateway: {
        authBrowserOrigin: "https://pilot.example",
        branch: "gateway-preview",
        gatewayOrigin: "https://gateway.example",
        origin: "https://pilot.example",
        projectId: "gateway-project",
      },
      effects: [
        { id: "auth-only-gateway-preview", kind: "gateway-delivery" },
        { id: "auth-only-app-preview", kind: "delivery" },
      ],
    },
    effects: [
      { id: "auth-only-gateway-preview", kind: "gateway-delivery" },
      { id: "auth-only-app-preview", kind: "delivery" },
    ],
  };
  const prep = nativeTargetAuthOnlyDeliveryPreparationInputSchema.parse({
    appId: "pilot",
    operationRef,
    planDigest: "a".repeat(64),
    resourcePlanDigest: "b".repeat(64),
    deliveryPlanDigest: createHash("sha256").update(JSON.stringify(deliveryPlan)).digest("hex"),
    deliveryPlan,
  });
  const planInput = nativeTargetAuthOnlyDeliveryPlanInputSchema.parse({
    appId: prep.appId,
    operationRef: prep.operationRef,
    planDigest: prep.planDigest,
    resourcePlanDigest: prep.resourcePlanDigest,
  });
  const prepared = nativeTargetAuthOnlyDeliveryResultSchema.parse({
    status: "prepared",
    deliveryPlanDigest: prep.deliveryPlanDigest,
    app: {
      operationRef,
      branch: "preview",
      deploymentId: "app-deployment",
      origin: "https://app-deployment.example",
      projectId: "pilot-project",
      readyState: "READY",
      repoId: "repository",
    },
    gateway: {
      operationRef,
      branch: "gateway-preview",
      deploymentId: "gateway-deployment",
      origin: "https://gateway-deployment.example",
      projectId: "gateway-project",
      readyState: "READY",
      repoId: "gateway-repository",
    },
  });
  const pending = {
    status: "pending-owner",
    deliveryPlanDigest: prep.deliveryPlanDigest,
    authIdentityLink: "https://pilot.example/auth/sign-in?nonce=fixture",
    authIdentityLinkExpiresAt: "2026-11-07T04:00:00.000Z",
  } as const;
  const ctx = {
    session: { id: "adapter", auth: { current: actor, initiator: actor } },
    callId: "current-call",
    abortSignal: new AbortController().signal,
  };
  const responseCtx: ApprovalResponseContext<Preparation> = {
    responder: actor,
    session: { id: "adapter", initiator: actor, turn: { id: "turn", sequence: 1 } },
    request: {
      requestId: "original-request",
      callId: "original-call",
      toolName: nativeTargetAuthOnlyDeliveryApprovalTool,
      toolInput: prep,
    },
    response: { decision: "approve" },
    auth: {
      getToken: async () => {
        throw new Error("unused");
      },
      requireAuth: () => {
        throw new Error("unused");
      },
    },
  };
  let output: unknown = prep;
  const sent: z.infer<typeof nativeTargetTransportRequestSchema>[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    sent.push(nativeTargetTransportRequestSchema.parse(JSON.parse(z.string().parse(init?.body))));
    return Response.json(output);
  });
  const client = createNativeTargetOnboardingClient({
    endpoint: "https://operator.example",
    ownerContext: owner,
    token: async () => "private-workload-token",
    fetch,
  });
  return {
    client,
    prep,
    planInput,
    prepared,
    pending,
    ctx,
    responseCtx,
    owner,
    sent,
    fetch,
    output(value: unknown) {
      output = value;
    },
  };
};

it("plans the same saved operation and returns the retained delivery preparation", async () => {
  const f = fixture();
  expect(await f.client.planAuthOnlyDelivery(f.planInput, f.ctx)).toEqual(f.prep);
  expect(f.sent[0]).toMatchObject({
    action: "native-target-auth-only-delivery-plan",
    ownerContext: f.owner,
    input: f.planInput,
  });
  expect(f.fetch).toHaveBeenCalledOnce();
});

it("accepts READY candidates for the exact approved app and Gateway", async () => {
  const f = fixture();
  f.output(f.prepared);
  expect(await f.client.prepareAuthOnlyDelivery(f.prep, f.ctx)).toEqual(f.prepared);
  expect(f.sent[0]).toMatchObject({ action: "native-target-auth-only-delivery", input: f.prep });
});

it.each(["app", "session", "plan", "resource"] as const)(
  "rejects a different request %s before dispatch",
  async (kind) => {
    const f = fixture();
    const changed = structuredClone(f.prep);
    if (kind === "app") changed.deliveryPlan.target.appId = "other";
    if (kind === "session") changed.deliveryPlan.target.sessionId = "other";
    if (kind === "plan") changed.deliveryPlan.authOnlyPlanDigest = "f".repeat(64);
    if (kind === "resource") changed.deliveryPlan.resourcePlanDigest = "f".repeat(64);
    await expect(f.client.prepareAuthOnlyDelivery(changed, f.ctx)).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
  },
);

it.each(["app", "operation", "plan", "resource", "target-session"] as const)(
  "rejects a mismatched planned %s",
  async (kind) => {
    const f = fixture();
    const changed = structuredClone(f.prep);
    if (kind === "app") changed.appId = "other";
    if (kind === "operation") changed.operationRef = "22222222-2222-4222-a222-222222222222";
    if (kind === "plan") changed.planDigest = "f".repeat(64);
    if (kind === "resource") changed.resourcePlanDigest = "f".repeat(64);
    if (kind === "target-session") changed.deliveryPlan.target.sessionId = "other";
    f.output(changed);
    await expect(f.client.planAuthOnlyDelivery(f.planInput, f.ctx)).rejects.toThrow();
  },
);

it.each([
  "digest",
  "app-project",
  "gateway-project",
  "operation",
  "branch",
  "repository",
  "not-ready",
] as const)("rejects mismatched delivery %s", async (kind) => {
  const f = fixture();
  if (f.prepared.status !== "prepared") throw new Error("fixture");
  const changed = structuredClone(f.prepared);
  if (kind === "digest") changed.deliveryPlanDigest = "f".repeat(64);
  if (kind === "app-project") changed.app.projectId = "other";
  if (kind === "gateway-project") changed.gateway.projectId = "other";
  if (kind === "operation") changed.gateway.operationRef = "22222222-2222-4222-a222-222222222222";
  if (kind === "branch") changed.app.branch = "other";
  if (kind === "repository") changed.gateway.repoId = "other";
  if (kind === "not-ready") Object.assign(changed.gateway, { readyState: "BUILDING" });
  f.output(changed);
  await expect(f.client.prepareAuthOnlyDelivery(f.prep, f.ctx)).rejects.toThrow();
});

it("returns only the typed owner invitation while delivery is pending", async () => {
  const f = fixture();
  f.output(f.pending);
  expect(await f.client.prepareAuthOnlyDelivery(f.prep, f.ctx)).toEqual(f.pending);
});

it.each(["http-link", "credentials", "private-proof", "gateway", "digest"] as const)(
  "rejects pending owner output with %s",
  async (kind) => {
    const f = fixture();
    const changed = { ...f.pending };
    if (kind === "http-link")
      Object.assign(changed, { authIdentityLink: "http://pilot.example/auth" });
    if (kind === "credentials")
      Object.assign(changed, { authIdentityLink: "https://user:password@pilot.example/auth" });
    if (kind === "private-proof") Object.assign(changed, { proof: "must-not-cross" });
    if (kind === "gateway") Object.assign(changed, { gateway: {} });
    if (kind === "digest") Object.assign(changed, { deliveryPlanDigest: "f".repeat(64) });
    f.output(changed);
    await expect(f.client.prepareAuthOnlyDelivery(f.prep, f.ctx)).rejects.toThrow();
  },
);

it("checks settled approval on a new call without changing the saved operation", async () => {
  const f = fixture();
  f.output({ status: "pending" });
  expect(await f.client.hasAuthOnlyDeliveryApproval(f.prep, f.ctx)).toBe(false);
  f.output({ status: "approved" });
  expect(
    await f.client.hasAuthOnlyDeliveryApproval(f.prep, { ...f.ctx, callId: "retry-call" }),
  ).toBe(true);
  expect(f.sent.map((entry) => entry.input)).toEqual([f.prep, f.prep]);
  expect(f.sent.map((entry) => entry.callId)).toEqual(["current-call", "retry-call"]);
});

it.each(["owner", "principal-type", "session", "tool", "target-session"] as const)(
  "rejects approval response from different %s",
  async (kind) => {
    const f = fixture();
    const ctx = {
      ...f.responseCtx,
      responder: { ...f.responseCtx.responder },
      session: { ...f.responseCtx.session },
      request: { ...f.responseCtx.request, toolInput: structuredClone(f.prep) },
    };
    if (kind === "owner") ctx.responder.principalId = "other";
    if (kind === "principal-type") ctx.responder.principalType = "service";
    if (kind === "session") ctx.session.id = "other";
    if (kind === "tool") ctx.request.toolName = "prepare-app-native-target-auth-only-resources";
    if (kind === "target-session") ctx.request.toolInput.deliveryPlan.target.sessionId = "other";
    await expect(f.client.authorizeAuthOnlyDeliveryApprovalResponse(ctx)).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
  },
);

it("authorizes the current owner's response without inventing a settled receipt", async () => {
  const f = fixture();
  await f.client.authorizeAuthOnlyDeliveryApprovalResponse(f.responseCtx);
  expect(f.fetch).not.toHaveBeenCalled();
});

it("does not resend an uncertain delivery request", async () => {
  const f = fixture();
  f.fetch.mockRejectedValue(new Error("connection lost"));
  await expect(f.client.prepareAuthOnlyDelivery(f.prep, f.ctx)).rejects.toThrow(
    "operator_unavailable",
  );
  expect(f.fetch).toHaveBeenCalledOnce();
});

it("routes the private runtime through its typed delivery ports and rejects wrong results", async () => {
  const f = fixture();
  const ports = {
    planAuthOnlyDelivery: vi.fn(async () => f.prep),
    prepareAuthOnlyDelivery: vi.fn(async () => f.prepared),
    hasAuthOnlyDeliveryApproval: vi.fn(async () => true),
    authorizeAuthOnlyDeliveryApprovalResponse: vi.fn(async () => undefined),
  };
  // Unused legacy project-creation ports intentionally do not exist in this Auth-only fixture.
  const runtime = createNativeTargetOnboardingRuntime(
    z.custom<NativeTargetOnboardingRuntimePorts>().parse(ports),
  );
  expect(await runtime.planAuthOnlyDelivery(f.planInput, f.ctx)).toEqual(f.prep);
  expect(await runtime.prepareAuthOnlyDelivery(f.prep, f.ctx)).toEqual(f.prepared);
  expect(await runtime.hasAuthOnlyDeliveryApproval(f.prep, f.ctx)).toBe(true);
  await runtime.authorizeAuthOnlyDeliveryApprovalResponse(f.responseCtx);
  expect(ports.authorizeAuthOnlyDeliveryApprovalResponse).toHaveBeenCalledWith(f.responseCtx);
  ports.planAuthOnlyDelivery.mockResolvedValue({
    ...f.prep,
    operationRef: "22222222-2222-4222-a222-222222222222",
  });
  await expect(runtime.planAuthOnlyDelivery(f.planInput, f.ctx)).rejects.toThrow();
  ports.prepareAuthOnlyDelivery.mockResolvedValue({
    ...f.prepared,
    deliveryPlanDigest: "f".repeat(64),
  });
  await expect(runtime.prepareAuthOnlyDelivery(f.prep, f.ctx)).rejects.toThrow();
  const missing = createNativeTargetOnboardingRuntime(
    z.custom<NativeTargetOnboardingRuntimePorts>().parse({}),
  );
  await expect(missing.planAuthOnlyDelivery(f.planInput, f.ctx)).rejects.toThrow();
});

it("uses the real private tools for settled retry, owner response and exactly two invitation partial fields", async () => {
  const f = fixture();
  configureNativeTargetOnboardingRuntime(async () => f.client);
  expect(await planTool.execute(f.planInput, z.custom<ToolContext>().parse(f.ctx))).toEqual(f.prep);
  const approval = z
    .custom<{
      request: (ctx: ApprovalContext<Preparation>) => Promise<ApprovalStatus>;
      response: (ctx: ApprovalResponseContext<Preparation>) => Promise<{ status: string }>;
    }>()
    .parse(prepareTool.approval);
  const approvalCtx = z
    .custom<ApprovalContext<Preparation>>()
    .parse({ ...f.ctx, toolInput: f.prep });
  f.output({ status: "pending" });
  expect(await approval.request(approvalCtx)).toBe("user-approval");
  f.output({ status: "approved" });
  expect(await approval.request({ ...approvalCtx, callId: "retry-call" })).toBe("not-applicable");
  expect(await approval.response(f.responseCtx)).toEqual({ status: "allowed" });
  expect(
    await approval.response({
      ...f.responseCtx,
      responder: { ...f.responseCtx.responder, principalId: "other" },
    }),
  ).toMatchObject({ status: "rejected" });
  f.output(f.pending);
  const result = z
    .custom<AsyncGenerator<unknown, unknown>>()
    .parse(prepareTool.execute(f.prep, z.custom<WorkflowToolContext>().parse(f.ctx)));
  expect(await result.next()).toEqual({
    done: false,
    value: {
      authIdentityLink: f.pending.authIdentityLink,
      authIdentityLinkExpiresAt: f.pending.authIdentityLinkExpiresAt,
    },
  });
  expect(await result.next()).toEqual({ done: true, value: f.pending });
  expect(
    f.sent.filter((entry) => entry.action === "native-target-auth-only-delivery"),
  ).toHaveLength(1);
});

it("returns the retained digest-only routing approval intent while delivery remains incomplete", async () => {
  const f = fixture();
  const routing = {
    ...f.prepared,
    status: "routing-required",
    finalRoutingPlan: {
      appId: f.prep.appId,
      operationRef: f.prep.operationRef,
      deliveryPlanDigest: f.prep.deliveryPlanDigest,
      routingOperationRef: "22222222-2222-4222-a222-222222222222",
      routingPlanDigest: "f".repeat(64),
    },
  };
  f.output(routing);
  expect(await f.client.prepareAuthOnlyDelivery(f.prep, f.ctx)).toEqual(routing);
  expect(f.fetch).toHaveBeenCalledOnce();
});

it.each(["appId", "operationRef", "deliveryPlanDigest", "routingPlanBase64"] as const)(
  "rejects a routing-required result with changed or private %s",
  async (field) => {
    const f = fixture();
    const intent: Record<string, string> = {
      appId: f.prep.appId,
      operationRef: f.prep.operationRef,
      deliveryPlanDigest: f.prep.deliveryPlanDigest,
      routingOperationRef: "22222222-2222-4222-a222-222222222222",
      routingPlanDigest: "f".repeat(64),
    };
    intent[field] =
      field === "appId"
        ? "another-app"
        : field === "operationRef"
          ? "33333333-3333-4333-a333-333333333333"
          : field === "deliveryPlanDigest"
            ? "e".repeat(64)
            : "private-fixture";
    f.output({ ...f.prepared, status: "routing-required", finalRoutingPlan: intent });
    await expect(f.client.prepareAuthOnlyDelivery(f.prep, f.ctx)).rejects.toThrow();
  },
);

const finalPrepared = (f: ReturnType<typeof fixture>) => {
  if (f.prepared.status !== "prepared") throw new Error("Expected prepared fixture");
  const finalRoutingPlan = {
    appId: f.prep.appId,
    operationRef: f.prep.operationRef,
    deliveryPlanDigest: f.prep.deliveryPlanDigest,
    routingOperationRef: "22222222-2222-4222-a222-222222222222",
    routingPlanDigest: "f".repeat(64),
  };
  return {
    ...f.prepared,
    finalRoutingPlan,
    projectionDigest: "e".repeat(64),
    gateway: {
      ...f.prepared.gateway,
      deploymentId: "refreshed-gateway",
      operationRef: finalRoutingPlan.routingOperationRef,
    },
  };
};

it("accepts the verified refreshed Gateway on an approved normal delivery replay", async () => {
  const f = fixture();
  const final = finalPrepared(f);
  f.output(final);
  expect(await f.client.prepareAuthOnlyDelivery(f.prep, f.ctx)).toEqual(final);
  const runtime = createNativeTargetOnboardingRuntime(
    z
      .custom<NativeTargetOnboardingRuntimePorts>()
      .parse({ prepareAuthOnlyDelivery: async () => final }),
  );
  expect(await runtime.prepareAuthOnlyDelivery(f.prep, f.ctx)).toEqual(final);
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]?.action).toBe("native-target-auth-only-delivery");
});

it.each([
  "missing-intent",
  "missing-projection",
  "app",
  "parent-operation",
  "parent-digest",
  "same-operation",
  "gateway-operation",
  "app-operation",
] as const)(
  "rejects incomplete or mismatched final routing on normal delivery: %s",
  async (kind) => {
    const f = fixture();
    const final = finalPrepared(f);
    const changed = structuredClone(final);
    if (kind === "app") changed.finalRoutingPlan.appId = "another-app";
    if (kind === "parent-operation")
      changed.finalRoutingPlan.operationRef = "33333333-3333-4333-a333-333333333333";
    if (kind === "parent-digest") changed.finalRoutingPlan.deliveryPlanDigest = "d".repeat(64);
    if (kind === "same-operation")
      changed.finalRoutingPlan.routingOperationRef = f.prep.operationRef;
    if (kind === "gateway-operation") changed.gateway.operationRef = f.prep.operationRef;
    if (kind === "app-operation")
      changed.app.operationRef = final.finalRoutingPlan.routingOperationRef;
    const output =
      kind === "missing-intent"
        ? { ...changed, finalRoutingPlan: undefined }
        : kind === "missing-projection"
          ? { ...changed, projectionDigest: undefined }
          : changed;
    f.output(output);
    await expect(f.client.prepareAuthOnlyDelivery(f.prep, f.ctx)).rejects.toThrow();
    const runtime = createNativeTargetOnboardingRuntime(
      z
        .custom<NativeTargetOnboardingRuntimePorts>()
        .parse({ prepareAuthOnlyDelivery: async () => output }),
    );
    await expect(runtime.prepareAuthOnlyDelivery(f.prep, f.ctx)).rejects.toThrow();
  },
);
