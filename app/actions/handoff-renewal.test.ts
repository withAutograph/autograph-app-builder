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
// oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
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

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function handoff(overrides: Partial<{ handoffId: string; status: "prepared" | "continued" }> = {}) {
  return {
    cursorInstallReady: true,
    destination: "codex" as const,
    expiresAt: "2031-01-01T00:00:00.000Z",
    handoffId: id,
    intent: {},
    mcpUrl: "https://builder.example/mcp",
    status: "prepared" as const,
    version: 1 as const,
    ...overrides,
  };
}

describe("renewBuilderHandoff", () => {
  it("uses the authenticated deployment renewal boundary and returns a fresh typed handoff", async () => {
    let receivedRequest: Request | undefined;
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const handler = vi.fn(async (request: Request) => {
      receivedRequest = request;
      return Response.json({
        expiresAt: "2031-01-01T00:00:00.000Z",
        handoffId: renewedId,
        version: 1,
      });
    });
    deployment.renew.mockReturnValue(handler);
    deployment.pageData.mockResolvedValue(handoff({ handoffId: renewedId, status: "continued" }));

    const result = await renewBuilderHandoff(undefined, {
      creationRequestId: "123e4567-e89b-42d3-a456-426614174003",
      handoffId: id,
    });

    expect(result).toEqual({
      handoff: {
        cursorInstallReady: true,
        destination: "codex",
        expiresAt: "2031-01-01T00:00:00.000Z",
        handoffId: renewedId,
        mcpUrl: "https://builder.example/mcp",
        status: "continued",
        version: 1,
      },
      status: "renewed",
    });
    expect(receivedRequest).toBeDefined();
    if (!receivedRequest) {
      throw new Error("Expected renewal handler to receive a request");
    }
    const request = receivedRequest;
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
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    deployment.renew.mockReturnValue(async () => new Response(null, { status }));

    await expect(
      renewBuilderHandoff(undefined, {
        creationRequestId: "123e4567-e89b-42d3-a456-426614174003",
        handoffId: id,
      }),
    ).resolves.toEqual({ status: expected });
    expect(deployment.pageData).not.toHaveBeenCalled();
  });

  it("rejects malformed client input before it reaches the renewal handler", async () => {
    await expect(
      renewBuilderHandoff(undefined, {
        creationRequestId: "123e4567-e89b-42d3-a456-426614174003",
        handoffId: "not-a-uuid",
      }),
    ).resolves.toEqual({ status: "error" });
    expect(deployment.renew).not.toHaveBeenCalled();
  });
});
