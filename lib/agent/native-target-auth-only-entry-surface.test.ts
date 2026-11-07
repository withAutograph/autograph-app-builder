/* oxlint-disable eslint/require-await -- Controlled transport and private ports retain asynchronous contracts. */
import { expect, it, vi } from "vitest";
import { z } from "zod";
import type { ApprovalContext, ApprovalResponseContext, ApprovalStatus } from "eve/tools/approval";
import type { ToolContext, WorkflowToolContext } from "eve/tools";
import planTool from "../../agent/tools/plan-app-native-target-auth-only-entry";
import prepareTool from "../../agent/tools/prepare-app-native-target-auth-only-entry";
import { operatorOwnerContextSchema } from "../provisioning/hosted-operator-contract";
import { nativeTargetAuthOnlyEntryApprovalTool } from "../eve/private-native-target-auth-only-entry-approval";
import { nativeTargetAuthOnlyEntryApprovalInputSchema } from "../provisioning/native-target-auth-only-entry-plan-store";
import {
  nativeTargetAuthOnlyEntryPlanInputSchema,
  nativeTargetAuthOnlyEntryResultSchema,
  nativeTargetTransportRequestSchema,
} from "../provisioning/native-target-onboarding-transport";
import { createNativeTargetOnboardingClient } from "./native-target-onboarding-client";
import {
  configureNativeTargetOnboardingRuntime,
  createNativeTargetOnboardingRuntime,
} from "./native-target-onboarding-runtime";
import type { NativeTargetOnboardingRuntimePorts } from "./native-target-onboarding-runtime";

type Preparation = z.infer<typeof nativeTargetAuthOnlyEntryApprovalInputSchema>;
const fixture = (effect: Preparation["effect"] = "organization") => {
  const authority = {
    audience: "https://builder.example/mcp",
    issuer: "https://builder.example/api/auth",
    ownerUserId: "owner",
    workspaceId: "workspace",
  };
  const owner = operatorOwnerContextSchema.parse({
    adapterGeneration: 1,
    adapterSessionId: "adapter",
    authority,
    kind: "direct",
    principal: { ...authority, scopes: ["autograph:start"] },
    sessionId: "saved-public-session",
  });
  const actor = {
    attributes: {},
    authenticator: "mcp-oauth-jwks",
    issuer: authority.issuer,
    principalId: "owner",
    principalType: "user",
    subject: "owner",
  };
  const prep = nativeTargetAuthOnlyEntryApprovalInputSchema.parse({
    appId: "pilot",
    childOperationRef: "22222222-2222-4222-a222-222222222222",
    childPlanDigest: "b".repeat(64),
    deliveryOperationRef: "11111111-1111-4111-a111-111111111111",
    deliveryPlanDigest: "a".repeat(64),
    effect,
  });
  const planInput = nativeTargetAuthOnlyEntryPlanInputSchema.parse({
    appId: prep.appId,
    deliveryOperationRef: prep.deliveryOperationRef,
    deliveryPlanDigest: prep.deliveryPlanDigest,
    effect: prep.effect,
  });
  const prepared = nativeTargetAuthOnlyEntryResultSchema.parse({
    childOperationRef: prep.childOperationRef,
    childPlanDigest: prep.childPlanDigest,
    effect,
    status: "prepared",
  });
  const ctx = {
    abortSignal: new AbortController().signal,
    callId: "current-call",
    session: { auth: { current: actor, initiator: actor }, id: "adapter" },
  };
  const responseCtx: ApprovalResponseContext<Preparation> = {
    auth: {
      getToken: async () => {
        throw new Error("unused");
      },
      requireAuth: () => {
        throw new Error("unused");
      },
    },
    request: {
      callId: "original-call",
      requestId: "original-request",
      toolInput: prep,
      toolName: nativeTargetAuthOnlyEntryApprovalTool,
    },
    responder: actor,
    response: { decision: "approve" },
    session: { id: "adapter", initiator: actor, turn: { id: "turn", sequence: 1 } },
  };
  let output: unknown = prep;
  const sent: z.infer<typeof nativeTargetTransportRequestSchema>[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    sent.push(nativeTargetTransportRequestSchema.parse(JSON.parse(z.string().parse(init?.body))));
    return Response.json(output);
  });
  const client = createNativeTargetOnboardingClient({
    endpoint: "https://operator.example",
    fetch,
    ownerContext: owner,
    token: async () => "private-workload-token",
  });
  return {
    client,
    ctx,
    fetch,
    output(value: unknown) {
      output = value;
    },
    owner,
    planInput,
    prep,
    prepared,
    responseCtx,
    sent,
  };
};

