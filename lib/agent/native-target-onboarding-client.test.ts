import { beforeEach, describe, expect, it, vi } from "vitest";
import { publicApprovalDescription } from "./approval-receipt";
import { z } from "zod";
import type { ApprovalResponseContext } from "eve/tools/approval";
import type { resolveHostedOperatorOwnerContext } from "../provisioning/hosted-operator-owner-context";
import type { NativeTargetOnboardingPlan } from "../provisioning/native-target-onboarding-contract";
import {
  nativeTargetOnboardingPlanDigest,
  nativeTargetRequiredProjectProtection,
} from "../provisioning/native-target-onboarding-contract";
import { operatorOwnerContextSchema } from "../provisioning/hosted-operator-contract";
import { nativeTargetTransportRequestSchema } from "../provisioning/native-target-onboarding-transport";
import type { NativeTargetTransportResponse } from "../provisioning/native-target-onboarding-transport";
import type { NativeTargetPreparationRequest } from "./native-target-onboarding-runtime";
import {
  createNativeTargetOnboardingClient,
  nativeTargetOnboardingClientForContext,
} from "./native-target-onboarding-client";

const ownerResolver = vi.fn<typeof resolveHostedOperatorOwnerContext>();

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
    sessionId: "public-session",
  });
  const plan: NativeTargetOnboardingPlan = {
    version: 1,
    appId: "invoice-review",
    origin: {
      publicSessionId: owner.sessionId,
      adapterSessionId: owner.adapterSessionId,
      adapterGeneration: 1,
      appSpecDigest: "a".repeat(64),
      release: {
        id: "release",
        artifactRef: "private-artifact",
        manifestSha256: "b".repeat(64),
        schemaSha256: "c".repeat(64),
      },
    },
    project: {
      name: "invoice-review",
      teamId: "team",
      installationId: "installation",
      projectSettings: {
        framework: null,
        rootDirectory: "apps/invoice-review",
        sourceFilesOutsideRootDirectory: true,
      },
      protection: nativeTargetRequiredProjectProtection,
    },
    branch: "preview",
    appDatabase: {
      resourceId: "app-resource",
      database: "invoice_data",
      migratorRole: "invoice_migrator",
      runtimeRole: "invoice_runtime",
    },
    productRoles: [],
    nativeNeon: {
      approvalReference: "approved-neon",
      nativeStore: {
        configurationId: "configuration",
        resourceId: "native-resource",
        sourceProjectId: "source-project",
      },
      scope: {
        projectId: "neon-project",
        branchId: "neon-branch",
        endpointId: "endpoint",
        hostname: "db.example",
        maintenanceDatabase: "neondb",
        maintenanceRole: "maintenance",
      },
    },
    worker: {
      id: "worker",
      executablePath: "/worker/install",
      sha256: "d".repeat(64),
      operationScope: "generated-app-release-install-v1",
      subcommand: "protected-generated-app-install",
    },
    cost: { ownership: "current-owner", description: "Dedicated project" },
    retention: { policy: "Until owner cleanup" },
    conflictPolicy: "stop-on-conflict",
  };
  const input = {
    appId: plan.appId,
    operationRef: "00000000-0000-5000-a000-000000000001",
    planDigest: nativeTargetOnboardingPlanDigest(plan),
    plan,
  };
  const actor = {
    authenticator: "mcp-oauth-jwks",
    principalType: "user",
    principalId: "owner",
    subject: "owner",
    issuer: authority.issuer,
    attributes: {
      "mcp:audience": authority.audience,
      "mcp:workspace-id": authority.workspaceId,
      "mcp:scopes": ["autograph:start"],
    },
  };
  const ctx = {
    session: { id: "adapter", auth: { current: actor, initiator: actor } },
    callId: "call",
    abortSignal: new AbortController().signal,
  };
  const responseCtx: ApprovalResponseContext<NativeTargetPreparationRequest> = {
    responder: actor,
    session: { id: "adapter", initiator: actor, turn: { id: "turn", sequence: 1 } },
    request: {
      requestId: "native-request",
      callId: "call",
      toolName: "prepare-app-native-target",
      toolInput: input,
    },
    response: { decision: "approve" },
    auth: {
      getToken: () => Promise.reject(new Error("unused")),
      requireAuth: () => {
        throw new Error("unused");
      },
    },
  };
  let output: NativeTargetTransportResponse = { ...input, status: "planned" };
  const sent: {
    url: string;
    options?: RequestInit;
    body: ReturnType<typeof nativeTargetTransportRequestSchema.parse>;
  }[] = [];
  const request = vi.fn<typeof fetch>((url, options) => {
    const serialized = z.string().parse(options?.body);
    sent.push({
      url: url instanceof Request ? url.url : url.toString(),
      options,
      body: nativeTargetTransportRequestSchema.parse(JSON.parse(serialized)),
    });
    return Promise.resolve(
      Response.json(output, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  const client = createNativeTargetOnboardingClient({
    endpoint: "https://operator.example",
    ownerContext: owner,
    token: () => Promise.resolve("synthetic-oidc"),
    fetch: request,
  });
  const proof = {
    requestId: "native-request",
    callId: "original-approved-call",
    planDigest: input.planDigest,
    responderPrincipalId: "owner",
    publicSessionId: "public-session",
    outcome: "approved" as const,
    observedAt: "2026-10-21T16:00:00Z",
  };
  return {
    owner,
    input,
    plan,
    ctx,
    actor,
    responseCtx,
    request,
    sent,
    client,
    proof,
    setOutput: (value: NativeTargetTransportResponse) => {
      output = value;
    },
  };
};

beforeEach(() => {
  ownerResolver.mockReset();
});
describe("native target protected client", () => {
  it("uses the existing target instruction without reserving another project", async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce(
      Response.json(
        {
          code: "native_target_existing_configured_target",
          nextAction: "resolve-preview-target",
        },
        { status: 409 },
      ),
    );
    await expect(
      f.client.plan(
        {
          appId: f.plan.appId,
          project: {
            name: f.plan.project.name,
            teamId: f.plan.project.teamId,
            installationId: f.plan.project.installationId,
            projectSettings: f.plan.project.projectSettings,
          },
          branch: f.plan.branch,
          conflictPolicy: f.plan.conflictPolicy,
        },
        f.ctx,
        {
          phase: "validated",
          appSpec: { appId: f.plan.appId, digest: f.plan.origin.appSpecDigest },
        },
      ),
    ).rejects.toThrow("plan-app-hosted-runtime");
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("describes the exact target approval without requiring declared product roles", () => {
    const f = fixture();
    const description = publicApprovalDescription(f.input, "prepare-app-native-target");
    expect(description).toContain(f.plan.project.name);
    expect(description).toContain(f.plan.cost.description);
    expect(description).toContain(f.plan.retention.policy);
    expect(description).toContain("Vercel Authentication for All Deployments");
    expect(description).toContain("team-issued OIDC tokens");
    expect(
      publicApprovalDescription(
        { ...f.input, planDigest: "0".repeat(64) },
        "prepare-app-native-target",
      ),
    ).toBeUndefined();
  });
  it("uses protected runtime and project OIDC without forwarding raw state/auth", async () => {
    const f = fixture();
    await f.client.plan(
      {
        appId: f.plan.appId,
        project: {
          name: f.plan.project.name,
          teamId: f.plan.project.teamId,
          installationId: f.plan.project.installationId,
          projectSettings: f.plan.project.projectSettings,
        },
        branch: f.plan.branch,
        conflictPolicy: f.plan.conflictPolicy,
      },
      f.ctx,
      {
        phase: "app_spec_accepted",
        appSpec: { appId: f.plan.appId, digest: f.plan.origin.appSpecDigest },
      },
    );
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.url).toBe("https://operator.example/v1/runtime");
    expect(f.sent[0]?.options?.headers).toMatchObject({
      authorization: "Bearer synthetic-oidc",
      "x-vercel-trusted-oidc-idp-token": "synthetic-oidc",
    });
    expect(f.sent[0]?.body).toMatchObject({
      ownerContext: f.owner,
      adapterSessionId: "adapter",
      callId: "call",
      selectedApp: { appId: f.plan.appId, appSpecDigest: f.plan.origin.appSpecDigest },
    });
    expect(f.sent[0]?.body).not.toHaveProperty("session");
    expect(f.sent[0]?.body).not.toHaveProperty("auth");
  });
  it("rejects insecure and credential-bearing operator endpoints", () => {
    const f = fixture();
    for (const endpoint of [
      "http://operator.example",
      "https://user:secret@operator.example",
      "https://operator.example/path",
    ]) {
      expect(() =>
        createNativeTargetOnboardingClient({
          endpoint,
          ownerContext: f.owner,
          token: () => Promise.resolve("synthetic"),
        }),
      ).toThrow();
    }
  });
  it("denies mismatching operation responses", async () => {
    const f = fixture();
    f.setOutput({
      ...f.input,
      operationRef: "00000000-0000-5000-a000-000000000002",
      status: "ready",
      projectId: "other",
    });
    await expect(f.client.prepare(f.input, f.ctx)).rejects.toThrow();
  });
  it("never repeats a transport-unknown preparation", async () => {
    const f = fixture();
    f.request.mockRejectedValue(new Error("connection lost"));
    await expect(f.client.prepare(f.input, f.ctx)).rejects.toThrow();
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("accepts only exact terminal approval, with explicit pending and cancellation", async () => {
    const f = fixture();
    f.setOutput({ status: "pending" });
    expect(await f.client.hasApproval(f.input, f.ctx)).toBe(false);
    f.setOutput({ status: "approved", proof: f.proof });
    expect(await f.client.hasApproval(f.input, f.ctx)).toBe(true);
    f.setOutput({ status: "cancelled", proof: { ...f.proof, outcome: "cancelled" } });
    await expect(f.client.hasApproval(f.input, f.ctx)).rejects.toThrow();
    f.setOutput({ status: "approved", proof: { ...f.proof, responderPrincipalId: "other" } });
    await expect(f.client.hasApproval(f.input, f.ctx)).rejects.toThrow();
  });
  it("forwards only exact candidate identity and never treats it as terminal", async () => {
    const f = fixture();
    f.setOutput({ status: "allowed" });
    await f.client.authorizeApprovalResponse(f.responseCtx);
    const request = f.sent[0]?.body;
    expect(request?.action).toBe("native-target-approval-candidate");
    if (request?.action !== "native-target-approval-candidate") {
      throw new Error("missing candidate");
    }
    expect(request.candidate).toMatchObject({
      requestId: "native-request",
      callId: "call",
      toolName: "prepare-app-native-target",
      responder: { principalId: "owner" },
    });
    expect(request.candidate.responder).not.toHaveProperty("attributes");
    expect(request).not.toHaveProperty("auth");
    f.setOutput({ status: "pending" });
    expect(await f.client.hasApproval(f.input, f.ctx)).toBe(false);
  });
  it("rejects a different authenticated candidate owner before HTTP", async () => {
    const f = fixture();
    await expect(
      f.client.authorizeApprovalResponse({
        ...f.responseCtx,
        responder: { ...f.actor, principalId: "other" },
      }),
    ).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });
  it("resolves normal authority from actual forwarded SDK auth", async () => {
    const f = fixture();
    ownerResolver.mockResolvedValue(f.owner);
    await nativeTargetOnboardingClientForContext(
      f.ctx,
      {
        HOSTED_RUNTIME_OPERATOR_URL: "https://operator.example",
      },
      { resolveOwner: ownerResolver },
    );
    expect(ownerResolver).toHaveBeenCalledWith(
      expect.objectContaining({
        authority: f.owner.authority,
        principal: f.owner.principal,
        sessionAuth: f.ctx.session.auth,
        adapterSessionId: "adapter",
      }),
    );
  });
  it("resolves response authority from complete actual responder and initiator", async () => {
    const f = fixture();
    ownerResolver.mockResolvedValue(f.owner);
    await nativeTargetOnboardingClientForContext(
      f.responseCtx,
      {
        HOSTED_RUNTIME_OPERATOR_URL: "https://operator.example",
      },
      { resolveOwner: ownerResolver },
    );
    expect(ownerResolver).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionAuth: { current: f.actor, initiator: f.actor },
        authority: f.owner.authority,
      }),
    );
  });
  it("does not fill missing responder attributes or use a different initiator", async () => {
    const f = fixture();
    await expect(
      nativeTargetOnboardingClientForContext(
        { ...f.responseCtx, responder: { ...f.actor, attributes: {} } },
        { HOSTED_RUNTIME_OPERATOR_URL: "https://operator.example" },
        { resolveOwner: ownerResolver },
      ),
    ).rejects.toThrow();
    await expect(
      nativeTargetOnboardingClientForContext(
        {
          ...f.responseCtx,
          session: {
            ...f.responseCtx.session,
            initiator: { ...f.actor, principalId: "other", subject: "other" },
          },
        },
        { HOSTED_RUNTIME_OPERATOR_URL: "https://operator.example" },
        { resolveOwner: ownerResolver },
      ),
    ).rejects.toThrow();
    expect(ownerResolver).not.toHaveBeenCalled();
  });
  it("rejects inconsistent native request/call and adapter identities at transport parsing", () => {
    const f = fixture();
    const request = {
      ownerContext: f.owner,
      adapterSessionId: "adapter",
      callId: "call",
      action: "native-target-approval-candidate",
      input: f.input,
      candidate: {
        requestId: "request",
        callId: "different-call",
        toolName: "prepare-app-native-target",
        responder: { authenticator: "mcp-oauth-jwks", principalId: "owner", principalType: "user" },
      },
    };
    expect(nativeTargetTransportRequestSchema.safeParse(request).success).toBe(false);
    expect(
      nativeTargetTransportRequestSchema.safeParse({
        ...request,
        adapterSessionId: "other",
        candidate: { ...request.candidate, callId: "call" },
      }).success,
    ).toBe(false);
  });
});
