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
    sessionId: "public-session",
  });
  const plan: NativeTargetOnboardingPlan = {
    appDatabase: {
      database: "invoice_data",
      migratorRole: "invoice_migrator",
      resourceId: "app-resource",
      runtimeRole: "invoice_runtime",
    },
    appId: "invoice-review",
    branch: "preview",
    conflictPolicy: "stop-on-conflict",
    cost: { description: "Dedicated project", ownership: "current-owner" },
    nativeNeon: {
      approvalReference: "approved-neon",
      nativeStore: {
        configurationId: "configuration",
        resourceId: "native-resource",
        sourceProjectId: "source-project",
      },
      scope: {
        branchId: "neon-branch",
        endpointId: "endpoint",
        hostname: "db.example",
        maintenanceDatabase: "neondb",
        maintenanceRole: "maintenance",
        projectId: "neon-project",
      },
    },
    origin: {
      adapterGeneration: 1,
      adapterSessionId: owner.adapterSessionId,
      appSpecDigest: "a".repeat(64),
      publicSessionId: owner.sessionId,
      release: {
        artifactRef: "private-artifact",
        id: "release",
        manifestSha256: "b".repeat(64),
        schemaSha256: "c".repeat(64),
      },
    },
    productRoles: [],
    project: {
      installationId: "installation",
      name: "invoice-review",
      projectSettings: {
        framework: null,
        rootDirectory: "apps/invoice-review",
        sourceFilesOutsideRootDirectory: true,
      },
      protection: nativeTargetRequiredProjectProtection,
      teamId: "team",
    },
    retention: { policy: "Until owner cleanup" },
    version: 1,
    worker: {
      executablePath: "/worker/install",
      id: "worker",
      operationScope: "generated-app-release-install-v1",
      sha256: "d".repeat(64),
      subcommand: "protected-generated-app-install",
    },
  };
  const input = {
    appId: plan.appId,
    operationRef: "00000000-0000-5000-a000-000000000001",
    plan,
    planDigest: nativeTargetOnboardingPlanDigest(plan),
  };
  const actor = {
    attributes: {
      "mcp:audience": authority.audience,
      "mcp:scopes": ["autograph:start"],
      "mcp:workspace-id": authority.workspaceId,
    },
    authenticator: "mcp-oauth-jwks",
    issuer: authority.issuer,
    principalId: "owner",
    principalType: "user",
    subject: "owner",
  };
  const ctx = {
    abortSignal: new AbortController().signal,
    callId: "call",
    session: { auth: { current: actor, initiator: actor }, id: "adapter" },
  };
  const responseCtx: ApprovalResponseContext<NativeTargetPreparationRequest> = {
    auth: {
      getToken: async () => {
        throw new Error("unused");
      },
      requireAuth: () => {
        throw new Error("unused");
      },
    },
    request: {
      callId: "call",
      requestId: "native-request",
      toolInput: input,
      toolName: "prepare-app-native-target",
    },
    responder: actor,
    response: { decision: "approve" },
    session: { id: "adapter", initiator: actor, turn: { id: "turn", sequence: 1 } },
  };
  let output: NativeTargetTransportResponse = { ...input, status: "planned" };
  const sent: {
    url: string;
    options?: RequestInit;
    body: ReturnType<typeof nativeTargetTransportRequestSchema.parse>;
  }[] = [];
  const request = vi.fn<typeof fetch>(async (url, options) => {
    const serialized = z.string().parse(options?.body);
    sent.push({
      body: nativeTargetTransportRequestSchema.parse(JSON.parse(serialized)),
      options,
      url: url instanceof Request ? url.url : url.toString(),
    });
    return Response.json(output, {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  });
  const client = createNativeTargetOnboardingClient({
    endpoint: "https://operator.example",
    fetch: request,
    ownerContext: owner,
    token: vi.fn<() => Promise<string>>().mockResolvedValue("synthetic-oidc"),
  });
  const proof = {
    callId: "original-approved-call",
    observedAt: "2026-10-21T16:00:00Z",
    outcome: "approved" as const,
    planDigest: input.planDigest,
    publicSessionId: "public-session",
    requestId: "native-request",
    responderPrincipalId: "owner",
  };
  return {
    actor,
    client,
    ctx,
    input,
    owner,
    plan,
    proof,
    request,
    responseCtx,
    sent,
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
          branch: f.plan.branch,
          conflictPolicy: f.plan.conflictPolicy,
          project: {
            installationId: f.plan.project.installationId,
            name: f.plan.project.name,
            projectSettings: f.plan.project.projectSettings,
            teamId: f.plan.project.teamId,
          },
        },
        f.ctx,
        {
          appSpec: { appId: f.plan.appId, digest: f.plan.origin.appSpecDigest },
          phase: "validated",
        },
      ),
    ).rejects.toThrow("plan-app-hosted-runtime");
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("sends a missing-selection retained-plan read without forwarding unrelated workflow state", async () => {
    const f = fixture();
    const result = await f.client.plan(
      {
        appId: f.plan.appId,
        branch: f.plan.branch,
        conflictPolicy: f.plan.conflictPolicy,
        project: {
          installationId: f.plan.project.installationId,
          name: f.plan.project.name,
          projectSettings: f.plan.project.projectSettings,
          teamId: f.plan.project.teamId,
        },
      },
      f.ctx,
      { phase: "prepared" },
    );
    expect(result.operationRef).toBe(f.input.operationRef);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.sent[0]?.body.action).toBe("native-target-plan");
    expect(f.sent[0]?.body).not.toHaveProperty("selectedApp");
    expect(f.sent[0]?.body).not.toHaveProperty("state");
  });
  it("still rejects an explicit foreign selected app before sending a retained read", async () => {
    const f = fixture();
    await expect(
      f.client.plan(
        {
          appId: f.plan.appId,
          branch: f.plan.branch,
          conflictPolicy: f.plan.conflictPolicy,
          project: {
            installationId: f.plan.project.installationId,
            name: f.plan.project.name,
            projectSettings: f.plan.project.projectSettings,
            teamId: f.plan.project.teamId,
          },
        },
        f.ctx,
        { appSpec: { appId: "other-app", digest: f.plan.origin.appSpecDigest }, phase: "prepared" },
      ),
    ).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });
  it("describes the exact target approval without requiring declared product roles", () => {
    const f = fixture();
    const description = publicApprovalDescription(f.input, "prepare-app-native-target");
    expect(description).toContain(f.plan.project.name);
    expect(description).toContain(f.plan.cost.description);
    expect(description).toContain(f.plan.retention.policy);
    expect(description).toContain("Require Vercel sign-in for deployments");
    expect(description).toContain("workload identity");
    expect(
      publicApprovalDescription(
        { ...f.input, planDigest: "0".repeat(64) },
        "prepare-app-native-target",
      ),
    ).toBeUndefined();
  });
  it("shows the changed resource scope and fresh approval requirement", () => {
    const f = fixture();
    const plan = {
      ...f.plan,
      resourceProfileAuthorityDigest: "a".repeat(64),
      resourceProfileId: "isolated-development",
      resourceSelectionRevision: 1,
    };
    const description = publicApprovalDescription(
      { ...f.input, plan, planDigest: nativeTargetOnboardingPlanDigest(plan) },
      "prepare-app-native-target",
    );
    for (const reference of [
      plan.resourceProfileId,
      plan.nativeNeon.scope.projectId,
      plan.nativeNeon.scope.branchId,
      plan.appDatabase.resourceId,
      plan.appDatabase.database,
      plan.appDatabase.runtimeRole,
      plan.appDatabase.migratorRole,
    ]) {
      expect(description).toContain(reference);
    }
    expect(description).toContain("needs a new approval");
    expect(description).toContain("No database or app-user access is created now");
  });
  it("uses protected runtime and project OIDC without forwarding raw state/auth", async () => {
    const f = fixture();
    await f.client.plan(
      {
        appId: f.plan.appId,
        branch: f.plan.branch,
        conflictPolicy: f.plan.conflictPolicy,
        project: {
          installationId: f.plan.project.installationId,
          name: f.plan.project.name,
          projectSettings: f.plan.project.projectSettings,
          teamId: f.plan.project.teamId,
        },
      },
      f.ctx,
      {
        appSpec: { appId: f.plan.appId, digest: f.plan.origin.appSpecDigest },
        phase: "app_spec_accepted",
      },
    );
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.url).toBe("https://operator.example/v1/runtime");
    expect(f.sent[0]?.options?.headers).toMatchObject({
      authorization: "Bearer synthetic-oidc",
      "x-vercel-trusted-oidc-idp-token": "synthetic-oidc",
    });
    expect(f.sent[0]?.body).toMatchObject({
      adapterSessionId: "adapter",
      callId: "call",
      ownerContext: f.owner,
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
          token: vi.fn<() => Promise<string>>().mockResolvedValue("synthetic"),
        }),
      ).toThrow();
    }
  });
  it("denies mismatching operation responses", async () => {
    const f = fixture();
    f.setOutput({
      ...f.input,
      operationRef: "00000000-0000-5000-a000-000000000002",
      projectId: "other",
      status: "ready",
    });
    await expect(f.client.prepare(f.input, f.ctx)).rejects.toThrow();
  });
  it("never repeats a transport-unknown preparation", async () => {
    const f = fixture();
    f.request.mockRejectedValue(new Error("connection lost"));
    await expect(f.client.prepare(f.input, f.ctx)).rejects.toThrow();
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("reports a failed approval read without exposing its request or credentials", async () => {
    const f = fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      f.request.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
      await expect(f.client.hasApproval(f.input, f.ctx)).rejects.toThrow("operator_unavailable");
      expect(f.request).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith("[builder:native-target-transport]", {
        action: "native-target-approval-read",
        failure: "http",
        status: 503,
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("synthetic-oidc");
      expect(JSON.stringify(warn.mock.calls)).not.toContain(f.input.operationRef);
    } finally {
      warn.mockRestore();
    }
  });
  it.each([
    "authorization_required",
    "resource_mismatch",
    "reconciliation_required",
    "operator_unavailable",
  ] as const)(
    "preserves typed blocked operator code %s without repeating or exposing private data",
    async (code) => {
      const f = fixture();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        f.request.mockResolvedValueOnce(
          Response.json({
            appId: f.input.appId,
            authenticatedBehavior: "unassessed",
            code,
            status: "blocked",
          }),
        );
        await expect(f.client.hasApproval(f.input, f.ctx)).rejects.toMatchObject({
          code,
          name: "HostedOperatorError",
        });
        expect(f.request).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls).toEqual([
          [
            "[builder:native-target-transport]",
            { action: "native-target-approval-read", failure: code },
          ],
        ]);
        expect(JSON.stringify(warn.mock.calls)).not.toContain(f.input.operationRef);
        expect(JSON.stringify(warn.mock.calls)).not.toContain("synthetic-oidc");
      } finally {
        warn.mockRestore();
      }
    },
  );
  it("preserves the generic handler's typed blocked envelope with unknown app identity", async () => {
    const f = fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      f.request.mockResolvedValueOnce(
        Response.json({
          appId: "unknown",
          authenticatedBehavior: "unassessed",
          code: "resource_mismatch",
          status: "blocked",
        }),
      );
      await expect(f.client.prepare(f.input, f.ctx)).rejects.toMatchObject({
        code: "resource_mismatch",
        name: "HostedOperatorError",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls).toEqual([
        [
          "[builder:native-target-transport]",
          { action: "native-target-prepare", failure: "resource_mismatch" },
        ],
      ]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(f.input.operationRef);
      expect(JSON.stringify(warn.mock.calls)).not.toContain("synthetic-oidc");
    } finally {
      warn.mockRestore();
    }
  });
  it.each([
    { code: "authorization_required", status: "blocked" },
    { authenticatedBehavior: "unassessed", code: "unknown-private-code", status: "blocked" },
    {
      authenticatedBehavior: "unassessed",
      code: "resource_mismatch",
      secret: "private-response",
      status: "blocked",
    },
    { authenticatedBehavior: "unassessed", status: "blocked" },
    { authenticatedBehavior: "unassessed", code: "resource_mismatch", status: "ready" },
  ])("does not accept malformed, unknown or nonblocked operator results", async (result) => {
    const f = fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      f.request.mockResolvedValueOnce(Response.json({ appId: f.input.appId, ...result }));
      await expect(f.client.prepare(f.input, f.ctx)).rejects.toMatchObject({
        code: "operator_unavailable",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls).toEqual([
        [
          "[builder:native-target-transport]",
          { action: "native-target-prepare", failure: "invalid_response" },
        ],
      ]);
    } finally {
      warn.mockRestore();
    }
  });
  it("does not propagate a blocked response for another app", async () => {
    const f = fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      f.request.mockResolvedValueOnce(
        Response.json({
          appId: "another-app",
          authenticatedBehavior: "unassessed",
          code: "resource_mismatch",
          status: "blocked",
        }),
      );
      await expect(f.client.prepare(f.input, f.ctx)).rejects.toMatchObject({
        code: "operator_unavailable",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
  it("accepts only exact terminal approval, with explicit pending and cancellation", async () => {
    const f = fixture();
    f.setOutput({ status: "pending" });
    expect(await f.client.hasApproval(f.input, f.ctx)).toBe(false);
    f.setOutput({ proof: f.proof, status: "approved" });
    expect(await f.client.hasApproval(f.input, f.ctx)).toBe(true);
    f.setOutput({ proof: { ...f.proof, outcome: "cancelled" }, status: "cancelled" });
    await expect(f.client.hasApproval(f.input, f.ctx)).rejects.toThrow();
    f.setOutput({ proof: { ...f.proof, responderPrincipalId: "other" }, status: "approved" });
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
      callId: "call",
      requestId: "native-request",
      responder: { principalId: "owner" },
      toolName: "prepare-app-native-target",
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
        adapterSessionId: "adapter",
        authority: f.owner.authority,
        principal: f.owner.principal,
        sessionAuth: f.ctx.session.auth,
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
        authority: f.owner.authority,
        sessionAuth: { current: f.actor, initiator: f.actor },
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
      action: "native-target-approval-candidate",
      adapterSessionId: "adapter",
      callId: "call",
      candidate: {
        callId: "different-call",
        requestId: "request",
        responder: { authenticator: "mcp-oauth-jwks", principalId: "owner", principalType: "user" },
        toolName: "prepare-app-native-target",
      },
      input: f.input,
      ownerContext: f.owner,
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
