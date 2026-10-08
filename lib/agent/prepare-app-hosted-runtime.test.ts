import type { ToolInputRequest } from "eve/tools";
import type { OperatorPublicResult } from "../provisioning/hosted-operator-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareHostedRuntimeWithOperator,
  realmIdentityInputQuestion,
} from "../../agent/tools/prepare-app-hosted-runtime";
import {
  hostedOperatorPlanSchema,
  operatorPlanDigest,
} from "../provisioning/hosted-operator-contract";
import type { PreparedRuntimeSelection } from "./prepared-runtime-selection";

const plan = hostedOperatorPlanSchema.parse({
  access: [],
  action: "prepare",
  appDatabase: {
    database: "app_db",
    migratorRole: "app_migrator",
    resourceId: "app-resource",
    runtimeRole: "app_runtime",
  },
  authDatabase: {
    database: "auth_db",
    migratorRole: "auth_migrator",
    resourceId: "auth-resource",
    runtimeRole: "auth_runtime",
  },
  contextId: "context",
  cost: { class: "independent-service", description: "fixture", owner: "fixture" },
  deploymentBoundary: {
    app: {
      branch: "feature",
      deploymentId: "dpl_app",
      environment: "preview",
      projectId: "prj_app",
    },
    authority: {
      audience: "https://builder.example/mcp",
      issuer: "https://builder.example/api/auth",
      ownerUserId: "owner",
      workspaceId: "workspace",
    },
    gateway: {
      branch: "feature",
      deploymentId: "dpl_gateway",
      environment: "preview",
      projectId: "prj_gateway",
    },
    operator: { deploymentId: "dpl_operator", environment: "preview", projectId: "prj_operator" },
    teamId: "team_1",
    verification: {
      gatewayOrigin: "https://gateway.example",
      jwksUrl: "https://gateway.example/_platform/jwks.json",
      publicOrigin: "https://public.example",
    },
  },
  effects: [
    { description: "resources", id: "resources", kind: "resources" },
    { description: "install", id: "install", kind: "install" },
    { description: "access", id: "access", kind: "access" },
    { description: "bind", id: "bind", kind: "bindings" },
    { description: "Bind owned Gateway Auth.", id: "gateway-bindings", kind: "gateway-bindings" },
  ],
  gatewayBindings: {
    authBrowserOrigin: "https://auth.example.test",
    builderCallbackOrigin: "https://builder.example.test",
    catalogAppIds: ["spend-review"],
    operatorOrigin: "https://operator.example",
    sourceWorkload: {
      audience: "https://vercel.com/fixture",
      environment: "preview",
      issuer: "https://oidc.vercel.com/fixture",
      ownerId: "team",
      projectId: "prj_gateway",
      subject: "observed-fixture",
    },
  },
  installer: { reference: "installer", sha256: "a".repeat(64) },
  neon: {
    branchId: "branch",
    connectionRef: "private",
    endpoint: "ep-fixture.neon.tech",
    projectId: "project",
    source: "synthetic-only",
  },
  publicGateway: { branch: "feature", origin: "https://public.example", projectId: "prj_gateway" },
  release: { artifactRef: "release", id: "v19", sha256: "b".repeat(64) },
  retention: { expiresAt: "2027-01-01T00:00:00Z", policy: "fixture" },
  selection: {
    appId: "spend-review",
    branch: "feature",
    environment: "preview",
    projectId: "prj_app",
    sessionId: "public-session",
  },
  version: 1,
});

const operationRef = "00000000-0000-4000-8000-000000000001";
const input = { ...plan.selection, operationRef, plan, planDigest: operatorPlanDigest(plan) };
const order: string[] = [];
const operator = {
  authIdentityInput: vi.fn(async () => {
    order.push("identity");
    return await Promise.resolve({
      browserUrl: "https://auth.example/link",
      expiresAt: "2027-01-01T00:00:00Z",
      operationRef,
      sessionId: "public-session",
    });
  }),
  bindings: vi.fn(),
  request: vi.fn(async (): Promise<OperatorPublicResult> => {
    try {
      return await Promise.resolve({
        appId: "spend-review",
        authenticatedBehavior: "unassessed" as const,
        operationRef,
        status: "auth-schema-prepared" as const,
      });
    } finally {
      order.push("lease-released");
    }
  }),
  sessionId: "public-session",
};
const ctx = {
  abortSignal: new AbortController().signal,
  callId: "call",
  session: { id: "adapter-session" },
};
const retain = (selection: PreparedRuntimeSelection) => {
  order.push("selection");
  expect(selection).toEqual({
    appId: input.appId,
    branch: input.branch,
    operationRef,
    planDigest: input.planDigest,
    projectId: input.projectId,
    sessionId: "public-session",
  });
};
describe("hosted runtime Auth identity handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    order.length = 0;
  });
  it("requests the real client identity port after execution finally and durable selection", async () => {
    const value = await prepareHostedRuntimeWithOperator(input, ctx, operator, retain);
    expect(value.result.status).toBe("auth-schema-prepared");
    expect(value.identityInput?.browserUrl).toBe("https://auth.example/link");
    expect(order).toEqual(["lease-released", "selection", "identity"]);
    if (value.identityInput === null) {
      throw new Error("Missing actual identity input");
    }
    const ask = vi.fn(async (question: ToolInputRequest) => {
      order.push("public-input");
      expect(question.display).toBe("confirmation");
      expect(question.prompt).toContain(value.identityInput?.browserUrl ?? "missing");
      return await Promise.resolve({ optionId: "continue", status: "answered" as const });
    });
    await ask(realmIdentityInputQuestion(value.identityInput));
    expect(order).toEqual(["lease-released", "selection", "identity", "public-input"]);
    expect(operator.authIdentityInput).toHaveBeenCalledWith(
      { action: "auth-identity-input", operationRef, selection: plan.selection },
      ctx.abortSignal,
    );
  });
  it.each(["pending", "prepared", "blocked"] as const)(
    "does not request identity or resend execution for %s",
    async (status) => {
      operator.request.mockResolvedValueOnce({
        appId: input.appId,
        authenticatedBehavior: "unassessed",
        operationRef,
        status,
      });
      const value = await prepareHostedRuntimeWithOperator(input, ctx, operator, retain);
      expect(value.result.status).toBe(status);
      expect(operator.request).toHaveBeenCalledTimes(1);
      expect(operator.authIdentityInput).not.toHaveBeenCalled();
    },
  );
  it("retains bootstrap selection when readiness denies the link", async () => {
    operator.authIdentityInput.mockRejectedValueOnce(new Error("not ready"));
    const value = await prepareHostedRuntimeWithOperator(input, ctx, operator, retain);
    expect(value.result.status).toBe("blocked");
    expect(order).toEqual(["lease-released", "selection"]);
  });
});
