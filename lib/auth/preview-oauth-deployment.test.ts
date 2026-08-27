import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  createPreviewOAuthRequestHandler,
  createPreviewOAuthWellKnownHandler,
} from "./preview-oauth-deployment";

describe("Preview OAuth deployment handlers", () => {
  it("mounts the Better Auth handler without eager runtime construction", async () => {
    const handler = vi.fn(async (request: Request) =>
      Response.json({ path: new URL(request.url).pathname }),
    );
    const getAuth = vi.fn(() => ({ handler }) as never);
    const requestHandler = createPreviewOAuthRequestHandler({
      environment: {},
      getAuth,
    });
    expect(getAuth).not.toHaveBeenCalled();
    const response = await requestHandler(
      new Request("https://builder.example.test/api/auth/jwks"),
    );
    await expect(response.json()).resolves.toEqual({ path: "/api/auth/jwks" });
    expect(getAuth).toHaveBeenCalledTimes(1);
  });

  it("maps OAuth AS discovery to the mounted Better Auth endpoint", async () => {
    const handler = vi.fn(async (request: Request) =>
      Response.json({ path: new URL(request.url).pathname }),
    );
    const getAuth = vi.fn(() => ({ handler }) as never);
    const wellKnown = createPreviewOAuthWellKnownHandler({
      environment: {},
      getAuth,
    });
    const response = await wellKnown(
      new Request(
        "https://builder.example.test/.well-known/oauth-authorization-server/api/auth",
      ),
    );
    await expect(response.json()).resolves.toEqual({
      path: "/api/auth/.well-known/oauth-authorization-server",
    });
  });

  it("fails closed without leaking runtime configuration", async () => {
    const requestHandler = createPreviewOAuthRequestHandler({
      environment: { BETTER_AUTH_SECRET: "should-not-appear" },
      getAuth: vi.fn(() => {
        throw new Error("should-not-appear");
      }),
    });
    const response = await requestHandler(
      new Request("https://builder.example.test/api/auth/jwks"),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe(
      JSON.stringify({ error: "preview_oauth_unavailable" }),
    );
  });

  it("binds every browser interaction surface to no-store anti-clickjacking headers", async () => {
    const [config, runtime, signIn] = await Promise.all([
      readFile("next.config.ts", "utf8"),
      readFile("lib/auth/preview-oauth-runtime.ts", "utf8"),
      readFile("app/auth/sign-in/sign-in-form.tsx", "utf8"),
    ]);
    expect(config).toContain('source: "/auth/:path*"');
    expect(config).toContain('{ key: "Cache-Control", value: "no-store" }');
    expect(config).toContain("frame-ancestors 'none'");
    expect(config).toContain('{ key: "X-Frame-Options", value: "DENY" }');
    expect(runtime).toContain("baseURL: resourceOrigin");
    expect(runtime).not.toContain("baseURL: config.issuer");
    expect(signIn).not.toContain("/oauth2/continue");
    await expect(
      readFile("app/auth/workspace/page.tsx", "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile("app/auth/workspace/workspace-form.tsx", "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
