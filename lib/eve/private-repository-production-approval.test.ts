import { describe, expect, it, vi } from "vitest";
import type { MessageStreamEvent } from "eve/client";
import { repositoryProductionApprovalInput } from "../provisioning/repository-production-approval";
import type {
  RepositoryProductionIntent,
  RepositoryProductionScope,
} from "../provisioning/repository-production-contract";
import {
  createPrivateRepositoryProductionApprovalCapture,
  readRepositoryProductionApproval,
} from "./private-repository-production-approval";

const scope: RepositoryProductionScope = {
  authority: {
    issuer: "https://builder.example/api/auth",
    audience: "https://builder.example/mcp",
    workspaceId: "workspace",
    ownerUserId: "creator",
  },
  appId: "example",
  repositoryId: "repo",
  repositoryFullName: "owner/repo",
  projectId: "project",
  organizationId: "org",
  publicOrigin: "https://apps.example",
  environment: "production",
};
const intent: RepositoryProductionIntent = {
  sessionId: "session",
  sourceSha: "a".repeat(40),
  creatorRoles: ["editor"],
  storage: {
    kind: "postgres",
    releaseId: "release",
    artifactRef: "artifact",
    manifestSha256: "b".repeat(64),
    databaseEnvironment: "APP_DATABASE_URL",
  },
};
const plan = repositoryProductionApprovalInput(scope, intent);
const request = (value = plan, callId = "call"): MessageStreamEvent => ({
  type: "input.requested",
  meta: { at: "2026-11-06T00:00:00Z", id: "request-event" },
  data: {
    sequence: 1,
    stepIndex: 0,
    turnId: "turn",
    requests: [
      {
        kind: "tool-approval",
        requestId: "request",
        prompt: "Set up this app?",
        action: { kind: "tool-call", toolName: "prepare-app-production", callId, input: value },
      },
    ],
  },
});
const settle = (
  actor = "creator",
  outcome: "approved" | "cancelled" = "approved",
): MessageStreamEvent => ({
  type: "approval.settled",
  meta: { at: "2026-11-06T00:00:01Z", id: "settlement" },
  data: {
    sequence: 2,
    stepIndex: 0,
    turnId: "turn",
    requestId: "request",
    responderPrincipalId: actor,
    outcome,
  },
});
describe("Production setup consent", () => {
  it("accepts the actual creator settlement for the current setup call", () => {
    const capture = createPrivateRepositoryProductionApprovalCapture({ plan, callId: "call" });
    capture.observe(request());
    expect(capture.read()).toBeNull();
    capture.observe(settle());
    expect(capture.read()).toEqual({ approvalId: "request", approvedByCallId: "call" });
  });
  it.each([
    "organization",
    "role",
    "schema",
    "storage",
    "session",
    "old-call",
    "actor",
    "cancelled",
  ])("rejects changed or unauthorised %s", (variation) => {
    const changedScope = {
      ...scope,
      ...(variation === "organization" ? { organizationId: "other" } : {}),
    };
    const changedIntent = {
      ...intent,
      ...(variation === "role" ? { creatorRoles: ["admin"] } : {}),
      ...(variation === "session" ? { sessionId: "other" } : {}),
      ...(variation === "storage" ? { storage: { kind: "none" as const } } : {}),
      ...(variation === "schema" && intent.storage.kind === "postgres"
        ? { storage: { ...intent.storage, manifestSha256: "c".repeat(64) } }
        : {}),
    };
    const capture = createPrivateRepositoryProductionApprovalCapture({ plan, callId: "call" });
    capture.observe(
      request(
        repositoryProductionApprovalInput(changedScope, changedIntent),
        variation === "old-call" ? "old" : "call",
      ),
    );
    capture.observe(
      settle(
        variation === "actor" ? "other" : "creator",
        variation === "cancelled" ? "cancelled" : "approved",
      ),
    );
    expect(capture.read()).toBeNull();
  });
  it("keeps resource consent stable when only the source commit changes", () => {
    expect(
      repositoryProductionApprovalInput(scope, { ...intent, sourceSha: "f".repeat(40) }).planDigest,
    ).toBe(plan.planDigest);
  });
  it("does not treat a partial history as settled consent", async () => {
    const assertOwner = vi.fn(async () => {});
    const result = readRepositoryProductionApproval({
      plan,
      callId: "call",
      owner: {
        kind: "direct",
        authority: scope.authority,
        principal: { ...scope.authority, scopes: ["autograph:send"] },
        sessionId: "session",
        adapterSessionId: "native",
        adapterGeneration: 1,
      },
      assertOwner,
      readHistory: (_start, observe) => {
        observe(request());
        observe(settle());
        return Promise.resolve({ complete: false, nextNativeIndex: 2, nativeTailIndex: 2 });
      },
    });
    await expect(result).rejects.toThrow("complete durable tail");
    expect(assertOwner).toHaveBeenCalled();
  });
});
