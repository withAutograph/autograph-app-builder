import { describe, expect, it, vi } from "vitest";

import { capturedStaticDescriptionProvenance, nativeTargetAuthOnlyPlanDigest, nativeTargetAuthOnlyPlanSchema, nativeTargetAuthOnlySchemaEffectDigest } from "./native-target-auth-only-plan-schema";
import { nativeTargetRequiredProjectProtection } from "./native-target-onboarding-plan-schema";
import { createNativeTargetAuthOnlyDispatch } from "./native-target-auth-only-dispatch";
import type { NativeTargetAuthOnlyDispatchState, NativeTargetAuthOnlyDispatchStore } from "./native-target-auth-only-dispatch";
import { createProtectedHostedOperatorHandler } from "./hosted-operator-service";
import type { ProtectedHostedOperatorDependencies } from "./hosted-operator-service";

const description = { app: { id: "signup-reset-pilot", routes: ["/"], workspacePath: "apps/signup-reset-pilot" }, backend: { kind: "static" }, deployment: { framework: "nextjs", sourceFilesOutsideRootDirectory: true }, validation: { browser: null, check: { task: "mise run app:check signup-reset-pilot" }, test: null }, version: 1 };
const plan = nativeTargetAuthOnlyPlanSchema.parse({
  version: 1, kind: "native-target-auth-only", appId: "signup-reset-pilot",
  origin: { authority: { issuer: "https://builder.example/api/auth", audience: "https://builder.example/mcp", workspaceId: "workspace_fixture", ownerUserId: "owner_fixture" }, publicSessionId: "public_original", adapterSessionId: "native_original", adapterGeneration: 1, appSpecDigest: "a".repeat(64), capturedDescription: capturedStaticDescriptionProvenance(description) },
  project: { name: "signup-reset-pilot", teamId: "team_fixture", installationId: "install_fixture", projectSettings: { framework: "nextjs", rootDirectory: "apps/signup-reset-pilot", sourceFilesOutsideRootDirectory: true }, protection: nativeTargetRequiredProjectProtection },
  branch: "main", publishedSource: { branch: "main", changeSetDigest: "c".repeat(64), gitSha: "d".repeat(40), gitTree: "e".repeat(40), repositoryId: "repo_fixture", reviewDigest: "f".repeat(64) }, authResource: { profileId: "preview-auth", authorityDigest: "b".repeat(64), resourceId: "isolated-auth", database: "auth_identity", endpointId: "endpoint_fixture", hostname: "auth-preview.neon.tech" }, authSchema: { artifactRef: "auth-artifact", planDigest: "1".repeat(64), targetDigest: "2".repeat(64), installer: { reference: "auth-worker", sha256: "3".repeat(64) } }, appRole: "pilot_user", signupPolicy: { eligibility: "approved-email-list", requireVerifiedEmail: true }, cost: { ownership: "current-owner", description: "Auth only" }, retention: { policy: "Retain until explicit cleanup" },
});

const fixture = () => {
  let row: { revision: number; state: NativeTargetAuthOnlyDispatchState } | undefined;
  const store: NativeTargetAuthOnlyDispatchStore = {
    read: async () => row,
    reserve: async (_key, state) => { if (row !== undefined) throw new Error("occupied"); row = { revision: 1, state }; return row; },
    compareAndSet: async (_key, expected, state) => { if (row?.revision !== expected) return undefined; row = { revision: expected + 1, state }; return row; },
  };
  const approval = { requestId: "approval_fixture", callId: "call_fixture", planDigest: nativeTargetAuthOnlyPlanDigest(plan), sourceDigest: nativeTargetAuthOnlySchemaEffectDigest(plan, plan.publishedSource), responderPrincipalId: "owner_fixture", publicSessionId: "public_original", outcome: "approved" as const, observedAt: "2026-11-06T12:00:00.000Z" };
  let uncertain = false;
  const createProject = vi.fn(async ({ authorizeAttempt, acceptProjectId }: { authorizeAttempt: () => Promise<void>; acceptProjectId: (id: string) => Promise<void> }): Promise<{ status: "created"; projectId: string } | { status: "uncertain"; projectId?: string }> => {
    await authorizeAttempt(); await acceptProjectId("vercel_project_fixture");
    return uncertain ? { status: "uncertain", projectId: "vercel_project_fixture" } : { status: "created", projectId: "vercel_project_fixture" };
  });
  const service = createNativeTargetAuthOnlyDispatch({
    store, authorize: async () => ({ authority: plan.origin.authority, ownerUserId: "owner_fixture", publicSessionId: "public_original" }),
    readApproval: async () => approval, revalidate: async () => undefined,
    observeProject: async ({ projectId }) => ({ status: "verified" as const, projectId }),
    createProject,
    now: () => new Date("2026-11-06T12:00:00.000Z"),
  });
  return { service, createProject, store, makeUncertain: () => { uncertain = true; } };
};

