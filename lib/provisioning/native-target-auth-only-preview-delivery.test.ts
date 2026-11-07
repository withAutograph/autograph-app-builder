import { expect, it, vi } from "vitest";

import { createNativeTargetAuthOnlyPreviewDelivery } from "./native-target-auth-only-preview-delivery";
import type { NativeTargetAuthOnlyPreviewDeliveryInput } from "./native-target-auth-only-preview-delivery";

type DeliveryPorts = Parameters<typeof createNativeTargetAuthOnlyPreviewDelivery>[0];
const authority = {
  audience: "autograph-operator",
  issuer: "https://builder.example.test",
  ownerUserId: "owner-1",
  workspaceId: "workspace-1",
};
const sha = "a".repeat(40);
const approvedPlanDigest = "b".repeat(64);
const deploymentId = "dpl_auth_only_preview";

const input = (
  checkpointDelivery: NativeTargetAuthOnlyPreviewDeliveryInput["checkpointDelivery"],
  assertCurrent: () => Promise<void>,
): NativeTargetAuthOnlyPreviewDeliveryInput => ({
  approval: {
    callId: "call-auth-only",
    observedAt: "2026-11-06T12:00:00.000Z",
    outcome: "approved",
    planDigest: approvedPlanDigest,
    publicSessionId: "session-1",
    requestId: "request-auth-only",
    responderPrincipalId: "owner-1",
    sourceDigest: "c".repeat(64),
  },
  approvedPlanDigest,
  assertCurrent,
  authority,
  checkpointDelivery,
  effectId: "auth-preview-delivery",
  fenceGeneration: 4,
  operationRef: "11111111-1111-4111-a111-111111111111",
  plan: {
    action: "prepare",
    delivery: {
      branch: "preview",
      gitSha: sha,
      projectId: "project-auth-only",
      repoId: "repo-1",
    },
    effects: [{ id: "auth-preview-delivery", kind: "delivery" }],
    stage: "app",
  },
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
});

it("reconciles a retained Auth-only Preview candidate using the exact approved digest and current fence", async () => {
  const assertCurrent = vi.fn(async () => {});
  const checkpointDelivery = vi.fn(async () => {});
  const requests: string[] = [];
  const providerFetch = vi.fn<typeof globalThis.fetch>((request, init) => {
    const url = new URL(request instanceof Request ? request.url : request);
    requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/v7/deployments") {
      return Promise.resolve(
        Response.json({
          deployments: [
            {
              meta: {
                autograph_operator_effect: "auth-preview-delivery",
                autograph_operator_operation: "11111111-1111-4111-a111-111111111111",
                autograph_operator_plan: approvedPlanDigest,
              },
              uid: deploymentId,
            },
          ],
        }),
      );
    }
    if (url.pathname === `/v13/deployments/${deploymentId}`) {
      return Promise.resolve(
        Response.json({
          gitSource: { ref: "preview", repoId: "repo-1", sha, type: "github" },
          id: deploymentId,
          meta: {
            autograph_operator_effect: "auth-preview-delivery",
            autograph_operator_operation: "11111111-1111-4111-a111-111111111111",
            autograph_operator_plan: approvedPlanDigest,
          },
          ownerId: "team-1",
          projectId: "project-auth-only",
          readyState: "READY",
          target: null,
          url: "signup-pilot-preview.example.test",
        }),
      );
    }
    if (url.pathname === "/v9/projects/project-auth-only") {
      return Promise.resolve(
        Response.json({
          accountId: "team-1",
          id: "project-auth-only",
          link: { repoId: "repo-1", type: "github" },
          name: "signup-pilot",
        }),
      );
    }
    if (url.pathname === "/v2/teams/team-1") {
      return Promise.resolve(Response.json({ id: "team-1", slug: "team" }));
    }
    return Promise.reject(new Error(`Unexpected fake provider path: ${url.pathname}`));
  });
  const delivery = createNativeTargetAuthOnlyPreviewDelivery({
    assertEnvironment: async () => {},
    fetch: providerFetch,
    readCredential: vi.fn<DeliveryPorts["readCredential"]>(() =>
      Promise.resolve({
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
    ),
  });

  const result = await delivery.deliver(input(checkpointDelivery, assertCurrent));

  expect(result.status).toBe("applied");
  if (result.status !== "applied") {
    throw new Error("Expected the retained Preview candidate to reconcile as applied.");
  }
  expect(result.selected.deploymentId).toBe(deploymentId);
  expect(result.selected.projectId).toBe("project-auth-only");
  expect(assertCurrent).toHaveBeenCalled();
  expect(checkpointDelivery).toHaveBeenCalled();
  expect(providerFetch).not.toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ method: "POST" }),
  );
  expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
  expect("appDatabase" in input(checkpointDelivery, assertCurrent).plan).toBe(false);
});

it("does not read or create a Preview deployment while the Auth-only approval is pending", async () => {
  const providerFetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(Response.json({ deployments: [] }));
  const delivery = createNativeTargetAuthOnlyPreviewDelivery({
    assertEnvironment: async () => {},
    fetch: providerFetch,
    readCredential: vi.fn<DeliveryPorts["readCredential"]>(() =>
      Promise.resolve({
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
    ),
  });
  const pending = input(
    async () => {},
    async () => {},
  );
  pending.approval.outcome = "cancelled";

  await expect(delivery.deliver(pending)).rejects.toThrow("resource_mismatch");
  expect(providerFetch).not.toHaveBeenCalled();
});
