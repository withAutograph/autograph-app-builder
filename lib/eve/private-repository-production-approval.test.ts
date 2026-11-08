import { describe, expect, it, vi } from "vitest";
import type { MessageStreamEvent } from "eve/client";
import { repositoryProductionApprovalInput } from "../provisioning/repository-production-approval";
import type {
  RepositoryProductionIntent,
  RepositoryProductionScope,
} from "../provisioning/repository-production-contract";
import {
  deriveInstalledEveStatus,
  outstandingInstalledEveRequests,
  projectInstalledEveEvent,
} from "./public-events";
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
  it.each(["postgres", "none"] as const)(
    "shows the ordinary setup approval for %s without treating the card as consent",
    (storageKind) => {
      const setupPlan = repositoryProductionApprovalInput(scope, {
        ...intent,
        storage: storageKind === "none" ? { kind: "none" } : intent.storage,
      });
      const pending = request(setupPlan);
      const projected = projectInstalledEveEvent(pending, 0);
      expect(projected).toMatchObject([
        {
          request: {
            kind: "approval",
            requestId: "request",
          },
          type: "input.requested",
        },
      ]);
      const [publicRequest] = outstandingInstalledEveRequests([pending]);
      expect(publicRequest?.description).toContain(scope.appId);
      expect(publicRequest?.description).toContain(scope.repositoryFullName);
      expect(publicRequest?.description).toContain(
        storageKind === "postgres" ? "database and keeps it" : "does not need a database",
      );
      expect(deriveInstalledEveStatus([pending])).toBe("input_required");
      expect(JSON.stringify(projected)).not.toContain(scope.authority.ownerUserId);
      expect(JSON.stringify(projected)).not.toContain(intent.sessionId);
      const capture = createPrivateRepositoryProductionApprovalCapture({
        callId: "call",
        plan: setupPlan,
      });
      capture.observe(pending);
      expect(capture.read()).toBeNull();
      capture.observe(settle());
      expect(capture.read()).toEqual({ approvalId: "request", approvedByCallId: "call" });
      expect(outstandingInstalledEveRequests([pending, settle()])).toEqual([]);
    },
  );
  it.each([
    { ...plan, scope: null },
    { ...plan, intent: { ...intent, creatorRoles: null } },
    { ...plan, intent: { ...intent, storage: { kind: "unsupported" } } },
  ])("keeps an unreadable setup confirmation closed", (invalidPlan) => {
    const pending = request();
    if (pending.type !== "input.requested") {
      throw new Error("Expected the approval request");
    }
    const [approval] = pending.data.requests;
    if (approval.kind !== "tool-approval") {
      throw new Error("Expected the tool approval");
    }
    approval.action.input = invalidPlan;
    expect(projectInstalledEveEvent(pending, 0)).toMatchObject([
      { code: "confirmation_unavailable", type: "error.public" },
      { status: "failed", type: "status" },
    ]);
    expect(outstandingInstalledEveRequests([pending])).toEqual([]);
    expect(deriveInstalledEveStatus([pending])).toBe("failed");
    const capture = createPrivateRepositoryProductionApprovalCapture({ callId: "call", plan });
    capture.observe(pending);
    capture.observe(settle());
    expect(capture.read()).toBeNull();
  });
  it("shows the selected creator account and binds it to the actual setup approval", () => {
    const selected = repositoryProductionApprovalInput(scope, {
      ...intent,
      creatorEmail: "app@example.com",
    });
    const [card] = outstandingInstalledEveRequests([request(selected)]);
    expect(card?.description).toContain("app@example.com");
    const capture = createPrivateRepositoryProductionApprovalCapture({
      callId: "call",
      plan: selected,
    });
    capture.observe(request(selected));
    capture.observe(settle());
    expect(capture.read()).toMatchObject({ approvedByCallId: "call" });
    expect(selected.planDigest).not.toBe(plan.planDigest);
  });
  it("accepts the actual creator settlement for the current setup call", () => {
    const capture = createPrivateRepositoryProductionApprovalCapture({ callId: "call", plan });
    capture.observe(request());
    expect(capture.read()).toBeNull();
    capture.observe(settle());
    expect(capture.read()).toEqual({ approvalId: "request", approvedByCallId: "call" });
  });
  it.each([
    "organization",
    "recipient",
    "role",
    "schema",
    "storage",
    "session",
    "old-call",
    "actor",
    "cancelled",
  ])("rejects changed or unauthorised %s", (variation) => {
    const changedScope = { ...scope };
    if (variation === "organization") {
      changedScope.organizationId = "other";
    }
    const changedIntent: RepositoryProductionIntent = { ...intent };
    if (variation === "recipient") {
      changedIntent.creatorEmail = "app@example.com";
    }
    if (variation === "role") {
      changedIntent.creatorRoles = ["admin"];
    }
    if (variation === "session") {
      changedIntent.sessionId = "other";
    }
    if (variation === "storage") {
      changedIntent.storage = { kind: "none" };
    }
    if (variation === "schema" && intent.storage.kind === "postgres") {
      changedIntent.storage = { ...intent.storage, manifestSha256: "c".repeat(64) };
    }
    const capture = createPrivateRepositoryProductionApprovalCapture({ callId: "call", plan });
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
      // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
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