it.each(["organization", "signup-policy"] as const)(
  "plans and executes only the retained %s references",
  async (effect) => {
    const f = fixture(effect);
    expect(await f.client.planAuthOnlyEntry(f.planInput, f.ctx)).toEqual(f.prep);
    f.output(f.prepared);
    expect(await f.client.prepareAuthOnlyEntry(f.prep, f.ctx)).toEqual(f.prepared);
    expect(f.sent).toEqual([
      {
        action: "native-target-auth-only-entry-plan",
        adapterSessionId: "adapter",
        callId: "current-call",
        input: f.planInput,
        ownerContext: f.owner,
      },
      {
        action: "native-target-auth-only-entry",
        adapterSessionId: "adapter",
        callId: "current-call",
        input: f.prep,
        ownerContext: f.owner,
      },
    ]);
  },
);

it.each(["appId", "deliveryOperationRef", "deliveryPlanDigest", "effect"] as const)(
  "rejects a different planned %s",
  async (key) => {
    const f = fixture();
    const changed = { ...f.prep };
    if (key === "appId") {
      changed.appId = "another-app";
    }
    if (key === "deliveryOperationRef") {
      changed.deliveryOperationRef = "33333333-3333-4333-a333-333333333333";
    }
    if (key === "deliveryPlanDigest") {
      changed.deliveryPlanDigest = "c".repeat(64);
    }
    if (key === "effect") {
      changed.effect = "signup-policy";
    }
    f.output(changed);
    await expect(f.client.planAuthOnlyEntry(f.planInput, f.ctx)).rejects.toThrow();
  },
);

it.each(["childOperationRef", "childPlanDigest", "effect"] as const)(
  "rejects a different prepared %s",
  async (key) => {
    const f = fixture();
    const changed = { ...f.prepared };
    if (key === "childOperationRef") {
      changed.childOperationRef = "33333333-3333-4333-a333-333333333333";
    }
    if (key === "childPlanDigest") {
      changed.childPlanDigest = "c".repeat(64);
    }
    if (key === "effect") {
      changed.effect = "signup-policy";
    }
    f.output(changed);
    await expect(f.client.prepareAuthOnlyEntry(f.prep, f.ctx)).rejects.toThrow();
  },
);

it.each(["allowedEmails", "ownerProof", "childPlan"])(
  "rejects private %s in request or response instead of exposing it",
  async (key) => {
    const f = fixture();
    const request = { ...f.prep, [key]: "private-controlled-fixture" };
    await expect(f.client.prepareAuthOnlyEntry(request, f.ctx)).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
    f.output({ ...f.prep, [key]: "private-controlled-fixture" });
    await expect(f.client.planAuthOnlyEntry(f.planInput, f.ctx)).rejects.toThrow();
    f.output({ ...f.prepared, [key]: "private-controlled-fixture" });
    await expect(f.client.prepareAuthOnlyEntry(f.prep, f.ctx)).rejects.toThrow();
  },
);

it("retains the exact child approval intent when the invocation call ID changes", async () => {
  const f = fixture();
  f.output({ status: "pending" });
  expect(await f.client.hasAuthOnlyEntryApproval(f.prep, f.ctx)).toBe(false);
  f.output({ status: "approved" });
  expect(await f.client.hasAuthOnlyEntryApproval(f.prep, { ...f.ctx, callId: "retry-call" })).toBe(
    true,
  );
  expect(f.sent.map(({ input }) => input)).toEqual([f.prep, f.prep]);
  expect(f.sent.map(({ callId }) => callId)).toEqual(["current-call", "retry-call"]);
});