describe("Auth-only fenced dispatch", () => {
  it("requires exact owner approval, fences the provider callbacks, and rejects replay", async () => {
    const f = fixture();
    await f.service.approve("request", plan);
    await expect(f.service.dispatch("request", plan)).resolves.toEqual({ status: "created", projectId: "vercel_project_fixture" });
    expect(f.createProject).toHaveBeenCalledTimes(1);
    await expect(f.service.dispatch("request", plan)).resolves.toEqual({ status: "created", projectId: "vercel_project_fixture" });
    expect(f.createProject).toHaveBeenCalledTimes(1);
    await expect(f.service.dispatch("request", plan)).resolves.toEqual({ status: "created", projectId: "vercel_project_fixture" });
    expect((await f.store.read({ authority: plan.origin.authority, appId: plan.appId }))?.state.stage).toBe("created");
  });

  it("does not reserve approval for another plan digest", async () => {
    const f = fixture();
    await f.service.approve("request", plan);
    const changed = nativeTargetAuthOnlyPlanSchema.parse({ ...plan, branch: "release" });
    await expect(f.service.dispatch("request", changed)).rejects.toThrow("native_target_auth_only_conflict");
    expect(f.createProject).not.toHaveBeenCalled();
  });

  it("reconciles an accepted project after uncertain readback without repeating create", async () => {
    const f = fixture();
    await f.service.approve("request", plan);
    f.makeUncertain();
    await expect(f.service.dispatch("request", plan)).resolves.toEqual({ status: "unknown", projectId: "vercel_project_fixture" });
    await expect(f.service.dispatch("request", plan)).resolves.toEqual({ status: "created", projectId: "vercel_project_fixture" });
    expect(f.createProject).toHaveBeenCalledTimes(1);
  });

  it("routes the hosted prepare action through owner approval and fenced dispatch", async () => {
    const f = fixture();
    const authority = plan.origin.authority;
    const ownerContext = {
      kind: "direct" as const, authority, adapterGeneration: 1, adapterSessionId: "native_original",
      sessionId: "public_original",
      principal: { audience: authority.audience, issuer: authority.issuer, ownerUserId: authority.ownerUserId, workspaceId: authority.workspaceId, scopes: ["autograph:operate"] },
    };
    const hostedDependencies = {
      authorize: vi.fn(), plan: vi.fn(), assertAuthorized: vi.fn(), readApproval: vi.fn(),
      withResourceLease: vi.fn(), reconcile: vi.fn(), executeEffect: vi.fn(), verify: vi.fn(),
      bindings: vi.fn(), store: {},
      nativeTargetRequest: async (_request: Request, raw: unknown) => {
        const request = raw as { action: string; input: { plan: typeof plan } };
        expect(request.action).toBe("native-target-auth-only-prepare");
        await f.service.approve("request", request.input.plan);
        const result = await f.service.dispatch("request", request.input.plan);
        return Response.json(result);
      },
    } as unknown as ProtectedHostedOperatorDependencies;
    const handler = createProtectedHostedOperatorHandler(hostedDependencies);
    const response = await handler(new Request("https://builder.example/v1/runtime", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "native-target-auth-only-prepare", ownerContext,
        adapterSessionId: "native_original", callId: "prepare_call",
        input: { appId: plan.appId, operationRef: nativeTargetAuthOnlyPlanDigest(plan), planDigest: nativeTargetAuthOnlyPlanDigest(plan), plan },
      }),
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "created", projectId: "vercel_project_fixture" });
    expect(f.createProject).toHaveBeenCalledTimes(1);
  });
});
