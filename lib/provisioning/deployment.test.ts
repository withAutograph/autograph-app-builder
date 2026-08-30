import { describe, expect, it, vi } from "vitest";

import { createBuilderProvisioningRouteHandler } from "./deployment";
import type { BuilderProvisioningDependencies } from "./service";

const origin = "https://builder.example.test";
const authority = {
  issuer: `${origin}/api/auth`,
  audience: `${origin}/mcp`,
  workspaceId: "workspace-1",
  ownerUserId: "user-1",
};
const request = {
  version: 1,
  requestId: "123e4567-e89b-42d3-a456-426614174000",
  operation: "github",
  appName: "Vendor Portal",
  repository: { name: "vendor-portal", private: true },
  providers: { githubInstallationId: "101" },
} as const;
const response = {
  version: 1,
  requestId: request.requestId,
  requestDigest: "a".repeat(64),
  appId: "vendor-portal",
  status: "settled",
  github: {
    status: "failed",
    code: "provider_rejected",
    retryable: true,
  },
  vercel: { status: "skipped", code: "not_selected", retryable: false },
  updatedAt: "2026-08-30T12:00:00.000Z",
} as const;

function dependencies() {
  return { journal: {} } as BuilderProvisioningDependencies;
}

describe("authenticated builder provisioning route", () => {
  it("requires a same-origin JSON POST and fails closed with the feature flag", async () => {
    const execute = vi.fn();
    const handler = createBuilderProvisioningRouteHandler({
      origin,
      enabled: async () => false,
      authorityForRequest: async () => authority,
      execute,
      read: vi.fn(),
      dependencies: dependencies(),
    });
    const disabled = await handler(
      new Request(`${origin}/api/builder/provision`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(request),
      }),
    );
    expect(disabled.status).toBe(503);
    expect(await disabled.json()).toEqual({ error: "feature_disabled" });
    expect(execute).not.toHaveBeenCalled();

    const crossOrigin = await handler(
      new Request(`${origin}/api/builder/provision`, {
        method: "POST",
        headers: {
          origin: "https://attacker.example.test",
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
      }),
    );
    expect(crossOrigin.status).toBe(400);
  });

  it("returns only the closed provisioning response and tenant-scoped read-back", async () => {
    const execute = vi.fn(async () => response);
    const read = vi.fn(async () => response);
    const handler = createBuilderProvisioningRouteHandler({
      origin,
      enabled: async () => true,
      authorityForRequest: async () => authority,
      execute,
      read,
      dependencies: dependencies(),
    });
    const created = await handler(
      new Request(`${origin}/api/builder/provision`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(request),
      }),
    );
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual(response);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ authority, request }),
    );

    const recovered = await handler(
      new Request(
        `${origin}/api/builder/provision?requestId=${request.requestId}`,
      ),
    );
    expect(recovered.status).toBe(200);
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ authority, requestId: request.requestId }),
    );
    expect(JSON.stringify(await recovered.json())).not.toMatch(
      /token|authorization/iu,
    );
  });

  it("does not disclose internal failures", async () => {
    const handler = createBuilderProvisioningRouteHandler({
      origin,
      enabled: async () => true,
      authorityForRequest: async () => authority,
      execute: vi.fn(async () => {
        throw new Error("Bearer super-secret provider response");
      }),
      read: vi.fn(),
      dependencies: dependencies(),
    });
    const failed = await handler(
      new Request(`${origin}/api/builder/provision`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(request),
      }),
    );
    expect(await failed.json()).toEqual({ error: "provisioning_unavailable" });
  });
});