it.each(["owner", "principal-type", "session", "tool", "malformed-intent"] as const)(
  "rejects an approval response with changed %s",
  async (kind) => {
    const f = fixture();
    const ctx = {
      ...f.responseCtx,
      request: { ...f.responseCtx.request, toolInput: { ...f.prep } },
      responder: { ...f.responseCtx.responder },
      session: { ...f.responseCtx.session },
    };
    if (kind === "owner") {
      ctx.responder.principalId = "other";
    }
    if (kind === "principal-type") {
      ctx.responder.principalType = "service";
    }
    if (kind === "session") {
      ctx.session.id = "other";
    }
    if (kind === "tool") {
      ctx.request.toolName = "prepare-app-native-target-auth-only-delivery";
    }
    if (kind === "malformed-intent") {
      ctx.request.toolInput.childPlanDigest = "invalid";
    }
    await expect(f.client.authorizeAuthOnlyEntryApprovalResponse(ctx)).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
  },
);

it("allows the current owner's response without fabricating a settled approval", async () => {
  const f = fixture();
  await f.client.authorizeAuthOnlyEntryApprovalResponse(f.responseCtx);
  expect(f.fetch).not.toHaveBeenCalled();
});

it("rejects another invocation session before any plan or effect request", async () => {
  const f = fixture();
  const ctx = { ...f.ctx, session: { ...f.ctx.session, id: "other" } };
  await expect(f.client.planAuthOnlyEntry(f.planInput, ctx)).rejects.toThrow();
  await expect(f.client.prepareAuthOnlyEntry(f.prep, ctx)).rejects.toThrow();
  await expect(f.client.hasAuthOnlyEntryApproval(f.prep, ctx)).rejects.toThrow();
  expect(f.fetch).not.toHaveBeenCalled();
});

it("rejects mismatched adapter ownership in the transport", () => {
  const f = fixture();
  expect(() =>
    nativeTargetTransportRequestSchema.parse({
      action: "native-target-auth-only-entry",
      adapterSessionId: "another-adapter",
      callId: "call",
      input: f.prep,
      ownerContext: f.owner,
    }),
  ).toThrow();
});

it("never resends an uncertain child effect", async () => {
  const f = fixture();
  f.fetch.mockRejectedValue(new Error("connection lost"));
  await expect(f.client.prepareAuthOnlyEntry(f.prep, f.ctx)).rejects.toThrow(
    "operator_unavailable",
  );
  expect(f.fetch).toHaveBeenCalledOnce();
});

it("stops cancelled requests before transport", async () => {
  const f = fixture();
  const abortSignal = AbortSignal.abort(new Error("cancelled"));
  await expect(f.client.prepareAuthOnlyEntry(f.prep, { ...f.ctx, abortSignal })).rejects.toThrow(
    "cancelled",
  );
  expect(f.fetch).not.toHaveBeenCalled();
});

it("routes through private ports and checks returned child identity", async () => {
  const f = fixture();
  const ports = {
    authorizeAuthOnlyEntryApprovalResponse: vi.fn(async () => undefined),
    hasAuthOnlyEntryApproval: vi.fn(async () => true),
    planAuthOnlyEntry: vi.fn(async () => f.prep),
    prepareAuthOnlyEntry: vi.fn(async () => f.prepared),
  };
  const runtime = createNativeTargetOnboardingRuntime(
    z.custom<NativeTargetOnboardingRuntimePorts>().parse(ports),
  );
  expect(await runtime.planAuthOnlyEntry(f.planInput, f.ctx)).toEqual(f.prep);
  expect(await runtime.prepareAuthOnlyEntry(f.prep, f.ctx)).toEqual(f.prepared);
  expect(await runtime.hasAuthOnlyEntryApproval(f.prep, f.ctx)).toBe(true);
  await runtime.authorizeAuthOnlyEntryApprovalResponse(f.responseCtx);
  expect(ports.authorizeAuthOnlyEntryApprovalResponse).toHaveBeenCalledWith(f.responseCtx);
  ports.planAuthOnlyEntry.mockResolvedValue({ ...f.prep, deliveryPlanDigest: "c".repeat(64) });
  await expect(runtime.planAuthOnlyEntry(f.planInput, f.ctx)).rejects.toThrow();
  ports.prepareAuthOnlyEntry.mockResolvedValue({ ...f.prepared, childPlanDigest: "c".repeat(64) });
  await expect(runtime.prepareAuthOnlyEntry(f.prep, f.ctx)).rejects.toThrow();
});

