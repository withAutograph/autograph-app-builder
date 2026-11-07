import { expect, it, vi } from "vitest";

import { createNativeTargetAuthOnlyPreviewDelivery } from "./native-target-auth-only-preview-delivery";
import type { NativeTargetAuthOnlyPreviewDeliveryInput } from "./native-target-auth-only-preview-delivery";

const authority = {
  issuer: "https://builder.example.test",
  audience: "autograph-operator",
  workspaceId: "workspace-1",
  ownerUserId: "owner-1",
};
const sha = "a".repeat(40);
const approvedPlanDigest = "b".repeat(64);
const deploymentId = "dpl_auth_only_preview";

const input = (
  checkpointDelivery: NativeTargetAuthOnlyPreviewDeliveryInput["checkpointDelivery"],
  assertCurrent: () => Promise<void>,
): NativeTargetAuthOnlyPreviewDeliveryInput => ({
  authority,
  target: {
    appId: "signup-pilot",
    branch: "preview",
    environment: "preview",
    installationId: "installation-1",
    projectId: "project-auth-only",
    scopeId: "team-1",
    scopeType: "team",
    sessionId: "session-1",
  },
  approvedPlanDigest,
  approval: {
    requestId: "request-auth-only",
    callId: "call-auth-only",
    planDigest: approvedPlanDigest,
    sourceDigest: "c".repeat(64),
    responderPrincipalId: "owner-1",
    publicSessionId: "session-1",
    outcome: "approved",
    observedAt: "2026-11-06T12:00:00.000Z",
  },
  operationRef: "11111111-1111-4111-a111-111111111111",
  fenceGeneration: 4,
  effectId: "auth-preview-delivery",
  plan: {
    action: "prepare",
    stage: "app",
    effects: [{ id: "auth-preview-delivery", kind: "delivery" }],
    delivery: {
      branch: "preview",
      gitSha: sha,
      projectId: "project-auth-only",
      repoId: "repo-1",
    },
  },
  checkpointDelivery,
  assertCurrent,
});

it("reconciles a retained Auth-only Preview candidate using the exact approved digest and current fence", async () => {
  const assertCurrent = vi.fn(async () => {});
  const checkpointDelivery = vi.fn(async () => {});
  const requests: string[] = [];
  const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(input instanceof URL ? input : String(input));
    requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/v7/deployments") {
      return Response.json({
        deployments: [
          {
            uid: deploymentId,
            meta: {
              autograph_operator_effect: "auth-preview-delivery",
              autograph_operator_operation: "11111111-1111-4111-a111-111111111111",
              autograph_operator_plan: approvedPlanDigest,
            },
          },
        ],
      });
    }
    if (url.pathname === `/v13/deployments/${deploymentId}`) {
      return Response.json({
        id: deploymentId,
        projectId: "project-auth-only",
        ownerId: "team-1",
        readyState: "READY",
        target: null,
        url: "signup-pilot-preview.example.test",
        gitSource: { ref: "preview", repoId: "repo-1", sha, type: "github" },
        meta: {
          autograph_operator_effect: "auth-preview-delivery",
          autograph_operator_operation: "11111111-1111-4111-a111-111111111111",
          autograph_operator_plan: approvedPlanDigest,
        },
      });
    }
    if (url.pathname === "/v9/projects/project-auth-only") {
      return Response.json({
        id: "project-auth-only",
        accountId: "team-1",
        link: { repoId: "repo-1", type: "github" },
        name: "signup-pilot",
      });
    }
    if (url.pathname === "/v2/teams/team-1") return Response.json({ id: "team-1", slug: "team" });
    throw new Error(`Unexpected fake provider path: ${url.pathname}`);
  });
  const delivery = createNativeTargetAuthOnlyPreviewDelivery({
    readCredential: async () => ({
      token: "fake-token",
      binding: {
        active: true,
        displayName: "Owner",
        installationId: "installation-1",
        plan: "hobby",
        scopeId: "team-1",
        scopeType: "team",
        slug: "team",
        updatedAt: new Date("2026-11-06T00:00:00.000Z"),
      },
    }),
    assertEnvironment: async () => {},
    fetch: fetch as typeof globalThis.fetch,
  });

  const result = await delivery.deliver(input(checkpointDelivery, assertCurrent));

  expect(result.status).toBe("applied");
  if (result.status !== "applied")
    throw new Error("Expected the retained Preview candidate to reconcile as applied.");
  expect(result.selected.deploymentId).toBe(deploymentId);
  expect(result.selected.projectId).toBe("project-auth-only");
  expect(assertCurrent).toHaveBeenCalled();
  expect(checkpointDelivery).toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ method: "POST" }),
  );
  expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
  expect("appDatabase" in input(checkpointDelivery, assertCurrent).plan).toBe(false);
});

it("does not read or create a Preview deployment while the Auth-only approval is pending", async () => {
  const fetch = vi.fn(async () => Response.json({ deployments: [] }));
  const delivery = createNativeTargetAuthOnlyPreviewDelivery({
    readCredential: async () => ({
      token: "fake-token",
      binding: {
        active: true,
        displayName: "Owner",
        installationId: "installation-1",
        plan: "hobby",
        scopeId: "team-1",
        scopeType: "team",
        slug: "team",
        updatedAt: new Date("2026-11-06T00:00:00.000Z"),
      },
    }),
    assertEnvironment: async () => {},
    fetch: fetch as typeof globalThis.fetch,
  });
  const pending = input(
    async () => {},
    async () => {},
  );
  pending.approval.outcome = "cancelled";

  await expect(delivery.deliver(pending)).rejects.toThrow("resource_mismatch");
  expect(fetch).not.toHaveBeenCalled();
});
