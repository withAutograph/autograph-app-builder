import { afterEach, describe, expect, it, vi } from "vitest";

import { renewBuilderHandoff } from "./handoff-renewal";

const id = "123e4567-e89b-42d3-a456-426614174001";
const renewedId = "123e4567-e89b-42d3-a456-426614174002";

const deployment = vi.hoisted(() => ({
  pageData: vi.fn(),
  renew: vi.fn(),
}));
const cache = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/cache", () => cache);
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers({ cookie: "session" })) }));
vi.mock("@/lib/auth/preview-oauth-runtime", () => ({
  readPreviewOAuthRuntimeConfig: vi.fn(() => ({ issuer: "https://builder.example" })),
}));
vi.mock("@/lib/handoff/deployment", () => ({
  getBuilderHandoffPageData: deployment.pageData,
  getBuilderHandoffRenewDeploymentHandler: deployment.renew,
}));

afterEach(() => {
  vi.clearAllMocks();
});

function handoff(overrides: Partial<{ handoffId: string; status: "prepared" | "continued" }> = {}) {
  return {
    version: 1 as const,
    handoffId: id,
    expiresAt: "2031-01-01T00:00:00.000Z",
    status: "prepared" as const,
    intent: {},
    destination: "codex" as const,
    cursorInstallReady: true,
    mcpUrl: "https://builder.example/mcp",
    ...overrides,
  };
}

describe("renewBuilderHandoff", () => {
  it("uses the authenticated deployment renewal boundary and returns a fresh typed handoff", async () => {
    const handler = vi.fn(async () =>
      Response.json({
        version: 1,
        handoffId: renewedId,
        expiresAt: "2031-01-01T00:00:00.000Z",
      }),
    );
    deployment.renew.mockReturnValue(handler);
    deployment.pageData.mockResolvedValue(handoff({ handoffId: renewedId, status: "continued" }));

    const result = await renewBuilderHandoff(undefined, {
      handoffId: id,
      creationRequestId: "123e4567-e89b-42d3-a456-426614174003",
    });

    expect(result).toEqual({
      status: "renewed",
      handoff: {
        version: 1,
        handoffId: renewedId,
        expiresAt: "2031-01-01T00:00:00.000Z",
        status: "continued",
        destination: "codex",
        cursorInstallReady: true,
        mcpUrl: "https://builder.example/mcp",
      },
    });
    const request = handler.mock.calls[0]?.[0] as Request;
    expect(request.method).toBe("POST");
    expect(request.headers.get("origin")).toBe("https://builder.example");
    await expect(request.json()).resolves.toEqual({
      creationRequestId: "123e4567-e89b-42d3-a456-426614174003",
    });
    expect(deployment.pageData).toHaveBeenCalledWith(
      expect.objectContaining({ handoffId: renewedId }),
    );
    expect(cache.refresh).toHaveBeenCalledOnce();
  });

  it.each([
    [401, "sign-in"],
    [403, "unavailable"],
    [404, "unavailable"],
    [503, "error"],
  ] as const)("maps renewal HTTP %s to the typed %s state", async (status, expected) => {
    deployment.renew.mockReturnValue(async () => new Response(null, { status }));

    await expect(
      renewBuilderHandoff(undefined, {
        handoffId: id,
        creationRequestId: "123e4567-e89b-42d3-a456-426614174003",
      }),
    ).resolves.toEqual({ status: expected });
    expect(deployment.pageData).not.toHaveBeenCalled();
  });

  it("rejects malformed client input before it reaches the renewal handler", async () => {
    await expect(
      renewBuilderHandoff(undefined, {
        handoffId: "not-a-uuid",
        creationRequestId: "123e4567-e89b-42d3-a456-426614174003",
      }),
    ).resolves.toEqual({ status: "error" });
    expect(deployment.renew).not.toHaveBeenCalled();
  });
});