it("does not execute when a private port is absent or the invocation is cancelled", async () => {
  const f = fixture();
  const missing = createNativeTargetOnboardingRuntime(
    z.custom<NativeTargetOnboardingRuntimePorts>().parse({}),
  );
  await expect(missing.planAuthOnlyEntry(f.planInput, f.ctx)).rejects.toThrow();
  await expect(missing.prepareAuthOnlyEntry(f.prep, f.ctx)).rejects.toThrow();
  await expect(missing.hasAuthOnlyEntryApproval(f.prep, f.ctx)).rejects.toThrow();
  await expect(missing.authorizeAuthOnlyEntryApprovalResponse(f.responseCtx)).rejects.toThrow();
  const prepareAuthOnlyEntry = vi.fn(async () => f.prepared);
  const runtime = createNativeTargetOnboardingRuntime(
    z.custom<NativeTargetOnboardingRuntimePorts>().parse({ prepareAuthOnlyEntry }),
  );
  await expect(
    runtime.prepareAuthOnlyEntry(f.prep, {
      ...f.ctx,
      abortSignal: AbortSignal.abort(new Error("cancelled")),
    }),
  ).rejects.toThrow("cancelled");
  expect(prepareAuthOnlyEntry).not.toHaveBeenCalled();
});

it("uses actual private tools for settled retry and exact single-effect execution", async () => {
  const f = fixture("signup-policy");
  configureNativeTargetOnboardingRuntime(async () => f.client);
  expect(await planTool.execute(f.planInput, z.custom<ToolContext>().parse(f.ctx))).toEqual(f.prep);
  const approval = z
    .custom<{
      request: (ctx: ApprovalContext<Preparation>) => Promise<ApprovalStatus>;
      response: (ctx: ApprovalResponseContext<Preparation>) => Promise<{ status: string }>;
    }>()
    .parse(prepareTool.approval);
  const ctx = z.custom<ApprovalContext<Preparation>>().parse({ ...f.ctx, toolInput: f.prep });
  f.output({ status: "pending" });
  expect(await approval.request(ctx)).toBe("user-approval");
  f.output({ status: "approved" });
  expect(await approval.request({ ...ctx, callId: "retry-call" })).toBe("not-applicable");
  expect(await approval.response(f.responseCtx)).toEqual({ status: "allowed" });
  expect(
    await approval.response({
      ...f.responseCtx,
      responder: { ...f.responseCtx.responder, principalId: "other" },
    }),
  ).toMatchObject({ status: "rejected" });
  f.output(f.prepared);
  expect(await prepareTool.execute(f.prep, z.custom<WorkflowToolContext>().parse(f.ctx))).toEqual(
    f.prepared,
  );
  expect(f.sent.filter(({ action }) => action === "native-target-auth-only-entry")).toHaveLength(1);
});

it("denies a private tool approval request when the retained approval cannot be read", async () => {
  const f = fixture();
  configureNativeTargetOnboardingRuntime(async () => f.client);
  f.fetch.mockResolvedValue(new Response(null, { status: 403 }));
  const approval = z
    .custom<{ request: (ctx: ApprovalContext<Preparation>) => Promise<ApprovalStatus> }>()
    .parse(prepareTool.approval);
  const result = await approval.request(
    z.custom<ApprovalContext<Preparation>>().parse({ ...f.ctx, toolInput: f.prep }),
  );
  expect(result).toMatchObject({ type: "denied" });
  expect(f.fetch).toHaveBeenCalledOnce();
});
