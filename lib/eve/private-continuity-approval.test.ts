import { describe, expect, it } from "vitest";
import type { MessageStreamEvent } from "eve/client";
import { hostedOperatorPlanSchema } from "../provisioning/hosted-operator-contract";
import type { HostedOperatorContext } from "../provisioning/hosted-operator-service";
import {
  hostedContinuityPlanSchema,
  continuityPlanDigest,
} from "../provisioning/hosted-operator-continuity-contract";
import { createPrivateContinuityApprovalCapture } from "./private-continuity-approval";

const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace",
  ownerUserId: "owner",
};
const context: HostedOperatorContext = {
  authority,
  target: {
    appId: "orchard",
    branch: "preview",
    environment: "preview",
    projectId: "app-project",
    sessionId: "saved-session",
    installationId: "installation",
    scopeId: "team",
    scopeType: "team",
  },
};
const preparedPlan = hostedOperatorPlanSchema.parse({
  version: 1,
  action: "prepare",
  access: [{ actorId: "actor-one", organizationId: "organization-one", roles: ["custom_role"] }],
  appDatabase: {
    database: "app_db",
    migratorRole: "app_migrator",
    runtimeRole: "app_runtime",
    resourceId: "app-resource",
  },
  authDatabase: {
    database: "auth_db",
    migratorRole: "auth_migrator",
    runtimeRole: "auth_runtime",
    resourceId: "auth-resource",
  },
  contextId: "ordinary-planning-context",
  cost: { class: "shared-recovery-group", description: "Controlled fixture", owner: "Fixture" },
  effects: [
    { id: "resources", kind: "resources", description: "Prepare resources" },
    { id: "install", kind: "install", description: "Install app" },
    { id: "access", kind: "access", description: "Authorize app" },
    { id: "bindings", kind: "bindings", description: "Bind runtime" },
  ],
  installer: { reference: "shared-installer", sha256: "a".repeat(64) },
  neon: {
    branchId: "branch",
    connectionRef: "private-connection",
    endpoint: "ep-controlled.us-east-1.aws.neon.tech",
    projectId: "database-project",
    source: "synthetic-only",
  },
  release: { artifactRef: "retained-app-release", id: "app-release", sha256: "b".repeat(64) },
  retention: { expiresAt: "2027-01-01T00:00:00.000Z", policy: "Original retention" },
  selection: {
    appId: context.target.appId,
    branch: context.target.branch,
    environment: "preview",
    projectId: context.target.projectId,
    sessionId: context.target.sessionId,
  },
});
const selection = {
  version: 1 as const,
  kind: "app-continuity-plan" as const,
  authority,
  target: context.target,
  originalSetup: {
    operationRef: "10000000-0000-4000-8000-000000000001",
    planDigest: "c".repeat(64),
    approvalId: "setup-human",
    approvedByCallId: "setup-call",
  },
  preparedPlan,
  runtime: {
    sandboxId: "owned-sandbox",
    root: "/controlled/source",
    projectId: "builder-project",
    ownerId: "team",
    appPort: 3000,
    bridgePort: 3100,
  },
  gateway: {
    projectId: "gateway-project",
    ownerId: "team",
    environment: "preview" as const,
    publicOrigin: "https://gateway.example",
  },
  actors: [{ actorId: "actor-one", organizationId: "organization-one" }],
};
const makePlan = () =>
  hostedContinuityPlanSchema.parse({
    ...selection,
    intentId: "20000000-0000-4000-8000-000000000002",
    planRef: "_protected-operator/continuity-plans/20000000-0000-4000-8000-000000000002",
  });

const plan = makePlan();
const request = {
  action: "continuity" as const,
  planRef: plan.planRef,
  planDigest: continuityPlanDigest(plan),
  idempotencyKey: "request",
};
const toolInput = { ...request, plan };
const requested = (
  options: { toolName?: string; callId?: string; toolInput?: typeof toolInput } = {},
): MessageStreamEvent => ({
  type: "input.requested",
  meta: { at: "2026-10-20T00:00:00Z", id: "request-event" },
  data: {
    sequence: 1,
    stepIndex: 0,
    turnId: "turn",
    requests: [
      {
        kind: "tool-approval",
        requestId: "human-request",
        prompt: "Approve this managed continuity run",
        action: {
          kind: "tool-call",
          toolName: options.toolName ?? "run-app-continuity-tests",
          callId: options.callId ?? "continuity-call",
          input: options.toolInput ?? toolInput,
        },
      },
    ],
  },
});
const settled = (
  owner = authority.ownerUserId,
  outcome: "approved" | "cancelled" = "approved",
  requestId = "human-request",
): MessageStreamEvent => ({
  type: "approval.settled",
  meta: { at: "2026-10-20T00:00:01Z", id: "settled-event" },
  data: {
    sequence: 2,
    stepIndex: 0,
    turnId: "turn",
    requestId,
    responderPrincipalId: owner,
    outcome,
  },
});
const capture = () =>
  createPrivateContinuityApprovalCapture({
    plan,
    request,
    principal: { ...authority, scopes: ["autograph:send"] },
    callId: "continuity-call",
  });
describe("native private managed continuity approval", () => {
  it("requires an exact authored request followed by its authenticated owner settlement", () => {
    const reader = capture();
    reader.observe(settled());
    expect(reader.read()).toBeNull();
    reader.observe(requested());
    expect(reader.read()).toBeNull();
    reader.observe(settled());
    expect(reader.read()).toEqual({
      ...request,
      approvalId: "human-request",
      approvedByCallId: "continuity-call",
    });
  });
  it.each([
    "foreign owner",
    "cancelled",
    "wrong tool",
    "wrong call",
    "wrong request",
    "changed intent",
    "changed plan",
    "changed digest",
    "different setup",
  ])("does not accept %s as continuity authority", (failure) => {
    const reader = capture();
    const changed = structuredClone(toolInput);
    if (failure === "changed intent") {
      changed.idempotencyKey = "other-request";
    }
    if (failure === "changed plan") {
      changed.plan.actors[0] = { actorId: "other-actor", organizationId: "other-organization" };
      changed.planDigest = continuityPlanDigest(changed.plan);
    }
    if (failure === "changed digest") {
      changed.planDigest = "e".repeat(64);
    }
    if (failure === "different setup") {
      changed.plan.originalSetup.operationRef = "70000000-0000-4000-8000-000000000007";
      changed.planDigest = continuityPlanDigest(changed.plan);
    }
    reader.observe(
      requested({
        toolName: failure === "wrong tool" ? "prepare-app-hosted-runtime" : undefined,
        callId: failure === "wrong call" ? "different-call" : undefined,
        toolInput: changed,
      }),
    );
    reader.observe(
      settled(
        failure === "foreign owner" ? "foreign" : authority.ownerUserId,
        failure === "cancelled" ? "cancelled" : "approved",
        failure === "wrong request" ? "other-request" : "human-request",
      ),
    );
    expect(reader.read()).toBeNull();
  });
  it("retains cancellation even if an approval event is later replayed", () => {
    const reader = capture();
    reader.observe(requested());
    reader.observe(settled(authority.ownerUserId, "cancelled"));
    reader.observe(settled());
    expect(reader.read()).toBeNull();
  });
});
