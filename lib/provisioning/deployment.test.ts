import { describe, expect, it, vi } from "vitest";

import { createBuilderProvisioningRouteHandler } from "./deployment";
import type { BuilderProvisioningDependencies } from "./service";

const origin = "https://builder.example.test";
const authority = {
  audience: `${origin}/mcp`,
  issuer: `${origin}/api/auth`,
  ownerUserId: "user-1",
  workspaceId: "workspace-1",
};
const request = {
  appName: "Vendor Portal",
  operation: "github",
  providers: { githubInstallationId: "101" },
  repository: { name: "vendor-portal", private: true },
  requestId: "123e4567-e89b-42d3-a456-426614174000",
  version: 1,
} as const;
const response = {
  appId: "vendor-portal",
  github: {
    code: "provider_rejected",
    retryable: true,
    status: "failed",
  },
  requestDigest: "a".repeat(64),
  requestId: request.requestId,
  status: "settled",
  updatedAt: "2026-08-30T12:00:00.000Z",
  vercel: { code: "not_selected", retryable: false, status: "skipped" },
  version: 1,
} as const;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function dependencies() {
  return { journal: {} } as BuilderProvisioningDependencies;
}

describe("authenticated builder provisioning route", () => {
  it("requires a same-origin JSON POST and fails closed with the feature flag", async () => {
    const execute = vi.fn();
    const handler = createBuilderProvisioningRouteHandler({
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      authorityForRequest: async () => authority,
      dependencies: dependencies(),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      enabled: async () => false,
      execute,
      origin,
      read: vi.fn(),
    });
    const disabled = await handler(
      new Request(`${origin}/api/builder/provision`, {
        body: JSON.stringify(request),
        headers: { "content-type": "application/json", origin },
        method: "POST",
      }),
    );
    expect(disabled.status).toBe(503);
    expect(await disabled.json()).toEqual({ error: "feature_disabled" });
    expect(execute).not.toHaveBeenCalled();

    const crossOrigin = await handler(
      new Request(`${origin}/api/builder/provision`, {
        body: JSON.stringify(request),
        headers: {
          "content-type": "application/json",
          origin: "https://attacker.example.test",
        },
        method: "POST",
      }),
    );
    expect(crossOrigin.status).toBe(400);
  });

  it("returns only the closed provisioning response and tenant-scoped read-back", async () => {
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const execute = vi.fn(async () => response);
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const read = vi.fn(async () => response);
    const handler = createBuilderProvisioningRouteHandler({
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      authorityForRequest: async () => authority,
      dependencies: dependencies(),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      enabled: async () => true,
      execute,
      origin,
      read,
    });
    const created = await handler(
      new Request(`${origin}/api/builder/provision`, {
        body: JSON.stringify(request),
        headers: { "content-type": "application/json", origin },
        method: "POST",
      }),
    );
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual(response);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ authority, request }));

    const recovered = await handler(
      new Request(`${origin}/api/builder/provision?requestId=${request.requestId}`),
    );
    expect(recovered.status).toBe(200);
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ authority, requestId: request.requestId }),
    );
    expect(JSON.stringify(await recovered.json())).not.toMatch(/token|authorization/iu);
  });

  it("exposes a monotonic journal projection only to an authenticated reader", async () => {
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const read = vi.fn(async () => ({
      record: { response },
      revision: 7,
    }));
    const handler = createBuilderProvisioningRouteHandler({
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      authorityForRequest: async () => authority,
      dependencies: {
        journal: { read },
      } as unknown as BuilderProvisioningDependencies,
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      enabled: async () => true,
      execute: vi.fn(),
      origin,
      read: vi.fn(),
    });

    const projection = await handler(
      new Request(`${origin}/api/builder/provision?projection=1&requestId=${request.requestId}`),
    );

    expect(projection.status).toBe(200);
    expect(await projection.json()).toEqual({
      provisioning: response,
      revision: 7,
    });
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ authority, requestId: request.requestId }),
    );
  });

  it("reserves a durable journal before the provider operation begins", async () => {
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const reserve = vi.fn(async () => ({ record: { response } }));
    const handler = createBuilderProvisioningRouteHandler({
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      authorityForRequest: async () => authority,
      dependencies: {
        journal: { reserve },
      } as unknown as BuilderProvisioningDependencies,
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      enabled: async () => true,
      execute: vi.fn(),
      origin,
      read: vi.fn(),
    });

    const reserved = await handler(
      new Request(`${origin}/api/builder/provision?mode=reserve`, {
        body: JSON.stringify(request),
        headers: { "content-type": "application/json", origin },
        method: "POST",
      }),
    );

    expect(reserved.status).toBe(200);
    expect(await reserved.json()).toEqual(response);
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ authority, request }));
  });

  it("does not disclose internal failures", async () => {
    const handler = createBuilderProvisioningRouteHandler({
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      authorityForRequest: async () => authority,
      dependencies: dependencies(),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      enabled: async () => true,
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      execute: vi.fn(async () => {
        throw new Error("Bearer super-secret provider response");
      }),
      origin,
      read: vi.fn(),
    });
    const failed = await handler(
      new Request(`${origin}/api/builder/provision`, {
        body: JSON.stringify(request),
        headers: { "content-type": "application/json", origin },
        method: "POST",
      }),
    );
    expect(await failed.json()).toEqual({ error: "provisioning_unavailable" });
  });
});
